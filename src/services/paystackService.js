'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const queries = require('../db/queries');
const linkShortenerService = require('./linkShortenerService');

const client = axios.create({
  baseURL: process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co',
  timeout: 10000,
  headers: {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json',
  },
});

const SUBSCRIPTION_DURATION_DAYS = Number(process.env.SUBSCRIPTION_DURATION_DAYS || 30);

/**
 * Every call to Paystack's REST API goes through here so it's logged to
 * payment_gateway_logs uniformly — request, response, success/failure —
 * regardless of which higher-level flow (subscription upgrade, customer
 * invoice, webhook re-verification) triggered it.
 */
async function callPaystack({ method, path, payload, merchantId, paymentLinkId, eventType, reference }) {
  let httpStatus = null;
  let responsePayload = null;
  let isSuccess = false;
  let errorMessage = null;

  try {
    const res = await client.request({ method, url: path, data: payload });
    httpStatus = res.status;
    responsePayload = res.data;
    isSuccess = Boolean(res.data?.status);
    return res.data;
  } catch (err) {
    httpStatus = err.response?.status || null;
    responsePayload = err.response?.data || null;
    errorMessage = err.message;
    throw err;
  } finally {
    await queries
      .logPaymentGatewayActivity({
        merchantId,
        paymentLinkId,
        gateway: 'paystack',
        eventType,
        reference,
        httpStatus,
        requestPayload: payload,
        responsePayload,
        isSuccess,
        errorMessage,
      })
      .catch((logErr) => logger.error({ err: logErr.message }, 'Failed to write payment gateway log'));
  }
}

/**
 * Initializes a dynamic Paystack transaction (functionally an invoice —
 * Paystack's REST surface for a one-off checkout link is
 * POST /transaction/initialize, which returns an authorization_url that
 * the merchant completes payment on) for the requested plan tier.
 * Price and currency are read live from subscription_tiers — never
 * hardcoded — so a price change in that table takes effect immediately
 * with no code deploy.
 *
 * `billingInterval` selects monthly (tier.price) or yearly
 * (tier.price_yearly — 10x the monthly rate, i.e. 2 months free, to
 * reward the longer commitment) billing. The chosen interval is stamped
 * on both the Paystack metadata and the local payment_transactions row,
 * so the webhook handler (paystack.routes.js) knows whether to extend
 * the subscription by 30 or 365 days once payment is verified.
 */
async function createUpgradeInvoice(merchant, tierName, billingInterval = 'monthly') {
  if (billingInterval !== 'monthly' && billingInterval !== 'yearly') {
    throw new Error(`Invalid billingInterval: ${billingInterval}`);
  }

  const tier = await queries.getSubscriptionTierByName(tierName);
  if (!tier) {
    throw new Error(`Unknown or inactive subscription tier: ${tierName}`);
  }

  // subscription_tiers.price / price_yearly are stored in major currency
  // units (e.g. 5000.00 NGN); Paystack's `amount` field wants the minor
  // unit (kobo for NGN, cents for USD) — both are x100, so this
  // conversion holds for any 2-decimal ISO currency this table might
  // hold in future.
  const priceMajorUnits = billingInterval === 'yearly' ? tier.price_yearly : tier.price;
  const amountMinorUnits = Math.round(Number(priceMajorUnits) * 100);
  const reference = `kika_${tier.name.toLowerCase()}_${billingInterval}_${uuidv4()}`;
  const syntheticEmail = `${merchant.whatsapp_number.replace(/[^\d]/g, '')}@wa.kikahq.invoice`;

  const payload = {
    email: syntheticEmail,
    amount: amountMinorUnits,
    currency: tier.currency,
    reference,
    callback_url: process.env.PAYSTACK_CALLBACK_URL,
    metadata: {
      merchant_id: merchant.id,
      whatsapp_number: merchant.whatsapp_number,
      subscription_tier_id: tier.id,
      plan_tier: tier.name,
      billing_interval: billingInterval,
    },
  };

  const data = await callPaystack({
    method: 'post',
    path: '/transaction/initialize',
    payload,
    merchantId: merchant.id,
    eventType: 'transaction.initialize',
    reference,
  });

  if (!data?.status || !data.data?.authorization_url) {
    logger.error({ response: data }, 'Paystack initialize returned unexpected payload');
    throw new Error('Failed to initialize Paystack transaction');
  }

  const { authorization_url: authorizationUrl } = data.data;

  await queries.createPaymentTransaction({
    merchantId: merchant.id,
    reference,
    subscriptionTierId: tier.id,
    billingInterval,
    amountKobo: amountMinorUnits,
    authorizationUrl,
  });

  return { authorizationUrl, reference, amountKobo: amountMinorUnits, billingInterval, tier };
}

/**
 * Generates a customer-facing payment link/invoice — the "digital
 * invoice sent directly inside a WhatsApp chat" — tracked in
 * payment_links with a compact short_url instead of Paystack's long
 * authorization_url. Used by the merchant-facing INVOICE command.
 */
async function createCustomerInvoice(merchant, { amountKobo, description, customerPhone, customerName, ttlHours = 24 }) {
  const reference = `kika_invoice_${uuidv4()}`;
  const currency = merchant.default_currency || 'NGN';
  const syntheticEmail = customerPhone
    ? `${customerPhone.replace(/[^\d]/g, '')}@wa.kikahq.invoice`
    : `${merchant.whatsapp_number.replace(/[^\d]/g, '')}@wa.kikahq.invoice`;

  const payload = {
    email: syntheticEmail,
    amount: amountKobo,
    currency,
    reference,
    callback_url: process.env.PAYSTACK_CALLBACK_URL,
    metadata: {
      merchant_id: merchant.id,
      type: 'CUSTOMER_INVOICE',
      customer_phone: customerPhone || null,
      description: description || null,
    },
  };

  const data = await callPaystack({
    method: 'post',
    path: '/transaction/initialize',
    payload,
    merchantId: merchant.id,
    eventType: 'transaction.initialize',
    reference,
  });

  if (!data?.status || !data.data?.authorization_url) {
    logger.error({ response: data }, 'Paystack initialize returned unexpected payload for customer invoice');
    throw new Error('Failed to initialize customer invoice');
  }

  const { authorization_url: fullUrl } = data.data;

  const link = await linkShortenerService.createShortPaymentLink({
    merchant,
    gateway: 'paystack',
    gatewayReference: reference,
    fullUrl,
    amountKobo,
    currency,
    customerPhone,
    customerName,
    description,
    ttlHours,
  });

  return link;
}

/**
 * Verifies the X-Paystack-Signature header using a timing-safe HMAC
 * comparison against the raw request body — the only trustworthy way to
 * confirm a webhook actually originated from Paystack rather than a
 * spoofed POST to the same endpoint.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(signatureHeader, 'hex');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Server-side re-verification of the transaction status directly against
 * Paystack's API (never trust the webhook payload's `status` field alone —
 * always confirm with a GET call using our own secret key).
 */
async function verifyTransaction(reference) {
  const data = await callPaystack({
    method: 'get',
    path: `/transaction/verify/${encodeURIComponent(reference)}`,
    eventType: 'verify.transaction',
    reference,
  });
  return data?.data;
}

module.exports = {
  createUpgradeInvoice,
  createCustomerInvoice,
  verifyWebhookSignature,
  verifyTransaction,
  SUBSCRIPTION_DURATION_DAYS,
};
