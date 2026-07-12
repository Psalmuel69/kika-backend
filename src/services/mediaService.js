'use strict';

const fs = require('fs/promises');
const path = require('path');
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
 * as base64 for the vision-capable chat completion call. Transient —
 * not persisted to disk, unlike saveWhatsappImageAsMerchantLogo below.
 */
async function downloadWhatsappImageAsBase64(mediaId) {
  const { buffer } = await downloadWhatsappMedia(mediaId);
  return buffer.toString('base64');
}

/**
 * Downloads a business logo image and persists it to disk under a
 * dedicated `logos/` subfolder of RECEIPT_STORAGE_DIR (separate from the
 * time-limited receipt/digest PNGs — a logo is long-lived and explicitly
 * NOT touched by diskCleanupService's expiry sweep). Returns the file
 * path to store on merchants.logo_file_path.
 */
async function saveWhatsappImageAsMerchantLogo(mediaId, merchantId) {
  const { buffer, mimeType } = await downloadWhatsappMedia(mediaId);
  const extension = mimeType?.includes('png') ? 'png' : 'jpg';

  const logosDir = path.join(process.env.RECEIPT_STORAGE_DIR || path.join(process.cwd(), 'public', 'receipts'), 'logos');
  await fs.mkdir(logosDir, { recursive: true });

  // Deterministic per-merchant filename (not a random token — logos
  // aren't served over an unguessable public URL, they're read directly
  // off disk by receiptService when compositing a receipt) so a re-upload
  // cleanly overwrites the previous logo rather than accumulating files.
  const filePath = path.join(logosDir, `${merchantId}.${extension}`);
  await fs.writeFile(filePath, buffer);

  logger.info({ merchantId, filePath }, 'Merchant logo saved');
  return filePath;
}

module.exports = {
  downloadWhatsappMedia,
  transcribeWhatsappAudio,
  downloadWhatsappImageAsBase64,
  saveWhatsappImageAsMerchantLogo,
};
