'use strict';

const rateLimit = require('express-rate-limit');

/**
 * Generous but bounded limit for the WhatsApp webhook — Meta itself
 * retries deliveries, and a single active merchant chatting quickly
 * should never trip this, but it caps the blast radius of any abusive
 * or spoofed traffic reaching the public endpoint before signature
 * verification even runs.
 */
const whatsappWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

/**
 * Tighter limit for the Paystack webhook — legitimate traffic here is
 * low-volume (one event per completed payment).
 */
const paystackWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Public receipt-image fetch endpoint — protects against token
 * brute-forcing (tokens are 24 random bytes, so this is defense in depth).
 */
const receiptFetchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { whatsappWebhookLimiter, paystackWebhookLimiter, receiptFetchLimiter };
