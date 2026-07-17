// src/utils/currency.js
'use strict';

/**
 * Convert a value in kobo (integer) to a formatted Naira string.
 * Example: 123456 → "₦1,235"
 */
function formatNaira(kobo) {
  const naira = Number(kobo) / 100;
  // Use the Nigerian locale for proper grouping; fallback to en if unavailable.
  const formatted = naira.toLocaleString('en-NG', { maximumFractionDigits: 0 });
  return `\u20a6${formatted}`;
}

module.exports = { formatNaira };