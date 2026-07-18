'use strict';

const queries = require('../db/queries');

function formatNaira(kobo) {
  return `\u20a6${(Number(kobo) / 100).toLocaleString('en-NG')}`;
}

/**
 * Assembles everything the AI needs to know about a merchant's business
 * BEFORE answering — the "Business Context Engine." Every AI-assisted
 * request gets this prepended to the system prompt, so the model isn't
 * just pattern-matching the current message in isolation; it actually
 * knows this merchant's debts, recent activity, and stock levels, which
 * is what lets it ask sharper follow-up questions and stop guessing at
 * numbers it was never given.
 *
 * `replyEntry` (optional) is the ledger entry the merchant's CURRENT
 * message was a WhatsApp reply to (resolved by the caller from the
 * inbound webhook's `context.id` — see worker.js and
 * queries.getLedgerEntryByOutboundMessageId). When present, it's
 * surfaced as an explicit "Reply context" block so the model can resolve
 * pronoun-only replies like "he paid" against the exact record being
 * replied to, instead of guessing which customer is meant.
 *
 * Deliberately bounded (8 recent transactions, 15 inventory rows) to
 * keep prompts short and cheap — this is meant to orient the model, not
 * replace Postgres as the source of truth for exact historical figures.
 */
async function buildBusinessContextBlock(merchant, replyEntry = null) {
  const [debt, recentEntries, inventory] = await Promise.all([
    queries.getOutstandingDebtTotal(merchant.id),
    queries.listRecentEntries(merchant.id, 8),
    queries.listProductsForMerchant(merchant.id, 15),
  ]);

  const lines = ['## Business context for this merchant (ground truth — never invent numbers beyond this)', ''];

  lines.push(`Business name: ${merchant.business_name || 'Not set yet'}`);
  if (merchant.business_type) lines.push(`Business type: ${merchant.business_type}${merchant.business_category ? ` (category: ${merchant.business_category})` : ''}`);
  const ownerName = merchant.merchant_name || merchant.whatsapp_display_name;
  if (ownerName) lines.push(`Merchant's own name: ${ownerName}`);
  lines.push(`Plan: ${merchant.plan}`);

  if (Number(debt.total_kobo) > 0) {
    lines.push(`Outstanding debt owed to them: ${formatNaira(debt.total_kobo)} across ${debt.entry_count} customer${debt.entry_count === '1' ? '' : 's'}.`);
  } else {
    lines.push('No outstanding customer debt right now.');
  }

  if (recentEntries.length > 0) {
    lines.push('', 'Recent transactions (most recent first):');
    recentEntries.forEach((e) => {
      const when = new Date(e.created_at).toLocaleDateString('en-NG', { month: 'short', day: 'numeric' });
      lines.push(
        `- [${when}] ${e.entry_type}: ${e.description} \u2014 ${formatNaira(e.total_kobo)}${e.counterparty_name ? ` (${e.counterparty_name})` : ''}`
      );
    });
  }

  if (inventory.length > 0) {
    lines.push('', 'Inventory snapshot (lowest stock first):');
    inventory.forEach((p) => {
      const low = Number(p.current_stock) <= Number(p.low_stock_threshold) ? ' (LOW)' : '';
      lines.push(`- ${p.name}: ${p.current_stock} ${p.unit || 'units'}${low}`);
    });
  }

  if (replyEntry) {
    lines.push(
      '',
      '## Reply context — the merchant\'s current message is a WhatsApp reply to this earlier message/entry:',
      `[${replyEntry.entry_type}] ${replyEntry.description} \u2014 total ${formatNaira(replyEntry.total_kobo)}, paid ${formatNaira(replyEntry.paid_kobo)}, balance ${formatNaira(replyEntry.balance_kobo)}${replyEntry.counterparty_name ? `, customer: ${replyEntry.counterparty_name}` : ''}.`,
      'If the current message uses a pronoun ("he paid", "she paid", "cleared it") with no name of its own, it almost certainly refers to the customer named above — use that name as counterpartyName rather than asking who it is, unless the message clearly names someone different.'
    );
  }

  lines.push(
    '',
    "Use this context to answer questions about their business, but only ever record a NEW transaction based on what the CURRENT message actually says — never re-record something already listed above, and never state a number that isn't grounded in this context or the current message."
  );

  return lines.join('\n');
}

module.exports = { buildBusinessContextBlock };
