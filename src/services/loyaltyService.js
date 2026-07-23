'use strict';

const queries = require('../db/queries');
const logger = require('../utils/logger');

const MILESTONE_INTERVAL = Number(process.env.LOYALTY_MILESTONE_INTERVAL || 5);

/**
 * Smart Customer Loyalty Flags — available to Standard and Premium
 * merchants only (not FREE). Tracks recurring customers by phone number
 * across purchases; every time a customer's count crosses a multiple of
 * `MILESTONE_INTERVAL` (5th, 10th, 15th...), flags it back to the caller
 * so it can be appended to the merchant's own receipt/confirmation.
 *
 * Deliberately does NOT message the customer directly. WhatsApp's
 * messaging policy only allows a business to freely message a number
 * that has itself messaged the business within the last 24h (or via a
 * pre-approved template outside that window) — a customer whose number
 * a merchant merely typed into a sale has never opened that session, so
 * an unprompted "thank you" DM to them would likely fail delivery or
 * risk the business number's messaging quality rating. Surfacing the
 * milestone to the *merchant* instead (who can celebrate with the
 * customer in person, or via their own channel) gets the same business
 * value — "loyal customers keep businesses alive" — without that risk.
 *
 * No-op silently if the merchant is on FREE, or if the message didn't
 * include a recognizable phone number for the counterparty — loyalty
 * tracking is opt-in by the merchant simply including the customer's
 * number in their message.
 */
async function trackPurchaseAndMaybeNotify({ merchant, counterpartyName, counterpartyPhone }) {
  if (!counterpartyPhone) return { milestoneFired: false };
  if (merchant.plan.toUpperCase() === 'FREE') return { milestoneFired: false };

  const loyaltyRow = await queries.incrementCustomerLoyalty(merchant.id, counterpartyPhone, counterpartyName);
  const count = loyaltyRow.purchase_count;

  const isMilestone = count > 0 && count % MILESTONE_INTERVAL === 0;
  const alreadyNotifiedThisMilestone = loyaltyRow.last_milestone_notified === count;

  if (!isMilestone || alreadyNotifiedThisMilestone) {
    return { loyaltyRow, milestoneFired: false };
  }

  await queries.markLoyaltyMilestoneNotified(loyaltyRow.id, count);

  const milestoneText =
    `\n\n*CUSTOMER MILESTONE!* This is ${counterpartyName || 'this customer'}'s *${ordinal(count)} purchase* ` +
    `at your shop! Tip: loyal customers keep businesses alive \u2014 a small discount or a tiny free item goes a long way.`;

  logger.info({ merchantId: merchant.id, counterpartyPhone, count }, 'Loyalty milestone reached');

  return { loyaltyRow, milestoneFired: true, milestoneText, purchaseCount: count };
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

module.exports = { trackPurchaseAndMaybeNotify, MILESTONE_INTERVAL };
