'use strict';

const queries = require('../db/queries');
const logger = require('../utils/logger');

/**
 * Labels that, when active on a merchant's conversation, mean a human
 * agent has taken over — the bot should log the message but not
 * auto-reply. Configured via SKIP_BOT_LABELS, comma-separated, e.g.
 * "Escalated,VIP,Human Only". Case-insensitive.
 */
function getSkipLabels() {
  return (process.env.SKIP_BOT_LABELS || '')
    .split(',')
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether WHITELIST_MODE is on — if so, ONLY explicitly whitelisted
 * numbers get bot responses (everyone else is silently ignored). Useful
 * for closed betas / phased rollouts. Off by default.
 */
function isWhitelistModeEnabled() {
  return String(process.env.WHITELIST_MODE_ENABLED || 'false').toLowerCase() === 'true';
}

/**
 * The single gate every inbound message passes through before the bot
 * does anything else. Returns a decision object rather than throwing,
 * so the caller can log exactly why a message was skipped.
 *
 * @returns {{ allowed: boolean, reason: string|null }}
 */
async function checkAccess(whatsappNumber, merchantId) {
  const blacklisted = await queries.isPhoneNumberListed(whatsappNumber, 'BLACKLIST');
  if (blacklisted) {
    return { allowed: false, reason: 'BLACKLISTED' };
  }

  if (isWhitelistModeEnabled()) {
    const whitelisted = await queries.isPhoneNumberListed(whatsappNumber, 'WHITELIST');
    if (!whitelisted) {
      return { allowed: false, reason: 'NOT_WHITELISTED' };
    }
  }

  const skipLabels = getSkipLabels();
  if (skipLabels.length > 0 && merchantId) {
    const activeLabels = await queries.getActiveConversationLabels(merchantId);
    const hasSkipLabel = activeLabels.some((row) => skipLabels.includes(row.label.toLowerCase()));
    if (hasSkipLabel) {
      return { allowed: false, reason: 'LABEL_SKIP' };
    }
  }

  return { allowed: true, reason: null };
}

async function blacklistNumber(phoneNumber, reason, createdBy) {
  const row = await queries.addAccessControlEntry(phoneNumber, 'BLACKLIST', reason, createdBy);
  logger.info({ phoneNumber, reason }, 'Number blacklisted');
  return row;
}

async function whitelistNumber(phoneNumber, reason, createdBy) {
  const row = await queries.addAccessControlEntry(phoneNumber, 'WHITELIST', reason, createdBy);
  logger.info({ phoneNumber, reason }, 'Number whitelisted');
  return row;
}

async function removeFromList(phoneNumber) {
  return queries.removeAccessControlEntry(phoneNumber);
}

module.exports = {
  checkAccess,
  blacklistNumber,
  whitelistNumber,
  removeFromList,
  getSkipLabels,
  isWhitelistModeEnabled,
};
