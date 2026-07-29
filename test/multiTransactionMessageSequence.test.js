'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// ledgerService.js talks to the database via db/queries — this test
// substitutes a mock BEFORE ledgerService is first required (the same
// technique used in test/receiptInvoiceLayout.test.js, for the same
// reason: a module's own `const queries = require('../db/queries')`
// binds at load time, so swapping the require cache any later has no
// effect on an already-loaded module).
let ledgerService;
const createLedgerEntryCalls = [];

before(() => {
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id.endsWith('db/queries')) {
      return {
        withTransaction: async (fn) => fn({}),
        createLedgerEntry: async (client, entry) => {
          createLedgerEntryCalls.push(entry);
          return { id: `entry-${createLedgerEntryCalls.length}`, ...entry, balance_after_kobo: entry.balanceAfterKobo };
        },
        lockCustomerBalance: async () => {},
        applyCustomerBalanceDelta: async () => ({ rolling_balance_kobo: 0 }),
        decrementProductStock: async () => null,
        settleOutstandingDebtForCounterparty: async () => ({ rollingBalanceKobo: 0, settled: [], unallocatedKobo: 0 }),
      };
    }
    return originalRequire.apply(this, arguments);
  };

  ledgerService = require('../src/services/ledgerService');

  Module.prototype.require = originalRequire;
});

const merchant = { id: 'merchant-1', plan: 'FREE' };

describe('multi-transaction messages must not collide on whatsapp_message_id (regression)', () => {
  test('each entry from the same inbound message gets its own message_sequence_index', async () => {
    createLedgerEntryCalls.length = 0;
    const whatsappMessageId = 'wamid.SAME_MESSAGE_FOR_ALL';

    const transactions = [
      { entryType: 'DEBIT', description: 'Fuel for generator', items: [], totalKobo: 1000000, paidKobo: 1000000, balanceKobo: 0, currency: 'NGN' },
      { entryType: 'DEBIT', description: 'Transport to Balogun', items: [], totalKobo: 250000, paidKobo: 250000, balanceKobo: 0, currency: 'NGN' },
      { entryType: 'DEBIT', description: 'Materials from supplier', items: [], totalKobo: 9500000, paidKobo: 9500000, balanceKobo: 0, currency: 'NGN' },
    ];

    for (const [index, parsedEntry] of transactions.entries()) {
      await ledgerService.recordLedgerEntryAndReceipt({
        merchant,
        parsedEntry: { ...parsedEntry, messageSequenceIndex: index },
        rawMessage: 'Today was busy o...',
        whatsappMessageId,
        replyToWhatsappMessageId: null,
      });
    }

    assert.equal(createLedgerEntryCalls.length, 3, 'all 3 entries must reach createLedgerEntry');

    const sequenceIndexes = createLedgerEntryCalls.map((c) => c.messageSequenceIndex);
    assert.deepEqual(sequenceIndexes, [0, 1, 2], 'each entry from the same message must have a DISTINCT sequence index');

    // Every call still shares the same whatsapp_message_id (that part is
    // correct and unchanged) — it's the composite (message_id, sequence)
    // pair that must be unique, not the message_id alone. See migration
    // 0002_multi_transaction_message_sequence.sql.
    const uniqueMessageIds = new Set(createLedgerEntryCalls.map((c) => c.whatsappMessageId));
    assert.deepEqual([...uniqueMessageIds], [whatsappMessageId]);

    // The actual bug this reproduces: without a distinct sequence index,
    // these three calls would all be (whatsapp_message_id,
    // message_sequence_index=0) — i.e. NOT distinct — which is exactly
    // what a UNIQUE index on that composite key would reject for the
    // 2nd and 3rd entry.
    const compositeKeys = createLedgerEntryCalls.map((c) => `${c.whatsappMessageId}::${c.messageSequenceIndex}`);
    assert.equal(new Set(compositeKeys).size, 3, 'composite (message_id, sequence_index) keys must all be distinct');
  });

  test('an ordinary single-transaction message defaults to sequence index 0', async () => {
    createLedgerEntryCalls.length = 0;
    await ledgerService.recordLedgerEntryAndReceipt({
      merchant,
      parsedEntry: { entryType: 'DEBIT', description: 'Fuel', items: [], totalKobo: 500000, paidKobo: 500000, balanceKobo: 0, currency: 'NGN' },
      rawMessage: 'bought fuel 5000',
      whatsappMessageId: 'wamid.SINGLE',
      replyToWhatsappMessageId: null,
    });
    assert.equal(createLedgerEntryCalls.length, 1);
    assert.equal(createLedgerEntryCalls[0].messageSequenceIndex, 0);
  });
});
