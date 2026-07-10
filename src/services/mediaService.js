'use strict';

const axios = require('axios');
const openaiService = require('./openaiService');
const logger = require('../utils/logger');

const client = axios.create({
  baseURL: process.env.WHATSAPP_API_BASE,
  timeout: 15000,
  headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
});

/**
 * Resolves a WhatsApp media id to its temporary CDN URL, then downloads
 * the raw bytes. Both calls need the same bearer token — the media URL
 * Meta returns is itself access-controlled, not a public link.
 */
async function downloadWhatsappMedia(mediaId) {
  const metaRes = await client.get(`/${mediaId}`);
  const { url, mime_type: mimeType } = metaRes.data;

  const fileRes = await client.get(url, { responseType: 'arraybuffer' });
  return { buffer: Buffer.from(fileRes.data), mimeType };
}

/**
 * Downloads a voice note / audio message and transcribes it via Whisper.
 * The transcript is then treated exactly like a typed text message by
 * the rest of the pipeline (regex parser first, AI fallback second).
 */
async function transcribeWhatsappAudio(mediaId) {
  const { buffer, mimeType } = await downloadWhatsappMedia(mediaId);
  const extension = mimeType?.includes('ogg') ? 'ogg' : mimeType?.includes('mp3') ? 'mp3' : 'm4a';
  const transcript = await openaiService.transcribeAudio(buffer, `voice.${extension}`);
  logger.info({ mediaId, transcriptLength: transcript?.length }, 'WhatsApp audio transcribed');
  return transcript;
}

/**
 * Downloads an image (receipt photo, handwritten note) and returns it
 * as base64 for the vision-capable chat completion call.
 */
async function downloadWhatsappImageAsBase64(mediaId) {
  const { buffer } = await downloadWhatsappMedia(mediaId);
  return buffer.toString('base64');
}

module.exports = { downloadWhatsappMedia, transcribeWhatsappAudio, downloadWhatsappImageAsBase64 };
