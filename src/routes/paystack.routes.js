'use strict';

const express = require('express');
const paystackService = require('../services/paystackService');
const queries = require('../db/queries');
const ledgerService = require('../services/ledgerService');
const whatsappService = require('../services/whatsappService');
const auditLogService = require('../services/auditLogService');
const { webhookAlertQueue } = require('../queue/queues');
const { asyncHandler } = require('../middleware/validation');
const { paystackWebhookLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Paystack webhook: charge.success (and others we ignore). Two layers of
 * trust verification before anything is mutated:
 *   1. HMAC signature over the raw body, using our secret key.
 *   2. A live GET /transaction/verify/:reference call back to Paystack —
 *      the webhook body itself is never trusted for the final status,
 *      only used to know which reference to go check.
 * Both branches below are idempotent on their respective reference, so a
 * duplicate webhook delivery (Paystack retries on non-200) can never
 * double-extend a subscription or double-record a sale.
 */
router.post(
  '/paystack/webhook',
  paystackWebhookLimiter,
  asyncHandler(async (req, res) => {
    const signature = req.get('X-Paystack-Signature');
    const isValid = paystackService.verifyWebhookSignature(req.rawBody, signature);

    if (!isValid) {
      logger.warn({ ip: req.ip }, 'Rejected Paystack webhook: invalid signature');
      return res.sendStatus(401);
    }

    // Acknowledge fast; Paystack retries aggressively on slow/failed responses.
    res.sendStatus(200);

    const event = req.body?.event;
    const reference = req.body?.data?.reference;
    if (event !== 'charge.success' || !reference) return;

    try {
      if (reference.startsWith('kika_invoice_')) {
        await handleCustomerInvoicePayment(reference);
      } else {
        await handleSubscriptionPayment(reference);
      }
    } catch (err) {
      logger.error({ err: err.message, reference }, 'Error processing Paystack webhook');
    }
  })
);

async function handleSubscriptionPayment(reference) {
  const existing = await queries.getPaymentTransactionByReference(reference);
  if (!existing) {
    logger.warn({ reference }, 'Webhook for unknown subscription payment reference — ignoring');
    return;
  }
  if (existing.status === 'SUCCESS') return; // idempotent no-op on duplicate delivery

  const verified = await paystackService.verifyTransaction(reference);
  if (verified?.status !== 'success') {
    await queries.markPaymentTransactionStatus(reference, 'FAILED');
    return;
  }

  await queries.markPaymentTransactionStatus(reference, 'SUCCESS');

  // A yearly purchase extends the subscription by a full year, not the
  // usual monthly duration — existing.billing_interval was stamped at
  // checkout time (see paystackService.createUpgradeInvoice) precisely
  // so this webhook, running independently and later, still knows which
  // one the merchant actually paid for.
  const durationDays = existing.billing_interval === 'yearly' ? 365 : paystackService.SUBSCRIPTION_DURATION_DAYS;
  const merchant = await queries.extendMerchantSubscription(existing.merchant_id, existing.tier_name, durationDays);

  await webhookAlertQueue.add(
    'onboarding-victory',
    {
      merchantId: merchant.id,
      paymentReference: reference,
      amountKobo: existing.amount_kobo,
      planTier: existing.tier_name,
    },
    { jobId: `alert-${reference}` }
  );

  await auditLogService.logEvent({
    merchantId: merchant.id,
    actorType: 'WEBHOOK',
    actorId: 'paystack',
    action: 'subscription.payment_confirmed',
    metadata: { reference, planTier: existing.tier_name },
  });

  logger.info({ merchantId: merchant.id, reference, planTier: existing.tier_name }, 'Subscription extended');
}

async function handleCustomerInvoicePayment(reference) {
  const link = await queries.getPaymentLinkByGatewayReference('paystack', reference);
  if (!link) {
    logger.warn({ reference }, 'Webhook for unknown payment link reference — ignoring');
    return;
  }
  if (link.status === 'PAID') return; // idempotent no-op on duplicate delivery

  const verified = await paystackService.verifyTransaction(reference);
  if (verified?.status !== 'success') {
    await queries.markPaymentLinkStatus(link.id, 'FAILED');
    return;
  }

  const merchant = await queries.getMerchantById(link.merchant_id);
  if (!merchant) return;

  // Auto-record the payment as a CREDIT sale in the merchant's ledger —
  // the whole point of a payment link is that it collects the money AND
  // updates the books without the merchant typing anything.
  const { ledgerEntry } = await ledgerService.recordLedgerEntryAndReceipt({
    merchant,
    parsedEntry: {
      entryType: 'CREDIT',
      description: link.description || 'Payment link',
      counterpartyName: link.customer_name,
      counterpartyPhone: link.customer_phone,
      items: [],
      totalKobo: link.amount_kobo,
      paidKobo: link.amount_kobo,
      balanceKobo: 0,
    },
    rawMessage: `[payment link ${link.short_code}]`,
  });

  await queries.markPaymentLinkStatus(link.id, 'PAID', { ledgerEntryId: ledgerEntry.id });

  await auditLogService.logEvent({
    merchantId: merchant.id,
    actorType: 'WEBHOOK',
    actorId: 'paystack',
    action: 'payment_link.paid',
    metadata: { paymentLinkId: link.id, reference },
  });

  await whatsappService.sendTextMessage(
    merchant.whatsapp_number,
    `\ud83d\udcb0 Payment received! ${link.currency} ${(link.amount_kobo / 100).toLocaleString('en-NG')} from ${
      link.customer_name || 'your customer'
    } has been recorded automatically.`
  );

  logger.info({ merchantId: merchant.id, reference, paymentLinkId: link.id }, 'Customer invoice paid and recorded');
}

module.exports = router;
