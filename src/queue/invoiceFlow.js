'use strict';

// ---------------------------------------------------------------------------
// Multi-item invoice creation ("new invoice for Adaeze" -> optional phone
// ask -> item lines -> DONE -> preview -> Image/PDF/Cancel). The finished
// invoice card + payment link are handed to the MERCHANT only — never sent
// to the customer directly. Plain deterministic logic throughout, no AI.
//
// Extracted out of worker.js as its own module: this is a cleanly bounded
// conversation flow (one merchant, one invoice-in-progress at a time,
// state carried entirely in merchants.invoice_* columns) with a small,
// stable set of dependencies, making it a natural first piece to split
// out of what had become an increasingly large single dispatch file.
// ---------------------------------------------------------------------------

const queries = require('../db/queries');
const receiptService = require('../services/receiptService');
const whatsappService = require('../services/whatsappService');
const ledgerParser = require('../services/ledgerParser');
const engagementService = require('../services/engagementService');
const logger = require('../utils/logger');
const { formatAmount } = require('../utils/currency');

async function startInvoiceCreation(merchant, whatsappNumber, customerName, customerPhone) {
  if (!customerName) {
    // Bare "create invoice"/"new invoice" with no name attached — rather
    // than silently starting a flow (or doing nothing at all), tell the
    // merchant the exact format so their next message succeeds on the
    // first try. No flow state is started here; invoice_awaiting_stage
    // stays untouched until they resend with a name.
    await whatsappService.sendTextMessage(
      whatsappNumber,
      `To create an invoice, include the customer's name:\n\n*Create invoice for <customer name>*\nor\n*New invoice <customer name>*`
    );
    return;
  }
  if (customerPhone) {
    // Phone came bundled with the trigger message ("new invoice for
    // Adaeze 08012345678") — go straight to item collection.
    await queries.startInvoiceFlow(merchant.id, customerName, customerPhone);
    await whatsappService.sendTextMessage(
      whatsappNumber,
      `Creating invoice for ${customerName}. Add your items \u2014 type each one like:\n\n_Quantity x Item name x Price (per item)_\n\nType *done* when finished.`
    );
    return;
  }
  // No phone yet — ask for it before collecting items, so it can be
  // saved against the customer's record and shown on the invoice's
  // "Billed to" block (see queries.startInvoiceAwaitingPhone and
  // handleInvoicePhoneReply below).
  await queries.startInvoiceAwaitingPhone(merchant.id, customerName);
  await whatsappService.sendTextMessage(
    whatsappNumber,
    `Creating invoice for ${customerName}. What's their phone number? (Reply *SKIP* if you'd rather not add one.)`
  );
}

const INVOICE_PHONE_SKIP_RE = /^skip$/i;

/** Resolves the AWAITING_PHONE stage — a phone number, SKIP, or CANCEL. Anything else is asked again rather than guessed at. */
async function handleInvoicePhoneReply(merchant, whatsappNumber, rawMessage) {
  const text = rawMessage.trim();
  if (/^cancel$/i.test(text)) {
    await queries.clearInvoiceFlow(merchant.id);
    await whatsappService.sendTextMessage(whatsappNumber, 'Invoice cancelled.');
    return;
  }

  let phone = null;
  if (!INVOICE_PHONE_SKIP_RE.test(text)) {
    const match = text.match(/\+\d{8,15}\b|(?:\+?234|0)([789]\d{9})\b/);
    if (!match) {
      await whatsappService.sendTextMessage(
        whatsappNumber,
        `That doesn't look like a phone number \u2014 try again (e.g. 08012345678, or +233... for other countries), or reply *SKIP* to continue without one.`
      );
      return;
    }
    phone = match[1] ? `+234${match[1]}` : match[0];
  }

  await queries.setInvoiceCustomerPhoneAndStartItems(merchant.id, phone);
  await whatsappService.sendTextMessage(
    whatsappNumber,
    `Got it! Add your items \u2014 type each one like:\n\n_Quantity x Item name x Price (per item)_\n\nType *done* when finished.`
  );
}

// Shared invoice item line renderer — used for the running "Added: ..."
// confirmation, the pre-confirm preview, and (indirectly) the final
// invoice card. Always shows the per-item price in brackets alongside
// the line total, so the customer-facing invoice is unambiguous about
// unit cost vs. total ("3\u00d7 bags rice (\u20a61,500/unit) \u2014 \u20a64,500"),
// not just a lump sum.
//
// Unlike ordinary ledger entries, an invoice is a document handed to
// the CUSTOMER — it doesn't touch the merchant's own accounting, so a
// merchant is free to bill in whatever currency suits that particular
// customer (see ledgerParser.parseInvoiceItemLine's currency tagging).
// `fallbackCurrency` (the merchant's own account currency) is only used
// when an item line didn't state one explicitly.
function formatInvoiceItemLabel(item, fallbackCurrency = 'NGN') {
  const currency = item.currency || fallbackCurrency;
  const label = item.unit ? `${item.unit} ${item.name}` : item.name;
  const unitPrice = formatAmount(item.unitPriceKobo, currency);
  const lineTotal = formatAmount(item.totalKobo, currency);
  return `${item.quantity}\u00d7 ${label} (${unitPrice}/unit) \u2014 ${lineTotal}`;
}

function buildInvoicePreviewText(customerName, items, totalKobo, fallbackCurrency = 'NGN') {
  const lines = [`Here's your invoice preview:`, '', `*Invoice for ${customerName}*`, ''];
  for (const item of items) {
    lines.push(formatInvoiceItemLabel(item, fallbackCurrency));
  }
  // Invoices are expected to be single-currency in practice (a merchant
  // billing one customer for one set of items) — the total is shown in
  // whichever currency the first item used, or the merchant's own
  // account currency if none of the items specified one.
  const totalCurrency = items[0]?.currency || fallbackCurrency;
  lines.push('', `*Total: ${formatAmount(totalKobo, totalCurrency)}*`);
  return lines.join('\n');
}

async function handleInvoiceItemsReply(merchant, whatsappNumber, rawMessage) {
  const command = ledgerParser.detectCommand(rawMessage);
  if (command === 'DONE') {
    const items = merchant.invoice_pending_items || [];
    if (items.length === 0) {
      await whatsappService.sendTextMessage(
        whatsappNumber,
        'You haven\u2019t added any items yet \u2014 send at least one like "2 x iPhone charger x 4500" or "3 bags rice x 15k" (price is per item), or type CANCEL to stop.'
      );
      return;
    }
    const totalKobo = items.reduce((sum, it) => sum + Number(it.totalKobo), 0);
    await queries.setInvoiceAwaitingStage(merchant.id, 'CONFIRM');
    await whatsappService.sendTextMessage(
      whatsappNumber,
      buildInvoicePreviewText(merchant.invoice_customer_name, items, totalKobo, merchant.default_currency)
    );
    await whatsappService.sendButtonMessage(whatsappNumber, {
      bodyText: 'Generate this invoice as an image or a PDF?',
      buttons: [
        { id: 'INVOICE_FORMAT_IMAGE', title: 'Image' },
        { id: 'INVOICE_FORMAT_PDF', title: 'PDF' },
        { id: 'INVOICE_FORMAT_CANCEL', title: 'Cancel' },
      ],
    });
    return;
  }

  if (/^cancel$/i.test(rawMessage.trim())) {
    await queries.clearInvoiceFlow(merchant.id);
    await whatsappService.sendTextMessage(whatsappNumber, 'Invoice cancelled.');
    return;
  }

  const item = ledgerParser.parseInvoiceItemLine(rawMessage);
  if (!item) {
    await whatsappService.sendTextMessage(
      whatsappNumber,
      'Didn\u2019t catch that \u2014 add items like "2 x iPhone charger x 4500" or "3 bags rice x 15k" (Quantity + item, then price PER ITEM), or type *done* when finished.'
    );
    return;
  }
  await queries.addInvoicePendingItem(merchant.id, item);
  await whatsappService.sendTextMessage(whatsappNumber, `Added: ${formatInvoiceItemLabel(item, merchant.default_currency)}. Send another item, or type *done*.`);
}

const INVOICE_FORMAT_BY_BUTTON_ID = {
  INVOICE_FORMAT_IMAGE: 'image',
  INVOICE_FORMAT_PDF: 'pdf',
  INVOICE_FORMAT_CANCEL: 'cancel',
};

async function handleInvoiceConfirmReply(merchant, whatsappNumber, rawMessage) {
  const text = String(rawMessage || '').trim();
  let format = INVOICE_FORMAT_BY_BUTTON_ID[text.toUpperCase()] || null;
  if (!format) {
    if (/^pdf$/i.test(text)) format = 'pdf';
    else if (/^image$/i.test(text)) format = 'image';
    // A plain "yes" (someone typing instead of tapping a button) keeps
    // the original default of an image, for backward compatibility.
    else if (engagementService.isAffirmative(text)) format = 'image';
    else format = 'cancel';
  }

  if (format === 'cancel') {
    await queries.clearInvoiceFlow(merchant.id);
    await whatsappService.sendTextMessage(whatsappNumber, 'No problem \u2014 invoice discarded. Say "new invoice for <name>" any time to start another.');
    return;
  }

  const items = merchant.invoice_pending_items || [];
  const totalKobo = items.reduce((sum, it) => sum + Number(it.totalKobo), 0);
  const invoiceNumber = await queries.claimNextInvoiceNumber(merchant.id);

  // Invoices are a document only — Kika generates the card and hands it
  // to the merchant; how the customer actually pays (bank transfer,
  // cash, their own POS, etc.) is between the two of them. Paystack is
  // reserved for merchant subscription upgrades only (see
  // handleTierPurchase / paystackService.createUpgradeInvoice) — no
  // payment link is created here, so there's nothing for Kika to track
  // or auto-confirm on this side.
  let card;
  try {
    card =
      format === 'pdf'
        ? await receiptService.generateInvoicePdf({
            merchant,
            invoiceNumber,
            customerName: merchant.invoice_customer_name,
            customerPhone: merchant.invoice_customer_phone,
            items,
            totalKobo,
          })
        : await receiptService.generateInvoiceCard({
            merchant,
            invoiceNumber,
            customerName: merchant.invoice_customer_name,
            customerPhone: merchant.invoice_customer_phone,
            items,
            totalKobo,
          });
  } catch (err) {
    logger.error(
      { err: err.message, httpStatus: err.response?.status, responseBody: err.response?.data, merchantId: merchant.id, invoiceNumber, format },
      'Invoice generation failed'
    );
    await whatsappService.sendTextMessage(
      whatsappNumber,
      "Something went wrong generating that invoice \u2014 nothing was lost, your items are still here. Reply *image* or *pdf* to try again, or CANCEL to stop."
    );
    return;
  }

  await queries.clearInvoiceFlow(merchant.id);

  // Handed to the MERCHANT only — Kika never messages the customer
  // directly with an invoice (same policy as loyalty milestones — see
  // loyaltyService.js). The merchant forwards it themselves, on their
  // own terms, and arranges payment directly with the customer.
  const invoiceCurrency = items[0]?.currency || merchant.default_currency;
  const caption = `Here\u2019s the invoice for ${merchant.invoice_customer_name} \u2014 you can share this with them. Payment is between you and your customer; once they've paid, just log it here as usual (e.g. "${merchant.invoice_customer_name} paid ${formatAmount(totalKobo, invoiceCurrency)}").`;
  try {
    if (format === 'pdf') {
      await whatsappService.sendDocument(whatsappNumber, { link: card.url, filename: `invoice-${invoiceNumber}.pdf`, caption });
    } else {
      await whatsappService.sendReceiptImage(whatsappNumber, card.url, caption);
    }
  } catch (err) {
    // The invoice card WAS generated and saved at this point
    // (queries.clearInvoiceFlow already ran) \u2014 only the WhatsApp
    // delivery of the image failed. Fall back to the plain-text link so
    // the merchant still gets something usable instead of nothing,
    // rather than losing the whole invoice to a media-send hiccup.
    logger.error({ err: err.message, httpStatus: err.response?.status, responseBody: err.response?.data, merchantId: merchant.id, invoiceNumber }, 'Invoice card image failed to send; falling back to text');
    await whatsappService.sendTextMessage(
      whatsappNumber,
      `Here\u2019s the invoice for ${merchant.invoice_customer_name} (the image didn\u2019t send, here\u2019s the link instead):\n\n${card.url}`
    );
  }
}

module.exports = {
  startInvoiceCreation,
  handleInvoicePhoneReply,
  handleInvoiceItemsReply,
  handleInvoiceConfirmReply,
};
