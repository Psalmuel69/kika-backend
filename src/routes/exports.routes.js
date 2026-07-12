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

const SAFE_DIR = path.resolve(
  path.join(process.env.RECEIPT_STORAGE_DIR || path.join(process.cwd(), 'public', 'receipts'), 'exports')
);

function resolveSafePath(filePath) {
  const resolved = path.resolve(SAFE_DIR, path.basename(filePath));
  if (!resolved.startsWith(SAFE_DIR)) return null;
  return resolved;
}

/**
 * Serves a CSV ledger export by its random 48-hex-char public token —
 * same unguessable-token + expiring-window model as receipts, and swept
 * by the same disk-cleanup job once expired.
 */
router.get(
  '/exports/:token.csv',
  receiptFetchLimiter,
  [param('token').isHexadecimal().isLength({ min: 48, max: 48 })],
  validate,
  asyncHandler(async (req, res) => {
    const dataExport = await queries.getDataExportByToken(req.params.token);
    if (!dataExport) return res.status(404).json({ error: 'Export not found or expired' });

    const resolvedPath = resolveSafePath(dataExport.file_path);
    if (!resolvedPath) return res.status(400).json({ error: 'Invalid export path' });

    if (!fsSync.existsSync(resolvedPath)) {
      logger.warn({ resolvedPath }, 'Export DB row exists but file is missing on disk');
      return res.status(410).json({ error: 'Export is no longer available' });
    }

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="kika_ledger_export.csv"`);
    return res.sendFile(resolvedPath, (err) => {
      if (err && !res.headersSent) {
        logger.error({ err: err.message, resolvedPath }, 'Failed to send export file');
        res.status(410).json({ error: 'Export is no longer available' });
      }
    });
  })
);

module.exports = router;
