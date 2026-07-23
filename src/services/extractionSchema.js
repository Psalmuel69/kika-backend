'use strict';

/**
 * The strict contract between Gemini and the rest of Kika.
 *
 * Gemini's ONLY job is natural-language understanding: read what the
 * merchant wrote and propose structured facts (intent + fields) plus a
 * conversational reply where one is needed. It never touches the
 * database, never does accounting math that the backend then trusts,
 * and never gets to hand the pipeline a shape the pipeline didn't ask
 * for. Every tool-call payload the model returns is validated against
 * the Zod schemas in this file BEFORE anything downstream sees it — a
 * payload that fails validation is treated exactly like the model
 * having said nothing usable at all (the merchant gets a clarifying
 * question, never a silently-guessed ledger entry).
 *
 * Money is validated here only for shape and sanity (finite,
 * non-negative, within a hard ceiling). Whether the numbers are
 * *arithmetically consistent* (total = paid + balance, entry-type
 * invariants, etc.) is deliberately NOT this file's job — that's the
 * accounting engine's (entryValidator.js), which recomputes and
 * repairs the math deterministically for every entry regardless of
 * whether regex or Gemini produced it. Schema answers "is this shaped
 * like a transaction?"; the validator answers "do these numbers make
 * accounting sense?".
 *
 * Kept as its own module (rather than inlined in aiTransactionParser)
 * so future intents — appointment booking, stock queries, whatever —
 * can define their own schema here and reuse the exact same
 * extract → validate → decide pipeline. See
 * aiTransactionParser.extractStructured for the reusable half.
 */

const { z } = require('zod');
const { SUPPORTED_LANGUAGES } = require('../config/aiPersona');
const { EXPENSE_CATEGORIES } = require('./categorizationService');

// Hard sanity ceiling on any single transaction: ₦500,000,000. Nothing
// an informal merchant logs in one WhatsApp message should exceed this;
// anything bigger is a hallucinated/misread number (e.g. a phone number
// mistaken for money) and must be bounced back as "unclear", never
// written to a ledger.
const MAX_SINGLE_TRANSACTION_NAIRA = 500_000_000;

const nairaAmount = z
  .number()
  .finite()
  .min(0)
  .max(MAX_SINGLE_TRANSACTION_NAIRA);

// Nigerian E.164 (+234 + 10 digits). The model is told to return E.164;
// a couple of near-miss formats it commonly emits anyway (leading 0,
// bare 234) are normalized rather than rejected, since the intent is
// unambiguous.
const nigerianPhone = z
  .string()
  .trim()
  .transform((v) => {
    const digits = v.replace(/[^\d+]/g, '');
    if (/^\+234\d{10}$/.test(digits)) return digits;
    if (/^234\d{10}$/.test(digits)) return `+${digits}`;
    if (/^0[789]\d{9}$/.test(digits)) return `+234${digits.slice(1)}`;
    return null; // unparseable phone -> dropped, never guessed
  })
  .nullable();

const shortText = (max) => z.string().trim().min(1).max(max);

/**
 * One extracted transaction, exactly as the model proposes it. This is
 * intentionally the model's *understanding*, still in naira and still
 * unrepaired — conversion to kobo and arithmetic enforcement happen in
 * entryValidator.js, on the backend's authority, after this passes.
 */
const ExtractedTransactionSchema = z
  .object({
    entryType: z.enum(['CREDIT', 'DEBIT', 'DEBT', 'DEBT_SETTLEMENT']),
    description: shortText(140),
    counterpartyName: shortText(80).nullable().optional().default(null),
    counterpartyPhone: nigerianPhone.optional().default(null),
    // Receipt-facing: a short noun phrase, never a sentence. The 60-char
    // cap is the schema-level enforcement of that rule.
    itemName: z.string().trim().max(60).nullable().optional().default(null),
    itemQuantity: z.number().finite().positive().max(100000).nullable().optional().default(null),
    itemUnit: z.string().trim().max(30).nullable().optional().default(null),
    expenseCategory: z
      .string()
      .nullable()
      .optional()
      .default(null)
      .transform((v) => (v && EXPENSE_CATEGORIES.includes(v) ? v : null)),
    totalNaira: nairaAmount,
    paidNaira: nairaAmount,
    balanceNaira: nairaAmount,
    detectedLanguage: z
      .string()
      .optional()
      .transform((v) => (SUPPORTED_LANGUAGES.includes(v) ? v : 'English')),
    confidence: z
      .number()
      .finite()
      .transform((v) => Math.min(1, Math.max(0, v))),
  })
  // Unknown/extra keys from the model are stripped, not fatal — the
  // model adding a field it invented shouldn't take Kika down, but that
  // field must never leak downstream either.
  .strip();

/**
 * The batch shape used by the Premium logbook-scan pipeline — an array
 * of the same transaction shape (without per-line confidence/language,
 * which don't exist per handwritten row).
 */
const ExtractedScanLineSchema = ExtractedTransactionSchema.omit({ confidence: true }).extend({
  confidence: z.number().finite().optional().transform((v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1)),
});

const ExtractedScanBatchSchema = z.object({ transactions: z.array(ExtractedScanLineSchema).max(100) }).strip();

/**
 * Validates a raw Gemini tool-call payload against a schema.
 *
 * @returns {{ ok: true, data: object } | { ok: false, issues: string[] }}
 *   Never throws — a malformed model payload is an expected runtime
 *   condition, not an exception.
 */
function validateExtraction(schema, rawArgs) {
  const result = schema.safeParse(rawArgs);
  if (result.success) return { ok: true, data: result.data };
  const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return { ok: false, issues };
}

module.exports = {
  ExtractedTransactionSchema,
  ExtractedScanBatchSchema,
  validateExtraction,
  MAX_SINGLE_TRANSACTION_NAIRA,
};
