'use strict';

/**
 * Regenerates src/config/countryCurrency.js from the `world-countries`
 * npm package (a devDependency — never installed in production, since
 * the generated output is a plain static JS file with no runtime
 * dependency on this package at all).
 *
 * Run with: npm run generate:country-currency
 *
 * When to re-run this: a country changes its currency (redenomination,
 * dollarization, joining/leaving a currency union), a new country is
 * assigned a calling code, or `world-countries` ships a data correction.
 * This does not need to run on a schedule — country calling codes and
 * currencies change on the order of years, not days.
 */

const fs = require('fs');
const path = require('path');
const countries = require('world-countries');

function buildTable() {
  const table = {};

  for (const c of countries) {
    if (!c.idd || !c.idd.root) continue;
    const root = c.idd.root.replace(/[^0-9]/g, '');
    const currencies = c.currencies || {};
    // A handful of countries list more than one legal-tender currency
    // (e.g. a small dollarized economy alongside its own currency) —
    // the FIRST key is consistently the country's own primary currency
    // in this dataset (see the Bahamas example in the module comment
    // this script generates: BSD listed before USD).
    const currencyCode = Object.keys(currencies)[0];
    if (!currencyCode) continue;
    const cur = currencies[currencyCode];

    // Empty suffixes array means the root ALONE is this country's full
    // calling code (the common case); a non-empty array means the root
    // is shared and each suffix narrows it to one specific
    // country/region (NANP's +1, Russia/Kazakhstan's +7, etc.) — see
    // the generated file's module comment for the full explanation.
    const suffixes = c.idd.suffixes && c.idd.suffixes.length > 0 ? c.idd.suffixes : [''];
    for (const suf of suffixes) {
      const key = root + suf.replace(/[^0-9]/g, '');
      if (!key) continue;
      table[key] = {
        country: c.name.common,
        currencyCode,
        currencySymbol: cur.symbol || currencyCode,
        currencyName: cur.name,
      };
    }
  }

  // Curated overrides: a handful of calling codes are shared between a
  // populous nation and a much smaller territory/dependency using the
  // SAME currency (so nothing functional is wrong either way) — these
  // just make the displayed country name match the overwhelmingly
  // common real-world case, and resolve the 2-3 genuine data collisions
  // between obscure, extremely-low-population territories.
  Object.assign(table, {
    44: { country: 'United Kingdom', currencyCode: 'GBP', currencySymbol: '\u00a3', currencyName: 'British pound' },
    61: { country: 'Australia', currencyCode: 'AUD', currencySymbol: '$', currencyName: 'Australian dollar' },
    268: { country: 'Eswatini', currencyCode: 'SZL', currencySymbol: 'L', currencyName: 'Swazi lilangeni' },
    500: { country: 'Falkland Islands', currencyCode: 'FKP', currencySymbol: '\u00a3', currencyName: 'Falkland Islands pound' },
  });

  return table;
}

function render(table) {
  const sortedKeys = Object.keys(table).sort();
  const sorted = {};
  for (const k of sortedKeys) sorted[k] = table[k];

  const dataLiteral = JSON.stringify(sorted, null, 2).replace(/"([a-zA-Z0-9_]+)":/g, '$1:');

  return `'use strict';

/**
 * Country calling-code -> currency lookup table.
 *
 * WHY THIS EXISTS: Kika started as a Nigeria-only product, but a
 * merchant's currency should never be a hardcoded assumption -- a
 * merchant messaging from a +233 (Ghana) number almost certainly runs
 * their business in Cedis, not Naira. Rather than call an external
 * exchange-rate API on every message (network latency, cost, and a
 * dependency that can go down), this is a static, offline lookup: the
 * merchant's WhatsApp number's country calling code deterministically
 * picks their default currency ONCE at signup (see
 * queries.findOrCreateMerchantByWhatsappNumber), and every receipt,
 * invoice, report, and reply after that just formats amounts in that
 * currency -- no per-message lookups, no API calls, no token cost.
 *
 * PROVENANCE: generated offline from the world-countries npm package's
 * idd.root/idd.suffixes + currencies fields (itself sourced from
 * restcountries.com / Wikipedia's country data), not maintained by
 * hand -- see scripts/generate-country-currency-table.js if this ever
 * needs regenerating (e.g. a currency redenomination). Run with:
 * npm run generate:country-currency
 *
 * KEYS are calling codes with the leading "+" stripped -- e.g. "234"
 * for Nigeria, "1201" for a US New Jersey number (the North American
 * Numbering Plan shares the bare "+1" root across ~25
 * countries/territories, disambiguated only by the area code that
 * follows -- so NANP entries are keyed by the FULL root+area-code
 * string, not just "1"). Keys are looked up longest-prefix-first -- see
 * resolveByPhoneNumber below -- so this disambiguation, and a handful of
 * similar cases (Russia/Kazakhstan under +7, Western Sahara inside
 * Morocco's +212 range, Vatican City inside Italy's +39 range), resolve
 * correctly without any special-casing in the lookup itself.
 *
 * A few calling codes are shared by a populous nation and a much
 * smaller dependency using the SAME currency (e.g. +44 covers the UK as
 * well as Jersey/Guernsey/Isle of Man, all GBP) -- the entry below
 * favors the larger nation's name for display purposes; the currency is
 * identical either way, so this never affects any actual money math.
 */

const COUNTRY_CURRENCY_BY_CALLING_CODE = ${dataLiteral};

// Longest key in the table above -- how many leading digits a lookup
// tries before giving up, since a calling code can be 1-7 digits (see
// the Western Sahara / Vatican City note above for why a couple of
// entries run that long).
const MAX_KEY_LENGTH = Math.max(...Object.keys(COUNTRY_CURRENCY_BY_CALLING_CODE).map((k) => k.length));

// Kika's original, single-market default -- used whenever a phone
// number's calling code isn't recognized at all (malformed input, or a
// numbering-plan corner this table doesn't cover) rather than ever
// leaving a merchant with no currency assigned.
const DEFAULT_CURRENCY = { country: 'Nigeria', currencyCode: 'NGN', currencySymbol: '\\u20a6', currencyName: 'Nigerian naira' };

/**
 * Tries progressively shorter leading-digit prefixes of \`digits\`
 * against the table, longest first -- this is what correctly resolves
 * shared-root cases (NANP's +1, Russia/Kazakhstan's +7, Western Sahara
 * inside Morocco, Vatican City inside Italy) without any special-casing
 * here: the table's keys are already exactly as specific as each case
 * needs, so the first (longest) match is always the right one.
 */
function lookupByCallingCodeDigits(digits) {
  const tryLength = Math.min(MAX_KEY_LENGTH, digits.length);
  for (let len = tryLength; len >= 1; len -= 1) {
    const candidate = digits.slice(0, len);
    if (COUNTRY_CURRENCY_BY_CALLING_CODE[candidate]) return COUNTRY_CURRENCY_BY_CALLING_CODE[candidate];
  }
  return null;
}

/**
 * Resolves {country, currencyCode, currencySymbol, currencyName} from a
 * phone number in (or convertible to) E.164 form -- "+2348012345678",
 * "2348012345678", and anything with stray formatting (spaces, dashes)
 * all work, since only the digits are used. Never throws and never
 * returns null/undefined -- an unrecognized or malformed number falls
 * back to DEFAULT_CURRENCY (NGN), Kika's original market, rather than
 * ever leaving a merchant with no currency at all.
 */
function resolveByPhoneNumber(phoneNumber) {
  const digits = String(phoneNumber || '').replace(/[^0-9]/g, '');
  if (!digits) return DEFAULT_CURRENCY;
  return lookupByCallingCodeDigits(digits) || DEFAULT_CURRENCY;
}

/** Plain currencyCode -> {symbol, name} reverse lookup, e.g. for a merchant record that already has a currency code saved but needs its symbol for display. Built from the same table, so it's always in sync. */
const CURRENCY_INFO_BY_CODE = {};
for (const entry of Object.values(COUNTRY_CURRENCY_BY_CALLING_CODE)) {
  if (!CURRENCY_INFO_BY_CODE[entry.currencyCode]) {
    CURRENCY_INFO_BY_CODE[entry.currencyCode] = { symbol: entry.currencySymbol, name: entry.currencyName };
  }
}
CURRENCY_INFO_BY_CODE[DEFAULT_CURRENCY.currencyCode] = { symbol: DEFAULT_CURRENCY.currencySymbol, name: DEFAULT_CURRENCY.currencyName };

/** Symbol for a known currency code, falling back to the code itself (e.g. "XYZ") if somehow unrecognized -- always renders SOMETHING rather than throwing. */
function getCurrencySymbol(currencyCode) {
  return CURRENCY_INFO_BY_CODE[currencyCode]?.symbol || currencyCode;
}

module.exports = {
  COUNTRY_CURRENCY_BY_CALLING_CODE,
  CURRENCY_INFO_BY_CODE,
  DEFAULT_CURRENCY,
  resolveByPhoneNumber,
  getCurrencySymbol,
};
`;
}

const table = buildTable();
const output = render(table);
const outPath = path.join(__dirname, '..', 'src', 'config', 'countryCurrency.js');
fs.writeFileSync(outPath, output);
console.log(`Wrote ${Object.keys(table).length} calling-code entries to ${outPath}`);
