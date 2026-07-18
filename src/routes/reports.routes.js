'use strict';

const express = require('express');
const { param } = require('express-validator');
const queries = require('../db/queries');
const { renderReportHtml } = require('../services/fullReportService');
const { validate, asyncHandler } = require('../middleware/validation');
const { receiptFetchLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

/**
 * Serves the "View Full Report" web page. The report is rendered from a
 * data snapshot taken at generation time (not live-queried), so the page
 * stays consistent with what the merchant was told in their Monthly
 * Digest even if new ledger entries come in afterward. Looked up by a
 * 48-hex-char unguessable token, same security model as receipts.
 */
router.get(
  '/reports/:token',
  receiptFetchLimiter,
  [param('token').isHexadecimal().isLength({ min: 48, max: 48 })],
  validate,
  asyncHandler(async (req, res) => {
    const report = await queries.getMonthlyReportByToken(req.params.token);
    if (!report) return res.status(404).send('<h1>Report not found or expired</h1>');

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'private, max-age=3600');
    return res.send(renderReportHtml(report.report_data));
  })
);

module.exports = router;
