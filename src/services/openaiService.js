'use strict';

const OpenAI = require('openai');
const logger = require('../utils/logger');

// --- 1. GEMINI CONFIGURATION (For Chat and Vision) ---
const CHAT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const CHAT_API_KEY = process.env.GEMINI_API_KEY;

// --- 2. OPENAI CONFIGURATION (Strictly for Voice Notes) ---
// If you want to transcribe WhatsApp voice notes, you MUST provide a real OpenAI API key.
// Gemini's OpenAI-compatible proxy does not support the audio/transcriptions endpoint.
const TRANSCRIBE_API_KEY = process.env.OPENAI_TRANSCRIBE_API_KEY || null;

const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gemini-1.5-flash';
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gemini-1.5-flash';
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';

let chatClient = null;
function getChatClient() {
  if (!CHAT_API_KEY) throw new Error('GEMINI_API_KEY is not configured in Environment Variables');
  if (!chatClient) {
    chatClient = new OpenAI({
      apiKey: CHAT_API_KEY,
      baseURL: CHAT_BASE_URL,
      timeout: 30000, 
    });
    logger.info({ model: CHAT_MODEL }, 'Gemini (OpenAI-compatible) chat client initialized');
  }
  return chatClient;
}

let transcribeClient = null;
function getTranscribeClient() {
  if (!TRANSCRIBE_API_KEY) {
    throw new Error('OPENAI_TRANSCRIBE_API_KEY is missing. Voice notes cannot be processed using a Gemini key.');
  }
  if (!transcribeClient) {
    // This points to the real OpenAI endpoint, strictly for Whisper
    transcribeClient = new OpenAI({ 
      apiKey: TRANSCRIBE_API_KEY, 
      timeout: 20000 
    });
    logger.info('OpenAI transcription client initialized for voice notes');
  }
  return transcribeClient;
}

/**
 * Executes the Chat/Vision call using Google Gemini via the OpenAI SDK
 */
async function chatCompletion({ systemPrompt, userText, imageBase64, tools }) {
  const openai = getChatClient();

  const userContent = imageBase64
    ? [
        { type: 'text', text: userText || 'Extract the sale, expense, or debt described in this image.' },
        // Ensure the base64 format perfectly matches what Gemini expects
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
      ]
    : userText;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  try {
    // CRITICAL FIX: Only pass tools and tool_choice to Gemini if tools actually exist in the array
    const hasTools = Array.isArray(tools) && tools.length > 0;
    
    const res = await openai.chat.completions.create({
      model: imageBase64 ? VISION_MODEL : CHAT_MODEL,
      messages,
      ...(hasTools && { tools: tools }),
      ...(hasTools && { tool_choice: 'auto' }),
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
  } catch (err) {
    // This will force the detailed error to appear in your Render logs
    logger.error({ err: err.message, stack: err.stack }, 'Gemini API Call Failed');
    throw err; 
  }
}

/**
 * Transcribes a WhatsApp voice note via OpenAI Whisper
 */
async function transcribeAudio(audioBuffer, filename = 'voice.ogg') {
  // If voice notes are sent but no OpenAI key exists, this will throw the
  // clear error defined in getTranscribeClient(), allowing the worker to fail gracefully.
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