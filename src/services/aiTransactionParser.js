'use strict';

const openaiService = require('./openaiService');
const { KIKA_SYSTEM_PROMPT, SUPPORTED_LANGUAGES } = require('../config/aiPersona');
const logger = require('../utils/logger');

const RECORD_TRANSACTION_TOOL = {
  type: 'function',
  function: {
    name: 'record_transaction',
    description:
      "Call this ONLY when the merchant's message clearly describes a sale, an expense, a customer debt, or a payment toward an existing debt — including slang, Pidgin, or indirect phrasing like 'I dashed Amaka 5k' or 'wired 10k for fuel'. Do not call this for greetings, questions, or anything that isn't a transaction.",
    parameters: {
      type: 'object',
      properties: {
        entryType: {
          type: 'string',
          enum: ['CREDIT', 'DEBIT', 'DEBT', 'DEBT_SETTLEMENT'],
          description:
            'CREDIT = a fully-paid sale (money coming in). DEBIT = an expense (money going out). DEBT = a sale where the customer still owes some or all of it. DEBT_SETTLEMENT = a payment received against an existing prior debt, not a new sale.',
        },
        description: { type: 'string', description: 'Short human-readable description of the transaction, e.g. "Fuel purchase" or "Rice x2 bags".' },
        counterpartyName: { type: ['string', 'null'], description: 'The customer or supplier name mentioned, or null if none.' },
        counterpartyPhone: { type: ['string', 'null'], description: 'E.164 Nigerian phone number if one was mentioned in the message, else null.' },
        itemName: { type: ['string', 'null'] },
        itemQuantity: { type: ['number', 'null'] },
        itemUnit: { type: ['string', 'null'], description: 'e.g. "bags", "cartons", "pieces" — null if not applicable.' },
        totalNaira: { type: 'number', description: 'Total value of the transaction, in Naira (not kobo).' },
        paidNaira: { type: 'number', description: 'Amount actually paid/received right now, in Naira.' },
        balanceNaira: { type: 'number', description: 'Amount still owed after this transaction, in Naira. 0 if fully settled.' },
        detectedLanguage: {
          type: 'string',
          enum: SUPPORTED_LANGUAGES,
          description: "The language/dialect the merchant's message was written in.",
        },
        confidence: {
          type: 'number',
          description:
            'Your own confidence (0.0-1.0) that this message really describes a transaction with the amounts you extracted, rather than an ambiguous or unclear message. Be honest — if the phrasing is vague or the amount is a guess, score it low rather than high.',
        },
      },
      required: ['entryType', 'description', 'totalNaira', 'paidNaira', 'balanceNaira', 'detectedLanguage', 'confidence'],
    },
  },
};

// Below this confidence, Kika treats the message as unclear rather than
// risking a wrong entry in the merchant's ledger — matching the
// "graceful fallback" behavior: better to ask the merchant to rephrase
// than to silently log a guessed amount.
const MIN_CONFIDENCE_THRESHOLD = Number(process.env.AI_MIN_CONFIDENCE_THRESHOLD || 0.65);

function toKobo(naira) {
  const n = Number(naira);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function normalizeToolCallArgs(args) {
  if (!args) return null;

  const items =
    args.itemName != null
      ? [{ name: String(args.itemName), quantity: Number(args.itemQuantity) || 1, unit: args.itemUnit || 'units' }]
      : [];

  return {
    entryType: args.entryType,
    description: args.description || (items[0] ? `${items[0].name} x${items[0].quantity} ${items[0].unit}` : 'Transaction'),
    counterpartyName: args.counterpartyName || null,
    counterpartyPhone: args.counterpartyPhone || null,
    items,
    totalKobo: toKobo(args.totalNaira),
    paidKobo: toKobo(args.paidNaira),
    balanceKobo: toKobo(args.balanceNaira),
  };
}

/**
 * The hybrid fallback: called only when the fast regex parser
 * (ledgerParser.parseLedgerMessage) has already returned null and the
 * message isn't a recognized command. Sends the raw text (and, for
 * multimodal messages, an image) to OpenAI with the record_transaction
 * tool available.
 *
 * Returns one of three shapes:
 *   { parsed: {...} }                        — a transaction was extracted
 *   { parsed: null, conversationalReply, detectedLanguage } — in-persona reply
 *   { parsed: null, error: true }             — the AI call itself failed;
 *                                                caller must use the fixed
 *                                                fallback text as a safety net
 */
async function parseWithAI(rawText, { imageBase64 } = {}) {
  if (!process.env.OPENAI_API_KEY) {
    logger.warn('Neither OPENAI_API_KEY nor GEMINI_API_KEY configured — skipping AI fallback, using fixed fallback reply');
    return { parsed: null, error: true };
  }

  try {
    const { toolCall, text } = await openaiService.chatCompletion({
      systemPrompt: KIKA_SYSTEM_PROMPT,
      userText: rawText,
      imageBase64,
      tools: [RECORD_TRANSACTION_TOOL],
    });

    if (toolCall?.name === 'record_transaction') {
      const parsed = normalizeToolCallArgs(toolCall.arguments);
      const confidence = Number(toolCall.arguments.confidence);
      const isConfident = Number.isFinite(confidence) ? confidence >= MIN_CONFIDENCE_THRESHOLD : true;

      if (parsed && parsed.totalKobo > 0 && isConfident) {
        return { parsed, detectedLanguage: toolCall.arguments.detectedLanguage };
      }
      // Model called the tool but either produced unusable data (e.g.
      // zero amount) or wasn't confident enough — treat as "unclear"
      // rather than risking a wrong entry in the merchant's ledger.
      if (!isConfident) {
        logger.info({ confidence, rawText }, 'AI extraction below confidence threshold — treating as unclear');
        return { parsed: null, lowConfidence: true, detectedLanguage: toolCall.arguments.detectedLanguage };
      }
    }

    return { parsed: null, conversationalReply: text, detectedLanguage: null };
  } catch (err) {
    logger.error({ err: err.message }, 'AI fallback parsing failed');
    return { parsed: null, error: true };
  }
}

module.exports = { parseWithAI, RECORD_TRANSACTION_TOOL };

// ---------------------------------------------------------------------------
// Premium Image/Photo Scan Capture — a handwritten logbook page usually has
// MANY transactions on it, not one. This is a deliberately separate tool
// schema (an array, each entry shaped like record_transaction) and system
// prompt from the single-message hybrid fallback above.
// ---------------------------------------------------------------------------

const RECORD_MULTIPLE_TRANSACTIONS_TOOL = {
  type: 'function',
  function: {
    name: 'record_multiple_transactions',
    description:
      'Call this with EVERY distinct transaction line visible in the photographed logbook page — each row or entry the merchant wrote down is a separate item in the array.',
    parameters: {
      type: 'object',
      properties: {
        transactions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              entryType: { type: 'string', enum: ['CREDIT', 'DEBIT', 'DEBT', 'DEBT_SETTLEMENT'] },
              description: { type: 'string' },
              counterpartyName: { type: ['string', 'null'] },
              itemName: { type: ['string', 'null'] },
              itemQuantity: { type: ['number', 'null'] },
              itemUnit: { type: ['string', 'null'] },
              totalNaira: { type: 'number' },
              paidNaira: { type: 'number' },
              balanceNaira: { type: 'number' },
            },
            required: ['entryType', 'description', 'totalNaira', 'paidNaira', 'balanceNaira'],
          },
        },
      },
      required: ['transactions'],
    },
  },
};

const SCAN_SYSTEM_PROMPT = `${KIKA_SYSTEM_PROMPT}

## Special mode: logbook page scan
You are looking at a photo of a merchant's handwritten paper ledger page. Read every line and call record_multiple_transactions ONCE with the full list of transactions you can identify. Skip lines you genuinely can't read rather than guessing amounts. If you can't confidently read ANY transaction on the page, call the tool with an empty transactions array.`;

/**
 * Extracts every transaction from a photographed logbook page in a
 * single AI call. Premium-only feature (gated by the caller, not here).
 *
 * @returns {{ transactions: Array, error: boolean }}
 */
async function parseMultiTransactionImage(imageBase64) {
  if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
    return { transactions: [], error: true };
  }

  try {
    const { toolCall } = await openaiService.chatCompletion({
      systemPrompt: SCAN_SYSTEM_PROMPT,
      userText: 'Read every transaction line on this logbook page.',
      imageBase64,
      tools: [RECORD_MULTIPLE_TRANSACTIONS_TOOL],
    });

    if (toolCall?.name !== 'record_multiple_transactions' || !Array.isArray(toolCall.arguments?.transactions)) {
      return { transactions: [], error: false };
    }

    const transactions = toolCall.arguments.transactions
      .map((t) => normalizeToolCallArgs({ ...t, detectedLanguage: 'English' }))
      .filter((t) => t && t.totalKobo > 0);

    return { transactions, error: false };
  } catch (err) {
    logger.error({ err: err.message }, 'Multi-transaction scan failed');
    return { transactions: [], error: true };
  }
}

module.exports.parseMultiTransactionImage = parseMultiTransactionImage;
