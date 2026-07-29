'use strict';

const logger = require('../utils/logger');

function hasAiProviderConfigured() {
  return Boolean(process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY);
}

/**
 * A merchant adding invoice items is asked for a specific structure
 * ("quantity x item name x price"). Most replies match it — this is
 * only reached for the minority that don't. Rather than immediately
 * rejecting those with "didn't catch that," this makes one AI attempt
 * to recognize a genuine item description phrased differently (e.g. "3
 * bags of rice, 15k each") and extract it properly.
 *
 * Critically, the model is explicitly asked to say NO rather than
 * guess when the message isn't really an item at all — a question, an
 * attempt to log an ordinary sale instead of an invoice item, a
 * command, small talk. isInvoiceItem: false is a first-class, expected
 * response, not a failure — this is what stops a free-form message
 * that was never meant to be an invoice item from ever being
 * misrecorded as one.
 */
const EXTRACT_INVOICE_ITEM_TOOL = {
  type: 'function',
  function: {
    name: 'extract_invoice_item',
    description: "Extract one invoice line item from a merchant's free-form reply, if one is genuinely present.",
    parameters: {
      type: 'object',
      properties: {
        isInvoiceItem: {
          type: 'boolean',
          description:
            'True ONLY if the merchant is clearly describing an item, a quantity, and a price per unit to add to the invoice they are building. False for anything else — a question, small talk, a command, an attempt to log an unrelated sale/expense/debt instead, or a message too ambiguous to confidently extract quantity+name+price from.',
        },
        itemName: { type: ['string', 'null'], description: 'Just the item/service name, e.g. "rice" or "iPhone charger".' },
        quantity: { type: ['number', 'null'] },
        unit: { type: ['string', 'null'], description: 'e.g. "bags", "pcs" — null if none was stated.' },
        unitPriceMajor: {
          type: ['number', 'null'],
          description: 'Price PER UNIT as a face-value number in whatever currency was stated (e.g. 15000 for "15k each"). Never the line total divided or multiplied — the price for ONE unit, exactly as the merchant would have typed it in the standard format.',
        },
        currency: {
          type: ['string', 'null'],
          enum: ['NGN', 'USD', 'GBP', 'EUR'],
          description: 'Only set if the merchant explicitly used a foreign currency symbol/word; null otherwise.',
        },
      },
      required: ['isInvoiceItem'],
    },
  },
};

/**
 * Returns a parsed invoice item (same shape as
 * ledgerParser.parseInvoiceItemLine) if the AI confidently recognizes
 * one in `rawMessage`, or null if it doesn't — either because the AI
 * declined (isInvoiceItem: false, or a "yes" with unusable numbers) or
 * because no AI provider is configured / the call failed. Never throws;
 * the caller falls back to its own "didn't catch that" messaging on
 * null, same as if this had never been called at all.
 */
async function extractInvoiceItemWithAI(rawMessage) {
  if (!hasAiProviderConfigured() || !rawMessage) return null;
  try {
    const openaiService = require('./openaiService');
    const { toolCall } = await openaiService.chatCompletion({
      systemPrompt:
        'A small merchant is building an invoice and was asked to add items in the format "quantity x item name x price per item" (e.g. "3 bags rice x 15k"). Their reply below does not match that exact template. Determine whether they are still clearly trying to add ONE item — just phrased differently (e.g. "3 bags of rice, 15k each", "iPhone charger, 2 of them, 4500 naira apiece") — and extract it if so. If the message is anything else at all, set isInvoiceItem to false rather than guessing. Respond only by calling extract_invoice_item.',
      userText: rawMessage,
      tools: [EXTRACT_INVOICE_ITEM_TOOL],
    });

    const args = toolCall?.arguments;
    if (!args || !args.isInvoiceItem) return null;

    const quantity = Number(args.quantity);
    const unitPriceMajor = Number(args.unitPriceMajor);
    if (!args.itemName || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPriceMajor) || unitPriceMajor <= 0) {
      // The model said "yes, this is an item" but didn't actually supply
      // usable numbers — treat exactly like a "no" rather than filling
      // in a guess for the missing piece.
      return null;
    }

    return {
      name: String(args.itemName).trim().slice(0, 60),
      unit: args.unit ? String(args.unit).trim().slice(0, 30) : null,
      quantity,
      currency: args.currency || null,
      unitPriceKobo: Math.round(unitPriceMajor * 100),
      totalKobo: Math.round(unitPriceMajor * 100) * quantity,
    };
  } catch (err) {
    logger.error({ err: err.message }, 'AI invoice-item extraction fallback failed');
    return null;
  }
}

module.exports = { extractInvoiceItemWithAI };
