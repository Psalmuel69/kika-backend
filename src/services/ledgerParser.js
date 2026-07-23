'use strict';

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

// "INVOICE 5000 for rice" or "INVOICE 08012345678 5000 rice delivery" —
// generates a customer-facing payment link rather than a ledger entry.
const INVOICE_PREFIX_RE = /^invoice\b[:\s]+(?:(\+?234\d{10}|0[789]\d{9})\s+)?([\d,]+(?:\.\d{1,2})?)(k)?\s*(.*)$/i;

function parseInvoiceCommand(rawMessage) {
  if (typeof rawMessage !== 'string') return null;
  const match = rawMessage.trim().match(INVOICE_PREFIX_RE);
  if (!match) return null;

  const [, phoneRaw, numberPart, kSuffix, description] = match;
  let amountNaira = parseFloat(numberPart.replace(/,/g, ''));
  if (Number.isNaN(amountNaira) || amountNaira <= 0) return null;
  if (kSuffix) amountNaira *= 1000;

  const customerPhone = phoneRaw ? (phoneRaw.startsWith('+234') ? phoneRaw : `+234${phoneRaw.replace(/^0/, '')}`) : null;

  return {
    amountKobo: Math.round(amountNaira * 100),
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

function parseAddStockCommand(rawMessage) {
  if (typeof rawMessage !== 'string') return null;
  const match = rawMessage.trim().match(ADD_STOCK_RE);
  if (!match) return null;
  const [, name, quantityStr, unit] = match;
  const quantity = Number(quantityStr);
  if (!name?.trim() || !Number.isFinite(quantity) || quantity <= 0) return null;
  return { productName: name.trim(), quantity, unit: unit?.trim() || null };
}

// "CLOSING HOUR 20" or "CLOSING HOUR: 7PM" (24hr or simple AM/PM)
const CLOSING_HOUR_RE = /^closing\s*hour\s*:?\s*(\d{1,2})\s*(am|pm)?\s*$/i;

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
// Front-door free-text transaction parser. Runs FIRST on every free-text
// message; its output is only trusted when scoreRegexParse (further
// down) clears the confidence threshold — see the file-level comment.
// ---------------------------------------------------------------------------

const CREDIT_VERBS = ['sold', 'sale', 'received', 'income', 'got paid', 'buy', 'bought from me', 'purchase from me'];
const DEBIT_VERBS = ['bought', 'paid for', 'spent', 'expense', 'purchase', 'i paid'];
const DEBT_SETTLE_VERBS = ['pay off', 'clear debt', 'settle debt', 'paid off', 'paid up', 'cleared'];
const DEBT_VERBS = ['owes', 'owe', 'debt', 'credit sale', 'on credit'];

// Matches "15k", "15,000", "₦15,000.50", "N15000", "15000 naira", "2m",
// "2 million", "5h", "5 hundred" — Nigerian chat shorthand for
// thousand/million/hundred multipliers, spelled out or abbreviated.
// The bare "n" prefix only matches when glued directly to a digit
// (lookahead \d, no space) — otherwise it would greedily swallow the
// trailing "n" of ordinary words like "remain" or "in" as a false
// currency marker.
const MONEY_TOKEN = /\b(?:₦\s*|ngn\s*|n(?=\d))?([\d,]+(?:\.\d{1,2})?)\s*(k|m|h|thousand|million|hundred)?\b(?!\w)/i;

const MONEY_SUFFIX_MULTIPLIER = {
  k: 1000,
  thousand: 1000,
  m: 1000000,
  million: 1000000,
  h: 100,
  hundred: 100,
};

function parseMoneyToken(matchGroups) {
  const [, numberPart, suffixRaw] = matchGroups;
  let value = parseFloat(numberPart.replace(/,/g, ''));
  if (Number.isNaN(value)) return null;
  const multiplier = MONEY_SUFFIX_MULTIPLIER[(suffixRaw || '').toLowerCase()];
  if (multiplier) value *= multiplier;
  return Math.round(value * 100); // -> kobo
}

/**
 * Finds every money mention in the text, in order of appearance, tagged
 * with which keyword (if any) immediately preceded it — "pay", "remain",
 * or none — so the caller can assign total/paid/balance correctly instead
 * of guessing by position alone.
 */
function extractMoneyMentions(text) {
  const mentions = [];
  const re = new RegExp(MONEY_TOKEN.source, 'gi');
  let match;
  while ((match = re.exec(text)) !== null) {
    const amountKobo = parseMoneyToken(match);
    if (!amountKobo) continue;
    const precedingText = text.slice(Math.max(0, match.index - 20), match.index).toLowerCase();
    let tag = null;
    if (/\b(pay|paid|pays)\s*$/.test(precedingText)) tag = 'PAID';
    else if (/\b(remain|remaining|balance|owing|left|bal)\s*$/.test(precedingText)) tag = 'BALANCE';
    mentions.push({ amountKobo, tag, index: match.index });
  }
  return mentions;
}

// "3 carton of indomie", "2 bags rice", "5 packs of sugar" — quantity
// and unit BEFORE the item name.
// The trailing lookahead also stops the (lazy) item name before a money
// amount ("2 bags rice 40k" — the name is "rice", not "rice 40k"),
// which is what lets the quantity digit be excluded from money-mention
// detection instead of being misread as a ₦2 total.
const ITEM_RE_QTY_FIRST = /(\d+)\s*(cartons?|bags?|packs?|pieces?|pcs?|cups?|plates?|dozen|crates?|kegs?|litres?|liters?|kg|tins?)\s+(?:of\s+)?([a-zA-Z][a-zA-Z\s]{1,40}?)(?=,|\.|$| she| he| and | pay| paid| to | for |\s+(?:\u20a6|ngn\s*|n(?=\d))?\d)/i;

// "rice 2 bags", "indomie 3 cartons" — item name BEFORE quantity/unit,
// equally common phrasing ("bought/sold <item> <qty> <unit>"). Captures
// only the single word immediately adjacent to the quantity (JS regex
// search tries the leftmost position where the WHOLE pattern matches,
// so for "John buy rice 2 bags" it correctly skips "John"/"buy" — they
// aren't immediately followed by a digit — and lands on "rice 2 bags").
const ITEM_RE_NAME_FIRST = /\b([a-zA-Z]+)\s+(\d+)\s*(cartons?|bags?|packs?|pieces?|pcs?|cups?|plates?|dozen|crates?|kegs?|litres?|liters?|kg|tins?)\b/i;

function extractItem(text) {
  const qtyFirstMatch = text.match(ITEM_RE_QTY_FIRST);
  if (qtyFirstMatch) {
    const [, quantity, unit, name] = qtyFirstMatch;
    return {
      name: name.trim(),
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
      name: name.trim(),
      quantity: Number(quantity),
      unit: unit.toLowerCase(),
      quantityIndex,
    };
  }

  return null;
}

// Nigerian mobile numbers: local "0803..." (11 digits) or international
// "+234803..." / "234803...". Normalized to E.164 (+234...) so the same
// customer is recognized across messages regardless of which format the
// merchant happened to type.
const PHONE_RE = /(?:\+?234|0)([789]\d{9})\b/;

// Verbs/fillers stripped when hunting for a bare item name (no
// quantity/unit pattern matched at all — e.g. "sold rice 5000", just a
// bare noun with no "bags"/"cartons"/etc). Deliberately mirrors the
// verb list classifyEntryType itself uses, since this only ever runs
// AFTER an entryType has already been determined.
const BARE_ITEM_LEADING_NAME_RE = /^[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*){0,2}\s+/;
const BARE_ITEM_LEADING_RE =
  /^(?:sold|sell|selling|sale of|bought|buy|purchase of|paid for|spent on|gave|received|owes?|owe)\s*/i;
const BARE_ITEM_TRAILING_RE = /\s+(?:to|from|for)\s+[A-Z][\s\S]*$|\s*(?:\u20a6|ngn)?\s*[\d][\d,.]*\s*(?:k|m)?\.?\s*[\s\S]*$/i;
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
  core = core.trim();
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
  const counterpartyPhone = phoneMatch ? `+234${phoneMatch[1]}` : null;
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

  return {
    entryType,
    description,
    counterpartyName,
    counterpartyPhone,
    items: displayItem ? [displayItem] : [],
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
  // is a partial settlement, not a full one.
  const mentions = extractMoneyMentions(text);
  const paidKobo = mentions.length > 0 ? mentions[0].amountKobo : Number(replyEntry.balance_kobo);

  return {
    entryType: 'DEBT_SETTLEMENT',
    description: `Payment from ${replyEntry.counterparty_name} (via reply)`,
    counterpartyName: replyEntry.counterparty_name,
    counterpartyPhone: replyEntry.counterparty_phone || null,
    items: [],
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
const INVOICE_ITEM_LINE_RE = /^(\d+)\s*x\s*(.+?)\s*x\s*([\d,]+(?:\.\d{1,2})?)(k)?\s*$/i;

function parseInvoiceItemLine(rawMessage) {
  if (typeof rawMessage !== 'string') return null;
  const match = rawMessage.trim().match(INVOICE_ITEM_LINE_RE);
  if (!match) return null;
  const [, quantityStr, name, priceStr, kSuffix] = match;
  const quantity = Number(quantityStr);
  let unitPriceNaira = parseFloat(priceStr.replace(/,/g, ''));
  if (!name?.trim() || !Number.isFinite(quantity) || quantity <= 0 || Number.isNaN(unitPriceNaira) || unitPriceNaira <= 0) {
    return null;
  }
  if (kSuffix) unitPriceNaira *= 1000;
  return {
    name: name.trim(),
    quantity,
    unitPriceKobo: Math.round(unitPriceNaira * 100),
    totalKobo: Math.round(unitPriceNaira * 100) * quantity,
  };
}

// "new invoice for Adaeze", "create invoice for Adaeze", "invoice for
// Adaeze" — the trigger that starts the multi-item invoice-creation flow
// (distinct from the one-shot "INVOICE 5000 for rice" command above,
// which has no customer-name-first phrasing and still works for a
// quick single-line invoice).
const NEW_INVOICE_TRIGGER_RE = /^(?:new\s+|create\s+)?invoice\s+for\s+(.+)$/i;

function parseNewInvoiceTrigger(rawMessage) {
  if (typeof rawMessage !== 'string') return null;
  const match = rawMessage.trim().match(NEW_INVOICE_TRIGGER_RE);
  if (!match) return null;
  const customerName = match[1].trim().replace(/[?.!]+$/, '');
  if (!customerName || customerName.length > 100) return null;
  return { customerName };
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
  parseClosingHourCommand,
  extractSelfIntroduction,
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
