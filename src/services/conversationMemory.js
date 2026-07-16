'use strict';

const { connection: redis } = require('../config/redis');
const logger = require('../utils/logger');

const MAX_MESSAGES = Number(process.env.CONVERSATION_MEMORY_MAX_MESSAGES || 20);
const TTL_SECONDS = Number(process.env.CONVERSATION_MEMORY_TTL_SECONDS || 60 * 60 * 24 * 7); // 7 days

function key(merchantId) {
  return `conversation:${merchantId}`;
}

/**
 * Appends one turn to a merchant's short-term conversation memory.
 * Deliberately NOT called for every message — see aiTransactionParser.js
 * for the rule: store conversational exchanges (clarifying questions,
 * general Q&A) so the AI can follow up naturally, but skip storing
 * routine transaction confirmations, since the ledger in Postgres is
 * always the source of truth for actual transaction data and re-stating
 * it in memory only bloats the prompt for no benefit.
 */
async function addMessage(merchantId, role, content) {
  if (!content) return; // nothing useful to remember
  try {
    const redisKey = key(merchantId);
    await redis.rpush(redisKey, JSON.stringify({ role, content }));
    await redis.ltrim(redisKey, -MAX_MESSAGES, -1);
    await redis.expire(redisKey, TTL_SECONDS);
  } catch (err) {
    // A memory-write failure should never break the actual conversation
    // turn that's in flight — worst case, the next reply just has less
    // context than it ideally would.
    logger.error({ err: err.message, merchantId }, 'Failed to append conversation memory');
  }
}

async function getHistory(merchantId) {
  try {
    const messages = await redis.lrange(key(merchantId), 0, -1);
    return messages.map((m) => JSON.parse(m));
  } catch (err) {
    logger.error({ err: err.message, merchantId }, 'Failed to read conversation memory');
    return [];
  }
}

async function clearHistory(merchantId) {
  try {
    await redis.del(key(merchantId));
  } catch (err) {
    logger.error({ err: err.message, merchantId }, 'Failed to clear conversation memory');
  }
}

module.exports = { addMessage, getHistory, clearHistory, MAX_MESSAGES, TTL_SECONDS };