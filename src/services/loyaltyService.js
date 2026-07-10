'use strict';

const queries = require('../db/queries');
const whatsappService = require('./whatsappService');
const logger = require('../utils/logger');

const MILESTONE_INTERVAL = Number(process.env.LOYALTY_MILESTONE_INTERVAL || 5);

/**
 * Smart Customer Loyalty Flags — available to Standard and Premium
 * merchants only (not FREE). Tracks recurring customers by phone number
 * across purchases; every time a customer's count crosses a multiple of
 * `MILESTONE_INTERVAL` (5th, 10th, 15th...), pings the *customer*
 * directly over WhatsApp, and lets the merchant know too.
 *
 * No-op silently if the merchant is on FREE, or if the message didn't
 * include a recognizable phone number for the counterparty — loyalty
 * tracking is opt-in by the merchant simply including the customer's
 * number in their message.
 */
async function trackPurchaseAndMaybeNotify({ merchant, counterpartyName, counterpartyPhone }) {
  if (!counterpartyPhone) return null;
  if (merchant.plan.toUpperCase() === 'FREE') return null;

  const loyaltyRow = await queries.incrementCustomerLoyalty(merchant.id, counterpartyPhone, counterpartyName);
  const count = loyaltyRow.purchase_count;

  const isMilestone = count > 0 && count % MILESTONE_INTERVAL === 0;
  const alreadyNotifiedThisMilestone = loyaltyRow.last_milestone_notified === count;

  if (!isMilestone || alreadyNotifiedThisMilestone) {
    return { loyaltyRow, milestoneFired: false };
  }

  try {
    await whatsappService.sendTextMessage(
      counterpartyPhone,
      `\ud83c\udf1f Hi${counterpartyName ? ' ' + counterpartyName : ''}! This is your ${ordinal(count)} purchase with ${merchant.business_name || merchant.display_name || 'us'} \u2014 thank you for being a loyal customer!`
    );
  } catch (err) {
    // A failed customer-facing ping shouldn't block the merchant's own
    // ledger flow — log and continue.
    logger.error({ err: err.message, merchantId: merchant.id }, 'Loyalty milestone ping to customer failed');
  }

  try {
    await whatsappService.sendTextMessage(
      merchant.whatsapp_number,
      `\ud83c\udfc6 Loyalty flag: ${counterpartyName || counterpartyPhone} just hit their ${ordinal(count)} purchase with you!`
    );
  } catch (err) {
    logger.error({ err: err.message, merchantId: merchant.id }, 'Loyalty milestone notice to merchant failed');
  }

  await queries.markLoyaltyMilestoneNotified(loyaltyRow.id, count);

  return { loyaltyRow, milestoneFired: true };
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

module.exports = { trackPurchaseAndMaybeNotify, MILESTONE_INTERVAL };
