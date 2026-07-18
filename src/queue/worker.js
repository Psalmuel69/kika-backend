'use strict';

require('dotenv').config();
const { Worker } = require('bullmq');
const { connection } = require('../config/redis');
const logger = require('../utils/logger');
const queries = require('../db/queries');
const ledgerParser = require('../services/ledgerParser');
const ledgerService = require('../services/ledgerService');
const whatsappService = require('../services/whatsappService');
const paystackService = require('../services/paystackService');
const brokerAlertService = require('../services/brokerAlertService');
const monthlyDigestService = require('../services/monthlyDigestService');
const fullReportService = require('../services/fullReportService');
const mediaService = require('../services/mediaService');
const aiTransactionParser = require('../services/aiTransactionParser');
const categorizationService = require('../services/categorizationService');
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

  return `Good ${timeOfDay}, ${firstName}! \ud83d\udc4b I'm *Kika AI* \u2014 your business ledger assistant right here on WhatsApp. I help you record sales, expenses, and customer debts just by texting me normally, no app needed. How can I help you today?`;
}

function formatNairaShort(kobo) {
  return `\u20a6${(Number(kobo) / 100).toLocaleString('en-NG')}`;
}

/**
 * Warm, specific confirmation copy instead of a robotic "Transaction
 * recorded." — names the actual customer and actual figures, since
 * that's what makes it feel like Kika actually understood what happened,
 * not just logged a row.
 */
function buildTransactionConfirmationCaption(parsed, outstandingDebtKobo) {
  const amountLabel = formatNairaShort(parsed.totalKobo);

  if (parsed.entryType === 'DEBIT') {
    return `Got it! I've logged your ${amountLabel} expense for ${parsed.description}.`;
  }

  if (parsed.entryType === 'DEBT_SETTLEMENT') {
    const who = parsed.counterpartyName || 'Your customer';
    return Number(outstandingDebtKobo) > 0
      ? `Nice one! ${who} just paid ${formatNairaShort(parsed.paidKobo)}. Outstanding balance is now ${formatNairaShort(outstandingDebtKobo)}.`
      : `Nice one! ${who} just paid ${formatNairaShort(parsed.paidKobo)} \u2014 fully settled, no balance left. \ud83c\udf89`;
  }

  const who = parsed.counterpartyName ? ` from ${parsed.counterpartyName}` : '';
  let caption = `Great! I've recorded the sale of ${amountLabel}${who}.`;
  if (Number(outstandingDebtKobo) > 0) {
    const possessive = parsed.counterpartyName ? `${parsed.counterpartyName}'s` : 'Their';
    caption += ` ${possessive} outstanding balance is now ${formatNairaShort(outstandingDebtKobo)}.`;
  }
  return caption;
}

async function handleTierPurchase(merchant, whatsappNumber, tierName) {
  const invoice = await paystackService.createUpgradeInvoice(merchant, tierName);
  await whatsappService.sendPaymentLink(
    whatsappNumber,
    invoice.authorizationUrl,
    `${invoice.tier.currency} ${(invoice.amountKobo / 100).toLocaleString('en-NG')} (${invoice.tier.name})`
  );
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
        "Account Activated! \ud83c\udf89 Your Kika Free Tier is live. Let's set up your business identity in 5 seconds.\n\n*What is the name of your business/shop?*"
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
      "No worries \u2014 whenever you're ready to get started, just say *Hi* and we'll pick up right where we left off. \ud83d\udc4b"
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
          await whatsappService.sendTextMessage(whatsappNumber, `Nice to meet you, ${introducedName}! \ud83d\ude0a I'll remember that.`);
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
        'Hi! Send me things like:\n"sold rice 5000"\n"Mama Tunde buy 3 carton indomie, she pay 15k remain 12k"\n"Chidi owes 2000"\n"John pay off his debt 5k"\n\nYou can also send a voice note or a photo of a receipt/handwritten note.\n\nTip: include a customer\'s phone number (e.g. "Mama Tunde 08012345678 buy...") to enable loyalty milestone tracking.\n\nCommands: BALANCE, SUNSET, INSIGHTS, DISPUTE <reason>, INVOICE <amount>, ADD STOCK: <item>, <qty>, UNDO, CLOSING HOUR <hour>, EXPORT, UPGRADE.'
      );
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

    if (command === 'UPGRADE') {
      const highestTier = await queries.getHighestActiveSubscriptionTier();
      if (highestTier && merchant.plan.toLowerCase() === highestTier.name.toLowerCase()) {
        await whatsappService.sendTextMessage(
          whatsappNumber,
          `You're already on *${merchant.plan}* \u2014 the full Kika experience! \ud83c\udf1f There's no higher tier to upgrade to right now. Type BALANCE or HELP if you need anything.`
        );
        return;
      }

      const tiers = await queries.listActiveSubscriptionTiers();
      const paidTiers = tiers.filter((t) => Number(t.price) > 0 && t.name.toLowerCase() !== merchant.plan.toLowerCase());
      const featureLines = paidTiers
        .map((t) => `\n*${t.name}* (${t.currency} ${Number(t.price).toLocaleString('en-NG')}/mo):\n${(t.feature_list || []).map((f) => `\u2022 ${f}`).join('\n')}`)
        .join('\n');
      await whatsappService.sendTextMessage(
        whatsappNumber,
        `\ud83d\ude80 *Let's upgrade your business profile!*\n${featureLines}\n\nTap a plan below to get your secure payment link \ud83d\udc47`
      );
      await whatsappService.sendPlanSelectionButtons(
        whatsappNumber,
        paidTiers.map((t) => ({ id: t.name.toUpperCase(), title: `${t.name} - ${t.currency} ${Number(t.price).toLocaleString('en-NG')}` }))
      );
      return;
    }

    if (command === 'STANDARD' || command === 'PREMIUM') {
      const highestTier = await queries.getHighestActiveSubscriptionTier();
      if (highestTier && merchant.plan.toLowerCase() === highestTier.name.toLowerCase()) {
        await whatsappService.sendTextMessage(
          whatsappNumber,
          `You're already on *${merchant.plan}* \u2014 the full Kika experience! \ud83c\udf1f There's no higher tier to upgrade to right now.`
        );
        return;
      }
      await handleTierPurchase(merchant, whatsappNumber, command);
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
          `Transaction cancelled! \u21a9\ufe0f Kika has deleted your last entry: '${result.entry.raw_message || result.entry.description}' from your sales records. Your balance and stock levels have been restored safely. Type your fresh entry whenever you're ready!`
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
      await whatsappService.sendTextMessage(whatsappNumber, 'No problem \u2014 maybe next Friday! \ud83d\udc4b');
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
        `\u2705 Sent polite reminders to ${sentCount} customer${sentCount === 1 ? '' : 's'}!${skippedCount > 0 ? ` (${skippedCount} skipped \u2014 no phone number on file.)` : ''}`
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
        `\ud83d\udce6 Stock updated! *${product.name}* now has *${product.current_stock} ${product.unit || 'units'}* in stock.`
      );
      return;
    }

    const disputeMatch = rawMessage.match(DISPUTE_PREFIX_RE);
    if (disputeMatch) {
      const reason = disputeMatch[1]?.trim() || 'No reason provided';
      const dispute = await queries.createLedgerDispute({ merchantId, raisedBy: 'MERCHANT', reason });
      await auditLogService.logEvent({ merchantId, actorType: 'MERCHANT', actorId: whatsappNumber, action: 'dispute.create', metadata: { disputeId: dispute.id, reason } });
      await whatsappService.sendTextMessage(whatsappNumber, `Got it \u2014 I've logged this for review (ref: ${dispute.id.slice(0, 8).toUpperCase()}). Our team will look into it.`);
      return;
    }

    const invoiceParsed = ledgerParser.parseInvoiceCommand(rawMessage);
    if (invoiceParsed) {
      const link = await paystackService.createCustomerInvoice(merchant, invoiceParsed);
      await auditLogService.logEvent({ merchantId, actorType: 'MERCHANT', actorId: whatsappNumber, action: 'payment_link.create', metadata: { paymentLinkId: link.id, amountKobo: link.amount_kobo } });
      await whatsappService.sendTextMessage(
        whatsappNumber,
        `\ud83e\uddfe Payment link ready \u2014 forward this to your customer:\n${link.short_url}\n\nAmount: ${link.currency} ${(link.amount_kobo / 100).toLocaleString('en-NG')}\nExpires: ${new Date(link.expires_at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}`
      );
      return;
    }

    // Logo upload — a short window right after a fresh Premium purchase
    // where the next image is treated as a business logo, not a scan.
    if (job.data.mediaType === 'image' && merchant.awaiting_logo_until && new Date(merchant.awaiting_logo_until) > new Date()) {
      try {
        const logoPath = await mediaService.saveWhatsappImageAsMerchantLogo(job.data.mediaId, merchantId);
        await queries.setMerchantLogo(merchantId, logoPath);
        await whatsappService.sendTextMessage(whatsappNumber, '\u2705 Logo saved! Your next receipt will carry your new brand look.');
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
      const itemLines = [];
      for (const t of transactions) {
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

      await connection.set(`kika:lastscan:${merchantId}`, JSON.stringify(itemLines), 'EX', 3600);
      await auditLogService.logEvent({ merchantId, actorType: 'MERCHANT', actorId: whatsappNumber, action: 'logbook_scan.completed', metadata: { count: transactions.length } });

      await whatsappService.sendTextMessage(
        whatsappNumber,
        `\u2705 Scan complete! Kika AI successfully extracted *${transactions.length} transaction${transactions.length === 1 ? '' : 's'}* from your paper log sheet and entered them cleanly into your database.\n\n*Quick Summary:*\nTotal Inflows: \u20a6${(totalInflowKobo / 100).toLocaleString('en-NG')}\nDebts Logged: ${debtCount} profile${debtCount === 1 ? '' : 's'} updated.\n\nTo review the individual breakdown lines, reply with: *REVIEW SCAN*`
      );
      return;
    }

    // --- Hybrid parsing: reply-context bare payments first (fastest,
    // most deterministic — see the long comment in ledgerParser.js),
    // then the fast regex parser, then the AI fallback. ---
    let parsed = ledgerParser.parseReplyMessage(rawMessage, replyEntry);
    let source = parsed ? 'reply-context' : 'regex';
    if (!parsed) parsed = ledgerParser.parseLedgerMessage(rawMessage);

    // --- AI safety net: only reached when neither of the above parsers
    // can make sense of the message (unfamiliar slang, indirect
    // phrasing, an image, or a transcribed voice note) ---
    let aiConversationalReply = null;
    let aiDetectedLanguage = null;
    let aiCallFailed = false;
    if (!parsed) {
      logger.info({ jobId: job.id }, 'WORKER_STARTING_AI_CALL');
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
      } else if (aiResult.error) {
        aiCallFailed = true;
      }
    }

    if (!parsed) {
      await auditLogService.logEvent({ merchantId, actorType: 'MERCHANT', actorId: whatsappNumber, action: 'message.unparsed', metadata: { rawMessage, hadImage: !!imageBase64, aiCallFailed } });
      logger.info({ jobId: job.id }, 'WORKER_SENDING_WHATSAPP_REPLY');
      await whatsappService.sendTextMessage(
        whatsappNumber,
        aiConversationalReply || (aiCallFailed ? AI_ERROR_FALLBACK_REPLY : getFallbackReply(aiDetectedLanguage))
      );
      return;
    }

    // The fast regex path doesn't classify expenses (keeps it simple and
    // dependency-free) — backfill via the same keyword/AI classifier the
    // AI path already uses for itself. Bare reply-payments and the AI
    // path never need this (they're never a fresh DEBIT).
    if (parsed.entryType === 'DEBIT' && !parsed.expenseCategory) {
      parsed.expenseCategory = await categorizationService.categorizeExpense(parsed.description, parsed.items?.[0]?.name);
    }

    await auditLogService.logEvent({ merchantId, actorType: 'MERCHANT', actorId: whatsappNumber, action: 'ledger_entry.parsed', metadata: { source, entryType: parsed.entryType } });

    const { ledgerEntry, receipt, outstandingDebtKobo, loyaltyMilestoneText, lowStockAlerts } = await ledgerService.recordLedgerEntryAndReceipt({
      merchant,
      parsedEntry: parsed,
      rawMessage,
      whatsappMessageId,
      replyToWhatsappMessageId,
    });

    const debtNote = Number(outstandingDebtKobo) > 0 ? '\n\nSend BALANCE anytime for a full summary.' : '';
    let caption = buildTransactionConfirmationCaption(parsed, outstandingDebtKobo) + debtNote;
    if (loyaltyMilestoneText) caption += loyaltyMilestoneText;

    logger.info({ jobId: job.id }, 'WORKER_SENDING_WHATSAPP_REPLY');
    const sendResult = await whatsappService.sendReceiptImage(whatsappNumber, receipt.url, caption);

    // Persist the wamid of THIS receipt against the entry — this is
    // what lets a later "he paid" reply (tapping Reply on this exact
    // WhatsApp message) resolve straight back to it. See
    // ledgerParser.parseReplyMessage and businessContextService's
    // "Reply context" block for where this pays off.
    const outboundMessageId = whatsappService.extractOutboundMessageId(sendResult);
    if (ledgerEntry?.id && outboundMessageId) {
      await queries.setLedgerEntryOutboundMessageId(ledgerEntry.id, outboundMessageId);
    }

    for (const alert of lowStockAlerts || []) {
      await whatsappService.sendTextMessage(whatsappNumber, alert);
    }
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
      `\ud83c\udf89 *Payment Received! Welcome to Kika ${planTier || 'Premium'}, ${merchant.business_name || 'friend'}!* Your custom brand settings are unlocked for the next 30 days.\n\n*Want to add your logo to your receipts?* Just send your business logo image directly into this chat right now, and Kika will save it automatically!`
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
    logger.error({ jobId: job?.id, queue: job?.queueName, err: err.message }, 'Job failed');
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
