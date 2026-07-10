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
const auditLogService = require('../services/auditLogService');
const diskCleanupService = require('../services/diskCleanupService');
const { getFallbackReply } = require('../config/aiPersona');
const { registerSchedules } = require('./scheduler');

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 10);

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

// "DISPUTE <reason>" — a merchant (or, via a future customer-facing
// surface, a customer) flags that a ledger balance looks wrong. Logged
// to ledger_disputes for a human to review and resolve via the admin API.
const DISPUTE_PREFIX_RE = /^dispute\b[:\s]*(.*)$/i;

/**
 * kika:ledger-processing — resolves multimodal content, tries the fast
 * regex parser first, falls back to the AI classifier only when the
 * regex parser can't make sense of the message, generates a receipt,
 * and pushes it back out over WhatsApp.
 */
const ledgerWorker = new Worker(
  'kika-ledger-processing',
  async (job) => {
    const { merchantId, whatsappNumber } = job.data;
    const merchant = await queries.getMerchantById(merchantId);
    if (!merchant) return;

    const { text: rawMessage, imageBase64, mediaError } = await resolveInboundContent(job);

    if (mediaError) {
      await whatsappService.sendTextMessage(
        whatsappNumber,
        "I couldn't process that file — could you resend it, or type the details instead?"
      );
      return;
    }

    const command = ledgerParser.detectCommand(rawMessage);

    if (command === 'HELP') {
      await whatsappService.sendTextMessage(
        whatsappNumber,
        'Hi! Send me things like:\n"sold rice 5000"\n"Mama Tunde buy 3 carton indomie, she pay 15k remain 12k"\n"Chidi owes 2000"\n"John pay off his debt 5k"\n\nYou can also send a voice note or a photo of a receipt/handwritten note.\n\nTip: include a customer\'s phone number (e.g. "Mama Tunde 08012345678 buy...") to enable loyalty milestone tracking.\n\nSend BALANCE for a live snapshot, SUNSET for today\'s recap, INSIGHTS for this month, DISPUTE <reason> to flag a balance issue, or UPGRADE to see pricing plans.'
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
      const report = await ledgerService.buildMonthlyInsightsReportText(
        merchantId,
        monthStart,
        monthEnd,
        prevMonthStart,
        monthStart
      );
      await whatsappService.sendTextMessage(whatsappNumber, report);
      return;
    }

    if (command === 'UPGRADE') {
      const tiers = await queries.listActiveSubscriptionTiers();
      const paidTiers = tiers.filter((t) => Number(t.price) > 0);
      await whatsappService.sendPlanSelectionButtons(
        whatsappNumber,
        paidTiers.map((t) => ({
          id: t.name.toUpperCase(),
          title: `${t.name} - ${t.currency} ${Number(t.price).toLocaleString('en-NG')}`,
        }))
      );
      return;
    }

    if (command === 'STANDARD' || command === 'PREMIUM') {
      await handleTierPurchase(merchant, whatsappNumber, command);
      return;
    }

    const disputeMatch = rawMessage.match(DISPUTE_PREFIX_RE);
    if (disputeMatch) {
      const reason = disputeMatch[1]?.trim() || 'No reason provided';
      const dispute = await queries.createLedgerDispute({
        merchantId,
        raisedBy: 'MERCHANT',
        reason,
      });
      await auditLogService.logEvent({
        merchantId,
        actorType: 'MERCHANT',
        actorId: whatsappNumber,
        action: 'dispute.create',
        metadata: { disputeId: dispute.id, reason },
      });
      await whatsappService.sendTextMessage(
        whatsappNumber,
        `Got it — I've logged this for review (ref: ${dispute.id.slice(0, 8).toUpperCase()}). Our team will look into it.`
      );
      return;
    }

    const invoiceParsed = ledgerParser.parseInvoiceCommand(rawMessage);
    if (invoiceParsed) {
      const link = await paystackService.createCustomerInvoice(merchant, invoiceParsed);
      await auditLogService.logEvent({
        merchantId,
        actorType: 'MERCHANT',
        actorId: whatsappNumber,
        action: 'payment_link.create',
        metadata: { paymentLinkId: link.id, amountKobo: link.amount_kobo },
      });
      await whatsappService.sendTextMessage(
        whatsappNumber,
        `\ud83e\uddfe Payment link ready \u2014 forward this to your customer:\n${link.short_url}\n\nAmount: ${link.currency} ${(link.amount_kobo / 100).toLocaleString('en-NG')}\nExpires: ${new Date(link.expires_at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}`
      );
      return;
    }

    // --- Hybrid parsing: fast regex first ---
    let parsed = ledgerParser.parseLedgerMessage(rawMessage);
    let source = 'regex';

    // --- AI safety net: only reached when the regex parser can't make
    // sense of the message (unfamiliar slang, indirect phrasing, an
    // image, or a transcribed voice note) ---
    let aiConversationalReply = null;
    let aiDetectedLanguage = null;
    if (!parsed) {
      const aiResult = await aiTransactionParser.parseWithAI(rawMessage, { imageBase64 });
      if (aiResult.parsed) {
        parsed = aiResult.parsed;
        source = 'ai';
        aiDetectedLanguage = aiResult.detectedLanguage;
      } else if (aiResult.conversationalReply) {
        aiConversationalReply = aiResult.conversationalReply;
      }
      // aiResult.error (AI call itself failed) falls through to the
      // guaranteed fixed fallback text below, same as "no reply at all".
    }

    if (!parsed) {
      await auditLogService.logEvent({
        merchantId,
        actorType: 'MERCHANT',
        actorId: whatsappNumber,
        action: 'message.unparsed',
        metadata: { rawMessage, hadImage: !!imageBase64 },
      });
      await whatsappService.sendTextMessage(
        whatsappNumber,
        aiConversationalReply || getFallbackReply(aiDetectedLanguage)
      );
      return;
    }

    await auditLogService.logEvent({
      merchantId,
      actorType: 'MERCHANT',
      actorId: whatsappNumber,
      action: 'ledger_entry.parsed',
      metadata: { source, entryType: parsed.entryType },
    });

    const { receipt, outstandingDebtKobo } = await ledgerService.recordLedgerEntryAndReceipt({
      merchant,
      parsedEntry: parsed,
      rawMessage,
    });

    const debtNote = Number(outstandingDebtKobo) > 0 ? '\n\nSend BALANCE anytime for a full summary.' : '';
    await whatsappService.sendReceiptImage(
      whatsappNumber,
      receipt.url,
      `\u2705 Recorded: ${parsed.description}${debtNote}`
    );
  },
  { connection, concurrency: CONCURRENCY }
);

/**
 * kika:webhook-alerts — fires the victory webhook + confirmation message
 * once a Paystack payment is verified and the subscription is extended.
 */
const webhookAlertWorker = new Worker(
  'kika-webhook-alerts',
  async (job) => {
    const { merchantId, paymentReference, amountKobo, planTier } = job.data;
    const merchant = await queries.getMerchantById(merchantId);
    if (!merchant) return;

    await brokerAlertService.fireOnboardingVictoryWebhook({ merchant, paymentReference, amountKobo });

    await whatsappService.sendTextMessage(
      merchant.whatsapp_number,
      `\ud83c\udf89 Payment confirmed! Kika ${planTier || 'Premium'} is active for the next 30 days (until ${new Date(
        merchant.subscription_expires_at
      ).toLocaleDateString('en-NG', { dateStyle: 'long' })}). Thank you!`
    );
  },
  { connection, concurrency: 5 }
);

/**
 * kika:scheduled-reports — the two repeatable cron ticks registered by
 * scheduler.js. Each tick fans out to every merchant active in the
 * relevant window and sends them their report, guarded by
 * report_dispatch_log so a duplicate tick (e.g. after a redeploy) can
 * never send the same day's/month's report twice.
 */
const scheduledReportsWorker = new Worker(
  'kika-scheduled-reports',
  async (job) => {
    if (job.name === 'daily-sunset-tick') {
      const dayStart = startOfDay(new Date());
      const dayEnd = addDays(dayStart, 1);
      const periodKey = dayKey(dayStart);

      const merchants = await queries.listMerchantsActiveSince(dayStart, dayEnd);
      logger.info({ count: merchants.length, periodKey }, 'Dispatching Daily Sunset Reports');

      for (const merchant of merchants) {
        const alreadySent = await queries.hasReportBeenSent(merchant.id, 'DAILY_SUNSET', periodKey);
        if (alreadySent) continue;

        const report = await ledgerService.buildDailySunsetReportText(merchant.id, dayStart, dayEnd);
        await whatsappService.sendTextMessage(merchant.whatsapp_number, report);
        await queries.markReportSent(merchant.id, 'DAILY_SUNSET', periodKey);
      }
      return;
    }

    if (job.name === 'monthly-insights-tick') {
      const now = new Date();
      const monthStart = startOfMonth(addMonths(now, -1)); // report on the month that just ended
      const monthEnd = addMonths(monthStart, 1);
      const prevMonthStart = addMonths(monthStart, -1);
      const periodKey = monthKey(monthStart);

      const merchants = await queries.listMerchantsActiveSince(monthStart, monthEnd);
      logger.info({ count: merchants.length, periodKey }, 'Dispatching Monthly reports');

      for (const merchant of merchants) {
        if (merchant.plan.toUpperCase() === 'PREMIUM') {
          const alreadySent = await queries.hasReportBeenSent(merchant.id, 'MONTHLY_DIGEST', periodKey);
          if (alreadySent) continue;

          const digestSummary = await ledgerService.buildMonthlyDigestSummary(
            merchant.id,
            monthStart,
            monthEnd,
            prevMonthStart
          );
          const digestCard = await monthlyDigestService.generateDigestCard({
            merchant,
            periodKey,
            ...digestSummary,
          });
          const { reportUrl } = await fullReportService.generateFullReport({
            merchant,
            periodKey,
            monthStart,
            monthEnd,
            prevMonthStart,
          });

          await whatsappService.sendMonthlyDigestCard(merchant.whatsapp_number, {
            imageUrl: digestCard.url,
            bodyText: `Your ${monthStart.toLocaleDateString('en-NG', { month: 'long' })} digest is ready.`,
            reportUrl,
          });

          await queries.markReportSent(merchant.id, 'MONTHLY_DIGEST', periodKey);
        } else {
          const alreadySent = await queries.hasReportBeenSent(merchant.id, 'MONTHLY_INSIGHTS', periodKey);
          if (alreadySent) continue;

          const report = await ledgerService.buildMonthlyInsightsReportText(
            merchant.id,
            monthStart,
            monthEnd,
            prevMonthStart,
            monthStart
          );
          await whatsappService.sendTextMessage(merchant.whatsapp_number, report);
          await queries.markReportSent(merchant.id, 'MONTHLY_INSIGHTS', periodKey);
        }
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
