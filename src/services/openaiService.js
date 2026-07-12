'use strict';

const OpenAI = require('openai');
const logger = require('../utils/logger');

/**
 * ---------------------------------------------------------------------
 * PROVIDER CONFIG — Gemini, OpenRouter, or OpenAI directly (any
 * OpenAI-compatible endpoint)
 * ---------------------------------------------------------------------
 * Resolution order (first match wins):
 *
 * 1) GEMINI_API_KEY set → routes through Gemini's OpenAI-compatible
 *    endpoint (https://generativelanguage.googleapis.com/v1beta/openai/)
 *    with model defaulting to "gemini-1.5-flash". This is the current
 *    deployment target (free tier). Override the endpoint/model via
 *    OPENAI_BASE_URL / OPENAI_CHAT_MODEL / OPENAI_VISION_MODEL if needed.
 *
 * 2) OPENAI_BASE_URL set (with OPENAI_API_KEY) → any other
 *    OpenAI-compatible proxy, e.g. OpenRouter
 *    (https://openrouter.ai/api/v1, key prefix "sk-or-v1-...").
 *
 * 3) Neither set → OpenAI directly, using OPENAI_API_KEY.
 *
 * IMPORTANT — audio transcription (Whisper) is NOT proxied by either
 * Gemini's or OpenRouter's OpenAI-compatible layer — only chat
 * completions (including vision/tool-calling) are. If you're running
 * Kika against Gemini or OpenRouter, voice-note transcription needs a
 * real OpenAI key configured separately via OPENAI_TRANSCRIBE_API_KEY /
 * OPENAI_TRANSCRIBE_BASE_URL (both default to the main chat provider's
 * key/URL if unset — fine only when the main provider IS OpenAI).
 * ---------------------------------------------------------------------
 */
const usingGemini = Boolean(process.env.GEMINI_API_KEY);

const CHAT_API_KEY = usingGemini ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY;
const CHAT_BASE_URL =
  process.env.OPENAI_BASE_URL || (usingGemini ? 'https://generativelanguage.googleapis.com/v1beta/openai/' : undefined);

const TRANSCRIBE_BASE_URL = process.env.OPENAI_TRANSCRIBE_BASE_URL || (usingGemini ? undefined : CHAT_BASE_URL);
const TRANSCRIBE_API_KEY = process.env.OPENAI_TRANSCRIBE_API_KEY || (usingGemini ? undefined : CHAT_API_KEY);

const NON_TRANSCRIBING_HOSTS = ['openrouter.ai', 'generativelanguage.googleapis.com'];
const usingNonTranscribingProviderForChat = NON_TRANSCRIBING_HOSTS.some((h) => (CHAT_BASE_URL || '').includes(h));
const usingNonTranscribingProviderForTranscription = NON_TRANSCRIBING_HOSTS.some((h) =>
  (TRANSCRIBE_BASE_URL || '').includes(h)
);
const usingOpenRouterForChat = (CHAT_BASE_URL || '').includes('openrouter.ai');

// OpenRouter attributes usage to your app via these optional headers.
// Harmless to send/omit against any other provider.
const OPENROUTER_HEADERS = {
  ...(process.env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': process.env.OPENROUTER_SITE_URL } : {}),
  ...(process.env.OPENROUTER_APP_NAME ? { 'X-Title': process.env.OPENROUTER_APP_NAME } : {}),
};

let chatClient = null;
function getChatClient() {
  if (!CHAT_API_KEY) throw new Error('GEMINI_API_KEY or OPENAI_API_KEY is not configured');
  if (!chatClient) {
    chatClient = new OpenAI({
      apiKey: CHAT_API_KEY,
      baseURL: CHAT_BASE_URL,
      defaultHeaders: usingOpenRouterForChat ? OPENROUTER_HEADERS : undefined,
      timeout: 20000,
    });
    logger.info(
      { provider: usingGemini ? 'gemini' : CHAT_BASE_URL ? 'openai-compatible' : 'openai', baseURL: CHAT_BASE_URL || 'api.openai.com (default)' },
      'AI chat client initialized'
    );
  }
  return chatClient;
}

let transcribeClient = null;
function getTranscribeClient() {
  if (!TRANSCRIBE_API_KEY) {
    throw new Error(
      'No transcription-capable API key configured. Gemini/OpenRouter do not support audio transcription — ' +
        'set OPENAI_TRANSCRIBE_API_KEY to a real OpenAI key to enable voice notes.'
    );
  }
  if (usingNonTranscribingProviderForTranscription) {
    logger.warn(
      'OPENAI_TRANSCRIBE_BASE_URL resolves to a provider that does not support audio transcription — ' +
        'this call will fail. Set OPENAI_TRANSCRIBE_API_KEY/OPENAI_TRANSCRIBE_BASE_URL to a real OpenAI key to enable voice notes.'
    );
  }
  if (!transcribeClient) {
    transcribeClient = new OpenAI({ apiKey: TRANSCRIBE_API_KEY, baseURL: TRANSCRIBE_BASE_URL, timeout: 20000 });
  }
  return transcribeClient;
}

// Model identifiers differ by provider — Gemini uses names like
// "gemini-1.5-flash", OpenRouter namespaces by vendor
// ("openai/gpt-4o-mini"), OpenAI direct uses the bare name
// ("gpt-4o-mini"). Always configurable via env so switching providers
// never requires a code change.
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || (usingGemini ? 'gemini-1.5-flash' : 'gpt-4o-mini');
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || (usingGemini ? 'gemini-1.5-flash' : 'gpt-4o-mini');
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

module.exports = {
  chatCompletion,
  transcribeAudio,
  CHAT_MODEL,
  VISION_MODEL,
  TRANSCRIBE_MODEL,
  usingGemini,
  usingNonTranscribingProviderForChat,
};
