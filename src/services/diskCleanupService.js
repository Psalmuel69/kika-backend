'use strict';

const fs = require('fs/promises');
const queries = require('../db/queries');
const logger = require('../utils/logger');
const auditLogService = require('./auditLogService');

/**
 * Deletes a file, treating "already gone" as success rather than an
 * error — the sweep is idempotent by design (see markXFileDeleted),
 * but this tolerance also covers manual cleanup or a restored-from-backup
 * mismatch without logging noise for something that isn't actually wrong.
 */
async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
    return { deleted: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { deleted: true }; // already gone — fine
    return { deleted: false, error: err };
  }
}

/**
 * The production fix for local-disk exhaustion under volume — but driven
 * by each row's OWN already-documented `expires_at` (set from
 * RECEIPT_URL_TTL_HOURS at generation time), not an arbitrary fixed age.
 * This is what lets the sweep run frequently (every 15 minutes, via
 * scheduler.js) without ever deleting a file before the lifetime already
 * promised to whoever holds its URL — receipts sent inline to WhatsApp,
 * the Monthly Digest card, and the underlying image WhatsApp itself
 * fetches when relaying the message all keep working for the full
 * window; only files whose window has already elapsed are removed.
 *
 * Marks `file_deleted_at` on each row after a successful delete so a
 * later run never re-examines it — the sweep stays cheap indefinitely
 * regardless of how large the historical row count grows.
 */
async function pruneExpiredAssets() {
  const [expiredReceipts, expiredDigestCards] = await Promise.all([
    queries.getExpiredUncleanedReceipts(),
    queries.getExpiredUncleanedDigestCards(),
  ]);

  let deletedCount = 0;
  let errorCount = 0;

  for (const row of expiredReceipts) {
    const result = await safeUnlink(row.file_path);
    if (result.deleted) {
      await queries.markReceiptFileDeleted(row.id);
      deletedCount++;
    } else {
      errorCount++;
      logger.error({ err: result.error.message, receiptId: row.id, filePath: row.file_path }, 'Failed to prune expired receipt file');
    }
  }

  for (const row of expiredDigestCards) {
    const result = await safeUnlink(row.file_path);
    if (result.deleted) {
      await queries.markDigestCardFileDeleted(row.id);
      deletedCount++;
    } else {
      errorCount++;
      logger.error({ err: result.error.message, digestCardId: row.id, filePath: row.file_path }, 'Failed to prune expired digest card file');
    }
  }

  if (deletedCount > 0 || errorCount > 0) {
    logger.info({ deletedCount, errorCount }, 'Storage scratchpad cleanup sweep complete');
    await auditLogService.logEvent({
      actorType: 'SYSTEM',
      actorId: 'scheduler',
      action: 'storage.cleanup_sweep',
      metadata: { deletedCount, errorCount },
    });
  }

  return { deletedCount, errorCount };
}

module.exports = { pruneExpiredAssets };
