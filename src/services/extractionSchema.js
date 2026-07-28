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

// International E.164 phone (+ followed by 8-15 digits, the ITU-T
// E.164 range) — accepts any country's number the model returns in
// proper E.164 form, not just Nigeria's. A bare Nigerian domestic-format
// shorthand (leading 0, 11 digits total) is ALSO normalized to +234,
// since Nigeria remains Kika's largest market and both merchants and
// the model frequently drop the country code for it — that's a
// convenience for the historically dominant case, not a restriction on
// any other country's numbers (a customer phone that previously fell
// outside +234 was silently dropped to null here, breaking loyalty
// milestone tracking for every non-Nigerian merchant's customers).
const internationalPhone = z
  .string()
  .trim()
  .transform((v) => {
    const digits = v.replace(/[^\d+]/g, '');
    if (/^\+\d{8,15}$/.test(digits)) return digits;
    if (/^234\d{10}$/.test(digits)) return `+${digits}`;
    if (/^0[789]\d{9}$/.test(digits)) return `+234${digits.slice(1)}`;
    return null; // unparseable phone -> dropped, never guessed
  })
  .nullable();

const shortText = (max) => z.string().trim().min(1).max(max);

// The currencies Kika's parsers can recognize an EXPLICIT statement of
// in merchant text at all (see MONEY_TOKEN/CURRENCY_MARKER_TO_CODE in
// ledgerParser.js — this list must stay in sync with that one).
// Anything the model reports outside this set is treated as
// unspecified (null) by the transform below — the same "don't guess,
// assume the merchant's own account currency" posture as every other
// unrecognized field in this schema.
const SUPPORTED_ENTRY_CURRENCIES = ['NGN', 'USD', 'GBP', 'EUR'];

/**
 * One extracted transaction, exactly as the model proposes it. This is
 * intentionally the model's *understanding*, still in the currency the
 * merchant actually used (see `currency` below) and still unrepaired —
 * conversion to NGN kobo and arithmetic enforcement happen later:
 * currency conversion in utils/currency.js (called from worker.js right
 * after extraction), then accounting enforcement in entryValidator.js,
 * on the backend's authority, after both of those pass.
 */
const ExtractedTransactionSchema = z
  .object({
    entryType: z.enum(['CREDIT', 'DEBIT', 'DEBT', 'DEBT_SETTLEMENT']),
    description: shortText(140),
    counterpartyName: shortText(80).nullable().optional().default(null),
    counterpartyPhone: internationalPhone.optional().default(null),
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
    // Which currency totalNaira/paidNaira/balanceNaira are actually
    // denominated in — despite the field names below (kept as
    // "…Naira" for backward compatibility with the accounting engine's
    // input contract), a merchant who wrote "$500" or "500 dollars"
    // should have this set to 'USD', with totalNaira etc. carrying the
    // face value 500 (NOT converted). null (the default, when the
    // model doesn't report an explicit foreign currency) means
    // "unspecified — assume the merchant's own account currency", NOT
    // "assume NGN": worker.js checks this against merchant.default_currency
    // (see src/config/countryCurrency.js) and only asks the merchant to
    // clarify on a genuine mismatch. Defaulting this to 'NGN' instead of
    // null would wrongly flag every AI-parsed entry from a non-Nigerian
    // merchant as a currency mismatch.
    currency: z
      .string()
      .nullable()
      .optional()
      .default(null)
      .transform((v) => {
        const upper = String(v || '').toUpperCase();
        return SUPPORTED_ENTRY_CURRENCIES.includes(upper) ? upper : null;
      }),
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
  SUPPORTED_ENTRY_CURRENCIES,
};
