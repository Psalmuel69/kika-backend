'use strict';

const crypto = require('crypto');
const { pool } = require('../config/db');
const queries = require('../db/queries');
const { formatNaira } = require('./receiptService');
const loyaltyService = require('./loyaltyService');
const logger = require('../utils/logger');

/**
 * A DEBT genuinely needs SOME identifier to be tracked and later settled
 * against — "who owes this?" has to resolve to the same value next time
 * that customer pays. A CREDIT (fully paid, nothing to track) doesn't
 * need one at all. Rather than fabricating a generic "Walk-in customer"
 * label (indistinguishable from every other unnamed walk-in, and wrongly
 * implying a name was given), an unnamed debt gets a short, unique code
 * instead — distinguishable, and honest about being a placeholder.
 */
function generateAnonymousCustomerCode() {
  return `Cust-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

/**
 * Records a parsed ledger entry (or applies it as a debt settlement) and
 * generates the matching receipt card. The write happens inside a single
 * Postgres transaction so concurrent bursts of messages — for the same or
 * different merchants — can never leave a half-written entry, and the
 * pool releases its client the instant the transaction resolves.
 *
 * When the entry is a DEBT (a sale that isn't fully paid for), this also
 * locks and updates the customer's rolling balance — see
 * queries.lockCustomerBalance for why that row lock, not just the
 * transaction wrapper, is what actually prevents two sales to the same
 * customer within seconds of each other from producing a lost update.
 */
async function recordLedgerEntryAndReceipt({ merchant, parsedEntry, rawMessage, whatsappMessageId, replyToWhatsappMessageId }) {
  // See generateAnonymousCustomerCode's comment above for why this only
  // applies to DEBT (never CREDIT/DEBIT, which have nothing to track).
  if (parsedEntry.entryType === 'DEBT' && !parsedEntry.counterpartyName) {
    parsedEntry = { ...parsedEntry, counterpartyName: generateAnonymousCustomerCode() };
  }

  if (parsedEntry.entryType === 'DEBT_SETTLEMENT' && parsedEntry.counterpartyName) {
    return recordDebtSettlement({ merchant, parsedEntry, rawMessage, whatsappMessageId, replyToWhatsappMessageId });
  }

  const ledgerEntry = await queries.withTransaction(async (client) => {
    let balanceAfterKobo = null;

    if (parsedEntry.entryType === 'DEBT' && parsedEntry.counterpartyName) {
      // BEGIN is already active on this client (withTransaction issued
      // it). Lock the customer's rolling balance row before computing
      // the new total — this is the explicit row-level lock that
      // serializes concurrent sales to the same customer.
      await queries.lockCustomerBalance(client, merchant.id, parsedEntry.counterpartyName);
      const updated = await queries.applyCustomerBalanceDelta(
        client,
        merchant.id,
        parsedEntry.counterpartyName,
        parsedEntry.balanceKobo
      );
      balanceAfterKobo = Number(updated.rolling_balance_kobo);
    }

    return queries.createLedgerEntry(client, {
      merchantId: merchant.id,
      entryType: parsedEntry.entryType,
      counterpartyName: parsedEntry.counterpartyName,
      counterpartyPhone: parsedEntry.counterpartyPhone,
      description: parsedEntry.description,
      items: parsedEntry.items,
      totalKobo: parsedEntry.totalKobo,
      paidKobo: parsedEntry.paidKobo,
      balanceKobo: parsedEntry.balanceKobo,
      balanceAfterKobo,
      rawMessage,
      whatsappMessageId,
      replyToWhatsappMessageId,
      expenseCategory: parsedEntry.expenseCategory || null,
    });
    // COMMIT happens automatically here as withTransaction's callback
    // resolves; the lock acquired above is held for the entire block
    // above and released only at COMMIT.
  });

  // Receipts are no longer generated here automatically — see worker.js's
  // DONE-triggered confirmation flow. This entry is recorded with
  // receipt_decision_pending=true (the column's own default), and stays
  // that way until the merchant explicitly says yes/no to a receipt for
  // it (possibly bundled with other entries logged in the same session).
  // Generating eagerly here would waste a render+storage write for every
  // entry someone declines a receipt for, which is now expected to be
  // common — the whole point of asking first.

  // Smart Customer Loyalty Flags — a CREDIT or DEBT entry represents an
  // actual purchase by this counterparty, so it counts toward their
  // milestone streak. Awaited (not fire-and-forget) because the result,
  // when a milestone is hit, gets appended to the merchant's own receipt
  // caption — see loyaltyService.js for why this no longer messages the
  // customer directly. A failure here must never block the receipt itself.
  let loyaltyMilestoneText = null;
  if (['CREDIT', 'DEBT'].includes(parsedEntry.entryType)) {
    try {
      const loyaltyResult = await loyaltyService.trackPurchaseAndMaybeNotify({
        merchant,
        counterpartyName: parsedEntry.counterpartyName,
        counterpartyPhone: parsedEntry.counterpartyPhone,
      });
      loyaltyMilestoneText = loyaltyResult.milestoneText || null;
    } catch (err) {
      logger.error({ err: err.message }, 'Loyalty tracking failed');
    }
  }

  // Smart Low-Stock Inventory Alerts — opt-in per product (only fires
  // for items the merchant has explicitly registered via ADD STOCK).
  // Runs after the sale is committed so a stock-tracking hiccup can
  // never block the sale itself from being recorded.
  const lowStockAlerts = [];
  if (['CREDIT', 'DEBT'].includes(parsedEntry.entryType) && parsedEntry.items?.length) {
    for (const item of parsedEntry.items) {
      try {
        const updatedProduct = await queries.decrementProductStock(merchant.id, item.name, item.quantity);
        if (updatedProduct && Number(updatedProduct.current_stock) <= Number(updatedProduct.low_stock_threshold)) {
          lowStockAlerts.push(
            `\u26a0\ufe0f *LOW STOCK ALERT* \u26a0\ufe0f\nYour inventory for *${updatedProduct.name}* dropped to just *${updatedProduct.current_stock} ${updatedProduct.unit || 'units'}* left.\n\nWhen you restock, just text: *ADD STOCK: ${updatedProduct.name}, 50*`
          );
        }
      } catch (err) {
        logger.error({ err: err.message, item: item.name }, 'Inventory decrement failed');
      }
    }
  }

  return {
    ledgerEntry,
    outstandingDebtKobo: ledgerEntry.balance_after_kobo != null ? Number(ledgerEntry.balance_after_kobo) : parsedEntry.balanceKobo,
    loyaltyMilestoneText,
    lowStockAlerts,
  };
}

/**
 * "John pay off his debt 5k" — applies the payment FIFO against John's
 * oldest open balances rather than creating a brand-new entry, then
 * renders a settlement receipt reflecting what was actually cleared.
 *
 * settleOutstandingDebtForCounterparty already locks the customer's
 * rolling balance row (before locking the individual ledger_entries
 * debt rows, in that fixed order — see the comment on that function for
 * why the ordering matters), so this inherits the same race-free
 * guarantee as a new DEBT entry.
 */
async function recordDebtSettlement({ merchant, parsedEntry, rawMessage, whatsappMessageId, replyToWhatsappMessageId }) {
  const { settlementResult, ledgerEntry } = await queries.withTransaction(async (client) => {
    const settlementResult = await queries.settleOutstandingDebtForCounterparty(
      client,
      merchant.id,
      parsedEntry.counterpartyName,
      parsedEntry.paidKobo
    );

    const ledgerEntry = await queries.createLedgerEntry(client, {
      merchantId: merchant.id,
      entryType: 'DEBT_SETTLEMENT',
      counterpartyName: parsedEntry.counterpartyName,
      counterpartyPhone: parsedEntry.counterpartyPhone,
      description: parsedEntry.description,
      items: [],
      totalKobo: parsedEntry.paidKobo,
      paidKobo: parsedEntry.paidKobo,
      balanceKobo: 0,
      balanceAfterKobo: settlementResult.rollingBalanceKobo,
      rawMessage,
      whatsappMessageId,
      replyToWhatsappMessageId,
    });

    return { settlementResult, ledgerEntry };
  });

  // Same deferred-receipt policy as the main recording path above.

  return {
    ledgerEntry,
    // The customer's remaining total after this payment — not
    // necessarily 0, if the payment only partially cleared what they owed.
    outstandingDebtKobo: settlementResult.rollingBalanceKobo,
    settledCount: settlementResult.settled.length,
    unallocatedKobo: settlementResult.unallocatedKobo,
  };
}

async function buildBalanceSummaryText(merchantId) {
  const [balance, debt] = await Promise.all([
    queries.getRunningBalance(merchantId),
    queries.getOutstandingDebtTotal(merchantId),
  ]);

  const netKobo = Number(balance.total_in_kobo) - Number(balance.total_out_kobo);

  return [
    '*Kika Balance Summary*',
    '',
    `Total In:  ${formatNaira(balance.total_in_kobo)}`,
    `Total Out: ${formatNaira(balance.total_out_kobo)}`,
    `Net:       ${formatNaira(netKobo)}`,
    '',
    Number(debt.total_kobo) > 0
      ? `\u26a0\ufe0f Outstanding debt owed to you: ${formatNaira(debt.total_kobo)} across ${debt.entry_count} entr${debt.entry_count === '1' ? 'y' : 'ies'}`
      : '\u2705 No outstanding debt on record.',
  ].join('\n');
}

/**
 * Daily Sunset Report — an end-of-day recap sent each evening summarizing
 * the day's sales, expenses, new debt issued, and top-moving items. Named
 * for the moment many informal merchants close shop and reconcile the day.
 */
async function buildDailySunsetReportText(merchantId, dayStart, dayEnd) {
  const summary = await queries.getPeriodSummary(merchantId, dayStart, dayEnd);
  const netKobo = Number(summary.sales_kobo) - Number(summary.expenses_kobo);

  const lines = [
    '*Kika Daily Sunset Report*',
    dayStart.toLocaleDateString('en-NG', { dateStyle: 'medium' }),
    '',
    `Sales:    ${formatNaira(summary.sales_kobo)}`,
    `Expenses: ${formatNaira(summary.expenses_kobo)}`,
    `Net:      ${formatNaira(netKobo)}`,
  ];

  if (Number(summary.new_debt_kobo) > 0) {
    lines.push(`New debt issued today: ${formatNaira(summary.new_debt_kobo)}`);
  }

  if (summary.topItems.length > 0) {
    lines.push('', '*Top items today:*');
    summary.topItems.forEach((item, i) => {
      lines.push(`${i + 1}. ${item.name} (${item.total_quantity})`);
    });
  }

  lines.push('', `Transactions logged: ${summary.entry_count}`);
  lines.push('', 'Rest well \u2014 see you tomorrow!');

  return lines.join('\n');
}

/**
 * Monthly Insights — trend-oriented recap: revenue vs. the prior month,
 * top customers, top products, and debt standing. Sent automatically on
 * the 1st of each month, or on demand via the INSIGHTS command.
 */
async function buildMonthlyInsightsReportText(merchantId, monthStart, monthEnd, prevMonthStart, prevMonthEnd) {
  const [current, previous, debt] = await Promise.all([
    queries.getPeriodSummary(merchantId, monthStart, monthEnd),
    queries.getPeriodSummary(merchantId, prevMonthStart, prevMonthEnd),
    queries.getOutstandingDebtTotal(merchantId),
  ]);

  const currentSales = Number(current.sales_kobo);
  const previousSales = Number(previous.sales_kobo);
  let trendLine;
  if (previousSales > 0) {
    const pctChange = (((currentSales - previousSales) / previousSales) * 100).toFixed(1);
    const arrow = pctChange >= 0 ? '\ud83d\udcc8' : '\ud83d\udcc9';
    trendLine = `${arrow} ${pctChange >= 0 ? '+' : ''}${pctChange}% vs last month`;
  } else {
    trendLine = 'No prior month data to compare yet.';
  }

  const lines = [
    '*Kika Monthly Insights*',
    monthStart.toLocaleDateString('en-NG', { month: 'long', year: 'numeric' }),
    '',
    `Total Sales:    ${formatNaira(current.sales_kobo)}`,
    `Total Expenses: ${formatNaira(current.expenses_kobo)}`,
    `Net:            ${formatNaira(currentSales - Number(current.expenses_kobo))}`,
    trendLine,
  ];

  if (current.topCustomers.length > 0) {
    lines.push('', '*Top customers this month:*');
    current.topCustomers.forEach((c, i) => {
      lines.push(`${i + 1}. ${c.counterparty_name} \u2014 ${formatNaira(c.total_value_kobo)}`);
    });
  }

  if (current.topItems.length > 0) {
    lines.push('', '*Best-selling items:*');
    current.topItems.forEach((item, i) => {
      lines.push(`${i + 1}. ${item.name} (${item.total_quantity})`);
    });
  }

  if (Number(debt.total_kobo) > 0) {
    lines.push('', `\u26a0\ufe0f Total outstanding debt: ${formatNaira(debt.total_kobo)}`);
  }

  return lines.join('\n');
}

/**
 * Aggregates the four figures shown on the Monthly Digest card: money
 * inflow (+ growth vs last month), total outstanding credit, trade days,
 * and the single top debtor.
 */
async function buildMonthlyDigestSummary(merchantId, monthStart, monthEnd, prevMonthStart) {
  const [current, previous, debt, tradeDays, topDebtor] = await Promise.all([
    queries.getPeriodSummary(merchantId, monthStart, monthEnd),
    queries.getPeriodSummary(merchantId, prevMonthStart, monthStart),
    queries.getOutstandingDebtTotal(merchantId),
    queries.getTradeDaysCount(merchantId, monthStart, monthEnd),
    queries.getTopDebtor(merchantId),
  ]);

  const currentSales = Number(current.sales_kobo);
  const previousSales = Number(previous.sales_kobo);
  const growthPct = previousSales > 0 ? ((currentSales - previousSales) / previousSales) * 100 : null;

  return {
    moneyInflowKobo: currentSales,
    growthPct,
    outstandingKobo: Number(debt.total_kobo),
    tradeDays,
    topDebtor,
  };
}

module.exports = {
  recordLedgerEntryAndReceipt,
  buildBalanceSummaryText,
  buildDailySunsetReportText,
  buildMonthlyInsightsReportText,
  buildMonthlyDigestSummary,
  pool,
};
