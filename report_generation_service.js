'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const queries = require('../db/queries');
const logger = require('../utils/logger');

// Dark theme to match the beautiful UI in screenshot 1
const THEME = {
  background: '#0F172A',      // Slate 900
  cardBg: '#1E293B',          // Slate 800
  textPrimary: '#F8FAFC',     // Slate 50
  textSecondary: '#94A3B8',   // Slate 400
  inflow: '#10B981',          // Emerald 500 (Green)
  outflow: '#EF4444',         // Red 500
  warning: '#F59E0B',         // Amber 500
  insightBg: '#312E81',       // Indigo 900
  insightText: '#E0E7FF',     // Indigo 100
};

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1350;
const PADDING = 80;

function formatNaira(kobo) {
  const naira = Number(kobo) / 100;
  return `\u20a6${naira.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Builds the SVG for the WhatsApp Monthly Digest Summary Image
 */
function buildReportSvg({
  businessName,
  monthLabel,
  inflowKobo,
  outflowKobo,
  netProfitKobo,
  topDebtorName,
  topDebtorAmountKobo,
}) {
  let svgContent = '';
  let y = 120;

  // Header
  svgContent += `<text x="${PADDING}" y="${y}" class="brand">KIKA AI DIGEST</text>`;
  y += 60;
  svgContent += `<text x="${PADDING}" y="${y}" class="title">${escapeXml(monthLabel)} Summary</text>`;
  
  // Business Name Top Right
  svgContent += `<text x="${CARD_WIDTH - PADDING}" y="${y}" class="bizname" text-anchor="end">${escapeXml(businessName)}</text>`;
  y += 100;

  // Net Profit Highlight (Big Number)
  svgContent += `<text x="${PADDING}" y="${y}" class="label">NET PROFIT</text>`;
  y += 80;
  const profitColor = netProfitKobo >= 0 ? THEME.inflow : THEME.outflow;
  svgContent += `<text x="${PADDING}" y="${y}" class="huge-amount" fill="${profitColor}">${escapeXml(formatNaira(netProfitKobo))}</text>`;
  y += 120;

  // Split Cards for Inflow & Outflow
  const cardWidth = (CARD_WIDTH - (PADDING * 2) - 40) / 2;
  
  // Inflow Card
  svgContent += `
    <rect x="${PADDING}" y="${y}" width="${cardWidth}" height="200" rx="24" fill="${THEME.cardBg}" />
    <text x="${PADDING + 40}" y="${y + 70}" class="card-label">TOTAL INFLOW</text>
    <text x="${PADDING + 40}" y="${y + 140}" class="card-value" fill="${THEME.inflow}">+${escapeXml(formatNaira(inflowKobo))}</text>
  `;

  // Outflow Card
  svgContent += `
    <rect x="${PADDING + cardWidth + 40}" y="${y}" width="${cardWidth}" height="200" rx="24" fill="${THEME.cardBg}" />
    <text x="${PADDING + cardWidth + 80}" y="${y + 70}" class="card-label">TOTAL OUTFLOW</text>
    <text x="${PADDING + cardWidth + 80}" y="${y + 140}" class="card-value" fill="${THEME.outflow}">-${escapeXml(formatNaira(outflowKobo))}</text>
  `;
  y += 280;

  // Top Debtor Section
  if (topDebtorName && topDebtorAmountKobo > 0) {
    svgContent += `
      <rect x="${PADDING}" y="${y}" width="${CARD_WIDTH - (PADDING * 2)}" height="220" rx="24" fill="${THEME.cardBg}" />
      <text x="${PADDING + 40}" y="${y + 70}" class="card-label" fill="${THEME.warning}">⚠️ TOP DEBTOR THIS MONTH</text>
      <text x="${PADDING + 40}" y="${y + 130}" class="debtor-name">${escapeXml(topDebtorName)}</text>
      <text x="${PADDING + 40}" y="${y + 180}" class="card-value" fill="${THEME.warning}">${escapeXml(formatNaira(topDebtorAmountKobo))} Owed</text>
    `;
    y += 280;
  }

  // AI Insight Teaser
  svgContent += `
    <rect x="${PADDING}" y="${y}" width="${CARD_WIDTH - (PADDING * 2)}" height="120" rx="24" fill="${THEME.insightBg}" />
    <text x="${CARD_WIDTH / 2}" y="${y + 68}" class="insight-text" text-anchor="middle">✨ Click "View Full Report" for Kika's AI insights</text>
  `;

  return `
<svg width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;700;800&amp;display=swap');
      
      text { font-family: 'Plus Jakarta Sans', sans-serif; }
      .brand { fill: ${THEME.inflow}; font-size: 28px; font-weight: 800; letter-spacing: 2px; }
      .title { fill: ${THEME.textPrimary}; font-size: 48px; font-weight: 700; }
      .bizname { fill: ${THEME.textSecondary}; font-size: 32px; font-weight: 500; }
      
      .label { fill: ${THEME.textSecondary}; font-size: 28px; font-weight: 700; letter-spacing: 1px; }
      .huge-amount { font-size: 110px; font-weight: 800; letter-spacing: -2px; }
      
      .card-label { fill: ${THEME.textSecondary}; font-size: 26px; font-weight: 700; }
      .card-value { font-size: 56px; font-weight: 800; }
      .debtor-name { fill: ${THEME.textPrimary}; font-size: 42px; font-weight: 700; }
      
      .insight-text { fill: ${THEME.insightText}; font-size: 28px; font-weight: 700; }
    </style>
  </defs>
  <rect x="0" y="0" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${THEME.background}" />
  ${svgContent}
</svg>`.trim();
}

/**
 * Generates the WhatsApp summary image AND the secure web link for the dashboard.
 */
async function generateMonthlyDigest({ merchant, reportData }) {
  const storageDir = process.env.RECEIPT_STORAGE_DIR || path.join(process.cwd(), 'public', 'reports');
  await fs.mkdir(storageDir, { recursive: true });

  const svg = buildReportSvg({
    businessName: merchant.business_name || merchant.display_name,
    monthLabel: reportData.monthLabel, // e.g., "August 2026"
    inflowKobo: reportData.totalInflowKobo,
    outflowKobo: reportData.totalOutflowKobo,
    netProfitKobo: reportData.totalInflowKobo - reportData.totalOutflowKobo,
    topDebtorName: reportData.topDebtor?.name,
    topDebtorAmountKobo: reportData.topDebtor?.amountKobo,
  });

  const publicToken = crypto.randomBytes(24).toString('hex');
  const fileName = `report_${uuidv4()}.png`;
  const filePath = path.join(storageDir, fileName);

  await sharp(Buffer.from(svg)).png({ quality: 95 }).toFile(filePath);

  // In a real app, you would save `reportData` to Postgres here tied to `publicToken`
  // so the React frontend can fetch it securely via an API endpoint.

  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  
  // Return BOTH the image URL (for WhatsApp) and the Dashboard URL (for the button)
  return { 
    whatsappImageUrl: `${baseUrl}/api/v1/reports/${fileName}`, 
    dashboardWebUrl: `${baseUrl}/dashboard/report/${publicToken}`,
    reportToken: publicToken
  };
}

module.exports = { generateMonthlyDigest };