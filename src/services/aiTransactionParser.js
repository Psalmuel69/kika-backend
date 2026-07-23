'use strict';

/**
 * The Gemini escalation path — Kika's natural-language understanding
 * layer, and ONLY that.
 *
 * Division of labor (the whole architecture in four lines):
 *   1. ledgerParser.js (regex + confidence gate) is the front door and
 *      handles the ~80-90% of messages that are short, predictable
 *      logging shapes — no AI call at all.
 *   2. THIS file handles the escalated ~10-20%: ambiguous phrasing,
 *      Pidgin/Yoruba/Igbo/Hausa, corrections, questions, multi-turn
 *      clarifications. Gemini reads the message (with business + reply
 *      context) and PROPOSES structured facts — intent + fields — or a
 *      conversational reply. It never writes to the database, and no
 *      arithmetic it produces is ever trusted as-is.
 *   3. extractionSchema.js (Zod) validates every tool-call payload the
 *      model returns before anything downstream sees it. Schema-invalid
 *      output is treated as "the model said nothing usable."
 *   4. entryValidator.js — the deterministic accounting engine —
 *      recomputes/repairs all money math and enforces business rules
 *      for EVERY entry (regex or Gemini) before ledgerService writes it.
 *
 * On intent classification: the regex path's classifyEntryType remains
 * the intent classifier for messages the front door confidently
 * handles. For escalated messages, Gemini classifies the intent itself
 * (the entryType field of its extraction) — that's deliberate, not
 * redundant: a message reaches Gemini precisely BECAUSE the keyword
 * classifier couldn't be trusted on it, so re-running the same word
 * lists over it would add nothing. entryValidator then cross-checks
 * the chosen label against the money facts (e.g. a "CREDIT" with an
 * outstanding balance is deterministically reclassified to DEBT), so a
 * mislabeled extraction still can't corrupt the ledger.
 *
 * The extract → validate → decide pipeline is exposed generically as
 * extractStructured() so future intents (appointment booking, stock
 * queries, price checks…) can plug in their own tool + Zod schema and
 * reuse the exact same machinery.
 */

const openaiService = require('./openaiService');
const businessContextService = require('./businessContextService');
const conversationMemory = require('./conversationMemory');
const categorizationService = require('./categorizationService');
const { EXPENSE_CATEGORIES } = categorizationService;
const { ExtractedTransactionSchema, ExtractedScanBatchSchema, validateExtraction } = require('./extractionSchema');
const { KIKA_SYSTEM_PROMPT, SUPPORTED_LANGUAGES } = require('../config/aiPersona');
const logger = require('../utils/logger');

const RECORD_TRANSACTION_TOOL = {
  type: 'function',
  function: {
    name: 'record_transaction',
    description:
      "Call this ONLY when the merchant's message clearly describes a sale, an expense, a customer debt, or a payment toward an existing debt — including slang, Pidgin, or indirect phrasing like 'I dashed Amaka 5k' or 'wired 10k for fuel'. Do not call this for greetings, questions, or anything that isn't a transaction. This call only PROPOSES the transaction — a separate deterministic accounting engine validates and records it, so report exactly what the merchant said rather than trying to make the numbers add up yourself.",
    parameters: {
      type: 'object',
      properties: {
        entryType: {
          type: 'string',
          enum: ['CREDIT', 'DEBIT', 'DEBT', 'DEBT_SETTLEMENT'],
          description:
            "CREDIT = a sale, fully paid right now (money in). DEBT = a sale where the customer still owes some/all of it — a credit sale (money partly/not yet in). DEBIT = the merchant's own expense/spending (money out) — e.g. restocking, fuel, rent. DEBT_SETTLEMENT = a customer paying back money they ALREADY owed from an earlier sale, not a new sale. Disambiguate 'buy/bought' by WHO is buying: a customer/third party buying FROM the merchant is a sale (CREDIT/DEBT); the merchant buying (restocking, 'I bought...') is an expense (DEBIT).",
        },
        description: { type: 'string', description: 'Short human-readable description of the transaction, e.g. "Fuel purchase" or "Rice x2 bags".' },
        counterpartyName: { type: ['string', 'null'], description: 'The customer or supplier name mentioned, or null if none.' },
        counterpartyPhone: { type: ['string', 'null'], description: 'E.164 Nigerian phone number if one was mentioned in the message, else null.' },
        itemName: {
          type: ['string', 'null'],
          description:
            'The product/service name, as a SHORT clean noun phrase (1-4 words, e.g. "Rice", "Fuel", "Hair styling") — this is shown directly on the merchant\'s receipt, so it must NEVER be a full sentence or repeat the whole message. Always populate this for CREDIT/DEBT/DEBIT (null only for DEBT_SETTLEMENT, which has no item).',
        },
        itemQuantity: { type: ['number', 'null'] },
        itemUnit: { type: ['string', 'null'], description: 'e.g. "bags", "cartons", "pieces" — null if not applicable.' },
        expenseCategory: {
          type: ['string', 'null'],
          enum: [...EXPENSE_CATEGORIES, null],
          description: 'Only for entryType DEBIT: which fixed expense category this spend falls under. Null for CREDIT/DEBT/DEBT_SETTLEMENT.',
        },
        totalNaira: { type: 'number', description: 'Total value of the transaction as the merchant stated it, in Naira (not kobo).' },
        paidNaira: { type: 'number', description: 'Amount actually paid/received right now as stated, in Naira.' },
        balanceNaira: { type: 'number', description: 'Amount still owed after this transaction as stated. 0 if fully settled. Do not invent a balance the merchant did not state or clearly imply.' },
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

// Below this confidence, Kika treats the extraction as unclear rather
// than risking a wrong entry in the merchant's ledger — the merchant is
// asked ONE specific clarifying question instead (never a silent guess,
// never a generic "didn't catch that" when the model can do better).
const MIN_CONFIDENCE_THRESHOLD = Number(process.env.AI_MIN_CONFIDENCE_THRESHOLD || 0.65);

function hasAiProviderConfigured() {
  return Boolean(process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY);
}

function toKobo(naira) {
  const n = Number(naira);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// Same cleanup approach as ledgerParser.js's extractBareItemName — used
// here only as a safety net for the rare case the model left itemName
// blank, so a receipt can NEVER end up showing a raw, unclean sentence
// as an "item". Deliberately duplicated rather than imported: this is a
// generic string-cleanup utility, not parsing logic, and keeping it
// tiny and local avoids a cross-module dependency for four lines of code.
function deriveCleanItemNameFromDescription(description) {
  let text = String(description || '').trim();
  text = text.replace(/^(sold|bought|buy|sell|selling|sale of|purchase of|paid for|spent on|gave|received)\s+/i, '');
  text = text.replace(/\s*(?:\u20a6|ngn)?\s*[\d][\d,.]*\s*(?:k|m)?\.?\s*$/i, '');
  text = text.trim();
  if (!text || text.length > 60) return null;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Schema-validated extraction -> Kika's internal candidate-entry shape
 * (kobo amounts, items array). Still only a CANDIDATE: worker.js runs
 * it through entryValidator before anything is written.
 */
function normalizeValidatedExtraction(data) {
  let items = [];
  if (data.entryType !== 'DEBT_SETTLEMENT') {
    const cleanName =
      data.itemName != null && String(data.itemName).trim() ? String(data.itemName).trim() : deriveCleanItemNameFromDescription(data.description);
    if (cleanName) {
      const item = { name: cleanName };
      if (data.itemQuantity != null && Number(data.itemQuantity) > 0) {
        item.quantity = Number(data.itemQuantity);
        item.unit = data.itemUnit || '';
      }
      items = [item];
    }
  }

  return {
    entryType: data.entryType,
    description: data.description || (items[0] ? items[0].name : 'Transaction'),
    counterpartyName: data.counterpartyName || null,
    counterpartyPhone: data.counterpartyPhone || null,
    items,
    totalKobo: toKobo(data.totalNaira),
    paidKobo: toKobo(data.paidNaira),
    balanceKobo: toKobo(data.balanceNaira),
    expenseCategory: data.entryType === 'DEBIT' ? data.expenseCategory || null : null,
  };
}

/**
 * The reusable extract → validate → decide pipeline. Sends one message
 * (plus business/reply context and short-term memory) to the configured
 * provider with a single tool, and validates any tool-call payload
 * against the given Zod schema before returning it.
 *
 * Returns a discriminated result — the caller decides what each status
 * means for ITS intent; this function makes no business decisions:
 *   { status: 'extracted', data, confidence, detectedLanguage }
 *   { status: 'conversational', text }        — model replied in prose
 *   { status: 'low_confidence', text|null, detectedLanguage }
 *   { status: 'invalid', issues }             — schema rejection
 *   { status: 'error' }                       — provider unreachable/failed
 */
async function extractStructured({ merchant, rawText, imageBase64, replyEntry, tool, schema, minConfidence = MIN_CONFIDENCE_THRESHOLD, rememberConversation = true }) {
  if (!hasAiProviderConfigured()) {
    logger.warn('Neither OPENAI_API_KEY nor GEMINI_API_KEY configured — AI escalation unavailable');
    return { status: 'error' };
  }

  try {
    const [businessContext, history] = await Promise.all([
      businessContextService.buildBusinessContextBlock(merchant, replyEntry),
      rememberConversation ? conversationMemory.getHistory(merchant.id) : Promise.resolve([]),
    ]);

    const systemPrompt = `${KIKA_SYSTEM_PROMPT}\n\n${businessContext}`;

    const { toolCall, text } = await openaiService.chatCompletion({
      systemPrompt,
      userText: rawText,
      imageBase64,
      tools: [tool],
      conversationHistory: history,
    });

    if (toolCall?.name === tool.function.name) {
      const validation = validateExtraction(schema, toolCall.arguments);
      if (!validation.ok) {
        // The model produced a payload that doesn't meet the contract.
        // Never "repair around" a schema failure — treat it as no
        // usable extraction and let the caller ask the merchant.
        logger.warn({ issues: validation.issues, tool: tool.function.name }, 'AI extraction failed schema validation — rejected');
        return { status: 'invalid', issues: validation.issues };
      }

      const confidence = Number(validation.data.confidence ?? 1);
      if (confidence < minConfidence) {
        logger.info({ confidence, rawText }, 'AI extraction below confidence threshold — asking for clarification');
        return { status: 'low_confidence', text: text || null, detectedLanguage: validation.data.detectedLanguage || null, confidence };
      }

      return { status: 'extracted', data: validation.data, confidence, detectedLanguage: validation.data.detectedLanguage || null };
    }

    // No tool call — a genuine conversational turn: a clarifying
    // question for an incomplete transaction, an answer to a question
    // about the business, or an in-persona decline. Exactly the
    // "unfinished conversation" worth remembering for the next turn.
    if (text && rememberConversation) {
      await conversationMemory.addMessage(merchant.id, 'user', rawText);
      await conversationMemory.addMessage(merchant.id, 'assistant', text);
    }

    return { status: 'conversational', text: text || null };
  } catch (err) {
    logger.error({ err: err.message }, 'AI extraction call failed');
    return { status: 'error' };
  }
}

/**
 * The transaction-intent wrapper around extractStructured — what
 * worker.js calls when the regex front door escalates a message.
 *
 * Return shapes (kept close to the historical contract):
 *   { parsed: {...}, detectedLanguage }               — candidate entry extracted
 *   { parsed: null, conversationalReply, ... }         — in-persona reply/question
 *   { parsed: null, lowConfidence: true, clarify, .. } — extraction too uncertain
 *   { parsed: null, error: true }                      — provider call failed
 */
async function parseWithAI(merchant, rawText, { imageBase64, replyEntry } = {}) {
  const result = await extractStructured({
    merchant,
    rawText,
    imageBase64,
    replyEntry,
    tool: RECORD_TRANSACTION_TOOL,
    schema: ExtractedTransactionSchema,
  });

  if (result.status === 'extracted') {
    const parsed = normalizeValidatedExtraction(result.data);
    if (parsed.entryType === 'DEBIT' && !parsed.expenseCategory) {
      parsed.expenseCategory = await categorizationService.categorizeExpense(parsed.description, parsed.items?.[0]?.name);
    }
    // A confirmed transaction is NOT stored in conversation memory —
    // Postgres is the source of truth for it, and re-stating it here
    // would only bloat future prompts (see conversationMemory.js). The
    // thread effectively resets after a successful recording.
    return { parsed, detectedLanguage: result.detectedLanguage };
  }

  if (result.status === 'conversational') {
    return { parsed: null, conversationalReply: result.text, detectedLanguage: null };
  }

  if (result.status === 'low_confidence') {
    // If the model volunteered its own clarifying text alongside the
    // hesitant tool call, that IS the clarification; otherwise the
    // worker falls back to a fixed, language-matched ask.
    return { parsed: null, lowConfidence: true, clarify: result.text || null, detectedLanguage: result.detectedLanguage };
  }

  if (result.status === 'invalid') {
    // Schema-invalid model output is a model failure, but the honest
    // user-facing behavior is the same as low confidence: ask, don't guess.
    return { parsed: null, lowConfidence: true, clarify: null, detectedLanguage: null };
  }

  return { parsed: null, error: true };
}

module.exports = { parseWithAI, extractStructured, RECORD_TRANSACTION_TOOL };

// ---------------------------------------------------------------------------
// Premium Image/Photo Scan Capture — a handwritten logbook page usually has
// MANY transactions on it, not one. This is a deliberately separate tool
// schema (an array, each entry shaped like record_transaction) and system
// prompt from the single-message escalation above. Not conversational
// (each scan is self-contained), so no conversation memory threading here.
// Each extracted line is schema-validated (ExtractedScanBatchSchema) and
// then individually run through entryValidator by the caller before any
// write — same trust boundary as the single-message path.
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
              itemName: {
                type: ['string', 'null'],
                description: 'SHORT clean noun phrase (1-4 words) — never a full sentence, this is shown directly on the receipt.',
              },
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
 * Returns CANDIDATE entries — the caller runs each through
 * entryValidator before writing.
 *
 * @returns {{ transactions: Array, error: boolean }}
 */
async function parseMultiTransactionImage(imageBase64) {
  if (!hasAiProviderConfigured()) {
    return { transactions: [], error: true };
  }

  try {
    const { toolCall } = await openaiService.chatCompletion({
      systemPrompt: SCAN_SYSTEM_PROMPT,
      userText: 'Read every transaction line on this logbook page.',
      imageBase64,
      tools: [RECORD_MULTIPLE_TRANSACTIONS_TOOL],
    });

    if (toolCall?.name !== 'record_multiple_transactions') {
      return { transactions: [], error: false };
    }

    const validation = validateExtraction(ExtractedScanBatchSchema, toolCall.arguments);
    if (!validation.ok) {
      logger.warn({ issues: validation.issues }, 'Logbook scan extraction failed schema validation — rejected');
      return { transactions: [], error: false };
    }

    const transactions = validation.data.transactions
      .map((t) => normalizeValidatedExtraction({ ...t, detectedLanguage: 'English' }))
      .filter((t) => t && t.totalKobo > 0);

    return { transactions, error: false };
  } catch (err) {
    logger.error({ err: err.message }, 'Multi-transaction scan failed');
    return { transactions: [], error: true };
  }
}

module.exports.parseMultiTransactionImage = parseMultiTransactionImage;
