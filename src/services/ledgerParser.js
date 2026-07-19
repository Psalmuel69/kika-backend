'use strict';

/**
 * Turns a free-text WhatsApp message — including common Nigerian Pidgin
 * phrasing — into a structured ledger entry. Deliberately rule-based
 * (no LLM call in the hot path) so it stays cheap and fast enough to run
 * inline on every inbound message.
 *
 * Real merchant messages this is built against, e.g.:
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
const ITEM_RE_QTY_FIRST = /(\d+)\s*(cartons?|bags?|packs?|pieces?|pcs?|cups?|plates?|dozen|crates?|kegs?|litres?|liters?|kg|tins?)\s+(?:of\s+)?([a-zA-Z][a-zA-Z\s]{1,40}?)(?=,|\.|$| she| he| and | pay| paid| to | for )/i;

// "rice 2 bags", "indomie 3 cartons" — item name BEFORE quantity/unit,
// equally common phrasing ("bought/sold <item> <qty> <unit>"). Captures
// only the single word immediately adjacent to the quantity (JS regex
// search tries the leftmost position where the WHOLE pattern matches,
// so for "John buy rice 2 bags" it correctly skips "John"/"buy" — they
// aren't immediately followed by a digit — and lands on "rice 2 bags").
// Deliberately doesn't support multi-word names in this order (e.g.
// "bag of rice 2 bags") to avoid re-introducing the over-capture bug
// this replaced; ITEM_RE_QTY_FIRST already handles multi-word names
// fine in the far more common "2 bags of rice" order.
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

function extractCounterpartyPhone(text) {
  const match = text.match(PHONE_RE);
  if (!match) return null;
  return `+234${match[1]}`;
}

// "Mama Tunde buy ..." / "sold rice to Amaka" / "Chidi owes 2000"
const LEADING_NAME_RE = /^([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*){0,2})\s+(?:buy|bought|owes?|pay|paid|purchase)/;
const TO_NAME_RE = /\bto\s+([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*){0,2})\b/;

function extractCounterparty(text) {
  const leading = text.match(LEADING_NAME_RE);
  if (leading) return leading[1].trim();
  const to = text.match(TO_NAME_RE);
  if (to) return to[1].trim();
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

  // Run name extraction against a copy with the phone digits blanked out
  // (same length, so all other match indices stay aligned) — otherwise
  // "Mama Tunde 08012345678 buy ..." fails to match because the phone
  // number sits between the name and the verb.
  const textForName = phoneSpan
    ? text.slice(0, phoneSpan.start) + ' '.repeat(phoneSpan.end - phoneSpan.start) + text.slice(phoneSpan.end)
    : text;
  const counterpartyName = extractCounterparty(textForName);

  const paidMention = mentions.find((m) => m.tag === 'PAID');
  const balanceMention = mentions.find((m) => m.tag === 'BALANCE');
  // Exclude the item's quantity digit (e.g. the "2" in "2 bags rice") from
  // candidate totals — it matches the same bare-number pattern as a price
  // but isn't one.
  const untaggedMentions = mentions.filter(
    (m) => !m.tag && !(item && m.index === item.quantityIndex)
  );

  let totalKobo;
  let paidKobo;
  let balanceKobo;

  if (paidMention && balanceMention) {
    // "she pay 15k remain 12k" -> total is implied as paid + balance
    paidKobo = paidMention.amountKobo;
    balanceKobo = balanceMention.amountKobo;
    totalKobo = paidKobo + balanceKobo;
  } else if (paidMention && !balanceMention) {
    // Fully paid on the spot
    paidKobo = paidMention.amountKobo;
    totalKobo = paidKobo;
    balanceKobo = 0;
  } else {
    // No explicit paid/remain split — first plain number is the total.
    const nonQuantityMentions = mentions.filter((m) => !(item && m.index === item.quantityIndex));
    totalKobo = untaggedMentions[0]?.amountKobo ?? nonQuantityMentions[0]?.amountKobo ?? mentions[0].amountKobo;
    if (entryType === 'DEBT') {
      // A pure debt line ("Chidi owes 2000") means nothing has been paid yet.
      paidKobo = 0;
      balanceKobo = totalKobo;
    } else {
      paidKobo = totalKobo;
      balanceKobo = 0;
    }
  }

  const resolvedEntryType = entryType === 'DEBT_SETTLEMENT' ? 'DEBT_SETTLEMENT' : balanceKobo > 0 ? 'DEBT' : entryType;

  const description = item
    ? `${item.name.charAt(0).toUpperCase()}${item.name.slice(1)} x${item.quantity} ${item.unit}`
    : text.slice(0, 200);

  return {
    entryType: resolvedEntryType,
    description,
    counterpartyName,
    counterpartyPhone,
    items: item ? [item] : [],
    totalKobo,
    paidKobo,
    balanceKobo,
  };
}

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
  BALANCE: ['balance', 'summary', 'report'],
  HELP: ['help', 'start', 'menu'],
  INSIGHTS: ['insights', 'monthly', 'monthly insights', 'monthly report'],
  SUNSET: ['sunset', 'today', "today's report", 'daily report'],
  UNDO: ['undo', 'delete last sale', 'delete last entry', 'cancel last sale'],
  EXPORT: ['export', 'my data', 'excel', 'csv'],
  REVIEW_SCAN: ['review scan', 'review'],
  TESTDIGEST: ['testdigest', 'test digest'],
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

module.exports = {
  parseLedgerMessage,
  detectCommand,
  parseInvoiceCommand,
  parseAddStockCommand,
  parseClosingHourCommand,
  parseReplyMessage,
  extractSelfIntroduction,
};

// ---------------------------------------------------------------------------
// Reply-context resolution — "John owes ₦12,000" gets sent as a receipt;
// the merchant later taps Reply on THAT WhatsApp message and just types
// "he paid" or "paid" with no name and no amount repeated. WhatsApp
// includes `context: { id: "wamid..." }` on that inbound message; the
// caller (worker.js) resolves that wamid back to the original ledger
// entry via queries.getLedgerEntryByOutboundMessageId and passes it in
// here as `replyEntry`. This is deliberately narrow — a fast, confident
// regex path for the single most common "bare payment reply" shape.
// Anything more indirect ("he paid me back yesterday for that") still
// falls through to the AI fallback, which also receives the reply
// context (see aiTransactionParser.js) and can resolve it more flexibly.
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
 *   if this doesn't look like a bare reply-payment at all (caller should
 *   fall through to the normal parser / AI fallback).
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

// "I'm Samuel", "I am Samuel", "My name is Samuel", "This is Samuel",
// "Call me Samuel" — deliberately conservative (2-word cap on the
// captured name, letters/hyphen/apostrophe only) so it doesn't
// misfire on unrelated sentences that happen to start similarly.
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
