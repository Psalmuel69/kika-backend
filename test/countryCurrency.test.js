'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { resolveByPhoneNumber, getCurrencySymbol, DEFAULT_CURRENCY } = require('../src/config/countryCurrency');
const { formatAmount, formatAmountWithCents, formatNaira } = require('../src/utils/currency');

describe('resolveByPhoneNumber — major markets', () => {
  const cases = [
    ['+2348012345678', 'NGN'],
    ['2348012345678', 'NGN'], // no leading '+' still resolves
    ['+233201234567', 'GHS'],
    ['+254712345678', 'KES'],
    ['+27821234567', 'ZAR'],
    ['+12125551234', 'USD'], // NANP, disambiguated by area code
    ['+441234567890', 'GBP'],
    ['+919876543210', 'INR'],
    ['+8613800138000', 'CNY'],
    ['+971501234567', 'AED'],
  ];

  for (const [phone, expected] of cases) {
    test(`${phone} -> ${expected}`, () => {
      assert.equal(resolveByPhoneNumber(phone).currencyCode, expected);
    });
  }
});

describe('resolveByPhoneNumber — shared-root disambiguation', () => {
  test('Russia vs Kazakhstan under the shared +7 root', () => {
    assert.equal(resolveByPhoneNumber('+79261234567').currencyCode, 'RUB'); // Russia
    assert.equal(resolveByPhoneNumber('+77012345678').currencyCode, 'KZT'); // Kazakhstan
  });
});

describe('resolveByPhoneNumber — malformed input never throws, always falls back', () => {
  const malformed = ['garbage', '', null, undefined, '123'];
  for (const input of malformed) {
    test(`falls back to ${DEFAULT_CURRENCY.currencyCode} for ${JSON.stringify(input)}`, () => {
      const result = resolveByPhoneNumber(input);
      assert.equal(result.currencyCode, DEFAULT_CURRENCY.currencyCode);
    });
  }
});

describe('getCurrencySymbol', () => {
  test('returns the correct symbol for known currencies', () => {
    assert.equal(getCurrencySymbol('NGN'), '\u20a6');
    assert.equal(getCurrencySymbol('USD'), '$');
    assert.equal(getCurrencySymbol('KES'), 'Sh');
  });

  test('falls back to the code itself for an unrecognized currency', () => {
    assert.equal(getCurrencySymbol('XYZ'), 'XYZ');
  });
});

describe('formatAmount / formatAmountWithCents', () => {
  test('formats whole-unit amounts with no decimals', () => {
    assert.equal(formatAmount(123456, 'NGN'), '\u20a61,235');
    assert.equal(formatAmount(5000000, 'GHS'), '\u20b550,000');
  });

  test('formats with 2 decimal places for receipts/invoices', () => {
    assert.equal(formatAmountWithCents(60000, 'NGN'), '\u20a6600.00');
    assert.equal(formatAmountWithCents(4500, 'USD'), '$45.00');
  });

  test('formatNaira is a stable back-compat alias for formatAmount(_, NGN)', () => {
    assert.equal(formatNaira(500000), formatAmount(500000, 'NGN'));
  });

  test('multi-character currency symbols render intact (Sh, Fr, R$)', () => {
    assert.equal(formatAmount(150000, 'KES'), 'Sh1,500');
    assert.equal(formatAmount(150000, 'XOF'), 'Fr1,500');
  });
});
