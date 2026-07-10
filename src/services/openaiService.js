'use strict';

const OpenAI = require('openai');
const logger = require('../utils/logger');

/*
let client = null;
function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 20000 });
  }
  return client;
}
*/

let client = null;
function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  if (!client) {
    client = new OpenAI({ 
      apiKey: process.env.OPENAI_API_KEY, 
      baseURL: 'https://openrouter.ai/api/v1', // <-- THIS is what routes it to OpenRouter
      timeout: 20000,
      defaultHeaders: {
        'HTTP-Referer': 'https://kika-receipts.onrender.com', // Optional: Put your future Render URL here
        'X-OpenRouter-Title': 'Kika WhatsApp Assistant', // Optional: Helps you track it in OpenRouter dashboard
      },
    });
  }
  return client;
}

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
  const openai = getClient();

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
 * from it.
 */
async function transcribeAudio(audioBuffer, filename = 'voice.ogg') {
  const openai = getClient();
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
