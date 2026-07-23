'use strict';

/**
 * The accounting engine — the single deterministic authority on what a
 * ledger entry's numbers are allowed to look like, applied to EVERY
 * candidate entry regardless of which extractor produced it (the regex
 * front door OR Gemini). This is the piece that keeps Kika's books
 * trustworthy while the language layer stays fuzzy:
 *
 *   - Gemini understands what the merchant MEANT (intent + facts).
 *   - extractionSchema.js checks the JSON is SHAPED right.
 *   - THIS file decides what the numbers actually ARE.
 *
 * No AI output ever reaches the database without passing through here,
 * and no AI-proposed arithmetic is ever trusted: paid/balance/total are
 * recomputed from first principles per entry type, using the model's
 * numbers only as *inputs*, with a deterministic repair for the common
 * off-by-consistency cases (e.g. the model returning total=27000,
 * paid=15000, balance=0 for "she pay 15k remain 12k" — repaired to
 * balance=12000 because total and paid are the primary facts).
 *
 * Hard rejects (returns ok:false, merchant is asked to clarify — the
 * entry is NEVER "best-effort" written):
 *   - total <= 0, or any negative amount
 *   - amounts above the sanity ceiling (₦500m per single entry)
 *   - paid > total on a sale/debt (money in can't exceed the sale)
 *   - a DEBT with nothing actually outstanding AND nothing paid
 *   - a DEBT_SETTLEMENT with a zero payment
 *
 * Soft repairs (fixed silently, deterministically):
 *   - balance recomputed as total - paid whenever the three disagree
 *   - CREDIT forced to fully-paid (that's what CREDIT means); if the
 *     numbers say money is still owed, the entry is *reclassified* to
 *     DEBT rather than rejected — the merchant's facts win over the
 *     extractor's label
 *   - DEBIT forced to paid=total, balance=0 (Kika doesn't track debt
 *     the merchant owes suppliers — an expense is money out, full stop)
 *   - DEBT_SETTLEMENT normalized to total=paid, balance=0 (how much of
 *     the customer's rolling balance it clears is decided later, inside
 *     the DB transaction, by settleOutstandingDebtForCounterparty — not
 *     by any extractor)
 */

const logger = require('../utils/logger');
const { MAX_SINGLE_TRANSACTION_NAIRA } = require('./extractionSchema');

const MAX_SINGLE_TRANSACTION_KOBO = MAX_SINGLE_TRANSACTION_NAIRA * 100;

function isValidKobo(v) {
  return Number.isSafeInteger(v) && v >= 0 && v <= MAX_SINGLE_TRANSACTION_KOBO;
}

function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((it) => it && typeof it.name === 'string' && it.name.trim())
    .map((it) => {
      const clean = { name: it.name.trim().slice(0, 60) };
      if (it.quantity != null && Number.isFinite(Number(it.quantity)) && Number(it.quantity) > 0) {
        clean.quantity = Number(it.quantity);
        clean.unit = typeof it.unit === 'string' ? it.unit.trim().slice(0, 30) : '';
      }
      return clean;
    })
    .slice(0, 20);
}

/**
 * Validates, repairs, and finalizes a candidate parsed entry.
 *
 * @param {object} candidate - the parser/extractor output shape:
 *   { entryType, description, counterpartyName, counterpartyPhone,
 *     items, totalKobo, paidKobo, balanceKobo, expenseCategory? }
 * @param {{ source: string }} [meta] - which extractor produced it, for logs.
 * @returns {{ ok: true, entry: object, repairs: string[] } |
 *           { ok: false, reason: string }}
 */
function validateAndFinalizeEntry(candidate, meta = {}) {
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, reason: 'empty' };
  }

  const repairs = [];
  let { entryType } = candidate;
  if (!['CREDIT', 'DEBIT', 'DEBT', 'DEBT_SETTLEMENT'].includes(entryType)) {
    return { ok: false, reason: 'unknown_entry_type' };
  }

  let totalKobo = Math.round(Number(candidate.totalKobo));
  let paidKobo = Math.round(Number(candidate.paidKobo));
  let balanceKobo = Math.round(Number(candidate.balanceKobo));

  if (![totalKobo, paidKobo, balanceKobo].every(Number.isFinite)) {
    return { ok: false, reason: 'non_numeric_amount' };
  }

  // DEBT_SETTLEMENT is the one type where "total" is just the payment.
  if (entryType === 'DEBT_SETTLEMENT') {
    if (paidKobo <= 0 && totalKobo > 0) {
      paidKobo = totalKobo; // extractor put the payment in total — fine
      repairs.push('settlement_paid_from_total');
    }
    if (paidKobo <= 0) return { ok: false, reason: 'settlement_without_payment' };
    if (!isValidKobo(paidKobo)) return { ok: false, reason: 'amount_out_of_range' };
    totalKobo = paidKobo;
    balanceKobo = 0;
  } else {
    if (totalKobo <= 0) return { ok: false, reason: 'zero_total' };
    if (!isValidKobo(totalKobo) || !isValidKobo(Math.max(paidKobo, 0)) || !isValidKobo(Math.max(balanceKobo, 0))) {
      return { ok: false, reason: 'amount_out_of_range' };
    }
    if (paidKobo < 0 || balanceKobo < 0) return { ok: false, reason: 'negative_amount' };

    if (entryType === 'DEBIT') {
      // An expense is money out in full — no counterparty balance math.
      if (paidKobo !== totalKobo || balanceKobo !== 0) repairs.push('debit_normalized');
      paidKobo = totalKobo;
      balanceKobo = 0;
    } else {
      // CREDIT / DEBT: enforce total = paid + balance, treating total
      // and paid as the primary facts (they're what merchants actually
      // state: "she pay 15k remain 12k" states paid and balance; "sold
      // rice 5000" states total). Resolution order:
      //   1. If paid + balance == total already — consistent, keep.
      //   2. Else if a balance was STATED (balance > 0) — the merchant
      //      used the "pay X remain Y" shape, so paid and balance are
      //      the stated facts; the real total IS their sum ("she pay
      //      15k remain 12k" with a misreported total of 15000 repairs
      //      to 27000, never to "remain 0").
      //   3. Else (balance == 0) — the stated facts are total and paid;
      //      recompute balance = total - paid, and reject outright if
      //      paid exceeds total (money received above the sale price is
      //      not something to silently guess about).
      if (paidKobo + balanceKobo !== totalKobo) {
        if (balanceKobo > 0 && isValidKobo(paidKobo + balanceKobo)) {
          totalKobo = paidKobo + balanceKobo;
          repairs.push('total_recomputed_from_paid_plus_balance');
        } else if (paidKobo <= totalKobo) {
          balanceKobo = totalKobo - paidKobo;
          repairs.push('balance_recomputed');
        } else {
          return { ok: false, reason: 'paid_exceeds_total' };
        }
      }

      // The label must match the money. CREDIT with an outstanding
      // balance IS a debt; DEBT with nothing outstanding IS a completed
      // sale. Reclassify from the numbers — the merchant's stated facts
      // outrank the extractor's chosen label.
      if (entryType === 'CREDIT' && balanceKobo > 0) {
        entryType = 'DEBT';
        repairs.push('reclassified_credit_to_debt');
      } else if (entryType === 'DEBT' && balanceKobo === 0) {
        entryType = 'CREDIT';
        repairs.push('reclassified_debt_to_credit');
      }
    }
  }

  const description = String(candidate.description || '').trim().slice(0, 140) || 'Transaction';
  const counterpartyName =
    typeof candidate.counterpartyName === 'string' && candidate.counterpartyName.trim()
      ? candidate.counterpartyName.trim().slice(0, 80)
      : null;
  const counterpartyPhone =
    typeof candidate.counterpartyPhone === 'string' && /^\+234\d{10}$/.test(candidate.counterpartyPhone.trim())
      ? candidate.counterpartyPhone.trim()
      : null;

  // A settlement must resolve to SOMEONE — with no name there is no
  // rolling balance to apply the payment against. (The worker's
  // reply-context path fills this in from the replied-to entry before
  // it ever gets here; a nameless settlement reaching this point means
  // the message genuinely didn't say who paid.)
  if (entryType === 'DEBT_SETTLEMENT' && !counterpartyName) {
    return { ok: false, reason: 'settlement_without_counterparty' };
  }

  const entry = {
    entryType,
    description,
    counterpartyName,
    counterpartyPhone,
    items: entryType === 'DEBT_SETTLEMENT' ? [] : sanitizeItems(candidate.items),
    totalKobo,
    paidKobo,
    balanceKobo,
    expenseCategory: entryType === 'DEBIT' ? candidate.expenseCategory || null : null,
  };

  if (repairs.length) {
    logger.info({ repairs, source: meta.source, entryType }, 'Entry validator applied deterministic repairs');
  }

  return { ok: true, entry, repairs };
}

module.exports = { validateAndFinalizeEntry, MAX_SINGLE_TRANSACTION_KOBO };
