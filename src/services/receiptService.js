'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const queries = require('../db/queries');
const logger = require('../utils/logger');

// Fixed brand palette — do not derive these from user input.
const THEME = {
  background: '#0B0F19',
  accent: '#10B981',
  mint: '#34D399',
  coral: '#E85555', // business name + "Powered by Kika AI" watermark — amounts stay green/mint
  textPrimary: '#F9FAFB',
  textMuted: '#9CA3AF',
  debtAmber: '#FBBF24', // outstanding balance still owed — matches the app's amber marker
  debtRed: '#F87171',   // reserved for aged/overdue debt emphasis
};

const CARD_WIDTH = 720;
const ROW_HEIGHT = 58;

function escapeXml(unsafe) {
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatNaira(kobo) {
  const naira = Number(kobo) / 100;
  return `\u20a6${naira.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatItemsLine(items) {
  if (!items || items.length === 0) return null;
  return items.map((it) => `${it.name.charAt(0).toUpperCase()}${it.name.slice(1)} x${it.quantity} ${it.unit}`).join(', ');
}

/**
 * Builds a KIKA RECEIPT card matching the Customer / Items / Total / Paid /
 * Balance layout merchants see in the chat UI, plus a "Recorded in your
 * Kika Book" confirmation line. All dynamic text is XML-escaped before
 * interpolation (this guards against SVG/XSS injection, which is the
 * relevant risk for markup — not SQL injection, which is handled entirely
 * at the query layer).
 */
function buildReceiptSvg({
  businessName,
  entryTypeLabel,
  counterpartyName,
  itemsLine,
  totalLabel,
  paidLabel,
  balanceLabel,
  timestampLabel,
  reference,
  logoDataUri,
}) {
  const rows = [
    { label: 'Customer', value: counterpartyName || 'Walk-in customer' },
    itemsLine ? { label: 'Items', value: itemsLine } : null,
    { label: 'Total', value: totalLabel },
    { label: 'Paid', value: paidLabel, colorClass: 'mint' },
  ].filter(Boolean);

  const showBalance = balanceLabel != null;
  const bodyRowsHeight = rows.length * ROW_HEIGHT;
  const balanceBlockHeight = showBalance ? 90 : 0;
  const height = 260 + bodyRowsHeight + balanceBlockHeight + 90; // header + rows + balance card + footer

  let y = 225;
  const rowSvgs = rows
    .map((row) => {
      const labelY = y;
      const valueY = y + 32;
      y += ROW_HEIGHT;
      const valueClass = row.colorClass === 'mint' ? 'mint' : 'value';
      return `
      <text x="40" y="${labelY}" class="label">${escapeXml(row.label)}</text>
      <text x="${CARD_WIDTH - 40}" y="${valueY}" class="${valueClass}" text-anchor="end">${escapeXml(row.value)}</text>`;
    })
    .join('');

  const balanceBlockSvg = showBalance
    ? `
  <rect x="40" y="${y + 10}" width="${CARD_WIDTH - 80}" height="${balanceBlockHeight - 20}" rx="12" fill="#1F1730" stroke="${THEME.debtAmber}" stroke-width="1.5" />
  <text x="60" y="${y + 42}" class="label">Customer Owes (Total)</text>
  <text x="${CARD_WIDTH - 60}" y="${y + 42}" class="balance" text-anchor="end">${escapeXml(balanceLabel)}</text>`
    : '';

  const dividerY = y + balanceBlockHeight + 20;
  const footerY = dividerY + 40;

  // A premium merchant's uploaded logo renders as a small rounded square
  // in the header's top-right corner, alongside the business name.
  const logoSvg = logoDataUri
    ? `
  <clipPath id="logoClip"><rect x="${CARD_WIDTH - 104}" y="24" width="64" height="64" rx="12" /></clipPath>
  <rect x="${CARD_WIDTH - 104}" y="24" width="64" height="64" rx="12" fill="#FFFFFF" opacity="0.06" />
  <image href="${logoDataUri}" x="${CARD_WIDTH - 104}" y="24" width="64" height="64" clip-path="url(#logoClip)" preserveAspectRatio="xMidYMid slice" />`
    : '';

  return `
<svg width="${CARD_WIDTH}" height="${height}" viewBox="0 0 ${CARD_WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      .label   { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.textMuted}; font-size: 22px; }
      .value   { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.textPrimary}; font-size: 26px; font-weight: 600; }
      .mint    { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.mint}; font-size: 28px; font-weight: 700; }
      .balance { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.debtAmber}; font-size: 28px; font-weight: 700; }
      .bizname { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.coral}; font-size: 34px; font-weight: 800; }
      .muted   { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.textMuted}; font-size: 18px; }
      .watermark { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.coral}; font-size: 18px; font-weight: 600; }
      .type    { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.textMuted}; font-size: 20px; font-weight: 600; }
    </style>
  </defs>

  <rect x="0" y="0" width="${CARD_WIDTH}" height="${height}" fill="${THEME.background}" rx="24" />
  <rect x="0" y="0" width="${CARD_WIDTH}" height="8" fill="${THEME.accent}" rx="4" />

  <text x="40" y="70" class="bizname">${escapeXml(businessName || 'Merchant')}</text>
  <text x="40" y="98" class="type">${escapeXml(entryTypeLabel)}</text>
  ${logoSvg}

  <line x1="40" y1="120" x2="${CARD_WIDTH - 40}" y2="120" stroke="${THEME.accent}" stroke-width="2" stroke-opacity="0.5" />
  ${rowSvgs}
  ${balanceBlockSvg}

  <line x1="40" y1="${dividerY}" x2="${CARD_WIDTH - 40}" y2="${dividerY}" stroke="${THEME.accent}" stroke-width="1" stroke-opacity="0.3" stroke-dasharray="6,6" />
  <text x="40" y="${footerY}" class="watermark">Powered by Kika AI</text>

  <line x1="40" y1="${height - 55}" x2="${CARD_WIDTH - 40}" y2="${height - 55}" stroke="${THEME.accent}" stroke-width="1" stroke-opacity="0.3" />
  <text x="40" y="${height - 25}" class="muted">${escapeXml(timestampLabel)}</text>
  <text x="${CARD_WIDTH - 40}" y="${height - 25}" class="muted" text-anchor="end">Ref: ${escapeXml(reference)}</text>
</svg>`.trim();
}

const ENTRY_TYPE_LABELS = {
  CREDIT: 'Sale Recorded',
  DEBIT: 'Expense Recorded',
  DEBT: 'Credit Sale (Debt)',
  DEBT_SETTLEMENT: 'Debt Payment Received',
};

/**
 * Reads a merchant's logo file (if set) and returns it as a data: URI
 * ready to embed directly in the SVG. Never throws — a missing or
 * unreadable logo file just means the receipt renders without one,
 * which is always safe to fall back to.
 */
async function loadLogoDataUri(logoFilePath) {
  if (!logoFilePath) return null;
  try {
    const buffer = await fs.readFile(logoFilePath);
    const mimeType = logoFilePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  } catch (err) {
    logger.warn({ err: err.message, logoFilePath }, 'Could not load merchant logo, rendering receipt without it');
    return null;
  }
}

/**
 * Renders a receipt PNG for a ledger entry, stores it, and returns a
 * safe, unguessable, expiring URL suitable for handing straight to the
 * WhatsApp message broker as a media attachment.
 */
async function generateReceipt({ merchant, ledgerEntry }) {
  const storageDir = process.env.RECEIPT_STORAGE_DIR || path.join(process.cwd(), 'public', 'receipts');
  await fs.mkdir(storageDir, { recursive: true });

  const logoDataUri = await loadLogoDataUri(merchant.logo_file_path);

  const svg = buildReceiptSvg({
    businessName: merchant.business_name || merchant.display_name,
    entryTypeLabel: ENTRY_TYPE_LABELS[ledgerEntry.entry_type] || 'Transaction',
    counterpartyName: ledgerEntry.counterparty_name,
    itemsLine: formatItemsLine(ledgerEntry.items),
    totalLabel: formatNaira(ledgerEntry.total_kobo),
    paidLabel: formatNaira(ledgerEntry.paid_kobo),
    // Prefer the customer's rolling total (balance_after_kobo, computed
    // under an explicit row lock in queries.lockCustomerBalance) over
    // this single entry's own leftover balance_kobo — the rolling figure
    // is what's actually correct when a customer has multiple open debts.
    balanceLabel: (() => {
      const rollingKobo = ledgerEntry.balance_after_kobo != null ? Number(ledgerEntry.balance_after_kobo) : null;
      const shownKobo = rollingKobo != null ? rollingKobo : Number(ledgerEntry.balance_kobo);
      return shownKobo > 0 ? formatNaira(shownKobo) : null;
    })(),
    timestampLabel: new Date(ledgerEntry.created_at).toLocaleString('en-NG', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
    reference: ledgerEntry.id.slice(0, 8).toUpperCase(),
    logoDataUri,
  });

  const publicToken = crypto.randomBytes(24).toString('hex');
  const fileName = `${uuidv4()}.png`;
  const filePath = path.join(storageDir, fileName);

  await sharp(Buffer.from(svg)).png({ quality: 92 }).toFile(filePath);

  const ttlHours = Number(process.env.RECEIPT_URL_TTL_HOURS || 72);
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);

  const receiptRecord = await queries.createReceiptRecord({
    merchantId: merchant.id,
    ledgerEntryId: ledgerEntry.id,
    filePath,
    publicToken,
    expiresAt,
  });

  await queries.attachReceiptToLedgerEntry(ledgerEntry.id, receiptRecord.id);

  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const safeUrl = `${baseUrl}/api/v1/receipts/${publicToken}.png`;

  logger.info({ merchantId: merchant.id, receiptId: receiptRecord.id }, 'Receipt generated');

  return { url: safeUrl, receiptId: receiptRecord.id, expiresAt };
}

module.exports = { generateReceipt, formatNaira };