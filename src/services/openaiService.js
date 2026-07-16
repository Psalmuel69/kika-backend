'use strict';

const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../utils/logger');

/**
 * ---------------------------------------------------------------------
 * PROVIDER CONFIG — Gemini (native SDK) or OpenAI directly
 * ---------------------------------------------------------------------
 * Exactly one of these is active, chosen by which key is set:
 *
 * 1) GEMINI_API_KEY set → calls Gemini directly via Google's official
 *    SDK (@google/generative-ai) — NOT through an OpenAI-compatibility
 *    shim. Model defaults to GEMINI_MODEL / "gemini-3.1-flash-lite".
 *    This is the current deployment target.
 *
 * 2) GEMINI_API_KEY unset → OPENAI_API_KEY is used against OpenAI
 *    directly. (OpenRouter / arbitrary OpenAI-compatible proxies are no
 *    longer supported here — removed per request, since the
 *    compatibility shim was the source of production issues.)
 *
 * IMPORTANT — audio transcription (Whisper) has no Gemini equivalent in
 * this SDK, so it ALWAYS goes through OpenAI regardless of which
 * provider is chosen above. If you're running Kika on Gemini, voice
 * notes need a real OpenAI key set via OPENAI_TRANSCRIBE_API_KEY (falls
 * back to OPENAI_API_KEY if that's also set, but neither is required
 * for text/image chat when using Gemini).
 * ---------------------------------------------------------------------
 */
const usingGemini = Boolean(process.env.GEMINI_API_KEY);

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';

const TRANSCRIBE_API_KEY = process.env.OPENAI_TRANSCRIBE_API_KEY || process.env.OPENAI_API_KEY;
const TRANSCRIBE_BASE_URL = process.env.OPENAI_TRANSCRIBE_BASE_URL || undefined;

let geminiSDK = null;
function getGeminiSDK() {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured');
  if (!geminiSDK) {
    geminiSDK = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    logger.info({ model: GEMINI_MODEL }, 'Gemini native SDK client initialized');
  }
  return geminiSDK;
}

let openaiChatClient = null;
function getOpenAIChatClient() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
  if (!openaiChatClient) {
    openaiChatClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 20000 });
    logger.info('OpenAI chat client initialized');
  }
  return openaiChatClient;
}

let transcribeClient = null;
function getTranscribeClient() {
  if (!TRANSCRIBE_API_KEY) {
    throw new Error(
      'No transcription-capable API key configured. Gemini has no audio-transcription equivalent in this SDK — ' +
        'set OPENAI_TRANSCRIBE_API_KEY (or OPENAI_API_KEY) to a real OpenAI key to enable voice notes.'
    );
  }
  if (!transcribeClient) {
    transcribeClient = new OpenAI({ apiKey: TRANSCRIBE_API_KEY, baseURL: TRANSCRIBE_BASE_URL, timeout: 20000 });
  }
  return transcribeClient;
}

// ---------------------------------------------------------------------------
// Tool-schema conversion: the rest of the codebase defines tools once, in
// OpenAI's JSON-Schema-ish function-calling format (aiTransactionParser.js).
// Gemini's native SDK wants its own Schema shape, which is almost
// identical (verified against the installed SDK's own type
// definitions) except: no `type: [...]` unions for nullable fields —
// Gemini uses a separate `nullable: true` flag instead.
// ---------------------------------------------------------------------------
function convertSchemaNode(node) {
  if (!node) return node;
  let type = node.type;
  let nullable = false;
  if (Array.isArray(type)) {
    nullable = type.includes('null');
    type = type.find((t) => t !== 'null') || 'string';
  }
  const out = { type };
  if (node.description) out.description = node.description;
  if (nullable) out.nullable = true;
  if (node.enum) out.enum = node.enum;
  if (type === 'object' && node.properties) {
    out.properties = Object.fromEntries(Object.entries(node.properties).map(([k, v]) => [k, convertSchemaNode(v)]));
    if (node.required) out.required = node.required;
  }
  if (type === 'array' && node.items) {
    out.items = convertSchemaNode(node.items);
  }
  return out;
}

function convertToolsToGemini(tools) {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: convertSchemaNode(t.function.parameters),
      })),
    },
  ];
}

// OpenAI-style history ({role: 'user'|'assistant', content}) -> Gemini's
// Content[] shape ({role: 'user'|'model', parts: [{text}]}).
function toGeminiHistory(conversationHistory) {
  return (conversationHistory || []).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
  }));
}

async function chatCompletionViaGemini({ systemPrompt, userText, imageBase64, tools, conversationHistory }) {
  const genAI = getGeminiSDK();
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: systemPrompt,
    tools: convertToolsToGemini(tools),
  });

  const chat = model.startChat({ history: toGeminiHistory(conversationHistory) });

  const parts = [];
  if (userText) parts.push({ text: userText });
  if (imageBase64) parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } });
  if (parts.length === 0) parts.push({ text: '' });

  const result = await chat.sendMessage(parts);
  const response = result.response;

  const functionCalls = typeof response.functionCalls === 'function' ? response.functionCalls() : null;
  const firstCall = functionCalls && functionCalls.length > 0 ? functionCalls[0] : null;

  return {
    toolCall: firstCall ? { name: firstCall.name, arguments: firstCall.args } : null,
    text: typeof response.text === 'function' ? response.text() : null,
    raw: response,
  };
}

async function chatCompletionViaOpenAI({ systemPrompt, userText, imageBase64, tools, conversationHistory }) {
  const openai = getOpenAIChatClient();

  const userContent = imageBase64
    ? [
        { type: 'text', text: userText || 'Please read this image and extract any sale, expense, or debt described in it.' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
      ]
    : userText;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...(conversationHistory || []),
    { role: 'user', content: userContent },
  ];

  const res = await openai.chat.completions.create({
    model: imageBase64 ? OPENAI_VISION_MODEL : OPENAI_CHAT_MODEL,
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
 * A single chat completion call with an optional tool (function-calling)
 * schema and optional prior conversation turns. Used by
 * aiTransactionParser for the hybrid regex→AI fallback. `imageBase64`
 * allows passing a photo (receipt, handwritten note) as a vision input
 * alongside the text prompt for multimodal messages.
 */
async function chatCompletion(params) {
  return usingGemini ? chatCompletionViaGemini(params) : chatCompletionViaOpenAI(params);
}

/**
 * Transcribes a WhatsApp voice note / audio file to text via Whisper.
 * Always uses OpenAI — see the provider-config note at the top of this
 * file for why this is independent of the GEMINI_API_KEY chat provider.
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
  usingGemini,
  GEMINI_MODEL,
  OPENAI_CHAT_MODEL,
  OPENAI_VISION_MODEL,
  TRANSCRIBE_MODEL,
  // exported for direct unit testing of the schema conversion logic
  convertSchemaNode,
  convertToolsToGemini,
  toGeminiHistory,
};
