'use strict';

const crypto = require('crypto');
const queries = require('../db/queries');

const SHORT_CODE_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/l/I ambiguity

function generateShortCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += SHORT_CODE_ALPHABET[bytes[i] % SHORT_CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Creates a payment_links record for a gateway checkout URL and returns
 * the compact short_url that actually gets texted to the customer, e.g.
 * https://api.kikahq.com/l/aB3xQ9kM instead of Paystack's
 * long authorization_url. Retries on the astronomically unlikely
 * short_code collision.
 */
async function createShortPaymentLink({
  merchant,
  gateway,
  gatewayReference,
  fullUrl,
  amountKobo,
  currency,
  customerPhone,
  customerName,
  description,
  ttlHours = 24,
}) {
  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);

  for (let attempt = 0; attempt < 5; attempt++) {
    const shortCode = generateShortCode();
    const shortUrl = `${baseUrl}/l/${shortCode}`;
    try {
      const link = await queries.createPaymentLink({
        merchantId: merchant.id,
        gateway,
        gatewayReference,
        fullUrl,
        shortUrl,
        shortCode,
        amountKobo,
        currency,
        customerPhone,
        customerName,
        description,
        expiresAt,
      });
      return link;
    } catch (err) {
      if (err.code === '23505') continue; // unique_violation on short_code — retry with a new one
      throw err;
    }
  }
  throw new Error('Failed to generate a unique payment link short code after 5 attempts');
}

module.exports = { createShortPaymentLink, generateShortCode };
