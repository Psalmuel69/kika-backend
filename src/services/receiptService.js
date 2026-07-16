/*'use strict';

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

const CARD_WIDTH = 1080;
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
/*
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
/*
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
/*
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
*/

'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const queries = require('../db/queries');
const logger = require('../utils/logger');

// Theme matches the light, minimal receipt template provided
const THEME = 
  background: '#FFFFFF',
  textPrimary: '#262A56',     // Deep Navy Blue for text and dashed lines
  textPaid: '#10B981',        // Emerald Green for paid amounts
  textOutstanding: '#EF4444', // Red for outstanding debt
};

const CARD_WIDTH = 1080;
const MIN_CARD_HEIGHT = 1350;
const PADDING = 80;

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

/**
 * Splits a long string into multiple lines to prevent SVG text clipping.
 */
function splitTextIntoLines(text, maxChars) {
  if (!text) return [];
  const words = String(text).split(' ');
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    if ((currentLine + word).length > maxChars) {
      if (currentLine) lines.push(currentLine.trim());
      currentLine = word + ' ';
    } else {
      currentLine += word + ' ';
    }
  }
  if (currentLine) lines.push(currentLine.trim());
  return lines;
}

/**
 * Builds a KIKA RECEIPT SVG dynamically adjusting height based on items.
 */
function buildReceiptSvg({
  businessName,
  entryTypeLabel,
  counterpartyName,
  items,
  description,
  totalLabel,
  paidLabel,
  balanceLabel,
  timestampLabel,
  reference,
  logoDataUri,
  kikaLogoDataUri,
  isFreeTier,
}) {
  let y = 80;
  let svgContent = '';

  // 1. Logo (Circular Mask)
  if (logoDataUri) {
    svgContent += `
      <clipPath id="logoClip">
        <circle cx="${CARD_WIDTH / 2}" cy="${y + 75}" r="75" />
      </clipPath>
      <image href="${logoDataUri}" x="${CARD_WIDTH / 2 - 75}" y="${y}" width="150" height="150" clip-path="url(#logoClip)" preserveAspectRatio="xMidYMid slice" />
    `;
    y += 180;
  } else {
    y += 40; // Breathing room if no logo
  }

  // 2. Business Name (Agrandir, Wrapping)
  y += 60;
  const bizNameLines = splitTextIntoLines(businessName || 'Merchant', 26);
  bizNameLines.forEach(line => {
    svgContent += `<text x="${CARD_WIDTH / 2}" y="${y}" class="bizname" text-anchor="middle">${escapeXml(line)}</text>`;
    y += 75;
  });
  y += 10;

  // 3. Dashed line
  svgContent += `<line x1="${PADDING}" y1="${y}" x2="${CARD_WIDTH - PADDING}" y2="${y}" class="dash" />`;
  y += 50;

  // 4. Meta Info (2 Columns, Fira Code)
  svgContent += `<text x="${PADDING}" y="${y}" class="meta-label">DATE: <tspan class="meta-value">${escapeXml(timestampLabel)}</tspan></text>`;
  svgContent += `<text x="${CARD_WIDTH / 2}" y="${y}" class="meta-label">LABEL: <tspan class="meta-value">${escapeXml(entryTypeLabel)}</tspan></text>`;
  y += 45;

  svgContent += `<text x="${PADDING}" y="${y}" class="meta-label">REF: <tspan class="meta-value">${escapeXml(reference)}</tspan></text>`;
  
  const custLines = splitTextIntoLines(counterpartyName || 'Walk-in', 22);
  svgContent += `<text x="${CARD_WIDTH / 2}" y="${y}" class="meta-label">CUSTOMER: <tspan class="meta-value">${escapeXml(custLines[0])}</tspan></text>`;
  y += 45;
  
  // Wrap customer name if it's too long
  for (let i = 1; i < custLines.length; i++) {
      svgContent += `<text x="${CARD_WIDTH / 2 + 160}" y="${y}" class="meta-value">${escapeXml(custLines[i])}</text>`;
      y += 45;
  }
  y += 15;

  // 5. Dashed line
  svgContent += `<line x1="${PADDING}" y1="${y}" x2="${CARD_WIDTH - PADDING}" y2="${y}" class="dash" />`;
  y += 65;

  // 6. Items (Fira Code)
  if (items && items.length > 0) {
    items.forEach((it) => {
      const unitStr = it.unit && it.unit !== 'units' ? ` ${it.unit}` : '';
      const itemName = `${it.name.charAt(0).toUpperCase()}${it.name.slice(1)} x${it.quantity}${unitStr}`;
      
      // Calculate if we need to wrap the item name
      // Leaving ~250px on the right for potential price string
      const nameLines = splitTextIntoLines(itemName, 38); 
      
      svgContent += `<text x="${PADDING}" y="${y}" class="item">${escapeXml(nameLines[0])}</text>`;
      
      // If item has a specific total_kobo mapped, render it on the right
      if (it.total_kobo) {
        svgContent += `<text x="${CARD_WIDTH - PADDING}" y="${y}" class="item" text-anchor="end">${escapeXml(formatNaira(it.total_kobo))}</text>`;
      }
      y += 50;

      for (let i = 1; i < nameLines.length; i++) {
          svgContent += `<text x="${PADDING}" y="${y}" class="item">${escapeXml(nameLines[i])}</text>`;
          y += 50;
      }
      y += 15;
    });
  } else if (description) {
      const descLines = splitTextIntoLines(description, 50);
      descLines.forEach(line => {
        svgContent += `<text x="${PADDING}" y="${y}" class="item">${escapeXml(line)}</text>`;
        y += 50;
      });
      y += 15;
  } else {
      svgContent += `<text x="${PADDING}" y="${y}" class="item">General Transaction</text>`;
      y += 65;
  }

  // 7. Dashed line
  y += 5;
  svgContent += `<line x1="${PADDING}" y1="${y}" x2="${CARD_WIDTH - PADDING}" y2="${y}" class="dash" />`;
  y += 75;

  // 8. Totals (Fira Code Bold)
  svgContent += `
    <text x="${PADDING}" y="${y}" class="total-label">TOTAL</text>
    <text x="${CARD_WIDTH - PADDING}" y="${y}" class="total-val" text-anchor="end">${escapeXml(totalLabel)}</text>
  `;
  y += 60;

  svgContent += `
    <text x="${PADDING}" y="${y}" class="paid-label">PAID</text>
    <text x="${CARD_WIDTH - PADDING}" y="${y}" class="paid-val" text-anchor="end">${escapeXml(paidLabel)}</text>
  `;
  y += 60;

  if (balanceLabel) {
    svgContent += `
      <text x="${PADDING}" y="${y}" class="out-label">OUTSTANDING</text>
      <text x="${CARD_WIDTH - PADDING}" y="${y}" class="out-val" text-anchor="end">${escapeXml(balanceLabel)}</text>
    `;
    y += 60;
  }

  // 9. Footer
  y += 50;
  svgContent += `
    <line x1="${PADDING}" y1="${y-8}" x2="${CARD_WIDTH/2 - 200}" y2="${y-8}" class="dash" />
    <text x="${CARD_WIDTH / 2}" y="${y}" class="footer" text-anchor="middle">Generated securely by Kika AI</text>
    <line x1="${CARD_WIDTH/2 + 200}" y1="${y-8}" x2="${CARD_WIDTH - PADDING}" y2="${y-8}" class="dash" />
  `;
  y += 80; // Final padding bottom ensures no awkward empty space

  const height = Math.max(MIN_CARD_HEIGHT, y);

  // Watermark for free tier using the Kika logo image
  let watermarkSvg = '';
  if (isFreeTier && kikaLogoDataUri) {
      // Scale and position the logo in the center of the receipt
      const watermarkWidth = 600;
      const watermarkHeight = 600;
      const watermarkX = (CARD_WIDTH - watermarkWidth) / 2;
      const watermarkY = (height - watermarkHeight) / 2;
      
      watermarkSvg = `
        <g opacity="0.05" transform="rotate(-30, ${CARD_WIDTH / 2}, ${height / 2})">
          <image href="${kikaLogoDataUri}" x="${watermarkX}" y="${watermarkY}" width="${watermarkWidth}" height="${watermarkHeight}" preserveAspectRatio="xMidYMid meet" />
        </g>
      `;
  }

  return `
<svg width="${CARD_WIDTH}" height="${height}" viewBox="0 0 ${CARD_WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&amp;display=swap');
      
      .bizname { font-family: 'Agrandir', 'Helvetica Neue', Helvetica, Arial, sans-serif; fill: ${THEME.textPrimary}; font-size: 64px; font-weight: 700; letter-spacing: -2px; }
      
      .meta-label { font-family: 'Fira Code', 'Courier New', monospace; fill: ${THEME.textPrimary}; font-size: 26px; font-weight: 600; }
      .meta-value { font-family: 'Fira Code', 'Courier New', monospace; fill: ${THEME.textPrimary}; font-size: 26px; font-weight: 400; }
      
      .item { font-family: 'Fira Code', 'Courier New', monospace; fill: ${THEME.textPrimary}; font-size: 34px; font-weight: 500; }
      
      .total-label { font-family: 'Fira Code', monospace; fill: ${THEME.textPrimary}; font-size: 42px; font-weight: 800; }
      .total-val { font-family: 'Fira Code', monospace; fill: ${THEME.textPrimary}; font-size: 42px; font-weight: 700; }
      
      .paid-label { font-family: 'Fira Code', monospace; fill: ${THEME.textPaid}; font-size: 42px; font-weight: 800; }
      .paid-val { font-family: 'Fira Code', monospace; fill: ${THEME.textPaid}; font-size: 42px; font-weight: 700; }
      
      .out-label { font-family: 'Fira Code', monospace; fill: ${THEME.textOutstanding}; font-size: 42px; font-weight: 800; }
      .out-val { font-family: 'Fira Code', monospace; fill: ${THEME.textOutstanding}; font-size: 42px; font-weight: 700; }
      
      .dash { stroke: ${THEME.textPrimary}; stroke-width: 2.5; stroke-dasharray: 10,10; }
      .footer { font-family: 'Fira Code', monospace; fill: ${THEME.textPrimary}; font-size: 24px; }
    </style>
  </defs>
  <rect x="0" y="0" width="${CARD_WIDTH}" height="${height}" fill="${THEME.background}" />
  ${watermarkSvg}
  ${svgContent}
</svg>`.trim();
}

// Shortened Entry Type Labels based on user request
const ENTRY_TYPE_LABELS = {
  CREDIT: 'Sale',
  DEBIT: 'Expense',
  DEBT: 'Credit Sale',
  DEBT_SETTLEMENT: 'Debt Payment',
};

/**
 * Reads an image file and returns it as a data: URI.
 * Handles removing the background via sharp for PNG/JPEG formats if requested.
 */
async function loadImageAsDataUri(filePath, removeBackground = false) {
  if (!filePath) return null;
  try {
    let buffer = await fs.readFile(filePath);
    let mimeType = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
    
    // If we need to remove the background (make white pixels transparent)
    // This is a basic background removal, assuming a mostly white background like the logo provided.
    if (removeBackground) {
        buffer = await sharp(buffer)
            .ensureAlpha()
            // Make near-white pixels transparent (tolerance can be adjusted)
            .raw()
            .toBuffer({ resolveWithObject: true })
            .then(({ data, info }) => {
                for (let i = 0; i < data.length; i += info.channels) {
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    // If pixel is very close to white, set alpha to 0
                    if (r > 240 && g > 240 && b > 240) {
                        data[i + 3] = 0;
                    }
                }
                return sharp(data, {
                    raw: {
                        width: info.width,
                        height: info.height,
                        channels: info.channels
                    }
                }).png().toBuffer();
            });
        mimeType = 'image/png'; // Ensure it's treated as a PNG since it now has alpha
    }

    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  } catch (err) {
    logger.warn({ err: err.message, filePath }, 'Could not load image, returning null');
    return null;
  }
}

/**
 * Renders a receipt PNG for a ledger entry, stores it, and returns a URL.
 */
async function generateReceipt({ merchant, ledgerEntry }) {
  const storageDir = process.env.RECEIPT_STORAGE_DIR || path.join(process.cwd(), 'public', 'receipts');
  await fs.mkdir(storageDir, { recursive: true });

  const logoDataUri = await loadImageAsDataUri(merchant.logo_file_path);
  
  // Assume free tier if not explicitly marked premium or on a paid plan
  const isFreeTier = !(merchant.is_premium === true || merchant.subscription_plan === 'PREMIUM');
  
  // Load the Kika logo for the watermark (assuming it's stored locally)
  // In a real scenario, this path would point to the actual Kika logo file in your assets directory.
  // For this implementation, we attempt to load it, and apply the background removal logic.
  const kikaLogoPath = process.env.KIKA_LOGO_PATH || path.join(process.cwd(), 'assets', 'kika-logo.png');
  const kikaLogoDataUri = isFreeTier ? await loadImageAsDataUri(kikaLogoPath, true) : null;

  const svg = buildReceiptSvg({
    businessName: merchant.business_name || merchant.display_name,
    entryTypeLabel: ENTRY_TYPE_LABELS[ledgerEntry.entry_type] || 'Transaction',
    counterpartyName: ledgerEntry.counterparty_name,
    items: ledgerEntry.items, // Pass the array directly to iterate in the SVG
    description: ledgerEntry.description, // Fallback if no items array exists
    totalLabel: formatNaira(ledgerEntry.total_kobo),
    paidLabel: formatNaira(ledgerEntry.paid_kobo),
    balanceLabel: (() => {
      const rollingKobo = ledgerEntry.balance_after_kobo != null ? Number(ledgerEntry.balance_after_kobo) : null;
      const shownKobo = rollingKobo != null ? rollingKobo : Number(ledgerEntry.balance_kobo);
      return shownKobo > 0 ? formatNaira(shownKobo) : null;
    })(),
    timestampLabel: new Date(ledgerEntry.created_at).toLocaleDateString('en-NG', {
      day: '2-digit', 
      month: '2-digit', 
      year: 'numeric'
    }),
    reference: ledgerEntry.id.slice(0, 8).toUpperCase(),
    logoDataUri,
    kikaLogoDataUri,
    isFreeTier,
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