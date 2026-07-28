'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { validateAndFinalizeEntry, MAX_SINGLE_TRANSACTION_KOBO } = require('../src/services/entryValidator');

// Minimal valid candidate shape, overridden per-test — keeps every test
// focused on the ONE thing it's actually checking instead of repeating
// the full object.
function candidate(overrides = {}) {
  return {
    entryType: 'CREDIT',
    description: 'Rice',
    counterpartyName: null,
    counterpartyPhone: null,
    items: [{ name: 'Rice', quantity: 2, unit: 'bags' }],
    totalKobo: 500000,
    paidKobo: 500000,
    balanceKobo: 0,
    ...overrides,
  };
}

describe('entryValidator — hard rejects', () => {
  test('rejects a non-object candidate', () => {
    assert.equal(validateAndFinalizeEntry(null).ok, false);
    assert.equal(validateAndFinalizeEntry(undefined).ok, false);
    assert.equal(validateAndFinalizeEntry('nope').ok, false);
  });

  test('rejects an unrecognized entryType', () => {
    const v = validateAndFinalizeEntry(candidate({ entryType: 'REFUND' }));
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'unknown_entry_type');
  });

  test('rejects non-numeric amounts', () => {
    const v = validateAndFinalizeEntry(candidate({ totalKobo: 'lots', paidKobo: 500000, balanceKobo: 0 }));
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'non_numeric_amount');
  });

  test('rejects a zero or negative total on a sale', () => {
    assert.equal(validateAndFinalizeEntry(candidate({ totalKobo: 0, paidKobo: 0, balanceKobo: 0 })).ok, false);
    assert.equal(validateAndFinalizeEntry(candidate({ totalKobo: -500, paidKobo: 0, balanceKobo: 0 })).ok, false);
  });

  test('rejects an amount above the single-transaction sanity ceiling', () => {
    const v = validateAndFinalizeEntry(candidate({ totalKobo: MAX_SINGLE_TRANSACTION_KOBO + 100, paidKobo: MAX_SINGLE_TRANSACTION_KOBO + 100, balanceKobo: 0 }));
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'amount_out_of_range');
  });

  test('rejects negative paid/balance amounts', () => {
    assert.equal(validateAndFinalizeEntry(candidate({ paidKobo: -100 })).ok, false);
    assert.equal(validateAndFinalizeEntry(candidate({ entryType: 'DEBT', totalKobo: 500000, paidKobo: 0, balanceKobo: -100 })).ok, false);
  });

  test('rejects paid exceeding total with no stated balance to reconcile against', () => {
    // paid (60000) > total (50000), balance not separately stated as
    // the primary fact — this is money received above the sale price,
    // never silently guessed at.
    const v = validateAndFinalizeEntry(candidate({ totalKobo: 500000, paidKobo: 600000, balanceKobo: 0 }));
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'paid_exceeds_total');
  });

  test('rejects a DEBT_SETTLEMENT with no payment at all', () => {
    const v = validateAndFinalizeEntry(
      candidate({ entryType: 'DEBT_SETTLEMENT', counterpartyName: 'Chidi', totalKobo: 0, paidKobo: 0, balanceKobo: 0 })
    );
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'settlement_without_payment');
  });

  test('rejects a DEBT_SETTLEMENT with no counterparty name', () => {
    const v = validateAndFinalizeEntry(
      candidate({ entryType: 'DEBT_SETTLEMENT', counterpartyName: null, totalKobo: 500000, paidKobo: 500000, balanceKobo: 0 })
    );
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'settlement_without_counterparty');
  });
});

describe('entryValidator — soft repairs', () => {
  test('recomputes balance from total - paid when they disagree and no balance was stated', () => {
    // "sold rice 5000, she pay 3000" — balance not stated at all
    // (0), so total/paid are the primary facts; balance is derived.
    const v = validateAndFinalizeEntry(candidate({ entryType: 'DEBT', totalKobo: 500000, paidKobo: 300000, balanceKobo: 0 }));
    assert.equal(v.ok, true);
    assert.equal(v.entry.balanceKobo, 200000);
    assert.ok(v.repairs.includes('balance_recomputed'));
  });

  test('recomputes total from paid + balance when a balance WAS stated (the "pay X remain Y" shape)', () => {
    // "she pay 15k remain 12k" mis-extracted with total=15000 — the
    // stated balance (12000) means paid+balance are the primary facts,
    // so total is corrected to their sum, never to "remain 0".
    const v = validateAndFinalizeEntry(candidate({ entryType: 'DEBT', totalKobo: 1500000, paidKobo: 1500000, balanceKobo: 1200000 }));
    assert.equal(v.ok, true);
    assert.equal(v.entry.totalKobo, 2700000);
    assert.equal(v.entry.paidKobo, 1500000);
    assert.equal(v.entry.balanceKobo, 1200000);
    assert.ok(v.repairs.includes('total_recomputed_from_paid_plus_balance'));
  });

  test('reclassifies CREDIT to DEBT when the numbers show an outstanding balance', () => {
    const v = validateAndFinalizeEntry(candidate({ entryType: 'CREDIT', totalKobo: 500000, paidKobo: 300000, balanceKobo: 200000 }));
    assert.equal(v.ok, true);
    assert.equal(v.entry.entryType, 'DEBT');
    assert.ok(v.repairs.includes('reclassified_credit_to_debt'));
  });

  test('reclassifies DEBT to CREDIT when the numbers show nothing outstanding', () => {
    const v = validateAndFinalizeEntry(candidate({ entryType: 'DEBT', totalKobo: 500000, paidKobo: 500000, balanceKobo: 0 }));
    assert.equal(v.ok, true);
    assert.equal(v.entry.entryType, 'CREDIT');
    assert.ok(v.repairs.includes('reclassified_debt_to_credit'));
  });

  test('normalizes a DEBIT to fully paid regardless of what was extracted', () => {
    const v = validateAndFinalizeEntry(candidate({ entryType: 'DEBIT', totalKobo: 300000, paidKobo: 100000, balanceKobo: 200000 }));
    assert.equal(v.ok, true);
    assert.equal(v.entry.paidKobo, 300000);
    assert.equal(v.entry.balanceKobo, 0);
    assert.ok(v.repairs.includes('debit_normalized'));
  });

  test('pulls a DEBT_SETTLEMENT payment out of totalKobo when paidKobo was left at 0', () => {
    const v = validateAndFinalizeEntry(
      candidate({ entryType: 'DEBT_SETTLEMENT', counterpartyName: 'Chidi', totalKobo: 500000, paidKobo: 0, balanceKobo: 0 })
    );
    assert.equal(v.ok, true);
    assert.equal(v.entry.paidKobo, 500000);
    assert.equal(v.entry.totalKobo, 500000);
    assert.equal(v.entry.balanceKobo, 0);
    assert.ok(v.repairs.includes('settlement_paid_from_total'));
  });
});

describe('entryValidator — passthrough fields', () => {
  test('trims and caps description/counterpartyName length', () => {
    const v = validateAndFinalizeEntry(
      candidate({ description: '  '.padEnd(0) + 'x'.repeat(200), counterpartyName: 'y'.repeat(200) })
    );
    assert.equal(v.ok, true);
    assert.equal(v.entry.description.length, 140);
    assert.equal(v.entry.counterpartyName.length, 80);
  });

  test('accepts an international (non-Nigerian) counterparty phone in E.164 form', () => {
    const v = validateAndFinalizeEntry(candidate({ counterpartyPhone: '+233241234567' }));
    assert.equal(v.ok, true);
    assert.equal(v.entry.counterpartyPhone, '+233241234567');
  });

  test('accepts a Nigerian counterparty phone in E.164 form', () => {
    const v = validateAndFinalizeEntry(candidate({ counterpartyPhone: '+2348012345678' }));
    assert.equal(v.ok, true);
    assert.equal(v.entry.counterpartyPhone, '+2348012345678');
  });

  test('drops a malformed counterparty phone rather than guessing', () => {
    const v = validateAndFinalizeEntry(candidate({ counterpartyPhone: '08012345678' })); // missing '+'
    assert.equal(v.ok, true);
    assert.equal(v.entry.counterpartyPhone, null);
  });

  test('passes through currency, defaulting to NGN only when truly absent', () => {
    assert.equal(validateAndFinalizeEntry(candidate({ currency: 'GHS' })).entry.currency, 'GHS');
    assert.equal(validateAndFinalizeEntry(candidate({ currency: null })).entry.currency, 'NGN');
    assert.equal(validateAndFinalizeEntry(candidate({})).entry.currency, 'NGN');
  });

  test('caps items to 20 and drops any without a usable name', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ name: `Item ${i}` }));
    items.push({ name: '' }, { quantity: 5 });
    const v = validateAndFinalizeEntry(candidate({ items }));
    assert.equal(v.ok, true);
    assert.equal(v.entry.items.length, 20);
  });

  test('DEBT_SETTLEMENT always has an empty items array', () => {
    const v = validateAndFinalizeEntry(
      candidate({ entryType: 'DEBT_SETTLEMENT', counterpartyName: 'Chidi', totalKobo: 500000, paidKobo: 500000, balanceKobo: 0, items: [{ name: 'should be dropped' }] })
    );
    assert.equal(v.ok, true);
    assert.deepEqual(v.entry.items, []);
  });
});
