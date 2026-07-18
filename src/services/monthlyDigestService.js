'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const queries = require('../db/queries');
const logger = require('../utils/logger');

// Same base palette as receipts, plus a coral brand accent for this
// card's icon badge and header — matching the product's Monthly Digest UI.
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

const CARD_WIDTH = 720;

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
  return `\u20a6${Math.round(naira).toLocaleString('en-NG')}`;
}

/**
 * Builds the Monthly Digest SVG: a coral "Monthly Digest" header badge,
 * a Money Inflow stat card with a growth-vs-last-month line, an
 * Outstanding Credit stat card, and a two-column Trade Days / Top Debtor
 * row — matching the product's WhatsApp digest card.
 */
function buildDigestSvg({ moneyInflowLabel, growthLabel, outstandingLabel, tradeDays, topDebtorName, topDebtorLabel }) {
  const height = 700;

  return `
<svg width="${CARD_WIDTH}" height="${height}" viewBox="0 0 ${CARD_WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      .badge-label { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.textPrimary}; font-size: 30px; font-weight: 700; }
      .badge-sub   { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.textMuted}; font-size: 20px; }
      .stat-label  { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.textMuted}; font-size: 22px; }
      .stat-value  { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.textPrimary}; font-size: 42px; font-weight: 700; }
      .stat-growth { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.mint}; font-size: 22px; font-weight: 600; }
      .mini-label  { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.textMuted}; font-size: 20px; }
      .mini-value  { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.textPrimary}; font-size: 28px; font-weight: 700; }
      .mini-amber  { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.amber}; font-size: 24px; font-weight: 700; }
      .footer-muted{ font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.textMuted}; font-size: 20px; }
      .footer-link { font-family: 'Helvetica Neue', Arial, sans-serif; fill: ${THEME.coral}; font-size: 20px; font-weight: 600; }
    </style>
  </defs>

  <rect x="0" y="0" width="${CARD_WIDTH}" height="${height}" fill="${THEME.background}" rx="24" />

  <!-- header badge -->
  <circle cx="76" cy="90" r="34" fill="${THEME.coral}" />
  <rect x="62" y="80" width="6" height="20" fill="${THEME.background}" rx="2" />
  <rect x="73" y="72" width="6" height="28" fill="${THEME.background}" rx="2" />
  <rect x="84" y="78" width="6" height="22" fill="${THEME.background}" rx="2" />
  <text x="126" y="82" class="badge-label">Monthly Digest</text>
  <text x="126" y="110" class="badge-sub">Powered by Kika AI</text>

  <line x1="40" y1="150" x2="${CARD_WIDTH - 40}" y2="150" stroke="${THEME.textMuted}" stroke-opacity="0.2" stroke-width="1" />

  <!-- Money Inflow card -->
  <rect x="40" y="180" width="${CARD_WIDTH - 80}" height="150" rx="16" fill="${THEME.cardBg}" />
  <path d="M64 218 l14 -14 l14 14 M78 205 v22" stroke="${THEME.mint}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round" transform="translate(0,-2)" />
  <text x="100" y="222" class="stat-label">Money Inflow</text>
  <text x="64" y="278" class="stat-value">${escapeXml(moneyInflowLabel)}</text>
  <text x="64" y="312" class="stat-growth">${escapeXml(growthLabel)}</text>

  <!-- Outstanding Credit card -->
  <rect x="40" y="350" width="${CARD_WIDTH - 80}" height="130" rx="16" fill="${THEME.cardBg}" />
  <path d="M64 378 l14 14 l14 -14 M78 405 v-22" stroke="${THEME.coral}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round" transform="translate(0,-8)" />
  <text x="100" y="392" class="stat-label">Outstanding Credit</text>
  <text x="64" y="448" class="stat-value">${escapeXml(outstandingLabel)}</text>

  <!-- Trade Days / Top Debtor mini cards -->
  <rect x="40" y="500" width="300" height="140" rx="16" fill="${THEME.cardBg}" />
  <text x="64" y="536" class="mini-label">\ud83d\udcc5 Trade Days</text>
  <text x="64" y="596" class="mini-value">${tradeDays}</text>

  <rect x="360" y="500" width="${CARD_WIDTH - 400}" height="140" rx="16" fill="${THEME.cardBg}" />
  <text x="384" y="536" class="mini-label">\ud83d\udc64 Top Debtor</text>
  <text x="384" y="580" class="mini-value">${escapeXml(topDebtorName || '\u2014')}</text>
  <text x="384" y="612" class="mini-amber">${escapeXml(topDebtorLabel)}</text>

  <line x1="40" y1="660" x2="${CARD_WIDTH - 40}" y2="660" stroke="${THEME.textMuted}" stroke-opacity="0.2" stroke-width="1" />
  <text x="40" y="${height - 20}" class="footer-muted">Generated by AI</text>
  <text x="${CARD_WIDTH - 40}" y="${height - 20}" class="footer-link" text-anchor="end">View Full Report &#8250;</text>
</svg>`.trim();
}

/**
 * Renders the Monthly Digest PNG for a merchant/period and returns a
 * safe, unguessable, expiring URL — the same security model as receipts.
 */
async function generateDigestCard({ merchant, periodKey, moneyInflowKobo, growthPct, outstandingKobo, tradeDays, topDebtor }) {
  const storageDir = process.env.RECEIPT_STORAGE_DIR || path.join(process.cwd(), 'public', 'receipts');
  await fs.mkdir(storageDir, { recursive: true });

  const growthLabel =
    growthPct == null ? 'No prior month to compare' : `${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(0)}% vs last month`;

  const svg = buildDigestSvg({
    moneyInflowLabel: formatNaira(moneyInflowKobo),
    growthLabel,
    outstandingLabel: formatNaira(outstandingKobo),
    tradeDays,
    topDebtorName: topDebtor?.counterparty_name || null,
    topDebtorLabel: topDebtor ? formatNaira(topDebtor.balance_kobo) : '\u20a60',
  });

  const publicToken = crypto.randomBytes(24).toString('hex');
  const fileName = `${uuidv4()}.png`;
  const filePath = path.join(storageDir, fileName);

  await sharp(Buffer.from(svg)).png({ quality: 92 }).toFile(filePath);

  const ttlHours = Number(process.env.RECEIPT_URL_TTL_HOURS || 72);
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);

  await queries.createDigestCard({ merchantId: merchant.id, periodKey, filePath, publicToken, expiresAt });

  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const safeUrl = `${baseUrl}/api/v1/digest-cards/${publicToken}.png`;

  logger.info({ merchantId: merchant.id, periodKey }, 'Monthly digest card generated');

  return { url: safeUrl, expiresAt };
}

module.exports = { generateDigestCard, formatNaira };
