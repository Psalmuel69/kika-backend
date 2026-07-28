'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const ledgerParser = require('../src/services/ledgerParser');

describe('parseLedgerMessage — entry type classification', () => {
  const cases = [
    ['sold rice 5000', 'CREDIT'],
    ['sold 2 bags rice 5000', 'CREDIT'],
    ['Chidi owes 2000', 'DEBT'],
    ['Chidi owes me 2000', 'DEBT'],
    ['on credit, sold rice 5000', 'DEBT'],
    ['bought fuel 3000', 'DEBIT'],
    ['I paid for transport 2000', 'DEBIT'],
    ['John pay off his debt 5k', 'DEBT_SETTLEMENT'],
    ['wetin dey happen', null],
    ['is this the right amount', null],
  ];

  for (const [msg, expected] of cases) {
    test(`"${msg}" -> ${expected}`, () => {
      const parsed = ledgerParser.parseLedgerMessage(msg);
      assert.equal(parsed ? parsed.entryType : null, expected);
    });
  }
});

describe('parseLedgerMessage — money math (pay/remain shape)', () => {
  test('"she pay X remain Y" tags paid and balance correctly', () => {
    const parsed = ledgerParser.parseLedgerMessage('Mama Tunde buy 3 carton indomie, she pay 15k remain 12k');
    assert.equal(parsed.paidKobo, 1500000);
    assert.equal(parsed.balanceKobo, 1200000);
    assert.equal(parsed.counterpartyName, 'Mama Tunde');
  });

  test('a bare total with no pay/remain language is fully paid', () => {
    const parsed = ledgerParser.parseLedgerMessage('sold rice 5000');
    assert.equal(parsed.totalKobo, 500000);
    assert.equal(parsed.paidKobo, 500000);
    assert.equal(parsed.balanceKobo, 0);
  });

  test('k/m/h shorthand multipliers resolve correctly', () => {
    assert.equal(ledgerParser.parseLedgerMessage('sold rice 15k').totalKobo, 1500000);
    assert.equal(ledgerParser.parseLedgerMessage('sold rice 2m').totalKobo, 200000000);
    assert.equal(ledgerParser.parseLedgerMessage('sold rice 5h').totalKobo, 50000);
  });
});

describe('parseLedgerMessage — currency detection', () => {
  test('a bare number with no symbol/word is unspecified (null), not NGN', () => {
    const parsed = ledgerParser.parseLedgerMessage('sold rice 5000');
    assert.equal(parsed.currency, null);
  });

  test('recognizes an explicit Naira symbol/word as NGN (not null)', () => {
    assert.equal(ledgerParser.parseLedgerMessage('sold rice \u20a65000').currency, 'NGN');
    assert.equal(ledgerParser.parseLedgerMessage('sold rice 5000 naira').currency, 'NGN');
  });

  test('recognizes USD/GBP/EUR symbols and words regardless of preceding whitespace', () => {
    assert.equal(ledgerParser.parseLedgerMessage('sold rice $500').currency, 'USD');
    assert.equal(ledgerParser.parseLedgerMessage('sold rice 500 dollars').currency, 'USD');
    assert.equal(ledgerParser.parseLedgerMessage('sold rice \u00a3500').currency, 'GBP');
    assert.equal(ledgerParser.parseLedgerMessage('sold rice 500 pounds').currency, 'GBP');
    assert.equal(ledgerParser.parseLedgerMessage('sold rice \u20ac500').currency, 'EUR');
    assert.equal(ledgerParser.parseLedgerMessage('sold rice 500 euros').currency, 'EUR');
  });

  test('a foreign currency symbol never leaks into the item name', () => {
    const parsed = ledgerParser.parseLedgerMessage('sold rice \u00a320 to John');
    assert.equal(parsed.items[0].name, 'Rice');
    assert.equal(parsed.counterpartyName, 'John');
  });

  test('the amount VALUE is correct regardless of currency (no accidental double-counting)', () => {
    assert.equal(ledgerParser.parseLedgerMessage('sold rice $500').totalKobo, 50000);
    assert.equal(ledgerParser.parseLedgerMessage('sold rice \u20a6500').totalKobo, 50000);
  });
});

describe('parseLedgerMessage — phone detection (international)', () => {
  test('recognizes a Nigerian domestic-shorthand phone and normalizes to E.164', () => {
    const parsed = ledgerParser.parseLedgerMessage('Mama Tunde 08012345678 buy 2 bags rice, she pay 15k');
    assert.equal(parsed.counterpartyPhone, '+2348012345678');
  });

  test('recognizes a non-Nigerian E.164 phone number as-is', () => {
    const parsed = ledgerParser.parseLedgerMessage('Amaka +233241234567 buy rice 5000');
    assert.equal(parsed.counterpartyPhone, '+233241234567');
  });

  test('a phone number is never mistaken for a money amount', () => {
    const parsed = ledgerParser.parseLedgerMessage('Mama Tunde 08012345678 buy 2 bags rice, she pay 15k');
    assert.equal(parsed.totalKobo, 1500000);
  });
});

describe('parseInvoiceItemLine', () => {
  test('parses the strict "qty unit x name x price" template', () => {
    const item = ledgerParser.parseInvoiceItemLine('3 bags x rice x 15k');
    assert.equal(item.quantity, 3);
    assert.equal(item.unit, 'bags');
    assert.equal(item.name, 'rice');
    assert.equal(item.unitPriceKobo, 1500000);
    assert.equal(item.totalKobo, 4500000);
  });

  test('parses the single-"x" fallback template as one free-text name (no unit split out)', () => {
    const item = ledgerParser.parseInvoiceItemLine('3 bags rice x 15k');
    assert.equal(item.quantity, 3);
    assert.equal(item.unit, null);
    assert.equal(item.name, 'bags rice');
    assert.equal(item.unitPriceKobo, 1500000);
    assert.equal(item.totalKobo, 4500000);
  });

  test('parses the "qty x name x price" template with no unit', () => {
    const item = ledgerParser.parseInvoiceItemLine('2 x iPhone charger x 4500');
    assert.equal(item.quantity, 2);
    assert.equal(item.name, 'iPhone charger');
    assert.equal(item.unitPriceKobo, 450000);
    assert.equal(item.totalKobo, 900000);
  });

  test('tags an explicit foreign currency on an invoice item', () => {
    const item = ledgerParser.parseInvoiceItemLine('2 x iPhone charger x $45');
    assert.equal(item.currency, 'USD');
    assert.equal(item.unitPriceKobo, 4500);
  });

  test('an invoice item with no explicit currency is untagged (null)', () => {
    const item = ledgerParser.parseInvoiceItemLine('2 x iPhone charger x 4500');
    assert.equal(item.currency, null);
  });

  test('rejects a line with no usable quantity/price', () => {
    assert.equal(ledgerParser.parseInvoiceItemLine('just some text'), null);
  });
});

describe('parseInvoiceCommand (one-shot INVOICE <amount>)', () => {
  test('parses amount, description, and optional phone', () => {
    const result = ledgerParser.parseInvoiceCommand('invoice 08012345678 5000 for rice');
    assert.equal(result.amountKobo, 500000);
    assert.equal(result.customerPhone, '+2348012345678');
    assert.equal(result.description, 'for rice');
  });

  test('recognizes an international phone in the one-shot command', () => {
    const result = ledgerParser.parseInvoiceCommand('invoice +233241234567 5000 for fabric');
    assert.equal(result.customerPhone, '+233241234567');
  });

  test('tags an explicit foreign currency', () => {
    const result = ledgerParser.parseInvoiceCommand('invoice $150 supplies');
    assert.equal(result.currency, 'USD');
    assert.equal(result.amountKobo, 15000);
  });
});

describe('parseNewInvoiceTrigger', () => {
  test('captures name and trailing Nigerian phone', () => {
    const result = ledgerParser.parseNewInvoiceTrigger('new invoice for Adaeze 08012345678');
    assert.equal(result.customerName, 'Adaeze');
    assert.equal(result.customerPhone, '+2348012345678');
  });

  test('captures name and trailing international phone', () => {
    const result = ledgerParser.parseNewInvoiceTrigger('new invoice for Efua +233241234567');
    assert.equal(result.customerName, 'Efua');
    assert.equal(result.customerPhone, '+233241234567');
  });

  test('a bare trigger with no name starts the flow with nulls', () => {
    const result = ledgerParser.parseNewInvoiceTrigger('new invoice');
    assert.equal(result.customerName, null);
    assert.equal(result.customerPhone, null);
  });

  test('does not swallow the one-shot INVOICE <amount> command', () => {
    assert.equal(ledgerParser.parseNewInvoiceTrigger('invoice 5000 for rice'), null);
  });
});

describe('deterministic command detection', () => {
  test('recognizes fixed keyword commands', () => {
    assert.equal(ledgerParser.detectCommand('help'), 'HELP');
    assert.equal(ledgerParser.detectCommand('BALANCE'), 'BALANCE');
    assert.equal(ledgerParser.detectCommand('done'), 'DONE');
  });

  test('ADD STOCK — complete command parses; incomplete is flagged, not silently ignored', () => {
    const full = ledgerParser.parseAddStockCommand('add stock rice 50 bags');
    assert.equal(full.productName, 'rice');
    assert.equal(full.quantity, 50);
    assert.equal(ledgerParser.isIncompleteAddStockCommand('add stock rice 50 bags'), false);

    assert.equal(ledgerParser.parseAddStockCommand('add stock'), null);
    assert.equal(ledgerParser.isIncompleteAddStockCommand('add stock'), true);
    assert.equal(ledgerParser.isIncompleteAddStockCommand('add stock rice'), true);
    assert.equal(ledgerParser.isIncompleteAddStockCommand('sold rice 5000'), false);
  });

  test('CLOSING HOUR — complete command parses; incomplete is flagged, not silently ignored', () => {
    assert.deepEqual(ledgerParser.parseClosingHourCommand('closing hour 20'), { hour: 20 });
    assert.equal(ledgerParser.isIncompleteClosingHourCommand('closing hour 20'), false);

    assert.equal(ledgerParser.parseClosingHourCommand('closing hour'), null);
    assert.equal(ledgerParser.isIncompleteClosingHourCommand('closing hour'), true);
    assert.equal(ledgerParser.isIncompleteClosingHourCommand('closing hour whenever'), true);
    assert.equal(ledgerParser.isIncompleteClosingHourCommand('sold rice 5000'), false);
  });

  test('SET CURRENCY — valid code parses; unrecognized/missing code is flagged, not silently ignored', () => {
    assert.deepEqual(ledgerParser.parseSetCurrencyCommand('set currency GHS'), { currencyCode: 'GHS' });
    assert.deepEqual(ledgerParser.parseSetCurrencyCommand('currency ghs'), { currencyCode: 'GHS' });
    assert.equal(ledgerParser.isIncompleteSetCurrencyCommand('set currency GHS'), false);

    assert.equal(ledgerParser.parseSetCurrencyCommand('currency XYZ'), null);
    assert.equal(ledgerParser.isIncompleteSetCurrencyCommand('currency XYZ'), true);
    assert.equal(ledgerParser.isIncompleteSetCurrencyCommand('set currency'), true);
    assert.equal(ledgerParser.isIncompleteSetCurrencyCommand('sold rice 5000'), false);
  });
});

describe('business name extraction (onboarding)', () => {
  const cases = [
    ['my business name is Ebuka&sons Ltd', 'Ebuka&sons Ltd'],
    ['the name is Ebuka Stores', 'Ebuka Stores'],
    ['Ebuka Stores is the name', 'Ebuka Stores'],
    ['Ebuka Stores is my business name', 'Ebuka Stores'],
    ['Ebuka Stores', 'Ebuka Stores'],
    ['my shop name is Mama Blessing Provisions', 'Mama Blessing Provisions'],
    ["it's called Chidi Electronics", 'Chidi Electronics'],
    ['name: Kemi Fashion House', 'Kemi Fashion House'],
  ];

  for (const [input, expected] of cases) {
    test(`"${input}" -> "${expected}"`, () => {
      const extracted = ledgerParser.extractBusinessNameFromReply(input);
      assert.equal(extracted, expected);
      assert.equal(ledgerParser.looksLikeCleanName(extracted), true);
    });
  }

  test('an unrecognized phrasing is left unstripped and flagged for the AI fallback', () => {
    const extracted = ledgerParser.extractBusinessNameFromReply('you can call my shop Ebuka Stores');
    assert.equal(ledgerParser.looksLikeCleanName(extracted), false);
  });
});

describe('self-introduction extraction (personal name)', () => {
  test('recognizes common self-intro phrasings', () => {
    assert.equal(ledgerParser.extractSelfIntroduction("I'm Samuel"), 'Samuel');
    assert.equal(ledgerParser.extractSelfIntroduction('My name is Ada Obi'), 'Ada Obi');
    assert.equal(ledgerParser.extractSelfIntroduction('Call me Tunde'), 'Tunde');
  });

  test('never captures a non-name follow-up like "I\'m fine"', () => {
    assert.equal(ledgerParser.extractSelfIntroduction("I'm fine"), null);
    assert.equal(ledgerParser.extractSelfIntroduction("I'm good"), null);
  });

  test('a stray "&sons Ltd" after a personal name is not captured (2-word cap + charset)', () => {
    assert.equal(ledgerParser.extractSelfIntroduction('my name is Ebuka&sons Ltd'), 'Ebuka');
  });
});

describe('scoring — regression guard against false confidence', () => {
  test('a confident regex parse stays confident after all currency/phone changes', () => {
    const scored = ledgerParser.parseLedgerMessageScored('sold rice 5000');
    assert.equal(scored.confident, true);
  });

  test('an ambiguous message with multiple untagged amounts is not falsely confident', () => {
    const scored = ledgerParser.parseLedgerMessageScored('sold rice 5000 and bought fuel 3000');
    assert.equal(scored.confidence < ledgerParser.REGEX_CONFIDENCE_THRESHOLD, true);
  });

  test('a non-transaction message never parses as confident', () => {
    const scored = ledgerParser.parseLedgerMessageScored('what time do you close today');
    assert.equal(scored.confident, false);
  });
});
