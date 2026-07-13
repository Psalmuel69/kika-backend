'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai'); // Kept exclusively for Whisper transcription
const logger = require('../utils/logger');

// --- KEYS ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TRANSCRIBE_API_KEY = process.env.OPENAI_TRANSCRIBE_API_KEY || process.env.OPENAI_API_KEY;

let geminiClient = null;
let transcribeClient = null;

function getGeminiClient() {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured in environment variables');
  if (!geminiClient) {
    geminiClient = new GoogleGenerativeAI(GEMINI_API_KEY);
    logger.info('Google Generative AI (Direct Gemini) client initialized');
  }
  return geminiClient;
}

function getTranscribeClient() {
  if (!TRANSCRIBE_API_KEY) {
    throw new Error('OPENAI_TRANSCRIBE_API_KEY is missing. Voice notes require a real OpenAI key.');
  }
  if (!transcribeClient) {
    transcribeClient = new OpenAI({ apiKey: TRANSCRIBE_API_KEY, timeout: 20000 });
    logger.info('OpenAI transcription client initialized for voice notes');
  }
  return transcribeClient;
}

const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash';
const VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';

/**
 * Utility to cleanly convert an OpenAI JSON Schema into Gemini's expected Schema format.
 * Fixes issues where OpenAI allows `type: ['string', 'null']` but Gemini expects uppercase types.
 */
function convertToGeminiSchema(schema) {
  if (!schema) return schema;
  const geminiSchema = { ...schema };
  
  // Handle OpenAI's nullable array format: e.g., type: ['string', 'null']
  if (Array.isArray(geminiSchema.type)) {
    const mainType = geminiSchema.type.find(t => t !== 'null');
    geminiSchema.type = mainType ? mainType.toUpperCase() : 'STRING';
    geminiSchema.nullable = true; 
  } else if (typeof geminiSchema.type === 'string') {
    geminiSchema.type = geminiSchema.type.toUpperCase();
  }

  // Recursively format properties and items
  if (geminiSchema.properties) {
    for (const key in geminiSchema.properties) {
      geminiSchema.properties[key] = convertToGeminiSchema(geminiSchema.properties[key]);
    }
  }
  if (geminiSchema.items) {
    geminiSchema.items = convertToGeminiSchema(geminiSchema.items);
  }
  
  return geminiSchema;
}

/**
 * Direct Gemini Chat Completion handler.
 * Takes OpenAI-style inputs and seamlessly wraps them for the native Gemini API.
 */
async function chatCompletion({ systemPrompt, userText, imageBase64, tools }) {
  const genAI = getGeminiClient();
  const modelName = imageBase64 ? VISION_MODEL : CHAT_MODEL;

  // Map OpenAI's tool format to Gemini's FunctionDeclarations
  let geminiTools = undefined;
  if (Array.isArray(tools) && tools.length > 0) {
    geminiTools = [{
      functionDeclarations: tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: convertToGeminiSchema(t.function.parameters)
      }))
    }];
  }

  // Initialize the Gemini model with system instructions and tools
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: systemPrompt,
    tools: geminiTools,
  });

  // Construct the multimodal parts array
  const parts = [];
  if (imageBase64) {
    parts.push({
      inlineData: {
        data: imageBase64,
        mimeType: 'image/jpeg', // Standardize to jpeg for WhatsApp media
      }
    });
  }
  
  parts.push({ text: userText || 'Extract the financial details from this message.' });

  try {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts }],
      generationConfig: {
         temperature: 0.2,
         maxOutputTokens: 400,
      }
    });

    const response = result.response;
    
    // Check for native function/tool calls
    const functionCalls = response.functionCalls();
    const functionCall = functionCalls && functionCalls.length > 0 ? functionCalls[0] : null;
    
    // Safely attempt to extract conversational text (if the model didn't just call a tool)
    let text = null;
    try {
      text = response.text();
    } catch (e) {
      // Normal behavior: response.text() throws if the payload was strictly a function call
    }

    // Return exactly the payload aiTransactionParser expects
    return {
      toolCall: functionCall
        ? { 
            name: functionCall.name, 
            // Gemini natively returns an object for args, no need to JSON.parse!
            arguments: functionCall.args 
          } 
        : null,
      text: text,
      raw: response,
    };
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Direct Gemini API Call Failed');
    throw err;
  }
}

/**
 * Transcribes a WhatsApp voice note via OpenAI Whisper
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

module.exports = { chatCompletion, transcribeAudio, CHAT_MODEL, VISION_MODEL, TRANSCRIBE_MODEL };