'use strict';

const queries = require('../db/queries');
const logger = require('../utils/logger');

/**
 * Writes an audit log entry without ever throwing back into the caller
 * — logging is important, but it must never be the reason a real
 * request fails. Callers can `await` this if they want to guarantee
 * ordering, or fire-and-forget it with `.catch()` already handled here.
 */
async function log(entry) {
  try {
    await queries.writeAuditLog(entry);
  } catch (err) {
    logger.error({ err: err.message, action: entry?.action }, 'Failed to write audit log entry');
  }
}

/** Convenience wrapper for a business-event audit entry (not tied to an HTTP request). */
function logEvent({ merchantId, actorType = 'SYSTEM', actorId, action, metadata }) {
  return log({ merchantId, actorType, actorId, action, metadata, isSuccess: true });
}

module.exports = { log, logEvent };
