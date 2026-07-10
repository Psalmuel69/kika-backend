'use strict';

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Fires a signed "victory" execution alert to the configured chat-broker
 * automation sink the moment a merchant's premium onboarding activates.
 * Signing lets the receiving broker verify the alert genuinely came from
 * Kika before it triggers any downstream automation (e.g. drip campaigns,
 * CRM state sync).
 */
async function fireOnboardingVictoryWebhook({ merchant, paymentReference, amountKobo }) {
  const url = process.env.BROKER_ALERT_WEBHOOK_URL;
  if (!url) {
    logger.info({ merchantId: merchant.id }, 'BROKER_ALERT_WEBHOOK_URL not configured, skipping alert');
    return null;
  }

  const payload = {
    event: 'kika.onboarding.premium_activated',
    merchant_id: merchant.id,
    whatsapp_number: merchant.whatsapp_number,
    onboarding_state: 'PREMIUM_ACTIVE',
    payment_reference: paymentReference,
    amount_kobo: amountKobo,
    subscription_expires_at: merchant.subscription_expires_at,
    fired_at: new Date().toISOString(),
  };

  const body = JSON.stringify(payload);
  const signature = crypto
    .createHmac('sha256', process.env.BROKER_ALERT_WEBHOOK_SECRET || '')
    .update(body)
    .digest('hex');

  try {
    await axios.post(url, payload, {
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'X-Kika-Signature': signature,
      },
    });
    logger.info({ merchantId: merchant.id }, 'Victory webhook fired to chat broker');
  } catch (err) {
    // Non-fatal — the merchant's premium activation already happened in
    // Postgres regardless of whether this observability hook succeeds.
    logger.error({ err: err.message, merchantId: merchant.id }, 'Victory webhook delivery failed');
  }
}

module.exports = { fireOnboardingVictoryWebhook };
