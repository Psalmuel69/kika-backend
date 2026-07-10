'use strict';

const express = require('express');
const { param } = require('express-validator');
const queries = require('../db/queries');
const { validate, asyncHandler } = require('../middleware/validation');
const { receiptFetchLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

/**
 * Resolves a short payment link and redirects to the real gateway
 * checkout URL. Expired or unknown codes get a plain explanation instead
 * of a broken redirect, since this link may be days old by the time a
 * customer taps it from WhatsApp chat history.
 */
router.get(
  '/l/:code',
  receiptFetchLimiter,
  [param('code').isAlphanumeric().isLength({ min: 4, max: 20 })],
  validate,
  asyncHandler(async (req, res) => {
    const link = await queries.getPaymentLinkByShortCode(req.params.code);
    if (!link) return res.status(404).send('<h1>Payment link not found</h1>');

    if (link.status === 'EXPIRED' || (link.status === 'PENDING' && new Date(link.expires_at) < new Date())) {
      if (link.status === 'PENDING') await queries.markPaymentLinkStatus(link.id, 'EXPIRED');
      return res.status(410).send('<h1>This payment link has expired</h1><p>Please ask the merchant to send a new one.</p>');
    }
    if (link.status === 'PAID') {
      return res.status(200).send('<h1>This invoice has already been paid</h1><p>Thank you!</p>');
    }
    if (link.status === 'CANCELLED' || link.status === 'FAILED') {
      return res.status(410).send('<h1>This payment link is no longer active</h1>');
    }

    return res.redirect(302, link.full_url);
  })
);

module.exports = router;
