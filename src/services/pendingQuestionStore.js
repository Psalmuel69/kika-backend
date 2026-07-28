'use strict';

const { connection } = require('../config/redis');

/**
 * A small, generic Redis-backed "I asked the merchant one question and
 * I'm holding a payload until they answer" store — the shared shape
 * behind worker.js's pending-debt-name, same-customer, and any future
 * single-outstanding-question flow. Each is a plain stash/consume pair
 * under a namespaced, per-merchant key with a TTL, so an unanswered
 * question doesn't sit around forever.
 *
 * This was previously copy-pasted (key-builder + connection.set/get/del
 * + JSON.parse-with-try/catch) once per flow — worth extracting once a
 * second copy existed, since each new copy is a place the same subtle
 * bug (e.g. forgetting to delete on read, or not TTL'ing) can be
 * reintroduced independently.
 */

const DEFAULT_TTL_SECONDS = 15 * 60;

function buildKey(namespace, merchantId) {
  return `kika:pending:${namespace}:${merchantId}`;
}

/**
 * Stashes a JSON-serializable payload for this merchant under the given
 * namespace, expiring after ttlSeconds if never consumed.
 */
async function stash(namespace, merchantId, payload, ttlSeconds = DEFAULT_TTL_SECONDS) {
  await connection.set(buildKey(namespace, merchantId), JSON.stringify(payload), 'EX', ttlSeconds);
}

/**
 * Reads and immediately clears whatever's stashed for this
 * namespace/merchant. Returns null if there's nothing pending, OR if
 * what's there is corrupt/unparseable (treated the same as "nothing
 * pending" — never throws back into the caller's message-handling path).
 */
async function consume(namespace, merchantId) {
  const key = buildKey(namespace, merchantId);
  const raw = await connection.get(key);
  if (!raw) return null;
  await connection.del(key);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** True if a question is currently pending for this namespace/merchant, without consuming it. Rarely needed (consume() is usually what you want), but useful for a quick existence check. */
async function has(namespace, merchantId) {
  const raw = await connection.get(buildKey(namespace, merchantId));
  return Boolean(raw);
}

module.exports = { stash, consume, has, DEFAULT_TTL_SECONDS };
