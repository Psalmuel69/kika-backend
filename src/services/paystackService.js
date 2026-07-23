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
 * Paystack's transaction/initialize endpoint requires a syntactically
 * valid `email`, even though Kika never actually collects one — the
 * merchant pays by tapping a link, not by typing an email address. This
 * derives a placeholder that satisfies that requirement without leaking
 * the merchant's real WhatsApp number (a phone number is personal data;
 * a raw-digits synthetic email put it in Paystack's systems — dashboard,
 * logs, support tooling, any downstream export — for no functional
 * reason, since nothing in this codebase ever reads the email back:
 * every actual lookup uses the unique `reference` plus
 * `metadata.merchant_id`, both already present on the same payload).
 *
 * Instead: an HMAC-SHA256 of merchant.id (itself just an opaque DB
 * UUID, not PII) keyed on PAYSTACK_SECRET_KEY, truncated to 12 hex
 * characters. Properties this gives us:
 *  - Non-reversible and non-enumerable — knowing the resulting address
 *    doesn't reveal the merchant.id, let alone a phone number, and the
 *    HMAC key never leaves this server.
 *  - Deterministic per merchant — every invoice/subscription payment
 *    for the same merchant gets the SAME synthetic address, so if
 *    anyone on the Kika side is ever looking at Paystack's own
 *    dashboard (which groups transactions into "Customers" by email),
 *    a merchant's history stays grouped together instead of scattering
 *    across a new random identity every time.
 *  - Short and readable enough to eyeball in logs, unlike a full UUID.
 * 12 hex chars is 48 bits of the underlying HMAC — collision risk is
 * negligible at any realistic merchant count.
 */
function buildSyntheticPaystackEmail(merchantId) {
  const digest = crypto
    .createHmac('sha256', process.env.PAYSTACK_SECRET_KEY || 'kika-synthetic-email-fallback')
    .update(String(merchantId))
    .digest('hex')
    .slice(0, 12);
  return `m${digest}@invoice.kikahq.com`;
}

// Very light sanity check — merchants.email is already validated at
// collection time (engagementService's opt-in flow), but this is cheap
// insurance against sending Paystack something malformed if that ever
// changes, or if the column is populated by some other path later.
const LOOKS_LIKE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Resolves the email to hand Paystack for a transaction where the
 * MERCHANT is the one actually paying (i.e. subscription upgrades,
 * never customer invoices — see the split explained at each call
 * site). If the merchant has already opted in with a real email
 * address, using it is not just harmless but genuinely better: it's
 * their own payment, their own address, already given voluntarily, and
 * it means Paystack's own receipt email (if their plan sends one)
 * reaches the right person. Only synthesize a placeholder when they
 * haven't provided one.
 */
function resolvePayerEmail(merchant) {
  if (merchant.email && LOOKS_LIKE_EMAIL_RE.test(merchant.email)) {
    return merchant.email;
  }
  return buildSyntheticPaystackEmail(merchant.id);
}

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
  // The merchant is the one actually completing this checkout, so their
  // own opted-in email (if they've given one) is the right address —
  // see resolvePayerEmail above. Falls back to the non-PII synthetic
  // placeholder if they haven't provided one.
  const syntheticEmail = resolvePayerEmail(merchant);

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
  // Deliberately always synthetic here, never the merchant's real
  // email even when they have one on file — unlike createUpgradeInvoice
  // above, the MERCHANT isn't the one paying this transaction, their
  // CUSTOMER is. Using the merchant's own address would be the wrong
  // identity attached to someone else's payment, and — since this
  // becomes the email on Paystack's hosted checkout page, which the
  // customer is the one looking at — could put the merchant's personal
  // email in front of their own customer for no reason. We don't
  // collect a real email for the customer either (only phone/name), so
  // there's no legitimate real address to use on their behalf.
  // See buildSyntheticPaystackEmail above.
  const syntheticEmail = buildSyntheticPaystackEmail(merchant.id);

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
