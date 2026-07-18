'use strict';

const express = require('express');
const whatsappService = require('../services/whatsappService');
const queries = require('../db/queries');
const { ledgerQueue } = require('../queue/queues');
const accessControlService = require('../services/accessControlService');
const auditLogService = require('../services/auditLogService');
const idempotencyService = require('../services/idempotencyService');
const { asyncHandler } = require('../middleware/validation');
const { whatsappWebhookLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Meta's one-time webhook verification handshake when the endpoint is
 * registered in the WhatsApp Business API dashboard.
 */
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/**
 * Extracts the (mediaType, rawMessage, mediaId) triple this pipeline
 * needs from any supported inbound message type. Multimodal messages
 * (image/audio) carry a `mediaId` that the worker resolves later —
 * downloading and transcribing/vision-processing media happens off the
 * webhook's hot path, in the worker process.
 */
function extractInboundPayload(message) {
  if (message.type === 'text') {
    return { mediaType: 'text', rawMessage: message.text?.body || '', mediaId: null };
  }
  if (message.type === 'interactive' && message.interactive?.button_reply?.id) {
    // A tap on a plan-selection button arrives as an interactive reply,
    // not free text — map its button id back into the same command
    // pipeline so it's processed identically to typing "PREMIUM".
    return { mediaType: 'text', rawMessage: message.interactive.button_reply.id, mediaId: null };
  }
  if (message.type === 'image') {
    return { mediaType: 'image', rawMessage: message.image?.caption || '', mediaId: message.image?.id };
  }
  if (message.type === 'audio') {
    return { mediaType: 'audio', rawMessage: '', mediaId: message.audio?.id };
  }
  return null;
}

/**
 * The contact's current WhatsApp profile display name, sent alongside
 * every message delivery in `change.value.contacts[]`, keyed by wa_id
 * (the same number as `message.from`). This is Meta's own metadata, not
 * anything the merchant explicitly told Kika — see queries.
 * findOrCreateMerchantByWhatsappNumber for how it's stored (and kept
 * fresh) separately from merchant_name.
 */
function extractDisplayName(contacts, waId) {
  const contact = (contacts || []).find((c) => c.wa_id === waId);
  return contact?.profile?.name || null;
}

/**
 * Inbound message delivery. Deliberately thin: verify signature, gate on
 * access control, extract the minimum needed fields, enqueue for async
 * processing, and return 200 immediately. All the actual work (media
 * download/transcription, parsing, DB writes, receipt rendering,
 * WhatsApp sends) happens in the worker process so a burst of concurrent
 * deliveries from Meta can never back up the HTTP response path or hold
 * a Postgres connection open while we wait on it.
 */
router.post(
  '/webhook',
  whatsappWebhookLimiter,
  asyncHandler(async (req, res) => {
    const signature = req.get('X-Hub-Signature-256');
    const isValid = whatsappService.verifyWebhookSignature(req.rawBody, signature);

    if (!isValid) {
      logger.warn({ ip: req.ip }, 'Rejected WhatsApp webhook: invalid signature');
      return res.sendStatus(401);
    }

    // Acknowledge immediately — Meta expects a fast 200 and will retry
    // on timeout, which we don't want to trigger under load.
    res.sendStatus(200);

    try {
      const entries = req.body?.entry || [];
      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          const messages = change.value?.messages || [];
          for (const message of messages) {
            const whatsappNumber = `+${message.from}`;

            // Idempotency gate — MUST run before any other work. Meta's
            // webhook can retry aggressively (per their own reliability
            // notes) or redeliver out of order if our server is briefly
            // slow; this Redis lock is keyed on the message's own id and
            // is the durable guard against double-logging a transaction,
            // since it survives far longer than BullMQ's bounded
            // completed-job retention (which we cap to bound Redis
            // memory, and which a sufficiently late retry could outlive).
            const isFirstDelivery = await idempotencyService.acquireMessageLock(message.id);
            if (!isFirstDelivery) {
              logger.info({ messageId: message.id, whatsappNumber }, 'Duplicate WhatsApp webhook delivery skipped');
              continue;
            }

            const payload = extractInboundPayload(message);
            if (!payload) continue;

            const displayName = extractDisplayName(change.value?.contacts, message.from);
            const merchant = await queries.findOrCreateMerchantByWhatsappNumber(whatsappNumber, displayName);

            // Access control gate: blacklist / whitelist-mode / active
            // human-handoff label. A blocked message is still visible in
            // logs (via the audit entry below) but never reaches the bot.
            const access = await accessControlService.checkAccess(whatsappNumber, merchant.id);
            if (!access.allowed) {
              await auditLogService.log({
                merchantId: merchant.id,
                actorType: 'WEBHOOK',
                actorId: whatsappNumber,
                action: 'whatsapp.message.blocked',
                isSuccess: true,
                metadata: { reason: access.reason, messageType: message.type },
              });
              continue;
            }

            if (merchant.onboarding_state === 'NEW') {
              await queries.setMerchantOnboardingState(merchant.id, 'ACTIVE');
            }

            await auditLogService.log({
              merchantId: merchant.id,
              actorType: 'MERCHANT',
              actorId: whatsappNumber,
              action: 'whatsapp.message.received',
              isSuccess: true,
              metadata: { messageType: message.type },
            });

            await ledgerQueue.add(
              'process-message',
              {
                merchantId: merchant.id,
                whatsappNumber,
                rawMessage: payload.rawMessage,
                mediaType: payload.mediaType,
                mediaId: payload.mediaId,
                whatsappMessageId: message.id,
                replyToWhatsappMessageId: message.context?.id || null,
              },
              { jobId: message.id } // dedupes retried webhook deliveries for the same message
            );
          }
        }
      }
    } catch (err) {
      // Response already sent; log and move on rather than throwing into
      // an already-flushed response cycle.
      logger.error({ err: err.message }, 'Error while enqueueing inbound WhatsApp message');
    }
  })
);

module.exports = router;
