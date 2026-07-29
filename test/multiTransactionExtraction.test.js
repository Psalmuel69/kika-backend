'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { ExtractedScanBatchSchema, validateExtraction } = require('../src/services/extractionSchema');
const entryValidator = require('../src/services/entryValidator');

/**
 * These tests don't call a real AI provider (no live Gemini/OpenAI in
 * this environment) — instead they simulate what a correctly-behaving
 * model SHOULD return for the exact "busy day recap" message that
 * previously only recorded the FIRST transaction and silently dropped
 * the other five (see the screenshots that reported this bug), and
 * verify the rest of the pipeline (schema validation ->
 * normalization -> entryValidator) handles a real multi-transaction
 * batch correctly end to end.
 */
describe('multi-transaction extraction pipeline (regression: must not silently drop transactions)', () => {
  test('a schema-valid 6-transaction batch validates and every transaction survives entryValidator', () => {
    const rawBatch = {
      transactions: [
        { entryType: 'DEBIT', description: 'Fuel for generator', totalNaira: 10000, paidNaira: 10000, balanceNaira: 0 },
        { entryType: 'DEBIT', description: 'Transport to Balogun', totalNaira: 2500, paidNaira: 2500, balanceNaira: 0 },
        { entryType: 'DEBIT', description: 'Materials from supplier', totalNaira: 95000, paidNaira: 95000, balanceNaira: 0 },
        { entryType: 'CREDIT', description: 'Wrappers x3', itemName: 'Wrappers', itemQuantity: 3, totalNaira: 48000, paidNaira: 48000, balanceNaira: 0 },
        { entryType: 'CREDIT', description: 'Shoes', totalNaira: 22000, paidNaira: 22000, balanceNaira: 0 },
        { entryType: 'DEBIT', description: 'Lunch for shop boy', totalNaira: 1500, paidNaira: 1500, balanceNaira: 0 },
      ],
    };

    const validation = validateExtraction(ExtractedScanBatchSchema, rawBatch);
    assert.equal(validation.ok, true, JSON.stringify(validation.issues));
    assert.equal(validation.data.transactions.length, 6, 'all 6 transactions must survive schema validation, none silently dropped');

    let survivingCount = 0;
    for (const t of validation.data.transactions) {
      const candidate = {
        entryType: t.entryType,
        description: t.description,
        counterpartyName: t.counterpartyName || null,
        counterpartyPhone: t.counterpartyPhone || null,
        items: t.itemName ? [{ name: t.itemName, quantity: t.itemQuantity || undefined, unit: t.itemUnit || undefined }] : [],
        currency: 'NGN',
        totalKobo: Math.round(t.totalNaira * 100),
        paidKobo: Math.round(t.paidNaira * 100),
        balanceKobo: Math.round(t.balanceNaira * 100),
      };
      const verdict = entryValidator.validateAndFinalizeEntry(candidate, { source: 'test' });
      assert.equal(verdict.ok, true, `transaction "${t.description}" should pass entryValidator`);
      survivingCount += 1;
    }
    assert.equal(survivingCount, 6, 'all 6 transactions must survive entryValidator — this is the exact bug: only 1 of 6 was previously recorded');

    const totalExpenseKobo = validation.data.transactions.filter((t) => t.entryType === 'DEBIT').reduce((sum, t) => sum + t.totalNaira * 100, 0);
    const totalSalesKobo = validation.data.transactions.filter((t) => t.entryType === 'CREDIT').reduce((sum, t) => sum + t.totalNaira * 100, 0);
    assert.equal(totalExpenseKobo, 10900000); // 10,000 + 2,500 + 95,000 + 1,500 = 109,000
    assert.equal(totalSalesKobo, 7000000); // 48,000 + 22,000 = 70,000
  });

  test('a schema-valid 5-transaction batch (customs clearance recap) survives entirely, including a DEBT for the unpaid demurrage', () => {
    const rawBatch = {
      transactions: [
        { entryType: 'DEBIT', description: 'Customs duty', totalNaira: 380000, paidNaira: 380000, balanceNaira: 0 },
        { entryType: 'DEBIT', description: 'Clearing agent fee', totalNaira: 45000, paidNaira: 45000, balanceNaira: 0 },
        { entryType: 'DEBIT', description: 'Trucking from Apapa', totalNaira: 60000, paidNaira: 60000, balanceNaira: 0 },
        { entryType: 'CREDIT', description: 'Units sold to wholesaler', totalNaira: 210000, paidNaira: 210000, balanceNaira: 0 },
        { entryType: 'DEBT', description: 'Shipping line demurrage', counterpartyName: 'Shipping line', totalNaira: 25000, paidNaira: 0, balanceNaira: 25000 },
      ],
    };

    const validation = validateExtraction(ExtractedScanBatchSchema, rawBatch);
    assert.equal(validation.ok, true, JSON.stringify(validation.issues));
    assert.equal(validation.data.transactions.length, 5);

    let survivingCount = 0;
    for (const t of validation.data.transactions) {
      const candidate = {
        entryType: t.entryType,
        description: t.description,
        counterpartyName: t.counterpartyName || null,
        counterpartyPhone: null,
        items: [],
        currency: 'NGN',
        totalKobo: Math.round(t.totalNaira * 100),
        paidKobo: Math.round(t.paidNaira * 100),
        balanceKobo: Math.round(t.balanceNaira * 100),
      };
      const verdict = entryValidator.validateAndFinalizeEntry(candidate, { source: 'test' });
      assert.equal(verdict.ok, true, `transaction "${t.description}" should pass entryValidator`);
      survivingCount += 1;
    }
    assert.equal(survivingCount, 5);
  });

  test('a single-transaction batch (array of 1) still validates cleanly', () => {
    const rawBatch = { transactions: [{ entryType: 'CREDIT', description: 'Rice', totalNaira: 5000, paidNaira: 5000, balanceNaira: 0 }] };
    const validation = validateExtraction(ExtractedScanBatchSchema, rawBatch);
    assert.equal(validation.ok, true);
    assert.equal(validation.data.transactions.length, 1);
  });
});
