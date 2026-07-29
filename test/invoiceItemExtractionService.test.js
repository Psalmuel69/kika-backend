'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

describe('invoiceItemExtractionService — graceful degradation', () => {
  test('returns null with no AI provider configured, never throws', async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalGeminiKey = process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    delete require.cache[require.resolve('../src/services/invoiceItemExtractionService')];
    const svc = require('../src/services/invoiceItemExtractionService');

    const result = await svc.extractInvoiceItemWithAI('3 bags of rice, 15k each');
    assert.equal(result, null);

    if (originalOpenAiKey) process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalGeminiKey) process.env.GEMINI_API_KEY = originalGeminiKey;
  });

  test('returns null for empty/missing input without calling anything', async () => {
    const svc = require('../src/services/invoiceItemExtractionService');
    assert.equal(await svc.extractInvoiceItemWithAI(''), null);
    assert.equal(await svc.extractInvoiceItemWithAI(null), null);
  });
});
