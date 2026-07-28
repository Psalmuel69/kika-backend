'use strict';

const logger = require('../utils/logger');

function hasAiProviderConfigured() {
  return Boolean(process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY);
}

/**
 * Small, single-purpose tool schema — deliberately separate from
 * RECORD_TRANSACTION_TOOL in aiTransactionParser.js, since this is a
 * plain text-extraction call with no money/entry semantics at all.
 */
const EXTRACT_NAME_TOOL = {
  type: 'function',
  function: {
    name: 'extract_name',
    description: 'Extract ONLY the name itself from the merchant\'s reply, with none of the surrounding sentence.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Just the name — no leading or trailing words like "my name is", "is the name", "my business", "is called", etc. If the reply genuinely contains no identifiable name at all, return an empty string.',
        },
      },
      required: ['name'],
    },
  },
};

/**
 * Last-resort extraction for a business or personal name reply that
 * doesn't match any of ledgerParser.js's known deterministic phrasings
 * (see extractBusinessNameFromReply/looksLikeCleanName) — e.g. "you can
 * call my shop Ebuka Stores". Only called for that minority case, never
 * on the common "merchant just typed the plain name" path, so this
 * adds no cost or latency to the overwhelming majority of onboarding
 * completions.
 *
 * Never throws and never blocks onboarding: returns null on any
 * failure (missing API key, network error, empty/unusable response),
 * and the caller falls back to using the merchant's raw reply as-is.
 */
async function extractNameWithAI(rawMessage, subject = 'business') {
  if (!hasAiProviderConfigured() || !rawMessage) return null;
  try {
    // Lazy require to avoid a require-cycle with services that
    // themselves depend on this one in the future.
    const openaiService = require('./openaiService');
    const systemPrompt =
      subject === 'business'
        ? 'A small merchant was asked "What is the name of your business/shop?" and gave the reply below, in their own words. Extract ONLY the actual business/shop name from it, with none of the surrounding sentence. Respond only by calling extract_name.'
        : 'A small merchant introduced themselves by name in conversation, in their own words. Extract ONLY their personal name from it, with none of the surrounding sentence. Respond only by calling extract_name.';

    const { toolCall } = await openaiService.chatCompletion({
      systemPrompt,
      userText: rawMessage,
      tools: [EXTRACT_NAME_TOOL],
    });

    const name = toolCall?.arguments?.name;
    return typeof name === 'string' && name.trim() ? name.trim().slice(0, 160) : null;
  } catch (err) {
    logger.error({ err: err.message, subject }, 'AI name-extraction fallback failed');
    return null;
  }
}

module.exports = { extractNameWithAI };
