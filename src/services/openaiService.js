'use strict';

const OpenAI = require('openai');
const logger = require('../utils/logger');

/**
 * ---------------------------------------------------------------------
 * PROVIDER CONFIG — OpenAI directly, or an OpenAI-compatible proxy
 * (e.g. OpenRouter)
 * ---------------------------------------------------------------------
 * Setting OPENAI_BASE_URL routes chat/vision calls through any
 * OpenAI-compatible endpoint — this is what lets Kika run against
 * OpenRouter (https://openrouter.ai/api/v1) using an "sk-or-v1-..." key
 * instead of a real OpenAI key. Leave OPENAI_BASE_URL unset to use
 * OpenAI directly.
 *
 * IMPORTANT — Whisper transcription is NOT proxied by OpenRouter.
 * OpenRouter only proxies chat completions; it does not expose an
 * /audio/transcriptions endpoint. If you're running Kika against
 * OpenRouter, voice-note transcription needs a real OpenAI key.
 * Configure that independently via OPENAI_TRANSCRIBE_API_KEY /
 * OPENAI_TRANSCRIBE_BASE_URL (both default to the main OPENAI_API_KEY /
 * OPENAI_BASE_URL if unset — fine when using OpenAI directly, but must
 * be overridden when the main key is an OpenRouter key).
 * ---------------------------------------------------------------------
 */
const CHAT_BASE_URL = process.env.OPENAI_BASE_URL || undefined; // undefined = OpenAI's own default
const CHAT_API_KEY = process.env.OPENAI_API_KEY;

const TRANSCRIBE_BASE_URL = process.env.OPENAI_TRANSCRIBE_BASE_URL || CHAT_BASE_URL;
const TRANSCRIBE_API_KEY = process.env.OPENAI_TRANSCRIBE_API_KEY || CHAT_API_KEY;

const usingOpenRouterForChat = (CHAT_BASE_URL || '').includes('openrouter.ai');
const usingOpenRouterForTranscription = (TRANSCRIBE_BASE_URL || '').includes('openrouter.ai');

// OpenRouter attributes usage to your app via these optional headers.
// Harmless to send even against plain OpenAI (it just ignores them).
const OPENROUTER_HEADERS = {
  ...(process.env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': process.env.OPENROUTER_SITE_URL } : {}),
  ...(process.env.OPENROUTER_APP_NAME ? { 'X-Title': process.env.OPENROUTER_APP_NAME } : {}),
};

let chatClient = null;
function getChatClient() {
  if (!CHAT_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
  if (!chatClient) {
    chatClient = new OpenAI({
      apiKey: CHAT_API_KEY,
      baseURL: CHAT_BASE_URL,
      defaultHeaders: usingOpenRouterForChat ? OPENROUTER_HEADERS : undefined,
      timeout: 20000,
    });
    logger.info({ baseURL: CHAT_BASE_URL || 'api.openai.com (default)' }, 'OpenAI chat client initialized');
  }
  return chatClient;
}

let transcribeClient = null;
function getTranscribeClient() {
  if (!TRANSCRIBE_API_KEY) throw new Error('OPENAI_API_KEY (or OPENAI_TRANSCRIBE_API_KEY) is not configured');
  if (usingOpenRouterForTranscription) {
    logger.warn(
      'OPENAI_TRANSCRIBE_BASE_URL resolves to OpenRouter, which does not support audio transcription — ' +
        'this call will fail. Set OPENAI_TRANSCRIBE_API_KEY/OPENAI_TRANSCRIBE_BASE_URL to a real OpenAI key to enable voice notes.'
    );
  }
  if (!transcribeClient) {
    transcribeClient = new OpenAI({ apiKey: TRANSCRIBE_API_KEY, baseURL: TRANSCRIBE_BASE_URL, timeout: 20000 });
  }
  return transcribeClient;
}

// Model identifiers differ by provider — OpenRouter namespaces models by
// vendor (e.g. "openai/gpt-4o-mini"), while OpenAI direct uses the bare
// name ("gpt-4o-mini"). Always configurable via env so switching
// providers never requires a code change.
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';

/**
 * A single chat completion call with an optional tool (function-calling)
 * schema. Used by aiTransactionParser for the hybrid regex→AI fallback:
 * the model either calls the `record_transaction` tool with structured
 * fields, or replies in plain text (an in-persona conversational reply
 * or a polite decline), per the system prompt's rules.
 *
 * `imageBase64` allows passing a photo (receipt, handwritten note) as a
 * vision input alongside the text prompt for multimodal messages.
 */
async function chatCompletion({ systemPrompt, userText, imageBase64, tools }) {
  const openai = getChatClient();

  const userContent = imageBase64
    ? [
        { type: 'text', text: userText || 'Please read this image and extract any sale, expense, or debt described in it.' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
      ]
    : userText;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const res = await openai.chat.completions.create({
    model: imageBase64 ? VISION_MODEL : CHAT_MODEL,
    messages,
    tools,
    tool_choice: tools ? 'auto' : undefined,
    temperature: 0.2,
    max_tokens: 400,
  });

  const choice = res.choices?.[0];
  const toolCall = choice?.message?.tool_calls?.[0];

  return {
    toolCall: toolCall
      ? { name: toolCall.function.name, arguments: safeJsonParse(toolCall.function.arguments) }
      : null,
    text: choice?.message?.content || null,
    raw: res,
  };
}

/**
 * Transcribes a WhatsApp voice note / audio file to text via Whisper.
 * `audioBuffer` is the raw downloaded media bytes; `filename` just needs
 * a plausible extension (e.g. 'voice.ogg') since the API infers format
 * from it. Uses the (possibly separate) transcription client/key — see
 * the provider-config note at the top of this file.
 */
async function transcribeAudio(audioBuffer, filename = 'voice.ogg') {
  const openai = getTranscribeClient();
  const { toFile } = require('openai');
  const res = await openai.audio.transcriptions.create({
    file: await toFile(audioBuffer, filename),
    model: TRANSCRIBE_MODEL,
  });
  return res.text;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    logger.error({ err: err.message, text }, 'Failed to parse AI tool-call arguments as JSON');
    return null;
  }
}

module.exports = { chatCompletion, transcribeAudio, CHAT_MODEL, VISION_MODEL, TRANSCRIBE_MODEL };
