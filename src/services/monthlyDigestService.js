'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const queries = require('../db/queries');
const logger = require('../utils/logger');

// ** NEW IMPORT **
const { formatNaira } = require('../utils/currency');

// -------------------------------------------------------------------
// Theme – dark background, coral accent (matches the existing UI)
// -------------------------------------------------------------------
const THEME = {
  background: '#0B0F19',
  cardBg: '#161B26',
  accent: '#10B981',
  mint: '#34D399',
  coral: '#F0655A',
  amber: '#FBBF24',
  textPrimary: '#F9FAFB',
  textMuted: '#9CA3AF',
};

// -------------------------------------------------------------------
// Dashboard URL – the full‑report page you supplied.
// -------------------------------------------------------------------
const DASHBOARD_URL = 'https://khhugmmuuu7w4.kimi.page';

// -------------------------------------------------------------------
// SVG dimensions – a little slimmer for chat embeds.
// -------------------------------------------------------------------
const CARD_WIDTH = 720;
const CARD_HEIGHT = 700;

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------
function escapeXml(unsafe) {
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// -------------------------------------------------------------------
// Build the SVG for the Monthly Digest.
// -------------------------------------------------------------------
function buildDigestSvg({
  merchantName,
  monthYear,
  moneyInflowLabel,
  growthLabel,
  outstandingLabel,
  tradeDays,
  topDebtorName,
  topDebtorLabel,
  reportUrl,
}) {
  return `
<svg width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}"
     xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      .badge-label   { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.textPrimary}; font-size: 30px; font-weight: 700; }
      .badge-sub     { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.textMuted}; font-size: 20px; }
      .stat-label    { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.textMuted}; font-size: 22px; }
      .stat-value    { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.textPrimary}; font-size: 42px; font-weight: 700; }
      .stat-growth   { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.mint}; font-size: 22px; font-weight: 600; }
      .mini-label    { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.textMuted}; font-size: 20px; }
      .mini-value    { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.textPrimary}; font-size: 28px; font-weight: 700; }
      .mini-amber    { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.amber}; font-size: 24px; font-weight: 700; }
      .footer-link   { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.coral}; font-size: 20px; font-weight: 600; cursor: pointer; }
      .footer-muted  { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.textMuted}; font-size: 20px; }
    </style>
  </defs>

  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${THEME.background}" rx="24"/>

  <circle cx="76" cy="90" r="34" fill="${THEME.coral}"/>
  <rect x="62" y="80" width="6" height="20" fill="${THEME.background}" rx="2"/>
  <rect x="73" y="72" width="6" height="28" fill="${THEME.background}" rx="2"/>
  <rect x="84" y="78" width="6" height="22" fill="${THEME.background}" rx="2"/>
  <text x="126" y="82" class="badge-label">Monthly Digest</text>
  <text x="126" y="110" class="badge-sub">Powered by Kika AI</text>

  <line x1="40" y1="150" x2="${CARD_WIDTH - 40}" y2="150"
        stroke="${THEME.textMuted}" stroke-opacity="0.2" stroke-width="1"/>

  <rect x="40" y="180" width="${CARD_WIDTH - 80}" height="150"
        rx="16" fill="${THEME.cardBg}"/>
  <path d="M64 218 l14 -14 l14 14 M78 205 v22"
        stroke="${THEME.mint}" stroke-width="3" fill="none"
        stroke-linecap="round" stroke-linejoin="round" transform="translate(0,-2)"/>
  <text x="100" y="222" class="stat-label">Money Inflow</text>
  <text x="64" y="278" class="stat-value">${escapeXml(moneyInflowLabel)}</text>
  <text x="64" y="312" class="stat-growth">${escapeXml(growthLabel)}</text>

  <rect x="40" y="350" width="${CARD_WIDTH - 80}" height="130"
        rx="16" fill="${THEME.cardBg}"/>
  <path d="M64 378 l14 14 l14 -14 M78 405 v-22"
        stroke="${THEME.coral}" stroke-width="3" fill="none"
        stroke-linecap="round" stroke-linejoin="round" transform="translate(0,-8)"/>
  <text x="100" y="392" class="stat-label">Outstanding Credit</text>
  <text x="64" y="448" class="stat-value">${escapeXml(outstandingLabel)}</text>

  <rect x="40" y="500" width="300" height="140" rx="16" fill="${THEME.cardBg}"/>
  <text x="64" y="536" class="mini-label">\ud83d\udcc5 Trade Days</text>
  <text x="64" y="596" class="mini-value">${tradeDays}</text>

  <rect x="360" y="500" width="${CARD_WIDTH - 400}" height="140" rx="16" fill="${THEME.cardBg}"/>
  <text x="384" y="536" class="mini-label">\ud83d\udc64 Top Debtor</text>
  <text x="384" y="580" class="mini-value">${escapeXml(topDebtorName || '\u2014')}</text>
  <text x="384" y="612" class="mini-amber">${escapeXml(topDebtorLabel)}</text>

  <line x1="40" y1="660" x2="${CARD_WIDTH - 40}" y2="660"
        stroke="${THEME.textMuted}" stroke-opacity="0.2" stroke-width="1"/>

  <text x="40" y="${CARD_HEIGHT - 20}" class="footer-muted">Generated by AI</text>
  <a href="${reportUrl}" target="_blank" rel="noopener">
    <text x="${CARD_WIDTH - 40}" y="${CARD_HEIGHT - 20}"
          class="footer-link" text-anchor="end">View Full Report &#8250;</text>
  </a>
</svg>`.trim();
}

// -------------------------------------------------------------------
// Generate the PNG + HTML snippet for a merchant/period.
// -------------------------------------------------------------------
async function generateDigestCard({
  merchant,
  periodKey,
  moneyInflowKobo,
  growthPct,
  outstandingKobo,
  tradeDays,
  topDebtor,
}) {
  const storageDir = process.env.RECEIPT_STORAGE_DIR ||
    path.join(process.cwd(), 'public', 'receipts');
  await fs.mkdir(storageDir, { recursive: true });

  const growthLabel = growthPct == null
    ? 'No prior month to compare'
    : `${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(0)}% vs last month`;

  const reportUrl = `${DASHBOARD_URL}?merchant=${merchant.id}&period=${periodKey}`;

  const svg = buildDigestSvg({
    merchantName: merchant.name,
    monthYear: periodKey,
    moneyInflowLabel: formatNaira(moneyInflowKobo),
    growthLabel,
    outstandingLabel: formatNaira(outstandingKobo),
    tradeDays,
    topDebtorName: topDebtor?.counterparty_name,
    topDebtorLabel: topDebtor ? formatNaira(topDebtor.balance_kobo) : '\u20a60',
    reportUrl,
  });

  const publicToken = crypto.randomBytes(24).toString('hex');
  const fileName = `${uuidv4()}.png`;
  const filePath = path.join(storageDir, fileName);
  await sharp(Buffer.from(svg)).png({ quality: 92 }).toFile(filePath);

  const ttlHours = Number(process.env.RECEIPT_URL_TTL_HOURS || 72);
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
  await queries.createDigestCard({
    merchantId: merchant.id,
    periodKey,
    filePath,
    publicToken,
    expiresAt,
  });

  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const pngUrl = `${baseUrl}/api/v1/digest-cards/${publicToken}.png`;

  const htmlSnippet = `
<div style="font-family:Inter,sans-serif;max-width:720px;background:${THEME.background};color:${THEME.textPrimary};padding:16px;border-radius:12px;">
  <img src="${pngUrl}" alt="Monthly Digest" style="width:100%;border-radius:8px;">
  <div style="margin-top:12px;text-align:center;">
    <a href="${reportUrl}" target="_blank" rel="noopener"
       style="display:inline-block;background:${THEME.coral};color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:600;">
      View Full Report
    </a>
  </div>
</div>`.trim();

  logger.info({ merchantId: merchant.id, periodKey }, 'Monthly digest card generated');
  return { url: pngUrl, expiresAt, html: htmlSnippet };
}

// -------------------------------------------------------------------
// Exported helpers
// -------------------------------------------------------------------
module.exports = { generateDigestCard, formatNaira };