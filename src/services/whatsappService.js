'use strict';

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');

const client = axios.create({
  baseURL: `${process.env.WHATSAPP_API_BASE}/${process.env.WHATSAPP_PHONE_NUMBER_ID}`,
  timeout: 8000,
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  },
});

/**
 * Verifies the X-Hub-Signature-256 header Meta sends on every webhook
 * delivery, using a timing-safe comparison. Rejects the request outright
 * if this fails — never process a payload we can't authenticate as
 * genuinely from Meta's infrastructure.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = crypto
    .createHmac('sha256', process.env.WHATSAPP_APP_SECRET)
    .update(rawBody)
    .digest('hex');
  const provided = signatureHeader.replace('sha256=', '');

  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Generic WhatsApp quick-reply button message — up to 3 buttons, 20-char
 * title limit per WhatsApp's own constraints. Every other "pick one of a
 * few options" flow (plan selection, consent, Friday debt amnesty)
 * routes through this single function.
 */
async function sendButtonMessage(toWhatsappNumber, { bodyText, footerText, buttons }) {
  return safeSend({
    messaging_product: 'whatsapp',
    to: toWhatsappNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      footer: footerText ? { text: footerText } : undefined,
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  });
}

/**
 * Presents pricing tiers as tappable WhatsApp reply buttons in response to
 * the generic UPGRADE keyword, so the merchant picks a plan instead of
 * guessing which keyword to type.
 */
async function sendPlanSelectionButtons(toWhatsappNumber, buttons) {
  return sendButtonMessage(toWhatsappNumber, {
    bodyText: '\ud83d\ude80 *Upgrade Kika*\n\nChoose a plan to continue:',
    buttons,
  });
}

/**
 * First-contact consent prompt. WhatsApp's "button" interactive type only
 * supports quick-reply buttons — it can't mix in a URL button alongside
 * them in the same message (that's the separate `cta_url` type, which
 * only supports a single button and nothing else). So the Terms link is
 * placed as plain text in the body (WhatsApp auto-links URLs) alongside
 * one quick-reply button for "I AGREE" — both asks satisfied within the
 * platform's actual constraints, in a single message.
 */
async function sendConsentPrompt(toWhatsappNumber) {
  const termsUrl = process.env.TERMS_URL || 'https://kika-book.example.com/terms';
  return sendButtonMessage(toWhatsappNumber, {
    bodyText:
      'Welcome to *Kika-Book*! Your automatic business notebook inside WhatsApp. No more lost paper, forgotten customer debts, or manual calculations. Kika records your sales, tracks inventory, and types customer receipts instantly \u2014 just from a normal chat text.\n\n\ud83d\udd12 *Before we start, our security agreement:*\nWe encrypt your customer records and *never* share your shop details with tax collectors or external parties. By using Kika, you agree to our Terms & Privacy Policy:\n' +
      termsUrl,
    footerText: 'Tap I AGREE to activate your free business notebook',
    buttons: [{ id: 'AGREE_TERMS', title: 'I AGREE \ud83d\udc47' }],
  });
}

/**
 * Friday afternoon "Polite Mode" prompt — the merchant opts in per week
 * rather than Kika messaging debtors automatically, since we can't be
 * sure every captured phone number is one WhatsApp is happy for us to
 * message unprompted.
 */
async function sendFridayAmnestyPrompt(toWhatsappNumber, { debtorCount, totalOwedLabel }) {
  return sendButtonMessage(toWhatsappNumber, {
    bodyText: `\ud83d\udc4b Happy Friday! You have *${debtorCount}* customer${debtorCount === 1 ? '' : 's'} with an outstanding balance, totalling *${totalOwedLabel}*.\n\nWant Kika to send them a polite, friendly reminder before the weekend?`,
    buttons: [
      { id: 'AMNESTY_SEND', title: 'Send Reminders \ud83d\udc4d' },
      { id: 'AMNESTY_SKIP', title: 'Not Now' },
    ],
  });
}

/**
 * Sends the generated receipt card image inline into the chat stream by
 * URL (the safe, expiring, unguessable link produced by receiptService).
 */
async function sendReceiptImage(toWhatsappNumber, imageUrl, caption) {
  return safeSend({
    messaging_product: 'whatsapp',
    to: toWhatsappNumber,
    type: 'image',
    image: { link: imageUrl, caption },
  });
}

/**
 * Sends a document (e.g. the CSV ledger export) by URL, WhatsApp's
 * equivalent of an email attachment.
 */
async function sendDocument(toWhatsappNumber, { link, filename, caption }) {
  return safeSend({
    messaging_product: 'whatsapp',
    to: toWhatsappNumber,
    type: 'document',
    document: { link, filename, caption },
  });
}

/**
 * Sends the Paystack checkout link inline as a plain text message with
 * a preview so WhatsApp renders a rich link card.
 */
async function sendPaymentLink(toWhatsappNumber, paymentUrl, amountLabel) {
  return safeSend({
    messaging_product: 'whatsapp',
    to: toWhatsappNumber,
    type: 'text',
    text: {
      preview_url: true,
      body: `🚀 *Kika Upgrade*\n\nAmount: ${amountLabel}\nComplete your payment securely here:\n${paymentUrl}\n\nYour new features activate instantly the second your payment is verified!`,
    },
  });
}

/**
 * Sends the Monthly Digest as an image with a tappable "View Full Report"
 * call-to-action button linking out to the hosted full report page —
 * matches the card + link pattern shown in the product's WhatsApp UI.
 */
async function sendMonthlyDigestCard(toWhatsappNumber, { imageUrl, bodyText, reportUrl }) {
  return safeSend({
    messaging_product: 'whatsapp',
    to: toWhatsappNumber,
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      header: { type: 'image', image: { link: imageUrl } },
      body: { text: bodyText },
      footer: { text: 'Generated by Kika AI' },
      action: {
        name: 'cta_url',
        parameters: { display_text: 'View Full Report', url: reportUrl },
      },
    },
  });
}

async function safeSend(payload) {
  try {
    const res = await client.post('/messages', payload);
    return res.data;
  } catch (err) {
    logger.error(
      { err: err.response?.data || err.message, to: payload.to },
      'WhatsApp send failed'
    );
    throw err;
  }
}

module.exports = {
  verifyWebhookSignature,
  sendTextMessage,
  sendReceiptImage,
  sendDocument,
  sendPaymentLink,
  sendButtonMessage,
  sendPlanSelectionButtons,
  sendConsentPrompt,
  sendFridayAmnestyPrompt,
  sendMonthlyDigestCard,
};
