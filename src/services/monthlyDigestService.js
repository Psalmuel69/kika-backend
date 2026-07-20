'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const queries = require('../db/queries');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// This is a direct port of the supplied DigestCard.tsx (React/Tailwind) into
// a static SVG — WhatsApp needs one flat image, not a live React tree, so
// every Tailwind class and lucide-react icon from that component has been
// translated by hand into the equivalent SVG below: same hex colors, same
// spacing scale, same type sizes, same icon vector paths (pulled straight
// from the `lucide-static` package so they're pixel-identical to
// lucide-react's own rendering, not hand-approximated).
//
// SCALE=2: the component's own px values (e.g. `p-6` = 24px, `text-[28px]`)
// are all doubled before being placed on the canvas. This is the same
// "design at 1x, export at 2x" trick used for any retina asset — it keeps
// every proportion in the original design exactly as specified while giving
// WhatsApp a crisp, high-resolution image instead of a small blurry one.
// Framer-motion animation and CSS hover states have no equivalent in a
// static image and are the only things intentionally not carried over.
// ---------------------------------------------------------------------------
const SCALE = 2;
const px = (n) => Math.round(n * SCALE);

const COLORS = {
  cardBg: '#121214',
  cardBorder: '#26262b',
  statBg: '#1a1a1d',
  statBorder: '#232328',
  divider: '#232328',
  white: '#ffffff',
  textMuted: '#7d7d85',
  textMuted2: '#9a9aa3',
  textFooter: '#6b6b73',
  green: '#22c55e',
  red: '#f05252',
  redDark: '#d63c3c',
  amber: '#eab308',
};

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

// --- Icons: exact path data from lucide-static, matching lucide-react's own
// rendering of BarChart3 / TrendingUp / TrendingDown / Calendar / User /
// ChevronRight exactly (same 24x24 viewBox, same path data). Nested <svg>
// elements scale their own viewBox/strokeWidth automatically, exactly like
// lucide-react's actual DOM output does via its own width/height props. ---
const ICONS = {
  barChart3: { paths: ['M3 3v16a2 2 0 0 0 2 2h16', 'M18 17V9', 'M13 17V5', 'M8 17v-3'] },
  trendingUp: { paths: ['M16 7h6v6', 'm22 7-8.5 8.5-5-5L2 17'] },
  trendingDown: { paths: ['M16 17h6v-6', 'm22 17-8.5-8.5-5 5L2 7'] },
  calendar: { paths: ['M8 2v4', 'M16 2v4', 'M3 10h18'], rects: [{ x: 3, y: 4, width: 18, height: 18, rx: 2 }] },
  user: { paths: ['M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2'], circles: [{ cx: 12, cy: 7, r: 4 }] },
  chevronRight: { paths: ['m9 18 6-6-6-6'] },
};

function icon(name, { x, y, size, color, strokeWidth = 2 }) {
  const def = ICONS[name];
  const paths = (def.paths || []).map((d) => `<path d="${d}" />`).join('');
  const rects = (def.rects || [])
    .map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" rx="${r.rx}" />`)
    .join('');
  const circles = (def.circles || []).map((c) => `<circle cx="${c.cx}" cy="${c.cy}" r="${c.r}" />`).join('');
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${paths}${rects}${circles}</svg>`;
}

const CARD_WIDTH = px(420);
const MARGIN = px(24); // p-6

/**
 * Builds the digest card SVG, laying out every block top-to-bottom exactly
 * in the order and spacing DigestCard.tsx does (header -> divider -> Money
 * Inflow card -> Outstanding Credit card -> Trade Days/Top Debtor row ->
 * divider -> footer), using a running Y-cursor the same way the browser's
 * own block layout would stack these divs.
 */
function buildDigestSvg({ moneyInflowLabel, growthLabel, outstandingLabel, tradeDays, topDebtorName, topDebtorLabel }) {
  const contentWidth = CARD_WIDTH - MARGIN * 2;
  let y = MARGIN; // p-6 top padding

  // --- Header: icon badge + title/subtitle ---
  const badgeSize = px(48); // h-12 w-12
  const badgeIconSize = px(20); // h-5 w-5
  const badgeGap = px(16); // gap-4
  const headerRowHeight = badgeSize;
  const badgeX = MARGIN;
  const badgeY = y;
  const textX = badgeX + badgeSize + badgeGap;

  const header = `
    <defs>
      <style>text { font-family: 'DejaVu Sans', sans-serif; }</style>
      <linearGradient id="badgeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${COLORS.red}" />
        <stop offset="100%" stop-color="${COLORS.redDark}" />
      </linearGradient>
    </defs>
    <circle cx="${badgeX + badgeSize / 2}" cy="${badgeY + badgeSize / 2}" r="${badgeSize / 2}" fill="url(#badgeGrad)" />
    ${icon('barChart3', { x: badgeX + (badgeSize - badgeIconSize) / 2, y: badgeY + (badgeSize - badgeIconSize) / 2, size: badgeIconSize, color: COLORS.white, strokeWidth: 2.4 })}
    <text x="${textX}" y="${badgeY + px(21)}" font-size="${px(17)}" font-weight="700" fill="${COLORS.white}" letter-spacing="-0.2">Monthly Digest</text>
    <text x="${textX}" y="${badgeY + px(21) + px(19)}" font-size="${px(13)}" fill="${COLORS.textMuted}">Powered by Kika AI</text>`;
  y += headerRowHeight;

  // --- Divider (my-5) ---
  y += px(20);
  const divider1Y = y;
  y += px(20);

  // --- Money Inflow card ---
  const inflowCardY = y;
  const cardPad = px(20); // p-5
  let iy = inflowCardY + cardPad;
  const rowIconSize = px(16); // h-4 w-4
  const inflowIconSvg = icon('trendingUp', { x: MARGIN + cardPad, y: iy, size: rowIconSize, color: COLORS.green, strokeWidth: 2.4 });
  const inflowLabelSvg = `<text x="${MARGIN + cardPad + rowIconSize + px(8)}" y="${iy + px(13)}" font-size="${px(13)}" font-weight="500" fill="${COLORS.textMuted2}">Money Inflow</text>`;
  iy += rowIconSize + px(10); // mt-2.5
  const inflowValueSvg = `<text x="${MARGIN + cardPad}" y="${iy + px(28)}" font-size="${px(28)}" font-weight="700" fill="${COLORS.white}" letter-spacing="-0.3">${escapeXml(moneyInflowLabel)}</text>`;
  iy += px(28) + px(10); // value height + mt-2.5
  const inflowNoteSvg = `<text x="${MARGIN + cardPad}" y="${iy + px(13)}" font-size="${px(13)}" font-weight="600" fill="${COLORS.green}">${escapeXml(growthLabel)}</text>`;
  iy += px(13);
  const inflowCardHeight = iy - inflowCardY + cardPad;
  const inflowCard = `
    <rect x="${MARGIN}" y="${inflowCardY}" width="${contentWidth}" height="${inflowCardHeight}" rx="${px(16)}" fill="${COLORS.statBg}" stroke="${COLORS.statBorder}" stroke-width="1" />
    ${inflowIconSvg}${inflowLabelSvg}${inflowValueSvg}${inflowNoteSvg}`;
  y = inflowCardY + inflowCardHeight;

  // --- Outstanding Credit card ---
  y += px(12); // mt-3
  const outstandingCardY = y;
  iy = outstandingCardY + cardPad;
  const outstandingIconSvg = icon('trendingDown', { x: MARGIN + cardPad, y: iy, size: rowIconSize, color: COLORS.red, strokeWidth: 2.4 });
  const outstandingLabelSvg = `<text x="${MARGIN + cardPad + rowIconSize + px(8)}" y="${iy + px(13)}" font-size="${px(13)}" font-weight="500" fill="${COLORS.textMuted2}">Outstanding Credit</text>`;
  iy += rowIconSize + px(10);
  const outstandingValueSvg = `<text x="${MARGIN + cardPad}" y="${iy + px(28)}" font-size="${px(28)}" font-weight="700" fill="${COLORS.white}" letter-spacing="-0.3">${escapeXml(outstandingLabel)}</text>`;
  iy += px(28);
  const outstandingCardHeight = iy - outstandingCardY + cardPad;
  const outstandingCard = `
    <rect x="${MARGIN}" y="${outstandingCardY}" width="${contentWidth}" height="${outstandingCardHeight}" rx="${px(16)}" fill="${COLORS.statBg}" stroke="${COLORS.statBorder}" stroke-width="1" />
    ${outstandingIconSvg}${outstandingLabelSvg}${outstandingValueSvg}`;
  y = outstandingCardY + outstandingCardHeight;

  // --- Trade Days / Top Debtor row (grid-cols-2 gap-3) ---
  y += px(12); // mt-3
  const miniRowY = y;
  const miniGap = px(12); // gap-3
  const miniPad = px(16); // p-4
  const miniColWidth = (contentWidth - miniGap) / 2;
  const miniIconSize = px(16);
  const miniLabelSize = px(12.5);

  // Trade Days content height
  let tdy = miniRowY + miniPad;
  const tradeDaysIconSvg = icon('calendar', { x: MARGIN + miniPad, y: tdy, size: miniIconSize, color: COLORS.red, strokeWidth: 2.2 });
  const tradeDaysLabelSvg = `<text x="${MARGIN + miniPad + miniIconSize + px(8)}" y="${tdy + px(12.5)}" font-size="${miniLabelSize}" font-weight="500" fill="${COLORS.textMuted2}">Trade Days</text>`;
  tdy += miniIconSize + px(10);
  const tradeDaysValueSvg = `<text x="${MARGIN + miniPad}" y="${tdy + px(24)}" font-size="${px(24)}" font-weight="700" fill="${COLORS.white}" letter-spacing="-0.3">${tradeDays}</text>`;
  tdy += px(24);
  const tradeDaysCardHeight = tdy - miniRowY + miniPad;

  // Top Debtor content height (taller: name + amount)
  const debtorX = MARGIN + miniColWidth + miniGap;
  let tby = miniRowY + miniPad;
  const topDebtorIconSvg = icon('user', { x: debtorX + miniPad, y: tby, size: miniIconSize, color: COLORS.amber, strokeWidth: 2.2 });
  const topDebtorLabelSvg = `<text x="${debtorX + miniPad + miniIconSize + px(8)}" y="${tby + px(12.5)}" font-size="${miniLabelSize}" font-weight="500" fill="${COLORS.textMuted2}">Top Debtor</text>`;
  tby += miniIconSize + px(10);
  const topDebtorNameSvg = `<text x="${debtorX + miniPad}" y="${tby + px(15)}" font-size="${px(15)}" font-weight="600" fill="${COLORS.white}">${escapeXml(topDebtorName || '\u2014')}</text>`;
  tby += px(15) + px(4); // mt-1
  const topDebtorAmountSvg = `<text x="${debtorX + miniPad}" y="${tby + px(15)}" font-size="${px(15)}" font-weight="700" fill="${COLORS.amber}">${escapeXml(topDebtorLabel)}</text>`;
  tby += px(15);
  const topDebtorCardHeight = tby - miniRowY + miniPad;

  const miniRowHeight = Math.max(tradeDaysCardHeight, topDebtorCardHeight);
  const miniRow = `
    <rect x="${MARGIN}" y="${miniRowY}" width="${miniColWidth}" height="${miniRowHeight}" rx="${px(16)}" fill="${COLORS.statBg}" stroke="${COLORS.statBorder}" stroke-width="1" />
    <rect x="${debtorX}" y="${miniRowY}" width="${miniColWidth}" height="${miniRowHeight}" rx="${px(16)}" fill="${COLORS.statBg}" stroke="${COLORS.statBorder}" stroke-width="1" />
    ${tradeDaysIconSvg}${tradeDaysLabelSvg}${tradeDaysValueSvg}
    ${topDebtorIconSvg}${topDebtorLabelSvg}${topDebtorNameSvg}${topDebtorAmountSvg}`;
  y = miniRowY + miniRowHeight;

  // --- Divider (my-5) ---
  y += px(20);
  const divider2Y = y;
  y += px(20);

  // --- Footer ---
  const footerY = y;
  const footerTextSvg = `<text x="${MARGIN}" y="${footerY + px(13)}" font-size="${px(13)}" fill="${COLORS.textFooter}">Generated by AI</text>`;
  const ctaLabel = 'View Full Report';
  const ctaFontSize = px(14);
  // Right-aligned CTA text + chevron icon, matching the button's flex row.
  const chevronSize = px(16);
  const ctaTextWidth = ctaLabel.length * ctaFontSize * 0.56; // monospace-ish estimate is fine for a right-align budget here
  const ctaGap = px(6);
  const ctaRightEdge = CARD_WIDTH - MARGIN;
  const chevronX = ctaRightEdge - chevronSize;
  const ctaTextX = chevronX - ctaGap;
  const footerCtaSvg = `
    <text x="${ctaTextX}" y="${footerY + px(14)}" text-anchor="end" font-size="${ctaFontSize}" font-weight="600" fill="${COLORS.red}">${escapeXml(ctaLabel)}</text>
    ${icon('chevronRight', { x: chevronX, y: footerY, size: chevronSize, color: COLORS.red, strokeWidth: 2.6 })}`;
  y = footerY + px(16);

  const cardHeight = y + MARGIN; // p-6 bottom padding

  return `
<svg width="${CARD_WIDTH}" height="${cardHeight}" viewBox="0 0 ${CARD_WIDTH} ${cardHeight}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${CARD_WIDTH}" height="${cardHeight}" rx="${px(24)}" fill="${COLORS.cardBg}" stroke="${COLORS.cardBorder}" stroke-width="1" />
  ${header}
  <line x1="${MARGIN}" y1="${divider1Y}" x2="${CARD_WIDTH - MARGIN}" y2="${divider1Y}" stroke="${COLORS.divider}" stroke-width="1" />
  ${inflowCard}
  ${outstandingCard}
  ${miniRow}
  <line x1="${MARGIN}" y1="${divider2Y}" x2="${CARD_WIDTH - MARGIN}" y2="${divider2Y}" stroke="${COLORS.divider}" stroke-width="1" />
  ${footerTextSvg}
  ${footerCtaSvg}
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
