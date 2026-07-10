'use strict';

const express = require('express');
const path = require('path');
const fsSync = require('fs');
const { param } = require('express-validator');
const queries = require('../db/queries');
const { validate, asyncHandler } = require('../middleware/validation');
const { receiptFetchLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');

const router = express.Router();

const SAFE_DIR = path.resolve(process.env.RECEIPT_STORAGE_DIR || path.join(process.cwd(), 'public', 'receipts'));

function resolveSafePath(filePath) {
  const resolved = path.resolve(SAFE_DIR, path.basename(filePath));
  if (!resolved.startsWith(SAFE_DIR)) return null;
  return resolved;
}

/**
 * Sends a file, converting "doesn't exist on disk" into a clean 410
 * Gone instead of the default 500 res.sendFile would otherwise produce.
 * This is a deliberate defense-in-depth backstop: the cleanup sweep
 * (diskCleanupService) only ever deletes a file after its DB row's own
 * expires_at has passed, so this path should be rare — but a restore-
 * from-backup mismatch or manual intervention shouldn't crash the
 * request when it happens.
 */
function sendFileOrGone(req, res, resolvedPath, notFoundLabel) {
  if (!fsSync.existsSync(resolvedPath)) {
    logger.warn({ resolvedPath }, `${notFoundLabel} DB row exists but file is missing on disk`);
    return res.status(410).json({ error: `${notFoundLabel} is no longer available` });
  }
  return res.sendFile(resolvedPath, (err) => {
    if (err && !res.headersSent) {
      logger.error({ err: err.message, resolvedPath }, `Failed to send ${notFoundLabel} file`);
      res.status(410).json({ error: `${notFoundLabel} is no longer available` });
    }
  });
}

/**
 * Serves a receipt PNG by its random 48-hex-char public token — never by
 * database ID or filesystem path, so there is no sequential ID to
 * enumerate and no user-controlled path segment reaches the filesystem.
 */
router.get(
  '/receipts/:token.png',
  receiptFetchLimiter,
  [param('token').isHexadecimal().isLength({ min: 48, max: 48 })],
  validate,
  asyncHandler(async (req, res) => {
    const receipt = await queries.getReceiptByToken(req.params.token);
    if (!receipt) return res.status(404).json({ error: 'Receipt not found or expired' });

    const resolvedPath = resolveSafePath(receipt.file_path);
    if (!resolvedPath) return res.status(400).json({ error: 'Invalid receipt path' });

    res.set('Cache-Control', 'private, max-age=3600');
    return sendFileOrGone(req, res, resolvedPath, 'Receipt');
  })
);

/**
 * Serves a Monthly Digest card PNG — same unguessable-token model as
 * receipts, backed by the digest_cards table instead.
 */
router.get(
  '/digest-cards/:token.png',
  receiptFetchLimiter,
  [param('token').isHexadecimal().isLength({ min: 48, max: 48 })],
  validate,
  asyncHandler(async (req, res) => {
    const card = await queries.getDigestCardByToken(req.params.token);
    if (!card) return res.status(404).json({ error: 'Digest card not found or expired' });

    const resolvedPath = resolveSafePath(card.file_path);
    if (!resolvedPath) return res.status(400).json({ error: 'Invalid digest card path' });

    res.set('Cache-Control', 'private, max-age=3600');
    return sendFileOrGone(req, res, resolvedPath, 'Digest card');
  })
);

module.exports = router;
