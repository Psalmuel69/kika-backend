'use strict';

const { connection } = require('../config/redis');
const logger = require('../utils/logger');

// Long enough to comfortably outlast any retry window Meta might use,
// including delayed retries after extended downtime on our end — this
// is the durable guard BullMQ's jobId dedup can't fully provide, since
// that dedup only holds while the completed job is still retained in
// Redis (we prune completed jobs after 1h / 1000 count to bound memory).
const DEFAULT_TTL_SECONDS = Number(process.env.MESSAGE_IDEMPOTENCY_TTL_SECONDS || 172800); // 48h

function lockKey(messageId) {
  return `kika:idempotency:whatsapp-message:${messageId}`;
}

/**
 * Attempts to claim a WhatsApp message id as "being processed for the
 * first time." Uses Redis's atomic SET ... NX so a true simultaneous
 * race between two deliveries is resolved correctly by Redis itself —
 * exactly one caller gets `true`, no matter how close together the
 * requests arrive.
 *
 * @returns {Promise<boolean>} true if this is the first time we've seen
 *   this message id (caller should proceed); false if it's a duplicate
 *   (caller should skip — the transaction was already logged).
 */
async function acquireMessageLock(messageId, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!messageId) return true; // nothing to dedupe against — let it through rather than block on a malformed payload

  try {
    const result = await connection.set(lockKey(messageId), '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  } catch (err) {
    // If Redis itself is unreachable, fail open rather than silently
    // dropping every inbound message — BullMQ's jobId dedup still
    // provides a second layer of protection in that scenario.
    logger.error({ err: err.message, messageId }, 'Idempotency lock check failed — proceeding without it');
    return true;
  }
}

module.exports = { acquireMessageLock, DEFAULT_TTL_SECONDS };
