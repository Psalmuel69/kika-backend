// src/utils/currency.js
'use strict';

const { getCurrencySymbol, DEFAULT_CURRENCY } = require('../config/countryCurrency');

/**
 * Formats a minor-unit integer amount as a symbol-prefixed, grouped
 * string with NO decimal places — e.g. formatAmount(123456, 'NGN') ->
 * "₦1,235", formatAmount(5000000, 'GHS') -> "₵50,000". This is the
 * "conversational" style used in chat replies, balance summaries, and
 * reports — see formatAmountWithCents below for the receipt/invoice
 * style, which keeps the 2-decimal precision those documents need.
 *
 * The field is still called "kobo" throughout the rest of the codebase
 * for historical reasons (Kika started Nigeria-only, where kobo really
 * is the minor unit) — it generically just means "amount x 100" in
 * whatever currencyCode is passed here now that merchants outside
 * Nigeria are supported. Renaming every *_kobo column/variable across
 * the codebase for this would be a large, purely-cosmetic risk for no
 * functional gain, so it's kept as the internal convention; the actual
 * currencyCode traveling alongside it (see countryCurrency.js and
 * merchants.default_currency / ledger_entries.currency) is what
 * determines correctness.
 */
function formatAmount(kobo, currencyCode = DEFAULT_CURRENCY.currencyCode) {
  const major = Number(kobo) / 100;
  const formatted = major.toLocaleString('en-NG', { maximumFractionDigits: 0 });
  return `${getCurrencySymbol(currencyCode)}${formatted}`;
}

/**
 * Same as formatAmount, but with the 2-decimal precision receipts and
 * invoices show (e.g. "₦1,234.50") — separate from formatAmount above
 * since chat-style summaries deliberately round to whole units for
 * readability while a financial document shouldn't silently drop cents.
 */
function formatAmountWithCents(kobo, currencyCode = DEFAULT_CURRENCY.currencyCode) {
  const major = Number(kobo) / 100;
  const formatted = major.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${getCurrencySymbol(currencyCode)}${formatted}`;
}

/**
 * Back-compat alias — most of the codebase was written when Kika was
 * Nigeria-only and calls this name directly. Equivalent to
 * formatAmount(kobo, 'NGN'); prefer formatAmount(kobo, merchant's
 * default_currency) in any new or currency-aware call site.
 */
function formatNaira(kobo) {
  return formatAmount(kobo, 'NGN');
}

module.exports = { formatAmount, formatAmountWithCents, formatNaira };
