'use strict';

require('dotenv').config();
const { Worker } = require('bullmq');
const { connection } = require('../config/redis');
const logger = require('../utils/logger');
const queries = require('../db/queries');
const ledgerParser = require('../services/ledgerParser');
const ledgerService = require('../services/ledgerService');
const receiptService = require('../services/receiptService');
const whatsappService = require('../services/whatsappService');
const paystackService = require('../services/paystackService');
const brokerAlertService = require('../services/brokerAlertService');
const monthlyDigestService = require('../services/monthlyDigestService');
const fullReportService = require('../services/fullReportService');
const mediaService = require('../services/mediaService');
const aiTransactionParser = require('../services/aiTransactionParser');
const entryValidator = require('../services/entryValidator');
const categorizationService = require('../services/categorizationService');
const conversationMemory = require('../services/conversationMemory');
const engagementService = require('../services/engagementService');
const exportService = require('../services/exportService');
const auditLogService = require('../services/auditLogService');
const diskCleanupService = require('../services/diskCleanupService');
const { getFallbackReply, AI_ERROR_FALLBACK_REPLY, GREETING_REPLY } = require('../config/aiPersona');
const { registerSchedules } = require('./scheduler');

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 10);
const ONBOARDING_GATE_STATES = ['PENDING_CONSENT', 'CONSENT_DECLINED', 'AWAITING_BUSINESS_NAME', 'AWAITING_BUSINESS_TYPE'];
const RESTART_TRIGGERS = ['hi', 'hello', 'start', 'menu', 'help', 'hey'];

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}
function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}
function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
function dayKey(date) {
  return date.toISOString().slice(0, 10);
}
function currentLagosHour() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: 'numeric', hour12: false }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === 'hour').value);
}

/**
 * "Good morning Samuel" instead of a generic "Hi" whenever Kika actually
 * knows who it's talking to — preferring the name the merchant
 * explicitly gave (merchant_name) over WhatsApp's own contact display
 * name (whatsapp_display_name, captured automatically from Meta's
 * webhook metadata; see queries.findOrCreateMerchantByWhatsappNumber),
 * since a self-introduced name is a stronger signal of what they'd
 * actually want to be called. Falls back to the original generic
 * GREETING_REPLY when Kika has no name at all for this merchant yet.
 */
function buildTimeAwareGreeting(merchant) {
  const name = merchant.merchant_name || merchant.whatsapp_display_name;
  if (!name) return GREETING_REPLY;

  const hour = currentLagosHour();
  const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const firstName = name.trim().split(/\s+/)[0];

  return `Good ${timeOfDay}, ${firstName}! I'm *Kika AI* \u2014 your business ledger assistant right here on WhatsApp. I help you record sales, expenses, and customer debts just by texting me normally, no app needed. How can I help you today?`;
}

function formatNairaShort(kobo) {
  return `\u20a6${(Number(kobo) / 100).toLocaleString('en-NG')}`;
}

const ENTRY_ACTION_WORD = { CREDIT: 'sale', DEBT: 'credit sale', DEBIT: 'expense', DEBT_SETTLEMENT: 'payment' };

/**
 * Describes the item(s) for one ledger entry the way a person would say
 * it out loud — "2 bags of rice", "3 cartons of indomie", or just
 * "Fuel" when there's no quantity/unit at all. Entries always have a
 * clean item name by this point (see ledgerParser.js /
 * aiTransactionParser.js) except DEBT_SETTLEMENT, which has none.
 */
function describeEntryItems(entry) {
  const items = entry.items || [];
  if (items.length === 0) return null;
  return items
    .map((it) => (it.quantity != null && it.unit ? `${it.quantity} ${it.unit} of ${it.name.toLowerCase()}` : it.name))
    .join(', ');
}

/**
 * Warm, specific confirmation copy for what was just logged — named the
 * actual customer/items/figures, since that's what makes it feel like
 * Kika actually understood what happened, not just logged a row. Sent
 * ONCE, covering everything logged since the last DONE — see
 * askReceiptDecision, which calls this before asking about a receipt.
 */
function buildBatchConfirmationText(entries) {
  if (entries.length > 1) {
    const totalKobo = entries.reduce((sum, e) => sum + Number(e.total_kobo), 0);
    return `Great! I've recorded your ${entries.length} entries (${formatNairaShort(totalKobo)} total) to your Kika book.`;
  }

  const entry = entries[0];
  const action = ENTRY_ACTION_WORD[entry.entry_type] || 'transaction';
  const itemPhrase = describeEntryItems(entry);

  if (entry.entry_type === 'DEBT_SETTLEMENT') {
    const who = entry.counterparty_name || 'Your customer';
    const balanceKobo = entry.balance_after_kobo != null ? Number(entry.balance_after_kobo) : 0;
    return balanceKobo > 0
      ? `Great! I've recorded the payment of ${formatNairaShort(entry.paid_kobo)} from ${who} to your Kika book. Outstanding balance is now ${formatNairaShort(balanceKobo)}.`
      : `Great! I've recorded the payment of ${formatNairaShort(entry.paid_kobo)} from ${who} to your Kika book \u2014 fully settled!`;
  }

  const whoPhrase =
    entry.entry_type === 'DEBIT'
      ? ''
      : entry.counterparty_name
        ? ` for ${entry.counterparty_name}`
        : '';

  return `Great! I've recorded the ${action} of ${itemPhrase || formatNairaShort(entry.total_kobo)}${whoPhrase} to your Kika book.`;
}

async function handleTierPurchase(merchant, whatsappNumber, tierName, billingInterval = 'monthly') {
  const invoice = await paystackService.createUpgradeInvoice(merchant, tierName, billingInterval);
  const intervalLabel = billingInterval === 'yearly' ? '/yr' : '/mo';
  await whatsappService.sendPaymentLink(
    whatsappNumber,
    invoice.authorizationUrl,
    `${invoice.tier.currency} ${(invoice.amountKobo / 100).toLocaleString('en-NG')}${intervalLabel} (${invoice.tier.name}${billingInterval === 'yearly' ? ' \u2014 Yearly' : ''})`
  );
}

// ---------------------------------------------------------------------------
// Receipt confirmation batching — a transaction is recorded immediately as
// always, but the receipt image is no longer auto-sent. A merchant can log
// one thing or several in a row; typing DONE is what asks "want a receipt
// for what you just logged?", covering everything logged since the last
// time that question was answered. Plain deterministic logic, no AI.
// ---------------------------------------------------------------------------

async function askReceiptDecision(merchant, whatsappNumber) {
  const pending = await queries.getPendingReceiptDecisionEntries(merchant.id);
  if (pending.length === 0) {
    await whatsappService.sendTextMessage(whatsappNumber, "There's nothing new to log right now.");
    return;
  }

  // The descriptive "here's what I recorded" message — sent once,
  // covering everything logged since the last DONE, and always BEFORE
  // the receipt question (not attached to the receipt itself — see
  // handleReceiptDecisionReply, whose "yes" caption is deliberately
  // minimal now that this has already said what's in it).
  await whatsappService.sendTextMessage(whatsappNumber, buildBatchConfirmationText(pending));

  await queries.setReceiptDecisionAwaiting(merchant.id, true);
  const totalKobo = pending.reduce((sum, e) => sum + Number(e.total_kobo), 0);
  const summary =
    pending.length === 1
      ? `that last entry (${formatNairaShort(totalKobo)})`
      : `these ${pending.length} entries (${formatNairaShort(totalKobo)} total)`;
  await whatsappService.sendButtonMessage(whatsappNumber, {
    bodyText: `Want a receipt for ${summary}?`,
    buttons: [
      { id: 'YES', title: 'Yes' },
      { id: 'NO', title: 'No' },
    ],
  });
}

/**
 * Engagement nudges (NPS survey, weekly email-collection nudge) are
 * checked here — once the receipt decision for a logging session has
 * fully resolved — rather than per entry or alongside the receipt
 * question itself. Firing one here would stack awkwardly with the
 * receipt Y/N prompt (whose button the merchant might tap only after
 * answering an NPS question first, or vice versa); waiting until this
 * flow is completely done keeps exactly one open question at a time.
 * Plain deterministic checks (engagementService.js), not AI-assisted.
 */
async function maybeSendEngagementNudge(merchant, whatsappNumber) {
  try {
    const npsTriggerReason = await engagementService.checkNpsTrigger(merchant);
    if (npsTriggerReason) {
      const npsQuestion = await engagementService.triggerNpsSurvey(merchant.id, npsTriggerReason);
      await whatsappService.sendTextMessage(whatsappNumber, npsQuestion);
      return;
    }
    const weeklyCount = await engagementService.checkEmailMilestoneTrigger(merchant);
    if (weeklyCount) {
      const emailNudge = await engagementService.triggerEmailMilestone(merchant.id, weeklyCount);
      await whatsappService.sendTextMessage(whatsappNumber, emailNudge);
    }
  } catch (err) {
    logger.error({ err: err.message, merchantId: merchant.id }, 'Engagement nudge check failed (non-fatal)');
  }
}

async function handleReceiptDecisionReply(merchant, whatsappNumber, rawMessage) {
  const text = String(rawMessage || '').trim();

  if (engagementService.isNegative(text)) {
    const pending = await queries.getPendingReceiptDecisionEntries(merchant.id);
    await queries.resolvePendingReceiptDecision(merchant.id, pending.map((e) => e.id));
    await queries.setReceiptDecisionAwaiting(merchant.id, false);
    await whatsappService.sendTextMessage(whatsappNumber, 'No problem \u2014 no receipt sent. Keep logging whenever you\'re ready!');
    await maybeSendEngagementNudge(merchant, whatsappNumber);
    return;
  }

  if (engagementService.isAffirmative(text)) {
    const pending = await queries.getPendingReceiptDecisionEntries(merchant.id);
    await queries.setReceiptDecisionAwaiting(merchant.id, false);
    if (pending.length === 0) {
      await whatsappService.sendTextMessage(whatsappNumber, "Looks like there's nothing pending anymore \u2014 nothing to send.");
      return;
    }
    const receipt =
      pending.length === 1
        ? await receiptService.generateReceipt({ merchant, ledgerEntry: pending[0] })
        : await receiptService.generateReceipt({ merchant, ledgerEntries: pending });
    await queries.resolvePendingReceiptDecision(merchant.id, pending.map((e) => e.id), { receiptId: receipt.receiptId });
    // Minimal caption — what was actually recorded was already described
    // in the confirmation message sent before this Yes/No question (see
    // askReceiptDecision), so the receipt itself doesn't need to repeat it.
    await whatsappService.sendReceiptImage(whatsappNumber, receipt.url, 'Here\u2019s your receipt!');
    await maybeSendEngagementNudge(merchant, whatsappNumber);
    return;
  }

  await whatsappService.sendTextMessage(whatsappNumber, 'Just reply YES or NO \u2014 want a receipt for what you logged?');
}

// ---------------------------------------------------------------------------
// Multi-item invoice creation ("new invoice for Adaeze" -> item lines ->
// DONE -> preview -> yes/no). The finished invoice card + payment link are
// handed to the MERCHANT only — never sent to the customer directly. Also
// plain deterministic logic, no AI.
// ---------------------------------------------------------------------------

async function startInvoiceCreation(merchant, whatsappNumber, customerName) {
  if (!customerName) {
    // Bare "create invoice"/"new invoice" with no name attached — rather
    // than silently starting a flow (or doing nothing at all), tell the
    // merchant the exact format so their next message succeeds on the
    // first try. No flow state is started here; invoice_awaiting_stage
    // stays untouched until they resend with a name.
    await whatsappService.sendTextMessage(
      whatsappNumber,
      `To create an invoice, include the customer's name:\n\n*Create invoice for <customer name>*\nor\n*New invoice <customer name>*`
    );
    return;
  }
  await queries.startInvoiceFlow(merchant.id, customerName);
  await whatsappService.sendTextMessage(
    whatsappNumber,
    `Creating invoice for ${customerName}. Add your items \u2014 type each one like:\n\n_Quantity x Item name x Price (per item)_\n\nType *done* when finished.`
  );
}

// Shared invoice item line renderer — used for the running "Added: ..."
// confirmation, the pre-confirm preview, and (indirectly) the final
// invoice card. Always shows the per-item price in brackets alongside
// the line total, so the customer-facing invoice is unambiguous about
// unit cost vs. total ("3\u00d7 bags rice (\u20a61,500/unit) \u2014 \u20a64,500"),
// not just a lump sum.
function formatInvoiceItemLabel(item) {
  const label = item.unit ? `${item.unit} ${item.name}` : item.name;
  const unitPrice = formatNairaShort(item.unitPriceKobo);
  const lineTotal = formatNairaShort(item.totalKobo);
  return `${item.quantity}\u00d7 ${label} (${unitPrice}/unit) \u2014 ${lineTotal}`;
}

function buildInvoicePreviewText(customerName, items, totalKobo) {
  const lines = [`Here's your invoice preview:`, '', `*Invoice for ${customerName}*`, ''];
  for (const item of items) {
    lines.push(formatInvoiceItemLabel(item));
  }
  lines.push('', `*Total: ${formatNairaShort(totalKobo)}*`, '', 'Generate this invoice? Reply *yes* to confirm.');
  return lines.join('\n');
}

async function handleInvoiceItemsReply(merchant, whatsappNumber, rawMessage) {
  const command = ledgerParser.detectCommand(rawMessage);
  if (command === 'DONE') {
    const items = merchant.invoice_pending_items || [];
    if (items.length === 0) {
      await whatsappService.sendTextMessage(
        whatsappNumber,
        'You haven\u2019t added any items yet \u2014 send at least one like "2 x iPhone charger x 4500" or "3 bags rice x 15k" (price is per item), or type CANCEL to stop.'
      );
      return;
    }
    const totalKobo = items.reduce((sum, it) => sum + Number(it.totalKobo), 0);
    await queries.setInvoiceAwaitingStage(merchant.id, 'CONFIRM');
    await whatsappService.sendTextMessage(whatsappNumber, buildInvoicePreviewText(merchant.invoice_customer_name, items, totalKobo));
    return;
  }

  if (/^cancel$/i.test(rawMessage.trim())) {
    await queries.clearInvoiceFlow(merchant.id);
    await whatsappService.sendTextMessage(whatsappNumber, 'Invoice cancelled.');
    return;
  }

  const item = ledgerParser.parseInvoiceItemLine(rawMessage);
  if (!item) {
    await whatsappService.sendTextMessage(
      whatsappNumber,
      'Didn\u2019t catch that \u2014 add items like "2 x iPhone charger x 4500" or "3 bags rice x 15k" (Quantity + item, then price PER ITEM), or type *done* when finished.'
    );
    return;
  }
  await queries.addInvoicePendingItem(merchant.id, item);
  await whatsappService.sendTextMessage(whatsappNumber, `Added: ${formatInvoiceItemLabel(item)}. Send another item, or type *done*.`);
}

async function handleInvoiceConfirmReply(merchant, whatsappNumber, rawMessage) {
  if (!engagementService.isAffirmative(rawMessage)) {
    await queries.clearInvoiceFlow(merchant.id);
    await whatsappService.sendTextMessage(whatsappNumber, 'No problem \u2014 invoice discarded. Say "new invoice for <name>" any time to start another.');
    return;
  }

  const items = merchant.invoice_pending_items || [];
  const totalKobo = items.reduce((sum, it) => sum + Number(it.totalKobo), 0);
  const invoiceNumber = await queries.claimNextInvoiceNumber(merchant.id);

  // Invoices are a document only — Kika generates the card and hands it
  // to the merchant; how the customer actually pays (bank transfer,
  // cash, their own POS, etc.) is between the two of them. Paystack is
  // reserved for merchant subscription upgrades only (see
  // handleTierPurchase / paystackService.createUpgradeInvoice) — no
  // payment link is created here, so there's nothing for Kika to track
  // or auto-confirm on this side.
  let card;
  try {
    card = await receiptService.generateInvoiceCard({ merchant, invoiceNumber, customerName: merchant.invoice_customer_name, items, totalKobo });
  } catch (err) {
    logger.error(
      { err: err.message, httpStatus: err.response?.status, responseBody: err.response?.data, merchantId: merchant.id, invoiceNumber },
      'Invoice generation failed'
    );
    await whatsappService.sendTextMessage(
      whatsappNumber,
      "Something went wrong generating that invoice \u2014 nothing was lost, your items are still here. Reply *yes* to try again, or CANCEL to stop."
    );
    return;
  }

  await queries.clearInvoiceFlow(merchant.id);

  // Handed to the MERCHANT only — Kika never messages the customer
  // directly with an invoice (same policy as loyalty milestones — see
  // loyaltyService.js). The merchant forwards it themselves, on their
  // own terms, and arranges payment directly with the customer.
  try {
    await whatsappService.sendReceiptImage(
      whatsappNumber,
      card.url,
      `Here\u2019s the invoice for ${merchant.invoice_customer_name} \u2014 you can share this with them. Payment is between you and your customer; once they've paid, just log it here as usual (e.g. "${merchant.invoice_customer_name} paid ${formatNairaShort(totalKobo)}").`
    );
  } catch (err) {
    // The invoice card WAS generated and saved at this point
    // (queries.clearInvoiceFlow already ran) \u2014 only the WhatsApp
    // delivery of the image failed. Fall back to the plain-text link so
    // the merchant still gets something usable instead of nothing,
    // rather than losing the whole invoice to a media-send hiccup.
    logger.error({ err: err.message, httpStatus: err.response?.status, responseBody: err.response?.data, merchantId: merchant.id, invoiceNumber }, 'Invoice card image failed to send; falling back to text');
    await whatsappService.sendTextMessage(
      whatsappNumber,
      `Here\u2019s the invoice for ${merchant.invoice_customer_name} (the image didn\u2019t send, here\u2019s the link instead):\n\n${card.url}`
    );
  }
}

/**
 * Resolves whatever the merchant actually sent (text, a tapped button,
 * a voice note, or a photo) into a plain-text string the rest of the
 * pipeline can parse, plus an optional image for the AI vision fallback.
 * Multimodal downloading/transcription happens here — in the worker,
 * off the webhook's hot path — never in the HTTP request/response cycle.
 */
async function resolveInboundContent(job) {
  const { mediaType, mediaId, rawMessage } = job.data;

  if (mediaType === 'audio') {
    try {
      const transcript = await mediaService.transcribeWhatsappAudio(mediaId);
      return { text: transcript || '', imageBase64: null };
    } catch (err) {
      logger.error({ err: err.message, mediaId }, 'Audio transcription failed');
      return { text: '', imageBase64: null, mediaError: true };
    }
  }

  if (mediaType === 'image') {
    try {
      const imageBase64 = await mediaService.downloadWhatsappImageAsBase64(mediaId);
      return { text: rawMessage || '', imageBase64 };
    } catch (err) {
      logger.error({ err: err.message, mediaId }, 'Image download failed');
      return { text: rawMessage || '', imageBase64: null, mediaError: true };
    }
  }

  return { text: rawMessage || '', imageBase64: null };
}

// ---------------------------------------------------------------------------
// Onboarding / consent state machine — gates EVERYTHING else. A merchant
// can only log entries once they've accepted terms AND provided a
// business name (existing merchants who already passed this skip
// straight to normal processing, since their state is already ACTIVE+).
// ---------------------------------------------------------------------------
async function handleOnboarding(merchant, whatsappNumber, jobData) {
  const rawMessage = (jobData.rawMessage || '').trim();
  const isAgreeButtonTap = rawMessage === 'AGREE_TERMS';

  if (merchant.onboarding_state === 'PENDING_CONSENT') {
    if (isAgreeButtonTap) {
      await queries.recordMerchantConsent(merchant.id);
      await auditLogService.logEvent({ merchantId: merchant.id, actorType: 'MERCHANT', actorId: whatsappNumber, action: 'consent.accepted' });
      await whatsappService.sendTextMessage(
        whatsappNumber,
        "Account Activated! Your Kika Free Tier is live. Let's set up your business identity in 5 seconds.\n\n*What is the name of your business/shop?*"
      );
      return;
    }

    if (merchant.consent_prompt_count < 3) {
      await whatsappService.sendConsentPrompt(whatsappNumber);
      await queries.incrementConsentPromptCount(merchant.id);
      return;
    }

    // 3 nudges sent, still no accept — decline politely and go quiet
    // until the merchant proactively re-engages.
    await queries.markConsentDeclined(merchant.id);
    await whatsappService.sendTextMessage(
      whatsappNumber,
      "No worries \u2014 whenever you're ready to get started, just say *Hi* and we'll pick up right where we left off."
    );
    return;
  }

  if (merchant.onboarding_state === 'CONSENT_DECLINED') {
    if (RESTART_TRIGGERS.includes(rawMessage.toLowerCase())) {
      await queries.restartConsentFlow(merchant.id);
      await whatsappService.sendConsentPrompt(whatsappNumber);
      await queries.incrementConsentPromptCount(merchant.id);
    }
    // Otherwise: stay silent. This merchant declined onboarding; we
    // don't keep messaging a number that hasn't agreed to be contacted.
    return;
  }

  if (merchant.onboarding_state === 'AWAITING_BUSINESS_NAME') {
    if (jobData.mediaType !== 'text' || !rawMessage) {
      await whatsappService.sendTextMessage(whatsappNumber, 'What is the name of your business/shop? (please type it as text)');
      return;
    }
    const businessName = rawMessage.slice(0, 160);
    await queries.setMerchantBusinessName(merchant.id, businessName);
    await auditLogService.logEvent({ merchantId: merchant.id, actorType: 'MERCHANT', actorId: whatsappNumber, action: 'onboarding.business_name_set', metadata: { businessName } });
    await whatsappService.sendTextMessage(
      whatsappNumber,
      `Nice, *${businessName}*! One last thing \u2014 what type of business is it? (e.g. "Provision store", "Hair salon", "Phone accessories")`
    );
    return;
  }

  if (merchant.onboarding_state === 'AWAITING_BUSINESS_TYPE') {
    if (jobData.mediaType !== 'text' || !rawMessage) {
      await whatsappService.sendTextMessage(whatsappNumber, 'What type of business is it? (please type it as text, e.g. "Provision store")');
      return;
    }
    const businessType = rawMessage.slice(0, 160);
    // Kika classifies the merchant's own free-text answer into one fixed
    // business_category (e.g. "Provision Store" -> "Retail") — see
    // categorizationService.js. Never blocks onboarding on this: any
    // failure just falls back to 'Other' inside the service itself.
    const businessCategory = await categorizationService.categorizeBusinessType(businessType, merchant.business_name);
    await queries.setMerchantBusinessType(merchant.id, businessType, businessCategory);
    await auditLogService.logEvent({
      merchantId: merchant.id,
      actorType: 'MERCHANT',
      actorId: whatsappNumber,
      action: 'onboarding.business_type_set',
      metadata: { businessType, businessCategory },
    });
    await whatsappService.sendTextMessage(
      whatsappNumber,
      `Perfect! *${merchant.business_name}* is officially registered on Kika. From now on, any sale you type will carry this name at the top of your digital receipts.\n\nTry it now \u2014 send something like "sold rice 5000" or type HELP for more examples.`
    );
  }
}

// "DISPUTE <reason>" — a merchant flags that a ledger balance looks
// wrong. Logged to ledger_disputes for a human to review and resolve.
const DISPUTE_PREFIX_RE = /^dispute\b[:\s]*(.*)$/i;

// ---------------------------------------------------------------------------
// Pending debt-name clarification — a DEBT is the one entry type where a
// missing customer name genuinely hurts later: settlement ("Chidi paid")
// has to resolve back to the same person, and an auto-generated
// anonymous code (Cust-XXXX) is honest but nearly impossible for a
// merchant to reconcile against a real face weeks later. So instead of
// silently recording a nameless debt, Kika asks ONE deterministic
// question ("Who owes this?") and holds the fully-validated entry in
// Redis for a short window. The merchant can reply with a name, reply
// SKIP to record it anonymously, or just move on — any non-name message
// records the held debt anonymously first (never lost) and then
// processes normally. CREDIT/DEBIT never trigger this: there's nothing
// to reconcile later, so a name is optional noise.
// ---------------------------------------------------------------------------

const PENDING_DEBT_NAME_TTL_SECONDS = 15 * 60;
const pendingDebtNameKey = (merchantId) => `kika:pendingdebtname:${merchantId}`;
const PENDING_NAME_LIKE_RE = /^[A-Za-z][A-Za-z' -]{0,59}$/;
const PENDING_SKIP_WORDS = new Set(['skip', 'no', 'none', 'nobody', 'no name', 'idk', "i don't know", 'i dont know']);

async function stashPendingDebtAndAskName({ merchant, whatsappNumber, entry, rawMessage, whatsappMessageId, replyToWhatsappMessageId, source }) {
  await connection.set(
    pendingDebtNameKey(merchant.id),
    JSON.stringify({ entry, rawMessage, whatsappMessageId, replyToWhatsappMessageId, source }),
    'EX',
    PENDING_DEBT_NAME_TTL_SECONDS
  );
  await whatsappService.sendTextMessage(
    whatsappNumber,
    `Got it \u2014 \u20a6${(entry.balanceKobo / 100).toLocaleString('en-NG')} owed on *${entry.description}*. Who owes this? Reply with the customer's name so you can track it, or reply *SKIP* to save it without a name.`
  );
}

/**
 * Consumes a merchant's reply while a debt-name question is pending.
 * Returns true if the inbound message was fully handled here (a name or
 * SKIP), false if the message should continue through the normal
 * pipeline (in which case the held debt has ALREADY been committed
 * anonymously — it is never dropped).
 */
async function handlePendingDebtNameReply(merchant, whatsappNumber, rawMessage, job) {
  const raw = await connection.get(pendingDebtNameKey(merchant.id));
  if (!raw) return false;

  let pending;
  try {
    pending = JSON.parse(raw);
  } catch {
    await connection.del(pendingDebtNameKey(merchant.id));
    return false;
  }
  await connection.del(pendingDebtNameKey(merchant.id));

  const text = rawMessage.trim();
  const lower = text.toLowerCase();
  const isSkip = PENDING_SKIP_WORDS.has(lower);
  const looksLikeName =
    !isSkip &&
    PENDING_NAME_LIKE_RE.test(text) &&
    text.split(/\s+/).length <= 4 &&
    !ledgerParser.detectCommand(text) &&
    !ledgerParser.classifyEntryType(lower);

  if (looksLikeName) pending.entry.counterpartyName = text;
  // else: name stays null -> ledgerService generates an anonymous code.

  await commitParsedEntry({
    job,
    merchant,
    whatsappNumber,
    entry: pending.entry,
    rawMessage: pending.rawMessage,
    whatsappMessageId: pending.whatsappMessageId,
    replyToWhatsappMessageId: pending.replyToWhatsappMessageId,
    source: `${pending.source}+name-reply`,
  });

  // A name or an explicit SKIP was the whole message — done. Anything
  // else (a command, a brand-new transaction) still needs its own
  // processing after the held debt was committed above.
  return looksLikeName || isSkip;
}

/**
 * The single commit path every successfully-validated entry goes
 * through, regardless of which extractor produced it (regex front door,
 * Gemini escalation, degraded regex, reply-context, or a debt-name
 * follow-up). Records the entry, sends the per-entry ack (see
 * ENTRY_ACK_TEXT below), wires up the outbound wamid for future
 * reply-context resolution, and surfaces any operational alerts.
 */
async function commitParsedEntry({ job, merchant, whatsappNumber, entry, rawMessage, whatsappMessageId, replyToWhatsappMessageId, source }) {
  // The AI path classifies DEBIT expenses itself; the regex path never
  // does — backfill via the same keyword/AI classifier either way.
  if (entry.entryType === 'DEBIT' && !entry.expenseCategory) {
    entry.expenseCategory = await categorizationService.categorizeExpense(entry.description, entry.items?.[0]?.name);
  }

  await auditLogService.logEvent({
    merchantId: merchant.id,
    actorType: 'MERCHANT',
    actorId: whatsappNumber,
    action: 'ledger_entry.parsed',
    metadata: { source, entryType: entry.entryType },
  });

  // This transaction is now fully resolved and committed to Postgres —
  // the source of truth from here on. Any earlier clarifying-question
  // exchange still sitting in conversation memory is now stale and, if
  // left there, could wrongly bleed into a LATER, unrelated message.
  // Clearing here covers every path uniformly — regex, reply-context,
  // and AI alike.
  await conversationMemory.clearHistory(merchant.id);

  const { ledgerEntry, loyaltyMilestoneText, lowStockAlerts } = await ledgerService.recordLedgerEntryAndReceipt({
    merchant,
    parsedEntry: entry,
    rawMessage,
    whatsappMessageId,
    replyToWhatsappMessageId,
  });

  // Per-entry acknowledgment — evaluated three options here: (1) send
  // nothing after the first entry in a run and only speak again at
  // DONE, (2) the invoice-flow pattern of a short constant text after
  // EVERY entry, (3) same as (1). Went with (2), for a reason that's
  // not just tone: reply-context resolution (see
  // getLedgerEntryByOutboundMessageId / businessContextService's
  // "Reply context" block) depends on THIS message's outbound wamid
  // being attached to THIS specific entry, so a merchant tapping
  // "Reply" on entry #2 of a five-in-a-row batch resolves back to
  // entry #2, not whichever entry happened to be last. Option (1) would
  // only ever produce one outbound message per batch, silently breaking
  // reply-context for every entry after the first. Sending the same
  // short line every time isn't the noisy "full description per entry"
  // problem this used to avoid with a bare checkmark — it's one stable,
  // constant prompt (not a repeated narrative), and the full "here's
  // what you logged" description is still deferred to the ONE
  // consolidated summary at DONE (buildBatchConfirmationText below).
  const ENTRY_ACK_TEXT = 'Noted \u2014 log another, or type DONE when finished.';
  logger.info({ jobId: job.id }, 'WORKER_SENDING_WHATSAPP_REPLY');
  const sendResult = await whatsappService.sendTextMessage(whatsappNumber, ENTRY_ACK_TEXT);

  const outboundMessageId = whatsappService.extractOutboundMessageId(sendResult);
  if (ledgerEntry?.id && outboundMessageId) {
    await queries.setLedgerEntryOutboundMessageId(ledgerEntry.id, outboundMessageId);
  }

  // Low-stock warnings and loyalty milestones are urgent/operational,
  // not part of the "here's what you logged" narrative — they still
  // surface immediately rather than waiting for DONE.
  for (const alert of lowStockAlerts || []) {
    await whatsappService.sendTextMessage(whatsappNumber, alert);
  }
  if (loyaltyMilestoneText) {
    await whatsappService.sendTextMessage(whatsappNumber, loyaltyMilestoneText.trim());
  }
}

/**
 * kika-ledger-processing — routes onboarding first, then resolves
 * multimodal content, tries the fast regex parser, falls back to the AI
 * classifier only when regex can't make sense of the message, generates
 * a receipt, and pushes it back out over WhatsApp.
 */
const ledgerWorker = new Worker(
  'kika-ledger-processing',
  async (job) => {
    logger.info({ jobId: job.id, data: job.data }, 'WORKER_RECEIVED_JOB');

    const { merchantId, whatsappNumber, whatsappMessageId, replyToWhatsappMessageId } = job.data;
    const merchant = await queries.getMerchantById(merchantId);
    if (!merchant) return;

    // Onboarding gate — nothing else runs until this merchant has
    // accepted terms AND provided a business name.
    if (ONBOARDING_GATE_STATES.includes(merchant.onboarding_state)) {
      await handleOnboarding(merchant, whatsappNumber, job.data);
      return;
    }

    // Belt-and-suspenders duplicate-transaction guard: the webhook's
    // Redis idempotency lock (48h TTL — see idempotencyService.js and
    // whatsapp.routes.js) is the primary defense against ever getting
    // here twice for the same wamid. This is the permanent, TTL-free
    // backstop — e.g. a delayed BullMQ retry landing after the Redis
    // lock already expired.
    if (whatsappMessageId) {
      const alreadyRecorded = await queries.getLedgerEntryByWhatsappMessageId(merchantId, whatsappMessageId);
      if (alreadyRecorded) {
        logger.warn({ whatsappMessageId, ledgerEntryId: alreadyRecorded.id }, 'Duplicate WhatsApp message id — entry already recorded, skipping');
        return;
      }
    }

    // Reply-context resolution: if this message is a WhatsApp reply,
    // look up the ledger entry Kika's own earlier message (the one
    // being replied to) was about — see queries.
    // getLedgerEntryByOutboundMessageId and the long comment on
    // ledgerService/businessContextService for how this is used below.
    const replyEntry = replyToWhatsappMessageId
      ? await queries.getLedgerEntryByOutboundMessageId(merchantId, replyToWhatsappMessageId)
      : null;

    const { text: rawMessage, imageBase64, mediaError } = await resolveInboundContent(job);

    if (mediaError) {
      await whatsappService.sendTextMessage(
        whatsappNumber,
        "I couldn't process that file — could you resend it, or type the details instead?"
      );
      return;
    }

    // In-progress NPS survey, email-collection reply, invoice creation,
    // or a pending receipt yes/no takes priority over everything else —
    // a bare "8", an email address, an invoice item line, or "yes"/"no"
    // should never be mistaken for a transaction attempt or sent to the
    // AI fallback. All of these are plain deterministic state machines,
    // not AI-assisted, on purpose.
    if (job.data.mediaType === 'text' && rawMessage) {
      // A pending "who owes this?" question outranks everything below:
      // the merchant's very next text is most plausibly the answer. If
      // it ISN'T a name (a command, a new transaction), the held debt
      // is committed anonymously inside the handler and this message
      // falls through to normal processing — the debt is never lost.
      const consumedByPendingDebtName = await handlePendingDebtNameReply(merchant, whatsappNumber, rawMessage, job);
      if (consumedByPendingDebtName) return;

      if (merchant.nps_awaiting_stage) {
        const reply = await engagementService.handleNpsReply(merchant, rawMessage);
        if (reply) await whatsappService.sendTextMessage(whatsappNumber, reply);
        return;
      }
      if (merchant.email_collection_awaiting_stage) {
        const reply = await engagementService.handleEmailCollectionReply(merchant, rawMessage);
        if (reply) await whatsappService.sendTextMessage(whatsappNumber, reply);
        return;
      }
      if (merchant.invoice_awaiting_stage === 'ITEMS') {
        await handleInvoiceItemsReply(merchant, whatsappNumber, rawMessage);
        return;
      }
      if (merchant.invoice_awaiting_stage === 'CONFIRM') {
        await handleInvoiceConfirmReply(merchant, whatsappNumber, rawMessage);
        return;
      }
      if (merchant.receipt_decision_awaiting) {
        await handleReceiptDecisionReply(merchant, whatsappNumber, rawMessage);
        return;
      }
    }

    // A merchant introducing themselves by name ("I'm Samuel") is stored
    // on merchant_name — deliberately separate from whatsapp_display_name
    // (Meta's own contact metadata, captured automatically on every
    // message) and business_name. See ledgerParser.extractSelfIntroduction
    // and buildTimeAwareGreeting, which prefers this name once known.
    // Detected on every text message (cheap regex, no AI), not just a
    // dedicated onboarding step — a merchant might introduce themselves
    // at any point in the conversation.
    if (job.data.mediaType === 'text' && rawMessage) {
      const introducedName = ledgerParser.extractSelfIntroduction(rawMessage);
      if (introducedName && introducedName !== merchant.merchant_name) {
        await queries.setMerchantName(merchantId, introducedName);
        merchant.merchant_name = introducedName; // keep this job's in-memory copy current for the greeting below
        // A short message that's basically JUST the introduction gets a
        // warm standalone acknowledgement instead of falling through to
        // "I didn't understand that" — anything longer (introduction
        // embedded in a longer message) is stored silently and normal
        // processing continues below.
        if (rawMessage.trim().length <= introducedName.length + 20) {
          await whatsappService.sendTextMessage(whatsappNumber, `Nice to meet you, ${introducedName}! I'll remember that.`);
          return;
        }
      }
    }

    const command = ledgerParser.detectCommand(rawMessage);

    if (command === 'GREETING') {
      await whatsappService.sendTextMessage(whatsappNumber, buildTimeAwareGreeting(merchant));
      return;
    }

    if (command === 'HELP') {
      await whatsappService.sendTextMessage(
        whatsappNumber,
        'Hi! Send me things like:\n"sold rice 5000"\n"Mama Tunde buy 3 carton indomie, she pay 15k remain 12k"\n"Chidi owes 2000"\n"John pay off his debt 5k"\n\nAfter logging, type *DONE* and I\'ll ask if you want a receipt \u2014 works for one entry or several in a row.\n\nWant an invoice for a customer instead? Just say "new invoice for <name>".\n\nYou can also send a voice note or a photo of a receipt/handwritten note.\n\nTip: include a customer\'s phone number (e.g. "Mama Tunde 08012345678 buy...") to enable loyalty milestone tracking.\n\nCommands: BALANCE, SUNSET, INSIGHTS, DISPUTE <reason>, INVOICE <amount>, ADD STOCK: <item>, <qty>, UNDO, CLOSING HOUR <hour>, EXPORT, UPGRADE.\n\nNeed a human? support@kikahq.com'
      );
      return;
    }

    if (command === 'DONE') {
      // Outside any active flow, DONE is what closes a regular logging
      // session and asks "want a receipt for what you logged?" — see
      // askReceiptDecision. (DONE while INSIDE the invoice-items flow is
      // handled earlier, at the interrupt-priority checks above, since
      // it means something different there — finishing item entry, not
      // asking about a receipt.)
      await askReceiptDecision(merchant, whatsappNumber);
      return;
    }

    const newInvoiceTrigger = ledgerParser.parseNewInvoiceTrigger(rawMessage);
    if (newInvoiceTrigger) {
      await startInvoiceCreation(merchant, whatsappNumber, newInvoiceTrigger.customerName);
      return;
    }

    if (command === 'BALANCE') {
      const summary = await ledgerService.buildBalanceSummaryText(merchantId);
      await whatsappService.sendTextMessage(whatsappNumber, summary);
      return;
    }

    if (command === 'SUNSET') {
      const dayStart = startOfDay(new Date());
      const dayEnd = addDays(dayStart, 1);
      const report = await ledgerService.buildDailySunsetReportText(merchantId, dayStart, dayEnd);
      await whatsappService.sendTextMessage(whatsappNumber, report);
      return;
    }

    if (command === 'INSIGHTS') {
      const monthStart = startOfMonth(new Date());
      const monthEnd = addMonths(monthStart, 1);
      const prevMonthStart = addMonths(monthStart, -1);
      const report = await ledgerService.buildMonthlyInsightsReportText(merchantId, monthStart, monthEnd, prevMonthStart, monthStart);
      await whatsappService.sendTextMessage(whatsappNumber, report);
      return;
    }

    // TESTDIGEST — dev/QA utility. Regenerates and sends THIS merchant's
    // current-month digest card + full report on demand, bypassing the
    // real scheduled flow's Premium-only gate and "active this month"
    // requirement. Calls the generation services directly rather than
    // going through report_dispatch_log, so it never marks the real
    // monthly send as already-delivered — running this doesn't affect
    // whether the actual 1st-of-month job fires normally later.
    if (command === 'TESTDIGEST') {
      const now = new Date();
      const monthStart = startOfMonth(now);
      const monthEnd = addMonths(monthStart, 1);
      const prevMonthStart = addMonths(monthStart, -1);
      const periodKey = monthKey(monthStart); // digest_cards/monthly_reports upsert on (merchant_id, period_key), so repeat test runs just update the same row — safe and keeps within the VARCHAR(10) column

      try {
        const digestSummary = await ledgerService.buildMonthlyDigestSummary(merchantId, monthStart, monthEnd, prevMonthStart);
        logger.info({ merchantId, digestSummary }, 'TESTDIGEST summary');

        const digestCard = await monthlyDigestService.generateDigestCard({ merchant, periodKey, ...digestSummary });
        const { reportUrl, snapshot } = await fullReportService.generateFullReport({ merchant, periodKey, monthStart, monthEnd, prevMonthStart });
        logger.info({ merchantId, snapshot }, 'TESTDIGEST full report snapshot');

        await whatsappService.sendTextMessage(
          whatsappNumber,
          `*Test Digest* (this month so far, not the real monthly send)\n\nMoney Inflow: \u20a6${(digestSummary.moneyInflowKobo / 100).toLocaleString('en-NG')}\nOutstanding: \u20a6${(digestSummary.outstandingKobo / 100).toLocaleString('en-NG')}\nTrade Days: ${digestSummary.tradeDays}\nTop Debtor: ${digestSummary.topDebtor?.counterparty_name || 'None'}`
        );
        await whatsappService.sendMonthlyDigestCard(whatsappNumber, {
          imageUrl: digestCard.url,
          bodyText: 'Test digest card \u2014 this is what your real Monthly Digest will look like.',
          reportUrl,
        });
      } catch (err) {
        logger.error({ err: err.message, merchantId }, 'TESTDIGEST failed');
        await whatsappService.sendTextMessage(whatsappNumber, `TESTDIGEST failed: ${err.message}`);
      }
      return;
    }

    if (command === 'UPGRADE') {
      const highestTier = await queries.getHighestActiveSubscriptionTier();
      if (highestTier && merchant.plan.toLowerCase() === highestTier.name.toLowerCase()) {
        await whatsappService.sendTextMessage(
          whatsappNumber,
          `You're already on *${merchant.plan}* \u2014 the full Kika experience! There's no higher tier to upgrade to right now. Type BALANCE or HELP if you need anything.`
        );
        return;
      }

      const tiers = await queries.listActiveSubscriptionTiers();
      const paidTiers = tiers.filter((t) => Number(t.price) > 0 && t.name.toLowerCase() !== merchant.plan.toLowerCase());
      const featureLines = paidTiers
        .map((t) => {
          const monthly = `${t.currency} ${Number(t.price).toLocaleString('en-NG')}/mo`;
          // Guard against a tier row where price_yearly is missing, zero,
          // or otherwise not a usable number (e.g. a custom tier added
          // without setting it) — fall back to the standard 10x-monthly
          // (2-months-free) rate rather than ever displaying "NaN/yr".
          const yearlyMajorUnits = Number(t.price_yearly) > 0 ? Number(t.price_yearly) : Number(t.price) * 10;
          const yearly = `${t.currency} ${yearlyMajorUnits.toLocaleString('en-NG')}/yr`;
          return `\n*${t.name}* \u2014 ${monthly} (or ${yearly}):\n${(t.feature_list || []).map((f) => `\u2022 ${f}`).join('\n')}`;
        })
        .join('\n');
      await whatsappService.sendTextMessage(
        whatsappNumber,
        `*Let's upgrade your business profile!*\n${featureLines}\n\nTap a plan below for the monthly price, or type "STANDARD YEARLY" / "PREMIUM YEARLY" to pay yearly`
      );
      await whatsappService.sendPlanSelectionButtons(
        whatsappNumber,
        paidTiers.map((t) => ({ id: t.name.toUpperCase(), title: `${t.name} - ${t.currency} ${Number(t.price).toLocaleString('en-NG')}` }))
      );
      return;
    }

    if (command === 'STANDARD' || command === 'PREMIUM' || command === 'STANDARD_YEARLY' || command === 'PREMIUM_YEARLY') {
      const highestTier = await queries.getHighestActiveSubscriptionTier();
      if (highestTier && merchant.plan.toLowerCase() === highestTier.name.toLowerCase()) {
        await whatsappService.sendTextMessage(
          whatsappNumber,
          `You're already on *${merchant.plan}* \u2014 the full Kika experience! There's no higher tier to upgrade to right now.`
        );
        return;
      }
      const isYearly = command.endsWith('_YEARLY');
      const tierName = isYearly ? command.replace('_YEARLY', '') : command;
      await handleTierPurchase(merchant, whatsappNumber, tierName, isYearly ? 'yearly' : 'monthly');
      return;
    }

    if (command === 'UNDO') {
      const entry = await queries.getMostRecentLedgerEntry(merchantId);
      if (!entry) {
        await whatsappService.sendTextMessage(whatsappNumber, "You don't have any recent entries to undo yet.");
        return;
      }
      if (entry.entry_type === 'DEBT_SETTLEMENT') {
        await whatsappService.sendTextMessage(
          whatsappNumber,
          "Your most recent entry was a debt payment, which touches multiple records — I can't auto-undo that safely. Type DISPUTE <reason> and our team will help fix it."
        );
        return;
      }

      const amountLabel = `\u20a6${(Number(entry.total_kobo) / 100).toLocaleString('en-NG')}`;
      await whatsappService.sendButtonMessage(whatsappNumber, {
        bodyText: `Just to confirm \u2014 you want to undo this entry?\n\n*${entry.description}*${entry.counterparty_name ? ` (${entry.counterparty_name})` : ''}\nAmount: ${amountLabel}\nRecorded: ${new Date(entry.created_at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}`,
        buttons: [
          { id: `UNDO_CONFIRM:${entry.id}`, title: 'Yes, Undo' },
          { id: 'UNDO_CANCEL', title: 'Cancel' },
        ],
      });
      return;
    }

    if (rawMessage === 'UNDO_CANCEL') {
      await whatsappService.sendTextMessage(whatsappNumber, "Got it \u2014 your last entry is still untouched.");
      return;
    }

    if (rawMessage.startsWith('UNDO_CONFIRM:')) {
      const entryId = rawMessage.slice('UNDO_CONFIRM:'.length);
      const result = await queries.voidLedgerEntryById(merchantId, entryId);
      if (result.reason === 'NO_ENTRY') {
        await whatsappService.sendTextMessage(whatsappNumber, "That entry is no longer available to undo \u2014 it may have already been changed.");
      } else if (result.reason === 'SETTLEMENT_NOT_UNDOABLE') {
        await whatsappService.sendTextMessage(
          whatsappNumber,
          "That entry was a debt payment, which touches multiple records — I can't auto-undo that safely. Type DISPUTE <reason> and our team will help fix it."
        );
      } else {
        await auditLogService.logEvent({ merchantId, actorType: 'MERCHANT', actorId: whatsappNumber, action: 'ledger_entry.void', metadata: { ledgerEntryId: result.entry.id } });
        await whatsappService.sendTextMessage(
          whatsappNumber,
          `Transaction cancelled! Kika has deleted your last entry: '${result.entry.raw_message || result.entry.description}' from your sales records. Your balance and stock levels have been restored safely. Type your fresh entry whenever you're ready!`
        );
      }
      return;
    }

    if (command === 'EXPORT') {
      if (merchant.plan.toUpperCase() === 'FREE') {
        await whatsappService.sendTextMessage(whatsappNumber, 'Data export is a Standard/Premium feature. Type UPGRADE to unlock it!');
        return;
      }
      const { downloadUrl, rowCount } = await exportService.generateLedgerCsvExport(merchant);
      await whatsappService.sendDocument(whatsappNumber, {
        link: downloadUrl,
        filename: 'kika_ledger_export.csv',
        caption: `Export complete! ${rowCount} transaction${rowCount === 1 ? '' : 's'} included.`,
      });
      await auditLogService.logEvent({ merchantId, actorType: 'MERCHANT', actorId: whatsappNumber, action: 'export.generated', metadata: { rowCount } });
      return;
    }

    if (command === 'REVIEW_SCAN') {
      const cached = await connection.get(`kika:lastscan:${merchantId}`);
      if (!cached) {
        await whatsappService.sendTextMessage(whatsappNumber, "I don't have a recent scan to review. Send a photo of your logbook page first.");
        return;
      }
      const lines = JSON.parse(cached);
      await whatsappService.sendTextMessage(whatsappNumber, lines.join('\n'));
      return;
    }

    if (rawMessage === 'AMNESTY_SKIP') {
      await whatsappService.sendTextMessage(whatsappNumber, 'No problem \u2014 maybe next Friday!');
      return;
    }

    if (rawMessage === 'AMNESTY_SEND') {
      const debtors = await queries.getOutstandingDebtorsWithPhones(merchantId);
      const messagable = debtors.filter((d) => d.counterparty_phone);
      let sentCount = 0;
      for (const debtor of messagable) {
        try {
          await whatsappService.sendTextMessage(
            debtor.counterparty_phone,
            `Happy weekend! Just a gentle automated update from ${merchant.business_name || 'us'} regarding our pending balance of \u20a6${(Number(debtor.balance_kobo) / 100).toLocaleString('en-NG')}. Wishing you a blessed weekend ahead!`
          );
          sentCount++;
        } catch (err) {
          logger.error({ err: err.message, debtor: debtor.counterparty_name }, 'Amnesty reminder send failed');
        }
      }
      await auditLogService.logEvent({ merchantId, actorType: 'MERCHANT', actorId: whatsappNumber, action: 'friday_amnesty.sent', metadata: { sentCount, totalDebtors: debtors.length } });
      const skippedCount = debtors.length - messagable.length;
      await whatsappService.sendTextMessage(
        whatsappNumber,
        `Sent polite reminders to ${sentCount} customer${sentCount === 1 ? '' : 's'}!${skippedCount > 0 ? ` (${skippedCount} skipped \u2014 no phone number on file.)` : ''}`
      );
      return;
    }

    const closingHourParsed = ledgerParser.parseClosingHourCommand(rawMessage);
    if (closingHourParsed) {
      await queries.setMerchantClosingHour(merchantId, closingHourParsed.hour);
      await whatsappService.sendTextMessage(
        whatsappNumber,
        `Got it! Your daily Business Sunset recap will now arrive around *${String(closingHourParsed.hour).padStart(2, '0')}:00* (Nigeria time) every day you record a sale.`
      );
      return;
    }

    const addStockParsed = ledgerParser.parseAddStockCommand(rawMessage);
    if (addStockParsed) {
      const product = await queries.addProductStock(merchantId, addStockParsed.productName, addStockParsed.quantity, addStockParsed.unit);
      await whatsappService.sendTextMessage(
        whatsappNumber,
        `Stock updated! *${product.name}* now has *${product.current_stock} ${product.unit || 'units'}* in stock.`
      );
      return;
    }

    const disputeMatch = rawMessage.match(DISPUTE_PREFIX_RE);
    if (disputeMatch) {
      const reason = disputeMatch[1]?.trim() || 'No reason provided';
      const dispute = await queries.createLedgerDispute({ merchantId, raisedBy: 'MERCHANT', reason });
      await auditLogService.logEvent({ merchantId, actorType: 'MERCHANT', actorId: whatsappNumber, action: 'dispute.create', metadata: { disputeId: dispute.id, reason } });
      await whatsappService.sendTextMessage(whatsappNumber, `Got it \u2014 I've logged this for review (ref: ${dispute.id.slice(0, 8).toUpperCase()}). Our team will look into it. Need to reach us directly? support@kikahq.com`);
      return;
    }

    const invoiceParsed = ledgerParser.parseInvoiceCommand(rawMessage);
    if (invoiceParsed) {
      // Same policy as the multi-item flow above — no Paystack, no
      // payment link. If the phone number given is one Kika already
      // recognizes, generate the card immediately; otherwise ask the
      // merchant to use the named format so the invoice isn't sent out
      // with a blank customer name.
      const resolvedName = invoiceParsed.customerPhone
        ? await queries.getCounterpartyNameByPhone(merchantId, invoiceParsed.customerPhone)
        : null;

      if (!resolvedName) {
        await whatsappService.sendTextMessage(
          whatsappNumber,
          `I don't have a name on file for that number yet \u2014 use *"create invoice for <customer name>"* instead, then add "${invoiceParsed.description}" as an item.`
        );
        return;
      }

      const item = {
        name: invoiceParsed.description || 'Item',
        unit: null,
        quantity: 1,
        unitPriceKobo: invoiceParsed.amountKobo,
        totalKobo: invoiceParsed.amountKobo,
      };
      const invoiceNumber = await queries.claimNextInvoiceNumber(merchant.id);
      let card;
      try {
        card = await receiptService.generateInvoiceCard({ merchant, invoiceNumber, customerName: resolvedName, items: [item], totalKobo: item.totalKobo });
      } catch (err) {
        logger.error({ err: err.message, merchantId }, 'One-shot invoice generation failed');
        await whatsappService.sendTextMessage(whatsappNumber, 'Something went wrong generating that invoice \u2014 please try again.');
        return;
      }
      await auditLogService.logEvent({ merchantId, actorType: 'MERCHANT', actorId: whatsappNumber, action: 'invoice.create', metadata: { invoiceNumber, amountKobo: item.totalKobo } });
      await whatsappService.sendReceiptImage(
        whatsappNumber,
        card.url,
        `Here\u2019s the invoice for ${resolvedName} \u2014 you can share this with them. Payment is between you and your customer; once they've paid, just log it here as usual.`
      );
      return;
    }

    // Logo upload — a short window right after a fresh Premium purchase
    // where the next image is treated as a business logo, not a scan.
    if (job.data.mediaType === 'image' && merchant.awaiting_logo_until && new Date(merchant.awaiting_logo_until) > new Date()) {
      try {
        const logoPath = await mediaService.saveWhatsappImageAsMerchantLogo(job.data.mediaId, merchantId);
        await queries.setMerchantLogo(merchantId, logoPath);
        await whatsappService.sendTextMessage(whatsappNumber, 'Logo saved! Your next receipt will carry your new brand look.');
      } catch (err) {
        logger.error({ err: err.message }, 'Logo save failed');
        await whatsappService.sendTextMessage(whatsappNumber, "I couldn't save that image as your logo — please try resending it.");
      }
      return;
    }

    // Premium Image/Photo Scan Capture — a photographed logbook page
    // usually has MANY transactions, so Premium merchants get the batch
    // OCR pipeline instead of the single-transaction hybrid fallback.
    if (job.data.mediaType === 'image' && imageBase64 && merchant.plan.toUpperCase() === 'PREMIUM') {
      await whatsappService.sendTextMessage(whatsappNumber, 'Image received! Kika AI is scanning your handwritten logbook page now. Please hold on...');
      const { transactions, error: scanError } = await aiTransactionParser.parseMultiTransactionImage(imageBase64);

      if (scanError) {
        await whatsappService.sendTextMessage(whatsappNumber, AI_ERROR_FALLBACK_REPLY);
        return;
      }
      if (transactions.length === 0) {
        await whatsappService.sendTextMessage(whatsappNumber, "I couldn't clearly read any transactions on that page. Could you resend a clearer photo, or type the entries instead?");
        return;
      }

      let totalInflowKobo = 0;
      let debtCount = 0;
      let rejectedLines = 0;
      const itemLines = [];
      for (const candidate of transactions) {
        // Same trust boundary as the single-message path: every AI-read
        // line passes the deterministic accounting engine or is skipped
        // (skipping a misread line beats writing a wrong number).
        const verdict = entryValidator.validateAndFinalizeEntry(candidate, { source: 'ai-scan' });
        if (!verdict.ok) {
          rejectedLines += 1;
          logger.warn({ reason: verdict.reason }, 'Scanned logbook line rejected by validator — skipped');
          continue;
        }
        const t = verdict.entry;
        await queries.withTransaction(async (client) => {
          let balanceAfterKobo = null;
          if (t.entryType === 'DEBT' && t.counterpartyName) {
            await queries.lockCustomerBalance(client, merchantId, t.counterpartyName);
            const updated = await queries.applyCustomerBalanceDelta(client, merchantId, t.counterpartyName, t.balanceKobo);
            balanceAfterKobo = Number(updated.rolling_balance_kobo);
          }
          return queries.createLedgerEntry(client, { merchantId, ...t, balanceAfterKobo, rawMessage: '[logbook scan]' });
        });
        if (t.entryType === 'CREDIT') totalInflowKobo += t.paidKobo;
        if (t.entryType === 'DEBT') debtCount += 1;
        itemLines.push(`\u2022 ${t.description} \u2014 \u20a6${(t.totalKobo / 100).toLocaleString('en-NG')}`);
      }

      if (itemLines.length === 0) {
        await whatsappService.sendTextMessage(whatsappNumber, "I couldn't read any line on that page clearly enough to record safely. Could you resend a clearer photo, or type the entries instead?");
        return;
      }

      await connection.set(`kika:lastscan:${merchantId}`, JSON.stringify(itemLines), 'EX', 3600);
      await auditLogService.logEvent({ merchantId, actorType: 'MERCHANT', actorId: whatsappNumber, action: 'logbook_scan.completed', metadata: { recorded: itemLines.length, rejected: rejectedLines } });

      await whatsappService.sendTextMessage(
        whatsappNumber,
        `Scan complete! Kika AI recorded *${itemLines.length} transaction${itemLines.length === 1 ? '' : 's'}* from your paper log sheet.${rejectedLines > 0 ? `\n(${rejectedLines} line${rejectedLines === 1 ? '' : 's'} couldn't be read clearly enough to record safely \u2014 you can type ${rejectedLines === 1 ? 'it' : 'them'} in manually.)` : ''}\n\n*Quick Summary:*\nTotal Inflows: \u20a6${(totalInflowKobo / 100).toLocaleString('en-NG')}\nDebts Logged: ${debtCount} profile${debtCount === 1 ? '' : 's'} updated.\n\nTo review the individual breakdown lines, reply with: *REVIEW SCAN*`
      );
      return;
    }

    // ========================================================================
    // Free-text transaction pipeline — the layered front door:
    //
    //   Stage 1  reply-context resolution (deterministic, regex)
    //   Stage 2  regex front door + confidence gate  (~80-90% of traffic
    //            ends here: no AI call, no AI cost, instant)
    //   Stage 3  Gemini escalation (the honest path for the ~10-20% the
    //            gate flags: Pidgin/other languages, ambiguity,
    //            corrections, questions, images) — extraction only,
    //            schema-validated, confidence-gated
    //   Stage 4  degraded regex fallback (ONLY if the Gemini call itself
    //            failed AND the regex parse cleared the lower floor)
    //   Stage 5  entryValidator — the deterministic accounting engine
    //            every surviving candidate must pass before any write
    //   Stage 6  debt-name clarification, then commit
    // ========================================================================

    let parsed = null;
    let source = null;
    let regexScored = null;
    let aiConversationalReply = null;
    let aiDetectedLanguage = null;
    let aiCallFailed = false;
    let aiAskedClarification = null;

    // --- Stage 1: a WhatsApp reply of "he paid" / "she don pay 3k" on a
    // debt receipt is fully unambiguous once resolved against the entry
    // being replied to — no scoring or AI needed.
    const replyParsed = ledgerParser.parseReplyMessage(rawMessage, replyEntry);
    if (replyParsed) {
      parsed = replyParsed;
      source = 'regex-reply';
    }

    // --- Stage 2: regex front door with the confidence gate. Skipped
    // entirely for image messages — the transaction may be IN the image,
    // which regex cannot see, so those always escalate.
    if (!parsed && !imageBase64) {
      regexScored = ledgerParser.parseLedgerMessageScored(rawMessage);
      if (regexScored.confident) {
        parsed = regexScored.parsed;
        source = 'regex';
      }
    }

    // --- Stage 3: honest escalation to Gemini for everything the gate
    // didn't trust (or couldn't parse at all, or that carries an image).
    if (!parsed) {
      await auditLogService.logEvent({
        merchantId,
        actorType: 'MERCHANT',
        actorId: whatsappNumber,
        action: 'message.escalated_to_ai',
        metadata: {
          regexConfidence: regexScored?.confidence ?? null,
          regexSignals: regexScored?.signals ?? (imageBase64 ? ['image_message'] : ['no_parse']),
          hadImage: !!imageBase64,
        },
      });
      logger.info({ jobId: job.id, regexConfidence: regexScored?.confidence ?? null }, 'WORKER_STARTING_AI_CALL');
      const aiResult = await aiTransactionParser.parseWithAI(merchant, rawMessage, { imageBase64, replyEntry });

      if (aiResult.parsed) {
        parsed = aiResult.parsed;
        source = 'ai';
        aiDetectedLanguage = aiResult.detectedLanguage;
      } else if (aiResult.conversationalReply) {
        // Covers BOTH "genuinely not a transaction" and "transaction is
        // missing a required detail" — in the latter case the model's
        // own reply is the clarifying question itself (see aiPersona's
        // tool-calling rules), which we forward verbatim.
        aiConversationalReply = aiResult.conversationalReply;
      } else if (aiResult.lowConfidence) {
        // Schema-valid extraction, but the model's own confidence was
        // below AI_MIN_CONFIDENCE_THRESHOLD (or the payload failed the
        // Zod schema outright) — per policy, ask instead of guessing.
        aiAskedClarification = aiResult.clarify || null;
        aiDetectedLanguage = aiResult.detectedLanguage;
      } else if (aiResult.error) {
        aiCallFailed = true;
      }

      // --- Stage 4: degraded mode. ONLY reached when the AI call itself
      // failed outright (network error, provider outage, exhausted
      // quota) — never when the AI validly declined or asked to clarify.
      // The regex candidate from Stage 2 is reused if it cleared the
      // lower REGEX_DEGRADED_FLOOR; a Gemini outage thus degrades Kika
      // to "less smart about tricky phrasing" instead of unusable.
      if (!parsed && aiCallFailed) {
        if (regexScored?.usableInDegradedMode) {
          logger.warn({ jobId: job.id, confidence: regexScored.confidence }, 'AI call failed — using degraded-mode regex parse');
          parsed = regexScored.parsed;
          source = 'regex-degraded';
        } else {
          logger.warn({ jobId: job.id }, 'AI call failed and no degraded-mode regex parse available');
        }
      }
    }

    if (!parsed) {
      await auditLogService.logEvent({
        merchantId,
        actorType: 'MERCHANT',
        actorId: whatsappNumber,
        action: 'message.unparsed',
        metadata: { rawMessage, hadImage: !!imageBase64, aiCallFailed, aiLowConfidence: !!aiAskedClarification || undefined },
      });
      logger.info({ jobId: job.id }, 'WORKER_SENDING_WHATSAPP_REPLY');
      await whatsappService.sendTextMessage(
        whatsappNumber,
        aiConversationalReply || aiAskedClarification || (aiCallFailed ? AI_ERROR_FALLBACK_REPLY : getFallbackReply(aiDetectedLanguage))
      );
      return;
    }

    // --- Stage 5: the deterministic accounting engine. EVERY candidate —
    // regex or Gemini — has its money math recomputed and business rules
    // enforced here. Gemini proposes understanding; this decides.
    const verdict = entryValidator.validateAndFinalizeEntry(parsed, { source });
    if (!verdict.ok) {
      await auditLogService.logEvent({
        merchantId,
        actorType: 'MERCHANT',
        actorId: whatsappNumber,
        action: 'ledger_entry.rejected',
        metadata: { source, reason: verdict.reason, rawMessage },
      });
      logger.info({ jobId: job.id, reason: verdict.reason }, 'Entry rejected by validator — asking merchant to clarify');
      await whatsappService.sendTextMessage(whatsappNumber, getFallbackReply(aiDetectedLanguage));
      return;
    }
    const entry = verdict.entry;

    // --- Stage 6: a DEBT with no customer name is worth one question
    // before it's written — see stashPendingDebtAndAskName for why (and
    // for the guarantees that the held entry is never lost).
    if (entry.entryType === 'DEBT' && !entry.counterpartyName) {
      await stashPendingDebtAndAskName({
        merchant,
        whatsappNumber,
        entry,
        rawMessage,
        whatsappMessageId,
        replyToWhatsappMessageId,
        source,
      });
      return;
    }

    await commitParsedEntry({
      job,
      merchant,
      whatsappNumber,
      entry,
      rawMessage,
      whatsappMessageId,
      replyToWhatsappMessageId,
      source,
    });
  },
  { connection, concurrency: CONCURRENCY }
);

/**
 * kika-webhook-alerts — fires the victory webhook + confirmation message
 * once a Paystack payment is verified and the subscription is extended.
 */
const webhookAlertWorker = new Worker(
  'kika-webhook-alerts',
  async (job) => {
    const { merchantId, paymentReference, amountKobo, planTier } = job.data;
    const merchant = await queries.getMerchantById(merchantId);
    if (!merchant) return;

    await brokerAlertService.fireOnboardingVictoryWebhook({ merchant, paymentReference, amountKobo });

    // Give the merchant a short window to upload a logo — the next
    // image they send gets treated as a brand asset, not a transaction.
    await queries.setAwaitingLogoWindow(merchantId, 10);

    await whatsappService.sendTextMessage(
      merchant.whatsapp_number,
      `*Payment Received! Welcome to Kika ${planTier || 'Premium'}, ${merchant.business_name || 'friend'}!* Your custom brand settings are unlocked for the next 30 days.\n\n*Want to add your logo to your receipts?* Just send your business logo image directly into this chat right now, and Kika will save it automatically!`
    );
  },
  { connection, concurrency: 5 }
);

/**
 * kika-scheduled-reports — every repeatable cron tick registered by
 * scheduler.js.
 */
const scheduledReportsWorker = new Worker(
  'kika-scheduled-reports',
  async (job) => {
    if (job.name === 'daily-sunset-tick') {
      const currentHour = currentLagosHour();
      const dayStart = startOfDay(new Date());
      const dayEnd = addDays(dayStart, 1);
      const periodKey = dayKey(dayStart);

      const merchantsThisHour = await queries.getMerchantsWithClosingHour(currentHour);
      for (const merchant of merchantsThisHour) {
        const alreadySent = await queries.hasReportBeenSent(merchant.id, 'DAILY_SUNSET', periodKey);
        if (alreadySent) continue;

        const summary = await queries.getPeriodSummary(merchant.id, dayStart, dayEnd);
        if (Number(summary.entry_count) === 0) continue; // no activity today — nothing to recap

        const report = await ledgerService.buildDailySunsetReportText(merchant.id, dayStart, dayEnd);
        await whatsappService.sendTextMessage(merchant.whatsapp_number, report);
        await queries.markReportSent(merchant.id, 'DAILY_SUNSET', periodKey);
      }
      return;
    }

    if (job.name === 'monthly-insights-tick') {
      const now = new Date();
      const monthStart = startOfMonth(addMonths(now, -1));
      const monthEnd = addMonths(monthStart, 1);
      const prevMonthStart = addMonths(monthStart, -1);
      const periodKey = monthKey(monthStart);

      const merchants = await queries.listMerchantsActiveSince(monthStart, monthEnd);
      logger.info({ count: merchants.length, periodKey }, 'Dispatching Monthly reports');

      for (const merchant of merchants) {
        if (merchant.plan.toUpperCase() === 'PREMIUM') {
          const alreadySent = await queries.hasReportBeenSent(merchant.id, 'MONTHLY_DIGEST', periodKey);
          if (alreadySent) continue;

          const digestSummary = await ledgerService.buildMonthlyDigestSummary(merchant.id, monthStart, monthEnd, prevMonthStart);
          const digestCard = await monthlyDigestService.generateDigestCard({ merchant, periodKey, ...digestSummary });
          const { reportUrl } = await fullReportService.generateFullReport({ merchant, periodKey, monthStart, monthEnd, prevMonthStart });

          await whatsappService.sendMonthlyDigestCard(merchant.whatsapp_number, {
            imageUrl: digestCard.url,
            bodyText: `Your ${monthStart.toLocaleDateString('en-NG', { month: 'long' })} digest is ready.`,
            reportUrl,
          });
          await queries.markReportSent(merchant.id, 'MONTHLY_DIGEST', periodKey);
        } else {
          const alreadySent = await queries.hasReportBeenSent(merchant.id, 'MONTHLY_INSIGHTS', periodKey);
          if (alreadySent) continue;

          const report = await ledgerService.buildMonthlyInsightsReportText(merchant.id, monthStart, monthEnd, prevMonthStart, monthStart);
          await whatsappService.sendTextMessage(merchant.whatsapp_number, report);
          await queries.markReportSent(merchant.id, 'MONTHLY_INSIGHTS', periodKey);
        }
      }
      return;
    }

    if (job.name === 'subscription-expiry-tick') {
      const expired = await queries.getExpiredSubscriptionMerchants();
      for (const merchant of expired) {
        await queries.downgradeMerchantToFreeTier(merchant.id);
        await auditLogService.logEvent({ merchantId: merchant.id, actorType: 'SYSTEM', actorId: 'scheduler', action: 'subscription.expired_downgrade' });
        await whatsappService.sendTextMessage(
          merchant.whatsapp_number,
          `Your Kika ${merchant.plan} tier has expired and your profile has returned to the Kika Free Tier.\n\n*What changes now:*\n\u2022 Receipts go back to the plain Kika template.\n\u2022 Handwritten logbook photo scanning is locked.\n\n\ud83d\udd12 *Don't worry:* all your past transactions, sales data, and customer debt records are 100% safe and will never be deleted.\n\nTo get your premium features back right now, just reply with: *UPGRADE*`
        );
      }
      return;
    }

    if (job.name === 'friday-amnesty-tick') {
      const now = new Date();
      const periodKey = dayKey(now);
      const merchants = await queries.listMerchantsActiveSince(addDays(now, -30), addDays(now, 1));
      for (const merchant of merchants) {
        const alreadyPrompted = await queries.hasReportBeenSent(merchant.id, 'FRIDAY_AMNESTY_PROMPT', periodKey);
        if (alreadyPrompted) continue;

        const debt = await queries.getOutstandingDebtTotal(merchant.id);
        if (Number(debt.total_kobo) <= 0) continue;

        await whatsappService.sendFridayAmnestyPrompt(merchant.whatsapp_number, {
          debtorCount: Number(debt.entry_count),
          totalOwedLabel: `\u20a6${(Number(debt.total_kobo) / 100).toLocaleString('en-NG')}`,
        });
        await queries.markReportSent(merchant.id, 'FRIDAY_AMNESTY_PROMPT', periodKey);
      }
      return;
    }

    if (job.name === 'scratchpad-cleanup-tick') {
      const { deletedCount, errorCount } = await diskCleanupService.pruneExpiredAssets();
      if (deletedCount > 0 || errorCount > 0) {
        logger.info({ deletedCount, errorCount }, 'Scratchpad cleanup tick processed');
      }
    }
  },
  { connection, concurrency: 2 }
);

for (const worker of [ledgerWorker, webhookAlertWorker, scheduledReportsWorker]) {
  worker.on('failed', (job, err) => {
    // Axios errors (WhatsApp Cloud API, Paystack) carry the actual
    // rejection reason in err.response.data — err.message alone is
    // just "Request failed with status code 400", which tells an
    // operator nothing about WHY. Logging the response body too means
    // a 400 is diagnosable straight from these logs instead of needing
    // a separate query against payment_gateway_activity_log or the
    // WhatsApp send audit trail.
    logger.error(
      { jobId: job?.id, queue: job?.queueName, err: err.message, httpStatus: err.response?.status, responseBody: err.response?.data },
      'Job failed'
    );
  });
  worker.on('error', (err) => logger.error({ err }, 'Worker-level error'));
}

registerSchedules().catch((err) => logger.error({ err }, 'Failed to register scheduled report jobs'));

logger.info({ concurrency: CONCURRENCY }, 'Kika worker process started');

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing workers gracefully');
  await Promise.all([ledgerWorker.close(), webhookAlertWorker.close(), scheduledReportsWorker.close()]);
  process.exit(0);
});
