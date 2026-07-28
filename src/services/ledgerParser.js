'use strict';

const { CURRENCY_INFO_BY_CODE } = require('../config/countryCurrency');

/**
 * Two different kinds of parsing live in this file:
 *
 * 1. Structured commands — "BALANCE", "ADD STOCK: rice, 50",
 *    "CLOSING HOUR 20", "INVOICE 5000 for rice". These are fixed
 *    keywords or a rigid syntax the merchant is explicitly instructed to
 *    type, not free-text business language — there's no interpretation
 *    happening, just pattern matching on a known shape. These stay
 *    regex-based permanently; there's no ambiguity for an AI to resolve.
 *
 * 2. Free-text transaction parsing (parseLedgerMessage, parseReplyMessage)
 *    — deciding whether a message is a sale, an expense, a debt, or a
 *    debt repayment, and extracting the customer/items/amounts from it.
 *    This regex parser is the FRONT DOOR: every free-text message is
 *    tried here first, and a deterministic confidence score
 *    (scoreRegexParse below) decides whether the parse is trusted.
 *    Merchants overwhelmingly log in a handful of short, predictable
 *    shapes ("sold rice 5000", "Chidi owes 2k", "Mama Tunde buy 3
 *    carton indomie, she pay 15k remain 12k"), so a confident regex
 *    parse handles the ~80-90% common case with zero AI latency and
 *    zero AI cost. Anything the scorer flags as ambiguous — question
 *    marks, negations, mixed languages/Pidgin the word lists don't
 *    cover, multiple candidate amounts, conflicting verbs, long
 *    rambling messages — is escalated honestly to Gemini
 *    (aiTransactionParser.js), which actually understands phrasing the
 *    word lists can't. The same regex result additionally serves as a
 *    degraded-mode fallback if that Gemini escalation itself fails
 *    (outage/quota) and the parse cleared at least the lower
 *    REGEX_DEGRADED_FLOOR — so an AI outage degrades Kika to "less
 *    smart about tricky phrasing" instead of "completely unusable."
 *    Either way, NOTHING from either extractor reaches the database
 *    without passing entryValidator.js, the deterministic accounting
 *    engine that recomputes and enforces all money math.
 *
 * Real merchant messages this fallback is built against, e.g.:
 *   "Mama Tunde buy 3 carton of indomie, she pay 15k remain 12k"
 *   "sold rice 5000 to Amaka"
 *   "bought fuel 3000"
 *   "Chidi owes 2000"
 *   "John pay off his debt 5k"
 *
 * Money shorthand: "15k" / "15,000" / "₦15000" / "15000 naira" all resolve
 * to the same kobo amount. Amounts are always stored as kobo (x100) to
 * avoid floating point drift on money math.
 */

// Currency prefix/suffix -> ISO code, shared by every money-parsing site
// in this file (the free-text ledger parser, the one-shot INVOICE
// command, and the multi-item invoice line parser).
//
// This is NOT the full list of currencies Kika supports — a merchant's
// actual account currency is resolved from their WhatsApp number's
// country calling code (see src/config/countryCurrency.js, which covers
// every ISO 4217 currency in the world) at signup, and the overwhelming
// majority of messages just use a bare number with no symbol at all
// (correctly assumed to be in THAT currency — see resolveCurrencyCode's
// null return below). This table only covers the handful of currencies
// a merchant anywhere might explicitly type the SYMBOL/WORD for, even
// outside their own country — Naira, Dollars, Pounds, Euros — so an
// amount stated in one of THESE is recognized and checked against the
// merchant's own account currency (see worker.js), asking for
// clarification on a genuine mismatch rather than silently misreading
// "$500" as five hundred of the merchant's own currency.
const CURRENCY_MARKER_TO_CODE = {
  '\u20a6': 'NGN',
  ngn: 'NGN',
  naira: 'NGN',
  '$': 'USD',
  usd: 'USD',
  dollar: 'USD',
  dollars: 'USD',
  '\u00a3': 'GBP',
  gbp: 'GBP',
  pound: 'GBP',
  pounds: 'GBP',
  '\u20ac': 'EUR',
  eur: 'EUR',
  euro: 'EUR',
  euros: 'EUR',
};

/**
 * Resolves the EXPLICIT currency a money token was written in, from
 * whichever of its prefix ("$", "₦", "usd"...) or suffix ("dollars",
 * "naira"...) markers actually matched — prefix wins if both somehow
 * fired. Returns null (meaning "no explicit currency stated — assume
 * whatever currency the merchant's account is already set up in") for
 * the overwhelming common case of a bare number with no symbol/word at
 * all — this is NOT a default currency guess, it's "unspecified." See
 * worker.js for how a null vs. an explicit-but-mismatched currency are
 * handled differently.
 */
function resolveCurrencyCode(prefixRaw, suffixRaw) {
  const prefixKey = String(prefixRaw || '').trim().toLowerCase();
  const suffixKey = String(suffixRaw || '').trim().toLowerCase();
  return CURRENCY_MARKER_TO_CODE[prefixKey] || CURRENCY_MARKER_TO_CODE[suffixKey] || null;
}

// "INVOICE 5000 for rice", "INVOICE 08012345678 2 million rice
// delivery", "INVOICE $150 supplies" — generates a customer-facing
// payment link rather than a ledger entry. The amount portion accepts
// the same money vocabulary as the ledger parser (k/m/h/thousand/
// million/hundred, ₦/$/£/€/naira/dollars/pounds/euros) — see
// MONEY_SUFFIX_MULTIPLIER below, which this shares.
const INVOICE_PREFIX_RE =
  /^invoice\b[:\s]+(?:(\+\d{8,15}|0[789]\d{9})\s+)?(\u20a6\s*|\$\s*|\u00a3\s*|\u20ac\s*|ngn\s*|usd\s*|gbp\s*|eur\s*)?([\d,]+(?:\.\d{1,2})?)\s*(k|m|h|thousand|million|milli|hundred|naira|dollars?|usd|pounds?|gbp|euros?|eur)?\b(?!\w)\s*(.*)$/i;

function parseInvoiceCommand(rawMessage) {
  if (typeof rawMessage !== 'string') return null;
  const match = rawMessage.trim().match(INVOICE_PREFIX_RE);
  if (!match) return null;

  const [, phoneRaw, prefixRaw, numberPart, suffixRaw, description] = match;
  let amountFace = parseFloat(numberPart.replace(/,/g, ''));
  if (Number.isNaN(amountFace) || amountFace <= 0) return null;
  const multiplier = MONEY_SUFFIX_MULTIPLIER[(suffixRaw || '').toLowerCase()];
  if (multiplier) amountFace *= multiplier;

  const customerPhone = phoneRaw ? (phoneRaw.startsWith('+') ? phoneRaw : `+234${phoneRaw.replace(/^0/, '')}`) : null;

  return {
    // NOTE: this is the face value in whatever `currency` is (x100),
    // NOT necessarily Naira kobo — an invoice is free to be in any
    // currency (see the note on buildInvoiceSvgForMerchant in
    // receiptService.js); this is never auto-converted.
    amountKobo: Math.round(amountFace * 100),
    currency: resolveCurrencyCode(prefixRaw, suffixRaw),
    description: description?.trim() || 'Invoice',
    customerPhone,
  };
}

const COMMAND_KEYWORDS = {
  UPGRADE: ['upgrade', 'plans', 'pricing'],
  STANDARD: ['standard'],
  PREMIUM: ['premium'],
  STANDARD_YEARLY: ['standard yearly', 'standard annual', 'standard year'],
  PREMIUM_YEARLY: ['premium yearly', 'premium annual', 'premium year'],
  BALANCE: ['balance', 'summary', 'report'],
  HELP: ['help', 'start', 'menu'],
  INSIGHTS: ['insights', 'monthly', 'monthly insights', 'monthly report'],
  SUNSET: ['sunset', 'today', "today's report", 'daily report'],
  UNDO: ['undo', 'delete last sale', 'delete last entry', 'cancel last sale'],
  EXPORT: ['export', 'my data', 'excel', 'csv'],
  REVIEW_SCAN: ['review scan', 'review'],
  TESTDIGEST: ['testdigest', 'test digest'],
  DONE: ['done', 'finish', 'finished', "that's all", 'thats all', 'complete'],
  GREETING: [
    'hi', 'hey', 'hello', 'howdy', 'yo',
    'hi kika', 'hey kika', 'hello kika', 'yo kika',
    'whatsup', 'wassup', "what's up", 'wetin dey happen', 'wetin dey',
    'howfa', 'howfar', 'how far', 'how far kika',
    'good morning', 'good afternoon', 'good evening',
  ],
};

function detectCommand(rawMessage) {
  if (typeof rawMessage !== 'string') return null;
  const normalized = rawMessage.trim().toLowerCase();
  for (const [command, keywords] of Object.entries(COMMAND_KEYWORDS)) {
    if (keywords.includes(normalized)) return command;
  }
  return null;
}

// "ADD STOCK: rice, 50" or "ADD STOCK rice 50 bags"
const ADD_STOCK_RE = /^add\s*stock\s*:?\s*([a-zA-Z][a-zA-Z\s]{0,60}?)\s*[,]?\s*(\d+(?:\.\d{1,2})?)\s*([a-zA-Z]+)?\s*$/i;
// Recognizes the command was clearly AIMED at ADD STOCK even when
// ADD_STOCK_RE above didn't fully match (no item name, no quantity, or
// both) — lets worker.js ask for exactly what's missing instead of
// silently ignoring the message or escalating it to the AI parser as if
// it were an ordinary transaction.
const ADD_STOCK_PREFIX_RE = /^add\s*stock\b/i;

function parseAddStockCommand(rawMessage) {
  if (typeof rawMessage !== 'string') return null;
  const match = rawMessage.trim().match(ADD_STOCK_RE);
  if (!match) return null;
  const [, name, quantityStr, unit] = match;
  const quantity = Number(quantityStr);
  if (!name?.trim() || !Number.isFinite(quantity) || quantity <= 0) return null;
  return { productName: name.trim(), quantity, unit: unit?.trim() || null };
}

/** True if the message is clearly an attempt at ADD STOCK that's missing the item name and/or quantity — see ADD_STOCK_PREFIX_RE above. */
function isIncompleteAddStockCommand(rawMessage) {
  if (typeof rawMessage !== 'string') return false;
  const text = rawMessage.trim();
  return ADD_STOCK_PREFIX_RE.test(text) && !parseAddStockCommand(text);
}

// "CLOSING HOUR 20" or "CLOSING HOUR: 7PM" (24hr or simple AM/PM)
const CLOSING_HOUR_RE = /^closing\s*hour\s*:?\s*(\d{1,2})\s*(am|pm)?\s*$/i;
// Same idea as ADD_STOCK_PREFIX_RE — the command was clearly aimed at
// CLOSING HOUR but has no (valid) hour attached.
const CLOSING_HOUR_PREFIX_RE = /^closing\s*hour\b/i;

function parseClosingHourCommand(rawMessage) {
  if (typeof rawMessage !== 'string') return null;
  const match = rawMessage.trim().match(CLOSING_HOUR_RE);
  if (!match) return null;
  let hour = Number(match[1]);
  const meridiem = match[2]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23) return null;
  return { hour };
}

/** True if the message is clearly an attempt at CLOSING HOUR that's missing a valid hour — see CLOSING_HOUR_PREFIX_RE above. */
function isIncompleteClosingHourCommand(rawMessage) {
  if (typeof rawMessage !== 'string') return false;
  const text = rawMessage.trim();
  return CLOSING_HOUR_PREFIX_RE.test(text) && !parseClosingHourCommand(text);
}

// "SET CURRENCY GHS" / "CURRENCY GHS" — lets a merchant correct the
// currency their account was auto-assigned at signup (see
// src/config/countryCurrency.js's phone-calling-code guess). That guess
// is a heuristic, not ground truth — a merchant using a relative's
// foreign-registered SIM, or genuinely running a cross-border business,
// needs a way to fix it rather than being permanently stuck with a
// wrong assumption with no recourse.
const SET_CURRENCY_RE = /^(?:set\s+)?currency\s*:?\s*([a-zA-Z]{3})\s*$/i;
// Same idea as the other command-completeness checks — the merchant
// clearly meant this command but gave no (valid) 3-letter code.
const SET_CURRENCY_PREFIX_RE = /^(?:set\s+)?currency\b/i;

function parseSetCurrencyCommand(rawMessage) {
  if (typeof rawMessage !== 'string') return null;
  const match = rawMessage.trim().match(SET_CURRENCY_RE);
  if (!match) return null;
  const code = match[1].toUpperCase();
  if (!CURRENCY_INFO_BY_CODE[code]) return null; // not a currency Kika recognizes at all
  return { currencyCode: code };
}

/** True if the message is clearly an attempt at SET CURRENCY with a missing or unrecognized code. */
function isIncompleteSetCurrencyCommand(rawMessage) {
  if (typeof rawMessage !== 'string') return false;
  const text = rawMessage.trim();
  return SET_CURRENCY_PREFIX_RE.test(text) && !parseSetCurrencyCommand(text);
}

// "I'm Samuel", "I am Samuel", "My name is Samuel", "This is Samuel",
// "Call me Samuel" — deliberately conservative (2-word cap on the
// captured name, letters/hyphen/apostrophe only) so it doesn't
// misfire on unrelated sentences that happen to start similarly. This
// stays regex-based (rather than folded into the AI call) because it's
// a cheap, unambiguous pattern match, not a business-transaction
// judgment call.
// Prefixes are matched case-insensitively; the name itself must still
// start with a capital letter, so the /i flag can't apply to the whole
// pattern (it would then also accept an all-lowercase "name").
const SELF_INTRO_PREFIXES = [/^i'?m\s+/i, /^i\s+am\s+/i, /^my\s+name\s+is\s+/i, /^this\s+is\s+/i, /^call\s+me\s+/i];
const NAME_CAPTURE_RE = /^([A-Z][a-zA-Z'-]*(?:\s+[A-Z][a-zA-Z'-]*){0,1})\b/;

/**
 * Best-effort extraction of a merchant introducing themselves by name in
 * ordinary conversation — NOT a business name (that's the separate,
 * explicit onboarding step). Deliberately only matches a handful of
 * clear self-introduction phrasings; anything murkier is left alone
 * rather than risk mis-attributing a name.
 */
function extractSelfIntroduction(rawMessage) {
  if (typeof rawMessage !== 'string') return null;
  const text = rawMessage.trim();

  for (const prefixRe of SELF_INTRO_PREFIXES) {
    const prefixMatch = text.match(prefixRe);
    if (!prefixMatch) continue;
    const rest = text.slice(prefixMatch[0].length);
    const nameMatch = rest.match(NAME_CAPTURE_RE);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    // Guard against matching common non-name follow-ups like "I'm fine",
    // "I'm good", "I am here" etc.
    const BLOCKLIST = ['Fine', 'Good', 'Okay', 'Ok', 'Here', 'Back', 'Ready', 'Sorry', 'Busy', 'Kika'];
    if (BLOCKLIST.includes(name)) return null;
    return name.slice(0, 60);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Onboarding's "What is the name of your business/shop?" reply — a
// merchant very often answers in a full sentence ("my business name is
// Ebuka & Sons Ltd", "Ebuka & Sons Ltd is the name") rather than just
// the name on its own ("Ebuka & Sons Ltd"). Since this name gets printed
// on every receipt/invoice going forward, silently saving the WHOLE
// sentence would be a lasting, visible mistake — so it's stripped of any
// recognized lead-in/trailing filler before being saved. Deliberately a
// short, explicit list rather than a single greedy regex — a phrase
// that isn't on this list is left untouched (see looksLikeCleanName
// below, which flags that case for the AI fallback in
// nameExtractionService.js instead of guessing at a stripping rule that
// might cut into the actual name).
// ---------------------------------------------------------------------------
const BUSINESS_NAME_LEADING_RES = [
  /^(?:the|my|our)\s+business\s+name\s+is\s+/i,
  /^(?:the|my|our)\s+shop\s+name\s+is\s+/i,
  /^(?:the|my|our)\s+store\s+name\s+is\s+/i,
  /^business\s+name\s*:?\s*is\s+/i,
  /^(?:the\s+)?name\s+is\s+/i,
  /^name\s*:\s*/i,
  /^(?:we're|we\s+are|it'?s|it\s+is)\s+called\s+/i,
  /^(?:my|our)\s+business\s+is\s+called\s+/i,
  /^(?:my|our)\s+shop\s+is\s+called\s+/i,
  /^(?:my|our)\s+store\s+is\s+called\s+/i,
  /^(?:we|i)\s+call\s+it\s+/i,
];
const BUSINESS_NAME_TRAILING_RES = [
  /\s+is\s+(?:the|my|our)\s+business(?:'s)?\s+name\.?$/i,
  /\s+is\s+(?:the|my|our)\s+shop(?:'s)?\s+name\.?$/i,
  /\s+is\s+(?:the|my|our)\s+store(?:'s)?\s+name\.?$/i,
  /\s+is\s+(?:the|my|our)\s+name\.?$/i,
  /\s+is\s+what\s+(?:we're|we\s+are|it'?s|it\s+is)\s+called\.?$/i,
  /\s+is\s+my\s+business\.?$/i,
  /\s+is\s+our\s+business\.?$/i,
];

/**
 * Strips a recognized lead-in ("my business name is ...") or trailing
 * ("... is the name") filler phrase from a merchant's answer to the
 * business-name onboarding question, leaving just the name itself. If
 * NEITHER pattern matches, the text is returned completely unchanged
 * (most merchants just type the plain name, which is exactly the
 * common case this must not disturb) — see looksLikeCleanName for how
 * the caller decides whether the result still needs the AI fallback.
 */
function extractBusinessNameFromReply(rawMessage) {
  if (typeof rawMessage !== 'string') return null;
  let text = rawMessage.trim();
  if (!text) return null;

  for (const re of BUSINESS_NAME_LEADING_RES) {
    if (re.test(text)) {
      text = text.replace(re, '').trim();
      break;
    }
  }
  for (const re of BUSINESS_NAME_TRAILING_RES) {
    if (re.test(text)) {
      text = text.replace(re, '').trim();
      break;
    }
  }
  // Leftover surrounding quotes/punctuation from a phrase like `It's
  // called "Ebuka Stores".` — cosmetic cleanup, not a stripping rule.
  text = text
    .replace(/^["'\u201c]+|["'\u201d]+$/g, '')
    .replace(/[.!]+$/, '')
    .trim();
  return text || null;
}

// Words that, if the text STILL contains/starts with them after
// extractBusinessNameFromReply's stripping attempt, mean it's very
// likely still a sentence rather than a clean name — e.g. a phrasing
// this file's explicit pattern list didn't anticipate ("you can call my
// shop Ebuka Stores", "Ebuka Stores, that's what we go by"). A real
// business name occasionally legitimately contains a short connector
// word ("Bread & Butter", "House of Ankara"), so this only flags the
// small set of words that are near-never part of an actual business
// name on their own.
const SUSPICIOUS_NAME_WORD_RE = /\b(is|called|name|business|shop|store)\b/i;
const MAX_PLAUSIBLE_NAME_WORDS = 7;

/**
 * Heuristic: does `text` look like a clean, already-extracted name
 * rather than a leftover sentence fragment? Used to decide whether
 * extractBusinessNameFromReply's result is trustworthy on its own, or
 * whether it's worth the one-off AI fallback call (see
 * nameExtractionService.extractNameWithAI) — never blocks onboarding
 * either way, since the caller falls back to the raw reply if the AI
 * call itself doesn't return anything usable.
 */
function looksLikeCleanName(text) {
  if (!text) return false;
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount === 0 || wordCount > MAX_PLAUSIBLE_NAME_WORDS) return false;
  if (SUSPICIOUS_NAME_WORD_RE.test(text)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Front-door free-text transaction parser. Runs FIRST on every free-text
// message; its output is only trusted when scoreRegexParse (further
// down) clears the confidence threshold — see the file-level comment.
// ---------------------------------------------------------------------------

const CREDIT_VERBS = ['sold', 'sale', 'received', 'income', 'got paid', 'buy', 'bought from me', 'purchase from me'];
const DEBIT_VERBS = ['bought', 'paid for', 'spent', 'expense', 'purchase', 'i paid'];
const DEBT_SETTLE_VERBS = ['pay off', 'clear debt', 'settle debt', 'paid off', 'paid up', 'cleared'];
const DEBT_VERBS = ['owes', 'owe', 'debt', 'credit sale', 'on credit'];

// Matches "15k", "15,000", "₦15,000.50", "N15000", "15000 naira", "2m",
// "2 million", "2 milli", "5h", "5 hundred", "$150", "150 dollars",
// "£20", "20 pounds", "€50", "50 euros" — Nigerian chat shorthand for
// thousand/million/hundred multipliers (spelled out or abbreviated),
// plus explicit currency words/symbols. Foreign-currency markers are
// recognized as money markers so an amount written that way is never
// mistaken for text (e.g. left over as a stray item name) — the prefix
// is now a CAPTURING group (see resolveCurrencyCode above) so
// extractMoneyMentions can tag which currency each mention was actually
// stated in; worker.js converts any non-NGN mention to its NGN
// equivalent, at the current market rate, before anything is validated
// or written — see utils/currency.js. The bare "n" prefix only matches
// when glued directly to a digit (lookahead \d, no space) — otherwise it
// would greedily swallow the trailing "n" of ordinary words like
// "remain" or "in" as a false currency marker.
// The prefix group is written as a MANDATORY alternation (no trailing
// `?`) whose last branch, `\b(?=\d)`, is a zero-width "no currency
// symbol here, just a plain boundary before a digit" match — this is
// what replaces a naive leading `\b` before the whole optional group.
// A plain leading `\b` doesn't work here: `\b` asserts a transition
// between a word and non-word character, and a currency SYMBOL ($, ₦,
// £, €) is itself a non-word character — so "rice $500" (space, then
// $) has a non-word-to-non-word run and never satisfies `\b` right
// before the "$", silently making the whole prefix fail to match and
// defaulting every symbol-prefixed foreign amount to NGN. Each
// word-based alternative (ngn/usd/gbp/eur/n) keeps its own `\b` since
// those genuinely are word characters and need the boundary check.
const MONEY_TOKEN =
  /(\u20a6\s*|\$\s*|\u00a3\s*|\u20ac\s*|\bngn\s*|\busd\s*|\bgbp\s*|\beur\s*|\bn(?=\d)|\b(?=\d))([\d,]+(?:\.\d{1,2})?)\s*(k|m|h|thousand|million|milli|hundred|naira|dollars?|usd|pounds?|gbp|euros?|eur)?\b(?!\w)/i;

const MONEY_SUFFIX_MULTIPLIER = {
  k: 1000,
  thousand: 1000,
  m: 1000000,
  million: 1000000,
  milli: 1000000,
  h: 100,
  hundred: 100,
  // Currency words carry no multiplier of their own — they just confirm
  // the number is money (and, via resolveCurrencyCode, which currency),
  // same role the ₦/$/£/€ symbols play as a prefix.
  naira: 1,
  dollar: 1,
  dollars: 1,
  usd: 1,
  pound: 1,
  pounds: 1,
  gbp: 1,
  euro: 1,
  euros: 1,
  eur: 1,
};

function parseMoneyToken(matchGroups) {
  const [, prefixRaw, numberPart, suffixRaw] = matchGroups;
  let value = parseFloat(numberPart.replace(/,/g, ''));
  if (Number.isNaN(value)) return null;
  const multiplier = MONEY_SUFFIX_MULTIPLIER[(suffixRaw || '').toLowerCase()];
  if (multiplier) value *= multiplier;
  return {
    // NOTE: for a non-NGN currency this is the face value's minor units
    // (x100) in THAT currency, not real Naira kobo — see the MONEY_TOKEN
    // comment above. Kept as `amountKobo` (rather than a more generic
    // name) since that's what every caller in this file already expects;
    // the currency conversion happens downstream, in worker.js.
    amountKobo: Math.round(value * 100),
    currency: resolveCurrencyCode(prefixRaw, suffixRaw),
  };
}

/**
 * Finds every money mention in the text, in order of appearance, tagged
 * with which keyword (if any) immediately preceded it — "pay", "remain",
 * or none — so the caller can assign total/paid/balance correctly instead
 * of guessing by position alone. Each mention also carries the currency
 * it was actually stated in (see parseMoneyToken/resolveCurrencyCode).
 */
function extractMoneyMentions(text) {
  const mentions = [];
  const re = new RegExp(MONEY_TOKEN.source, 'gi');
  let match;
  while ((match = re.exec(text)) !== null) {
    const parsedToken = parseMoneyToken(match);
    if (!parsedToken || !parsedToken.amountKobo) continue;
    const precedingText = text.slice(Math.max(0, match.index - 20), match.index).toLowerCase();
    let tag = null;
    if (/\b(pay|paid|pays)\s*$/.test(precedingText)) tag = 'PAID';
    else if (/\b(remain|remaining|balance|owing|left|bal)\s*$/.test(precedingText)) tag = 'BALANCE';
    mentions.push({ amountKobo: parsedToken.amountKobo, currency: parsedToken.currency, tag, index: match.index });
  }
  return mentions;
}

// "3 carton of indomie", "2 bags rice", "5 packs of sugar" — quantity
// and unit BEFORE the item name.
// The trailing lookahead also stops the (lazy) item name before a money
// amount ("2 bags rice 40k" — the name is "rice", not "rice 40k"),
// which is what lets the quantity digit be excluded from money-mention
// detection instead of being misread as a ₦2 total.
const ITEM_RE_QTY_FIRST =
  /(\d+)\s*(cartons?|bags?|packs?|pieces?|pcs?|cups?|plates?|dozen|crates?|kegs?|litres?|liters?|kg|tins?)\s+(?:of\s+)?([a-zA-Z][a-zA-Z\s]{1,40}?)(?=,|\.|$| she| he| and | pay| paid| to | for | today| yesterday| tomorrow| last week| last month| last year| this week| this month|\s+(?:\u20a6|\$|ngn|usd)?\s*\d)/i;

// "rice 2 bags", "indomie 3 cartons" — item name BEFORE quantity/unit,
// equally common phrasing ("bought/sold <item> <qty> <unit>"). Captures
// only the single word immediately adjacent to the quantity (JS regex
// search tries the leftmost position where the WHOLE pattern matches,
// so for "John buy rice 2 bags" it correctly skips "John"/"buy" — they
// aren't immediately followed by a digit — and lands on "rice 2 bags").
const ITEM_RE_NAME_FIRST = /\b([a-zA-Z]+)\s+(\d+)\s*(cartons?|bags?|packs?|pieces?|pcs?|cups?|plates?|dozen|crates?|kegs?|litres?|liters?|kg|tins?)\b/i;

// Trailing words that are never part of an item name even though the
// item-name capture groups above have no way to know where the noun
// phrase actually ends — date/time references ("rice TODAY", "maize
// LAST WEEK") and a bare dangling preposition left behind when its
// object wasn't captured ("rice YESTERDAY FOR" once "yesterday" itself
// is peeled off). Applied repeatedly so a chain like "today for" is
// fully stripped, not just its outermost word.
const TRAILING_NOISE_RE =
  /\s+(?:today|yesterday|tomorrow|tonight|this\s+morning|this\s+afternoon|this\s+evening|last\s+night|last\s+week|last\s+month|last\s+year|this\s+week|this\s+month|this\s+year|earlier|just\s+now|now|for|to|from|at)\s*$/i;

function cleanItemName(name) {
  if (!name) return name;
  let cleaned = name.trim();
  let previous;
  do {
    previous = cleaned;
    cleaned = cleaned.replace(TRAILING_NOISE_RE, '').trim();
  } while (cleaned !== previous && cleaned.length > 0);
  return cleaned;
}

function extractItem(text) {
  const qtyFirstMatch = text.match(ITEM_RE_QTY_FIRST);
  if (qtyFirstMatch) {
    const [, quantity, unit, name] = qtyFirstMatch;
    return {
      name: cleanItemName(name),
      quantity: Number(quantity),
      unit: unit.toLowerCase(),
      // Index of the quantity digit within the message, so callers can
      // exclude it from money-amount detection (e.g. the "2" in "2 bags
      // rice" is a quantity, not a price, even though it matches the
      // same digit pattern as a bare money mention).
      quantityIndex: qtyFirstMatch.index,
    };
  }

  const nameFirstMatch = text.match(ITEM_RE_NAME_FIRST);
  if (nameFirstMatch) {
    const [, name, quantity, unit] = nameFirstMatch;
    // Guard against matching a preceding verb as if it were the item
    // name (e.g. "buy 2 bags" with no item word at all) — a handful of
    // common transaction verbs never ARE the item.
    const VERB_BLOCKLIST = ['buy', 'bought', 'sold', 'sell', 'sells', 'selling', 'pay', 'paid', 'owe', 'owes', 'got'];
    if (VERB_BLOCKLIST.includes(name.toLowerCase())) return null;
    const quantityIndex = nameFirstMatch.index + nameFirstMatch[0].indexOf(quantity, name.length);
    return {
      name: cleanItemName(name),
      quantity: Number(quantity),
      unit: unit.toLowerCase(),
      quantityIndex,
    };
  }

  return null;
}

// Nigerian mobile numbers: local "0803..." (11 digits) or international
// "+234803..." / "234803..." / "08034..." (Nigerian domestic shorthand,
// normalized to E.164) — OR any other country's number typed in full
// E.164 form with a leading "+" (e.g. "+233241234567", "+254712345678")
// — recognized regardless of which country the merchant or their
// customer is in, not just Nigeria. A bare digit run with no "+" and no
// Nigerian-style leading 0 is deliberately NOT treated as a phone
// number here — unlike an explicit "+"-prefixed number, it would be
// genuinely ambiguous with a large money amount without knowing the
// country, so it's left alone rather than guessed at.
const PHONE_RE = /\+\d{8,15}\b|(?:\+?234|0)([789]\d{9})\b/;

/** Normalizes a PHONE_RE match to E.164 — group 1 only exists for the Nigerian-shorthand branch; the full match is already E.164 for the "+..." branch. */
function normalizePhoneMatch(match) {
  if (!match) return null;
  return match[1] ? `+234${match[1]}` : match[0];
}

// Verbs/fillers stripped when hunting for a bare item name (no
// quantity/unit pattern matched at all — e.g. "sold rice 5000", just a
// bare noun with no "bags"/"cartons"/etc). Deliberately mirrors the
// verb list classifyEntryType itself uses, since this only ever runs
// AFTER an entryType has already been determined.
const BARE_ITEM_LEADING_NAME_RE = /^[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*){0,2}\s+/;
const BARE_ITEM_LEADING_RE =
  /^(?:sold|sell|selling|sale of|bought|buy|purchase of|paid for|spent on|gave|received|owes?|owe)\s*/i;
// The currency-symbol alternation here MUST list every prefix
// MONEY_TOKEN recognizes (₦, $, £, €, ngn, usd, gbp, eur) — otherwise a
// symbol that isn't consumed as part of the stripped amount (e.g.
// "£150" when only "₦"/"ngn" were listed) is left dangling and gets
// returned as if it were part of the item name itself.
const BARE_ITEM_TRAILING_RE =
  /\s+(?:to|from|for)\s+[A-Z][\s\S]*$|\s*(?:\u20a6|\$|\u00a3|\u20ac|ngn|usd|gbp|eur)?\s*[\d][\d,.]*\s*(?:k|m|h|thousand|million|milli|hundred|naira|dollars?|usd|pounds?|gbp|euros?|eur)?\.?\s*[\s\S]*$/i;
// After stripping verbs/names/amounts, a handful of bare leftover words
// mean "there was no item at all" (e.g. "Chidi owes 2000" leaves
// nothing product-like once "Chidi" and "owes" are both gone) — these
// entries correctly have NO item line, same as a debt settlement.
const BARE_ITEM_REJECT_WORDS = new Set(['owes', 'owe', 'debt', 'money', 'balance', 'it', 'him', 'her', 'them']);

/**
 * When extractItem finds no quantity+unit pattern at all (the common
 * case — "sold rice 5000" has neither "bags" nor "cartons"), this pulls
 * out just the bare noun phrase so the receipt still has a clean,
 * presentable item name instead of ever falling back to showing the
 * merchant's raw message text. Returns null when there's no actual
 * item to report (e.g. "Chidi owes 2000", a bare debt with nothing
 * product-like in it) — the caller then correctly shows no item line
 * at all, the same way a debt settlement does.
 */
function extractBareItemName(text) {
  let core = text.trim();
  // Strip a leading customer name ("Chidi owes..." -> "owes...") BEFORE
  // stripping the verb, since the verb isn't at position 0 until the
  // name in front of it is gone.
  core = core.replace(BARE_ITEM_LEADING_NAME_RE, '');
  core = core.replace(BARE_ITEM_LEADING_RE, '');
  core = core.replace(BARE_ITEM_TRAILING_RE, '');
  core = cleanItemName(core);
  if (!core || core.length > 60) return null;
  if (BARE_ITEM_REJECT_WORDS.has(core.toLowerCase())) return null;
  return core.charAt(0).toUpperCase() + core.slice(1);
}

// "Mama Tunde buy ..." / "sold rice to Amaka" / "Chidi owes 2000"
const LEADING_NAME_RE = /^([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*){0,2})\s+(?:buy|bought|owes?|pay|paid|purchase)/;
const TO_NAME_RE = /\bto\s+([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*){0,2})\b/;

const COUNTERPARTY_NAME_BLOCKLIST = new Set(['I', 'We', 'You', 'He', 'She', 'They', 'It']);

function extractCounterparty(text) {
  const leading = text.match(LEADING_NAME_RE);
  if (leading && !COUNTERPARTY_NAME_BLOCKLIST.has(leading[1].trim())) return leading[1].trim();
  const to = text.match(TO_NAME_RE);
  if (to && !COUNTERPARTY_NAME_BLOCKLIST.has(to[1].trim())) return to[1].trim();
  return null;
}

function classifyEntryType(lowerText) {
  if (DEBT_SETTLE_VERBS.some((v) => lowerText.includes(v))) return 'DEBT_SETTLEMENT';
  if (DEBT_VERBS.some((v) => lowerText.includes(v))) return 'DEBT';
  if (CREDIT_VERBS.some((v) => lowerText.includes(v))) return 'CREDIT';
  if (DEBIT_VERBS.some((v) => lowerText.includes(v))) return 'DEBIT';
  return null;
}

/**
 * Front-door free-text parser — see the file-level comment. Invoked by
 * worker.js on every free-text message BEFORE any AI call; whether the
 * result is trusted is decided by scoreRegexParse / parseLedgerMessageScored.
 *
 * @param {string} rawMessage
 * @returns {{
 *   entryType: 'CREDIT'|'DEBIT'|'DEBT'|'DEBT_SETTLEMENT',
 *   description: string,
 *   counterpartyName: string|null,
 *   items: Array<{name:string, quantity:number, unit:string}>,
 *   totalKobo: number,
 *   paidKobo: number,
 *   balanceKobo: number,
 * } | null} null if the message doesn't look like a transaction at all
 */
function parseLedgerMessage(rawMessage) {
  if (typeof rawMessage !== 'string' || !rawMessage.trim()) return null;

  const text = rawMessage.trim();
  const lower = text.toLowerCase();

  const entryType = classifyEntryType(lower);
  if (!entryType) return null;

  const phoneMatch = text.match(PHONE_RE);
  const counterpartyPhone = normalizePhoneMatch(phoneMatch);
  const phoneSpan = phoneMatch
    ? { start: phoneMatch.index, end: phoneMatch.index + phoneMatch[0].length }
    : null;

  const allMentions = extractMoneyMentions(text);
  // A phone number is an 11+ digit run that would otherwise be misread as
  // a huge money amount — strip any mention whose position falls inside
  // the matched phone number's span before doing anything else with it.
  const mentions = phoneSpan
    ? allMentions.filter((m) => m.index < phoneSpan.start || m.index >= phoneSpan.end)
    : allMentions;
  if (mentions.length === 0) return null;

  const item = extractItem(text);
  // Exclude the item's own quantity digit from being misread as a money
  // mention (e.g. the "2" in "2 bags rice" is a quantity, not a price).
  const nonQuantityMentions = item
    ? mentions.filter((m) => m.index !== item.quantityIndex)
    : mentions;
  if (nonQuantityMentions.length === 0) return null;

  const textForName = phoneSpan ? text.slice(0, phoneSpan.start) + text.slice(phoneSpan.end) : text;
  const counterpartyName = extractCounterparty(textForName);

  const paidMention = nonQuantityMentions.find((m) => m.tag === 'PAID');
  const balanceMention = nonQuantityMentions.find((m) => m.tag === 'BALANCE');
  const untaggedMentions = nonQuantityMentions.filter((m) => !m.tag);

  let totalKobo;
  let paidKobo;
  let balanceKobo;

  if (entryType === 'DEBT_SETTLEMENT') {
    paidKobo = paidMention ? paidMention.amountKobo : (untaggedMentions[0]?.amountKobo ?? nonQuantityMentions[0].amountKobo);
    totalKobo = paidKobo;
    balanceKobo = 0;
  } else if (paidMention && balanceMention) {
    paidKobo = paidMention.amountKobo;
    balanceKobo = balanceMention.amountKobo;
    totalKobo = paidKobo + balanceKobo;
  } else if (paidMention && !balanceMention) {
    paidKobo = paidMention.amountKobo;
    totalKobo = untaggedMentions[0]?.amountKobo ?? nonQuantityMentions[0].amountKobo;
    balanceKobo = Math.max(0, totalKobo - paidKobo);
  } else if (!paidMention && balanceMention && untaggedMentions.length > 0) {
    // "sold lace to Blessing for 50k, balance 20k" — a stated total plus
    // a stated outstanding balance, with the paid part implied as the
    // difference. Without this branch the tagged balance was silently
    // ignored and the sale recorded as fully paid.
    totalKobo = untaggedMentions[0].amountKobo;
    balanceKobo = Math.min(balanceMention.amountKobo, totalKobo);
    paidKobo = totalKobo - balanceKobo;
  } else {
    totalKobo = untaggedMentions[0]?.amountKobo ?? nonQuantityMentions[0].amountKobo;
    if (entryType === 'DEBT') {
      paidKobo = 0;
      balanceKobo = totalKobo;
    } else {
      paidKobo = totalKobo;
      balanceKobo = 0;
    }
  }

  // Receipts must only ever show items/units/amounts — never the
  // merchant's raw message text (see receiptService.js, which now
  // trusts this array completely and no longer falls back to
  // `description` at render time). If extractItem found a proper
  // quantity+unit item, use it; otherwise fall back to just the bare
  // item noun (still clean, still receipt-safe) with no quantity/unit.
  // DEBT_SETTLEMENT is the one case with no "item" at all — that's a
  // payment against an existing debt, not something being sold/bought.
  let displayItem = item;
  if (!displayItem && entryType !== 'DEBT_SETTLEMENT') {
    const bareName = extractBareItemName(text);
    if (bareName) displayItem = { name: bareName };
  }

  const description = displayItem
    ? displayItem.quantity != null
      ? `${displayItem.name.charAt(0).toUpperCase()}${displayItem.name.slice(1)} x${displayItem.quantity} ${displayItem.unit}`
      : displayItem.name
    : 'Transaction';

  // Which EXPLICIT currency this entry was stated in, if any — a
  // message mixing currencies within itself isn't something real
  // merchant traffic does, so the first money mention's currency stands
  // for the whole entry. null means no currency symbol/word was used at
  // all (the overwhelming common case) — worker.js treats that as "this
  // is in the merchant's own account currency," not a guess of NGN
  // specifically; a NON-null value here is checked against the
  // merchant's actual account currency, and only asked about if it
  // genuinely doesn't match (see worker.js).
  const currency = nonQuantityMentions[0]?.currency || null;

  return {
    entryType,
    description,
    counterpartyName,
    counterpartyPhone,
    items: displayItem ? [displayItem] : [],
    currency,
    totalKobo,
    paidKobo,
    balanceKobo,
  };
}

// ---------------------------------------------------------------------------
// Reply-context resolution fallback — "John owes ₦12,000" gets sent as a
// receipt; the merchant later taps Reply on THAT WhatsApp message and
// just types "he paid" or "paid" with no name and no amount repeated.
// WhatsApp includes `context: { id: "wamid..." }` on that inbound
// message; the caller (worker.js) resolves that wamid back to the
// original ledger entry via queries.getLedgerEntryByOutboundMessageId
// and passes it in here as `replyEntry`. Same emergency-fallback-only
// status as parseLedgerMessage above — Gemini handles this via the
// "Reply context" block in the normal case (see
// businessContextService.js).
// ---------------------------------------------------------------------------

// "he paid", "she paid 5k", "paid in full", "don pay", "he don pay 3000",
// "fully paid", "cleared" — a bare settlement acknowledgement with no
// customer name of its own, meant to be resolved against replyEntry.
const BARE_REPLY_PAYMENT_RE =
  /^(?:(?:he|she|they|him|her)\s+)?(?:has\s+|don\s+)?(?:paid|pays|payed|cleared|settled)(?:\s+(?:in\s+full|up|off))?\b/i;

/**
 * @param {string} rawMessage
 * @param {object|null} replyEntry - the ledger_entries row the inbound
 *   message was a WhatsApp reply to (or null if it wasn't a reply, or
 *   the replied-to message doesn't map to any entry).
 * @returns {object|null} a DEBT_SETTLEMENT-shaped parsed entry, or null
 *   if this doesn't look like a bare reply-payment at all.
 */
function parseReplyMessage(rawMessage, replyEntry) {
  if (!replyEntry || typeof rawMessage !== 'string') return null;
  // Only a DEBT (or a still-open DEBT_SETTLEMENT chain) has an
  // outstanding balance a bare "he paid" could plausibly be closing.
  if (!replyEntry.counterparty_name || Number(replyEntry.balance_kobo) <= 0) return null;

  const text = rawMessage.trim();
  if (!BARE_REPLY_PAYMENT_RE.test(text)) return null;

  // An explicit amount in the reply itself overrides "assume it's the
  // full outstanding balance" — e.g. "he paid 5k" against a ₦12,000 debt
  // is a partial settlement, not a full one. A foreign-currency amount
  // here is a rare edge case but tagged the same way as everywhere
  // else — worker.js converts it before writing, same as any other entry.
  const mentions = extractMoneyMentions(text);
  const paidKobo = mentions.length > 0 ? mentions[0].amountKobo : Number(replyEntry.balance_kobo);
  const currency = mentions.length > 0 ? mentions[0].currency : 'NGN';

  return {
    entryType: 'DEBT_SETTLEMENT',
    description: `Payment from ${replyEntry.counterparty_name} (via reply)`,
    counterpartyName: replyEntry.counterparty_name,
    counterpartyPhone: replyEntry.counterparty_phone || null,
    items: [],
    currency,
    totalKobo: paidKobo,
    paidKobo,
    balanceKobo: 0,
  };
}

// "2 x iPhone charger x 4500" — the line format used while collecting
// items for a multi-item invoice (see worker.js's invoice-creation flow).
// Deliberately strict (exactly two "x" separators) so an ordinary
// transaction message ("sold 2 phones today") is never mistaken for an
// invoice line — this parser is only ever consulted while a merchant is
// already inside the invoice-items step, never against arbitrary text.
//
// The quantity may optionally be followed by a unit word before the
// first "x" ("2 bags x rice x 4500", "3 sacks x maize x 15k") — this is
// intentionally NOT a fixed list of recognized units (bags, sacks,
// bundles, packs, boxes, cartons, pieces, pcs, cups, crates, kegs,
// dozen, ...). Any single word works, since the merchant's own choice
// of unit is just descriptive text to Kika, never something it needs
// to interpret numerically — hardcoding a list would only mean some
// future word the merchant uses ("cans", "rolls", "trays", "kegs",
// "gallons"...) throws an error for no reason.
const INVOICE_ITEM_LINE_RE =
  /^(\d+)\s*(?:([a-zA-Z]+)\s+)?x\s*(.+?)\s*x\s*(\u20a6\s*|\$\s*|\u00a3\s*|\u20ac\s*|ngn\s*|usd\s*|gbp\s*|eur\s*)?([\d,]+(?:\.\d{1,2})?)\s*(k|m|h|thousand|million|milli|hundred|naira|dollars?|usd|pounds?|gbp|euros?|eur)?\b(?!\w)\s*$/i;

// Fallback for a single-"x" line where the merchant wrote the quantity,
// unit, and item name as one natural phrase instead of the strict
// template — "3 bags of rice x 15k", "5 bundles firewood x 2k", "10 pcs
// biro x 500". No unit word is parsed out here at all; whatever the
// merchant wrote between the quantity and the price is kept verbatim as
// the item's display name, so literally any unit word (or none) works
// without the parser needing to recognize it.
const INVOICE_ITEM_LINE_FALLBACK_RE =
  /^(\d+)\s+(.+?)\s*x\s*(\u20a6\s*|\$\s*|\u00a3\s*|\u20ac\s*|ngn\s*|usd\s*|gbp\s*|eur\s*)?([\d,]+(?:\.\d{1,2})?)\s*(k|m|h|thousand|million|milli|hundred|naira|dollars?|usd|pounds?|gbp|euros?|eur)?\b(?!\w)\s*$/i;

function resolveMoney(numberPart, suffixRaw) {
  let value = parseFloat(numberPart.replace(/,/g, ''));
  if (Number.isNaN(value)) return null;
  const multiplier = MONEY_SUFFIX_MULTIPLIER[(suffixRaw || '').toLowerCase()];
  if (multiplier) value *= multiplier;
  return value;
}

/**
 * Parses one invoice item line into its NGN-or-foreign face-value price.
 * NOTE: when the detected currency isn't 'NGN', unitPriceKobo/totalKobo
 * below are face-value-times-100 in THAT currency, not real Naira kobo —
 * see the same note on parseMoneyToken above. worker.js converts every
 * item's price to real NGN kobo (via utils/currency.js) right after this
 * returns, before the item is added to the invoice.
 */
function parseInvoiceItemLine(rawMessage) {
  if (typeof rawMessage !== 'string') return null;
  const trimmed = rawMessage.trim();

  const strict = trimmed.match(INVOICE_ITEM_LINE_RE);
  if (strict) {
    const [, quantityStr, unit, name, prefixRaw, priceStr, suffixRaw] = strict;
    const quantity = Number(quantityStr);
    const unitPriceFace = resolveMoney(priceStr, suffixRaw);
    if (name?.trim() && Number.isFinite(quantity) && quantity > 0 && unitPriceFace != null && unitPriceFace > 0) {
      return {
        name: name.trim(),
        unit: unit ? unit.toLowerCase() : null,
        quantity,
        currency: resolveCurrencyCode(prefixRaw, suffixRaw),
        unitPriceKobo: Math.round(unitPriceFace * 100),
        totalKobo: Math.round(unitPriceFace * 100) * quantity,
      };
    }
  }

  // Only reached when the strict two-"x" template didn't match at all
  // (not as a second attempt after a valid strict match) — a single "x"
  // in the message means the merchant phrased quantity+unit+name as one
  // free-text chunk.
  const fallback = trimmed.match(INVOICE_ITEM_LINE_FALLBACK_RE);
  if (fallback) {
    const [, quantityStr, name, prefixRaw, priceStr, suffixRaw] = fallback;
    const quantity = Number(quantityStr);
    const unitPriceFace = resolveMoney(priceStr, suffixRaw);
    if (name?.trim() && Number.isFinite(quantity) && quantity > 0 && unitPriceFace != null && unitPriceFace > 0) {
      return {
        name: name.trim(),
        unit: null,
        quantity,
        currency: resolveCurrencyCode(prefixRaw, suffixRaw),
        unitPriceKobo: Math.round(unitPriceFace * 100),
        totalKobo: Math.round(unitPriceFace * 100) * quantity,
      };
    }
  }

  return null;
}

// "new invoice for Adaeze", "create invoice for Adaeze", "invoice for
// Adaeze" — the trigger that starts the multi-item invoice-creation flow
// (distinct from the one-shot "INVOICE 5000 for rice" command above,
// which has no customer-name-first phrasing and still works for a
// quick single-line invoice).
// "for" is optional — "new invoice for Adaeze" and "new invoice Adaeze"
// both work, matching what the HELP text and startInvoiceCreation's own
// no-name prompt tell merchants they can type (that instruction text
// showed the no-"for" form without this regex actually accepting it —
// this was a real bug, not just wording: a merchant following the
// instructions literally would get no response at all).
//
// The (?!\d) guard is load-bearing, not decorative: with "for" now
// optional, "INVOICE 5000 for rice" (the one-shot payment-amount
// command, parsed separately by parseInvoiceCommand below) would
// otherwise ALSO match here first — "invoice " + "5000 for rice"
// captured as if it were a customer name — since this trigger is
// checked before the one-shot command in worker.js's dispatch order.
// A real customer name never starts with a digit, so this excludes
// exactly the one-shot command's shape without needing to hardcode
// anything about its syntax here.
const NEW_INVOICE_TRIGGER_RE = /^(?:new\s+|create\s+)?invoice\s+(?:for\s+)?(?!\d)(.+)$/i;
// The bare command with no name attached ("create invoice", "new
// invoice", just "invoice") also starts the flow — the caller asks for
// the customer's name as a separate step instead of doing nothing.
const NEW_INVOICE_BARE_TRIGGER_RE = /^(?:new\s+|create\s+)?invoice\s*[?.!]*$/i;

function parseNewInvoiceTrigger(rawMessage) {
  if (typeof rawMessage !== 'string') return null;
  const trimmed = rawMessage.trim();
  const namedMatch = trimmed.match(NEW_INVOICE_TRIGGER_RE);
  if (namedMatch) {
    let nameRaw = namedMatch[1].trim().replace(/[?.!]+$/, '');
    // Optional trailing phone — "new invoice for Adaeze 08012345678" —
    // so the invoice card's "Billed to" can show it when given, without
    // requiring a separate step. Peeled off the end rather than baked
    // into the main regex, since a lazy name capture followed by an
    // optional trailing group interacts unpredictably with names that
    // themselves contain digits.
    let customerPhone = null;
    const phoneTrailMatch = nameRaw.match(/\s+(\+\d{8,15}|0[789]\d{9})$/);
    if (phoneTrailMatch) {
      customerPhone = phoneTrailMatch[1].startsWith('+') ? phoneTrailMatch[1] : `+234${phoneTrailMatch[1].replace(/^0/, '')}`;
      nameRaw = nameRaw.slice(0, phoneTrailMatch.index).trim();
    }
    if (!nameRaw || nameRaw.length > 100) return null;
    return { customerName: nameRaw, customerPhone };
  }
  if (NEW_INVOICE_BARE_TRIGGER_RE.test(trimmed)) {
    return { customerName: null, customerPhone: null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Confidence gate — the deterministic scorer that decides whether a
// regex parse is trusted (handled locally, no AI) or escalated to
// Gemini. Every signal here is a plain, inspectable heuristic: the same
// message always gets the same score, and the audit log records the
// exact signals that fired (worker.js logs them on every escalation),
// so "why did this go to the AI?" is always answerable.
//
// The two thresholds:
//   REGEX_CONFIDENCE_THRESHOLD (default 0.80) — at/above this the regex
//     parse is committed directly; below it the message escalates to
//     Gemini. Tune UP to send more traffic to the AI (more nuance, more
//     cost), DOWN to keep more local (cheaper, stricter phrasing).
//   REGEX_DEGRADED_FLOOR (default 0.45) — if the Gemini escalation
//     itself fails (outage/quota), a below-threshold regex parse is
//     still usable as a degraded emergency answer as long as it cleared
//     this floor; anything below it is too ambiguous to write even in
//     an outage, and the merchant is asked to rephrase instead.
// ---------------------------------------------------------------------------

const REGEX_CONFIDENCE_THRESHOLD = Number(process.env.REGEX_CONFIDENCE_THRESHOLD || 0.8);
const REGEX_DEGRADED_FLOOR = Number(process.env.REGEX_DEGRADED_FLOOR || 0.45);

// Words from Pidgin/Yoruba/Igbo/Hausa business talk that the English
// verb lists above genuinely do not understand. Their presence doesn't
// mean the parse is WRONG — it means the regex probably missed meaning,
// which is exactly when Gemini (which reads all of these natively — see
// aiPersona.js) should take over.
const NON_ENGLISH_MARKERS = /\b(?:don|dey|abeg|wetin|dash(?:ed)?|wan|sabi|shishi|kudi|ego|ow[oó]|san|z[uụ]r[uụ]|sayar|ranka|biko|j[oọ]w[oọ])\b/i;

// "didn't sell", "not paid", "cancel that", "wrong amount" — statements
// ABOUT a transaction rather than a transaction, or corrections. The
// regex parser has no concept of negation; these must escalate.
const NEGATION_RE = /\b(?:didn'?t|did\s+not|not|never|no\s+be|cancel|mistake|wrong|remove|instead)\b/i;

/**
 * Scores a completed regex parse of `rawMessage` between 0 and 1.
 * Pure function of (text, parsed) — no I/O, no randomness.
 *
 * @returns {{ confidence: number, signals: string[] }}
 */
function scoreRegexParse(rawMessage, parsed) {
  const text = rawMessage.trim();
  const lower = text.toLowerCase();
  const signals = [];
  let confidence = 0.95; // free text never scores a flat 1.0

  // --- Conflicting intent verbs -------------------------------------------
  const settleHit = DEBT_SETTLE_VERBS.some((v) => lower.includes(v));
  const debtHit = !settleHit && DEBT_VERBS.some((v) => lower.includes(v)); // settle phrases legitimately contain "debt"
  const creditHit = CREDIT_VERBS.some((v) => lower.includes(v));
  const debitHit = DEBIT_VERBS.some((v) => lower.includes(v));
  const classesHit = [settleHit, debtHit, creditHit, debitHit].filter(Boolean).length;
  if (classesHit >= 2) {
    confidence -= 0.3;
    signals.push('conflicting_intent_verbs');
  }

  // --- Message-shape signals ----------------------------------------------
  if (text.includes('?')) {
    confidence -= 0.4;
    signals.push('question_mark');
  }
  if (NEGATION_RE.test(lower)) {
    confidence -= 0.35;
    signals.push('negation_or_correction');
  }
  if (NON_ENGLISH_MARKERS.test(lower)) {
    confidence -= 0.35;
    signals.push('non_english_marker');
  }

  const wordCount = text.split(/\s+/).length;
  if (wordCount > 30) {
    confidence -= 0.3;
    signals.push('very_long_message');
  } else if (wordCount > 18 || text.length > 140) {
    confidence -= 0.15;
    signals.push('long_message');
  }

  // --- Money-amount ambiguity ---------------------------------------------
  // Mirror the parser's own exclusions: a phone number's digits and an
  // item's quantity digit are NOT money mentions, and must not count as
  // "ambiguous extra amounts" here either.
  const phoneMatch = text.match(PHONE_RE);
  const quantityIndex = parsed?.items?.[0]?.quantityIndex;
  const mentions = extractMoneyMentions(text).filter((m) => {
    if (phoneMatch && m.index >= phoneMatch.index && m.index < phoneMatch.index + phoneMatch[0].length) return false;
    if (quantityIndex != null && m.index === quantityIndex) return false;
    return true;
  });
  const untagged = mentions.filter((m) => !m.tag);
  if (untagged.length > 1) {
    // More than one bare amount and no pay/remain tag to anchor them —
    // the parser is guessing which is the total.
    confidence -= 0.25;
    signals.push('multiple_untagged_amounts');
  }
  if (/\band\b|&/.test(lower) && mentions.length >= 2 && classesHit >= 2) {
    confidence -= 0.2;
    signals.push('possible_multiple_transactions');
  }

  // --- Parse-completeness signals -----------------------------------------
  if (parsed) {
    const paidTagged = mentions.some((m) => m.tag === 'PAID');
    const balanceTagged = mentions.some((m) => m.tag === 'BALANCE');
    if (paidTagged && balanceTagged) {
      confidence += 0.03; // "pay X remain Y" — the clearest shape there is
      signals.push('paid_and_balance_tagged');
    }
    if (parsed.items?.[0]?.quantity != null) {
      confidence += 0.02;
      signals.push('structured_item');
    }
    if (['CREDIT', 'DEBIT'].includes(parsed.entryType) && (!parsed.items || parsed.items.length === 0)) {
      confidence -= 0.1;
      signals.push('no_item_extracted');
    }
  }

  return { confidence: Math.min(0.98, Math.max(0, Number(confidence.toFixed(3)))), signals };
}

/**
 * The scored front-door entry point worker.js actually calls.
 *
 * @returns {{
 *   parsed: object|null,     // parseLedgerMessage output (or null)
 *   confidence: number,      // 0..1; 0 when parsed is null
 *   confident: boolean,      // confidence >= REGEX_CONFIDENCE_THRESHOLD
 *   usableInDegradedMode: boolean, // confidence >= REGEX_DEGRADED_FLOOR
 *   signals: string[],       // which heuristics fired (for audit logs)
 * }}
 */
function parseLedgerMessageScored(rawMessage) {
  const parsed = parseLedgerMessage(rawMessage);
  if (!parsed) {
    return { parsed: null, confidence: 0, confident: false, usableInDegradedMode: false, signals: ['no_parse'] };
  }
  const { confidence, signals } = scoreRegexParse(rawMessage, parsed);
  return {
    parsed,
    confidence,
    confident: confidence >= REGEX_CONFIDENCE_THRESHOLD,
    usableInDegradedMode: confidence >= REGEX_DEGRADED_FLOOR,
    signals,
  };
}

module.exports = {
  detectCommand,
  parseInvoiceCommand,
  parseAddStockCommand,
  isIncompleteAddStockCommand,
  parseClosingHourCommand,
  isIncompleteClosingHourCommand,
  parseSetCurrencyCommand,
  isIncompleteSetCurrencyCommand,
  extractSelfIntroduction,
  extractBusinessNameFromReply,
  looksLikeCleanName,
  parseLedgerMessage,
  parseLedgerMessageScored,
  scoreRegexParse,
  classifyEntryType,
  REGEX_CONFIDENCE_THRESHOLD,
  REGEX_DEGRADED_FLOOR,
  parseReplyMessage,
  parseInvoiceItemLine,
  parseNewInvoiceTrigger,
};
