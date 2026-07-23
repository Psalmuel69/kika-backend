'use strict';

const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const queries = require('../db/queries');
const logger = require('../utils/logger');

// --- Fonts -------------------------------------------------------------
//
// librsvg (what sharp uses under the hood to rasterize the SVG) resolves
// font-family names through fontconfig — it does NOT read @font-face/src
// URLs the way a browser would. So the fonts referenced below must be
// registered with fontconfig, not just declared in CSS.
//
// A tiny, self-contained fontconfig config is generated (once, on first
// module load) pointing at assets/fonts (Fira Code, bundled) and
// assets/fonts/agrandir (Agrandir, NOT bundled — see that folder's
// README), using this deployment's actual absolute path. It's written
// to the OS temp dir and FONTCONFIG_FILE (and, for older/alternate
// fontconfig builds that only honor the directory form,
// FONTCONFIG_PATH) is pointed at it before any render happens, so this
// works identically on a laptop, in Docker, or on Render, with no
// system font install step and no root required — and with no
// ambiguous-relative-path warnings from fontconfig, since the generated
// config always uses an absolute <dir>.
//
// Two real-world footguns this deliberately avoids, both of which
// produce the exact same silent symptom — a receipt that "renders" fine
// (no error, no crash) but comes out totally blank except for the
// vector-drawn dashed dividers, because every <text> glyph quietly
// failed to resolve:
//   1. The `<!DOCTYPE fontconfig SYSTEM "fonts.dtd">` header some
//      fontconfig examples include. It's optional, and on a minimal
//      libxml2 (no local XML catalog entry for fonts.dtd, no network)
//      it can make the whole config fail to parse. Left out entirely.
//   2. `fontconfig` (the actual OS package, not just `libvips`) not
//      being installed in the container at all — see the Dockerfile,
//      which installs it explicitly and copies this assets/ folder in.
const os = require('os');
const FONTS_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
if (!process.env.FONTCONFIG_FILE) {
  try {
    const cacheDir = path.join(os.tmpdir(), 'kika-fontconfig-cache');
    fssync.mkdirSync(cacheDir, { recursive: true });
    const generatedConf = `<?xml version="1.0"?>
<fontconfig>
  <dir>${FONTS_DIR}</dir>
  <dir>${path.join(FONTS_DIR, 'agrandir')}</dir>
  <dir>${path.join(FONTS_DIR, 'fallback')}</dir>
  <cachedir>${cacheDir}</cachedir>
</fontconfig>`;
    const generatedConfDir = path.join(os.tmpdir(), 'kika-fontconfig');
    fssync.mkdirSync(generatedConfDir, { recursive: true });
    const generatedConfPath = path.join(generatedConfDir, 'fonts.conf');
    fssync.writeFileSync(generatedConfPath, generatedConf);
    process.env.FONTCONFIG_FILE = generatedConfPath;
    if (!process.env.FONTCONFIG_PATH) process.env.FONTCONFIG_PATH = generatedConfDir;
  } catch (err) {
    logger.warn({ err: err.message }, 'Could not generate fontconfig config; receipts will fall back to system fonts');
  }
}

// 'Agrandir' resolves if the operator has dropped a licensed copy into
// assets/fonts/agrandir/; otherwise it falls through to a heavy Fira
// Code weight so the business name still reads as a strong wordmark.
const FONT_BRAND = `'Agrandir', 'Fira Code SemiBold', 'Fira Code', sans-serif`;
const FONT_BODY = `'Fira Code', 'Fira Code Medium', monospace`;
// Fira Code has no glyph for the Naira sign (₦, U+20A6) — DejaVu Sans
// does, and is bundled specifically so this never falls back to a tofu
// box regardless of what fonts the host OS has installed.
const FONT_NAIRA = `'DejaVu Sans', sans-serif`;

/**
 * Renders a "₦12,345.00"-style amount string as two <tspan>s sharing one
 * baseline: the ₦ sign in FONT_NAIRA (the only bundled font guaranteed
 * to have that glyph) and the digits/commas in FONT_BODY (Fira Code, so
 * the numerals still match the rest of the receipt). Works the same
 * whether the enclosing <text> is left- or right/end-anchored, since
 * anchoring is computed against the full text run, not each tspan.
 */
function amountMarkup(amountStr, { fontSize, weight = 700 }) {
  const str = String(amountStr);
  const symbol = str.charAt(0);
  const rest = str.slice(1);
  return `<tspan font-family="${FONT_NAIRA}" font-size="${fontSize}" font-weight="${weight}">${escapeXml(symbol)}</tspan><tspan font-family="${FONT_BODY}" font-size="${fontSize}" font-weight="${weight}">${escapeXml(rest)}</tspan>`;
}

// --- Theme (light card, matches the reference template) ----------------
const THEME = {
  background: '#FFFFFF',
  ink: '#2B2E7A',        // headings / labels / item text — deep indigo-navy
  inkMuted: '#6B6FA8',   // secondary/meta text, a softer tint of ink
  hairline: '#C7C9E8',   // dashed dividers
  total: '#111111',      // TOTAL row — near-black, heaviest weight
  paid: '#1DAA6B',       // PAID row — green
  outstanding: '#E14848', // OUTSTANDING row — red
  footer: '#9AA0C8',
};

const CARD_WIDTH = 1080;
const MIN_HEIGHT = 1350;
const MARGIN_X = 84;
const CONTENT_WIDTH = CARD_WIDTH - MARGIN_X * 2;

// --- Invoice theme (separate visual system from the receipt card) ------
// The receipt keeps its existing dashed-line, centered-wordmark look.
// Invoices follow a different reference layout entirely (warm paper
// background, left-aligned masthead, solid hairlines, a purple accent
// on the amount actually owed) — see buildInvoiceSvg further below.
const INVOICE_THEME = {
  background: '#FFFDF9',
  ink: '#1B1B2E',        // headings, item names, values that matter
  inkMuted: '#8D8D9C',   // secondary text — labels' values, dates, descriptions
  hairline: '#E7E3D8',   // solid (not dashed) divider lines
  accent: '#5B4FE0',     // "Amount due" — the one figure that should pop
  footer: '#ADADBE',
};

// --- Small helpers -------------------------------------------------------

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

function titleCaseFirst(word) {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function formatItemLabel(item) {
  const name = titleCaseFirst(item.name || '');
  const qty = item.quantity != null ? item.quantity : null;
  const unit = item.unit || '';
  const qtyPart = qty != null ? ` x${qty}${unit ? ` ${unit}` : ''}` : '';
  return `${name}${qtyPart}`;
}

/**
 * Very cheap width estimator (no headless canvas / font-metrics library
 * available in this environment). Fira Code is monospace, so per-glyph
 * width is a fixed fraction of font-size and this estimate is exact.
 * Agrandir is proportional, so its estimate is a conservative
 * over-estimate (better to wrap one glyph early than overflow the card).
 */
function estimateTextWidth(text, fontSize, { monospace = true } = {}) {
  const factor = monospace ? 0.6 : 0.56;
  return String(text).length * fontSize * factor;
}

/**
 * Greedy word-wrap that keeps every line within maxWidth for the given
 * font size, falling back to a hard character split for single tokens
 * (e.g. one very long item/business name with no spaces) so nothing is
 * ever allowed to overflow the card horizontally.
 */
function wrapText(text, fontSize, maxWidth, { monospace = true, maxLines = 3 } = {}) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines = [];
  let current = '';

  const pushWord = (word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (estimateTextWidth(candidate, fontSize, { monospace }) <= maxWidth) {
      current = candidate;
      return;
    }
    if (current) {
      lines.push(current);
      current = '';
    }
    if (estimateTextWidth(word, fontSize, { monospace }) > maxWidth) {
      let chunk = '';
      for (const ch of word) {
        const test = chunk + ch;
        if (estimateTextWidth(test, fontSize, { monospace }) > maxWidth && chunk) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk = test;
        }
      }
      current = chunk;
    } else {
      current = word;
    }
  };

  for (const word of words) pushWord(word);
  if (current) lines.push(current);

  if (lines.length > maxLines) {
    const clipped = lines.slice(0, maxLines);
    let last = clipped[maxLines - 1];
    while (estimateTextWidth(`${last}\u2026`, fontSize, { monospace }) > maxWidth && last.length > 1) {
      last = last.slice(0, -1);
    }
    clipped[maxLines - 1] = `${last}\u2026`;
    return clipped;
  }
  return lines;
}

const ENTRY_TYPE_LABELS = {
  CREDIT: 'Sale',
  DEBIT: 'Expense',
  DEBT: 'Credit Sale',
  DEBT_SETTLEMENT: 'Debt Payment',
};

/**
 * Reads a file from disk and returns it as a data: URI. Never throws —
 * a missing/unreadable file just means that visual element is skipped,
 * which is always safe.
 */
async function loadDataUri(filePath, fallbackMime = 'image/png') {
  if (!filePath) return null;
  try {
    const buffer = await fs.readFile(filePath);
    const mimeType = filePath.endsWith('.png')
      ? 'image/png'
      : filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')
        ? 'image/jpeg'
        : fallbackMime;
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  } catch (err) {
    logger.warn({ err: err.message, filePath }, 'Could not load image for receipt, skipping it');
    return null;
  }
}

const KIKA_WORDMARK_PATH = path.join(__dirname, '..', '..', 'assets', 'brand', 'kika-logo.png');
// Cached once — this file never changes at runtime.
let kikaWordmarkDataUriPromise = null;
function getKikaWordmarkDataUri() {
  if (!kikaWordmarkDataUriPromise) {
    kikaWordmarkDataUriPromise = loadDataUri(KIKA_WORDMARK_PATH);
  }
  return kikaWordmarkDataUriPromise;
}

// --- Watermark (tier-gated brand mark behind the receipt body) ---------
//
// Free      -> Kika wordmark, tiled
// Standard  -> merchant business name, tiled
// Premium   -> merchant logo (if uploaded) + business name, tiled
//
// Rendered as a repeating, diagonally-slanted pattern (like a document
// watermark) rather than one big centered mark — it shows up in several
// places on the card, but at ~4-5% opacity and modest tile density so it
// reads as texture, not clutter. Drawn *behind* every other element on
// every tier, including Free, which otherwise gets no branding anywhere
// else on the card.
const WATERMARK_OPACITY = 0.045;
const WATERMARK_ROTATION_DEG = -28;
const WATERMARK_TILE_SIZE = 340;

function buildWatermarkSvg({ tier, businessName, merchantLogoDataUri, kikaWordmarkDataUri, height }) {
  const normalizedTier = String(tier || 'Free').toLowerCase();
  const tile = WATERMARK_TILE_SIZE;
  const cx = tile / 2;
  const cy = tile / 2;

  let tileContent;

  if (normalizedTier === 'premium') {
    const shortName = (businessName || 'Merchant').length > 22
      ? `${(businessName || 'Merchant').slice(0, 20)}\u2026`
      : businessName || 'Merchant';
    if (merchantLogoDataUri) {
      const logoW = 108;
      const logoH = 108;
      tileContent = `
      <image href="${merchantLogoDataUri}" x="${cx - logoW / 2}" y="${cy - logoH / 2 - 26}" width="${logoW}" height="${logoH}" preserveAspectRatio="xMidYMid meet" />
      <text x="${cx}" y="${cy + logoH / 2 + 6}" text-anchor="middle" font-family="${FONT_BRAND}" font-size="26" font-weight="800" fill="${THEME.ink}">${escapeXml(shortName)}</text>`;
    } else {
      tileContent = `<text x="${cx}" y="${cy}" text-anchor="middle" font-family="${FONT_BRAND}" font-size="30" font-weight="800" fill="${THEME.ink}">${escapeXml(shortName)}</text>`;
    }
  } else if (normalizedTier === 'standard') {
    const shortName = (businessName || 'Merchant').length > 22
      ? `${(businessName || 'Merchant').slice(0, 20)}\u2026`
      : businessName || 'Merchant';
    tileContent = `<text x="${cx}" y="${cy}" text-anchor="middle" font-family="${FONT_BRAND}" font-size="30" font-weight="800" fill="${THEME.ink}">${escapeXml(shortName)}</text>`;
  } else if (kikaWordmarkDataUri) {
    // Free tier (and safe default): Kika wordmark image.
    const wmW = 150;
    const wmH = wmW * (239 / 930);
    tileContent = `<image href="${kikaWordmarkDataUri}" x="${cx - wmW / 2}" y="${cy - wmH / 2}" width="${wmW}" height="${wmH}" preserveAspectRatio="xMidYMid meet" />`;
  } else {
    tileContent = `<text x="${cx}" y="${cy}" text-anchor="middle" font-family="${FONT_BRAND}" font-size="34" font-weight="800" fill="${THEME.ink}">Kika</text>`;
  }

  return `
  <defs>
    <pattern id="kikaWatermark" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse" patternTransform="rotate(${WATERMARK_ROTATION_DEG})">
      ${tileContent}
    </pattern>
  </defs>
  <rect x="0" y="0" width="${CARD_WIDTH}" height="${height}" fill="url(#kikaWatermark)" opacity="${WATERMARK_OPACITY}" />`;
}

/**
 * Builds the receipt SVG. Height is computed up-front from the actual
 * content (business-name wrapping, item-row wrapping, item count) so
 * the card never crops or overlaps text — it grows instead, with a
 * floor of MIN_HEIGHT (1350) matching the 1080x1350 template.
 */
function buildReceiptSvg({
  businessName,
  entryTypeLabel,
  counterpartyName,
  reference,
  timestampLabel,
  items,
  totalLabel,
  paidLabel,
  outstandingLabel,
  logoDataUri,
  tier,
  kikaWordmarkDataUri,
}) {
  let y = 0;

  const HEADER_TOP_PAD = 80;
  y += HEADER_TOP_PAD;

  // Optional centered circular merchant logo above the business name
  // (only rendered when the merchant has uploaded one).
  let logoBadgeSvg = '';
  const LOGO_SIZE = 130;
  if (logoDataUri) {
    const logoY = y;
    logoBadgeSvg = `
  <clipPath id="logoClip"><circle cx="${CARD_WIDTH / 2}" cy="${logoY + LOGO_SIZE / 2}" r="${LOGO_SIZE / 2}" /></clipPath>
  <circle cx="${CARD_WIDTH / 2}" cy="${logoY + LOGO_SIZE / 2}" r="${LOGO_SIZE / 2 + 3}" fill="none" stroke="${THEME.hairline}" stroke-width="2" />
  <image href="${logoDataUri}" x="${CARD_WIDTH / 2 - LOGO_SIZE / 2}" y="${logoY}" width="${LOGO_SIZE}" height="${LOGO_SIZE}" clip-path="url(#logoClip)" preserveAspectRatio="xMidYMid slice" />`;
    y += LOGO_SIZE + 44;
  }

  // Business name — brand font, centered, wraps onto a second line for
  // long names.
  const BIZNAME_FONT_SIZE = 58;
  const BIZNAME_LINE_HEIGHT = 66;
  const bizNameLines = wrapText(businessName || 'Merchant', BIZNAME_FONT_SIZE, CONTENT_WIDTH, {
    monospace: false,
    maxLines: 2,
  });
  const bizNameSvg = bizNameLines
    .map((line, i) => {
      const ly = y + BIZNAME_FONT_SIZE + i * BIZNAME_LINE_HEIGHT;
      return `<text x="${CARD_WIDTH / 2}" y="${ly}" text-anchor="middle" font-family="${FONT_BRAND}" font-size="${BIZNAME_FONT_SIZE}" font-weight="800" fill="${THEME.ink}">${escapeXml(line)}</text>`;
    })
    .join('');
  y += bizNameLines.length * BIZNAME_LINE_HEIGHT + 20;

  const dividerAfterHeaderY = y;
  y += 56;

  // Meta grid: DATE / LABEL then REF / CUSTOMER. Label and value sit on
  // the same line ("DATE: 18 Jul 2026, 03:53"); the value only drops to
  // a second line if it's too long to fit next to the label.
  const META_FONT_SIZE = 25;
  const META_LINE_HEIGHT = 34;
  const metaColGap = 40;
  const metaColWidth = (CONTENT_WIDTH - metaColGap) / 2;
  const metaLeftX = MARGIN_X;
  const metaRightX = MARGIN_X + metaColWidth + metaColGap;

  function metaCell(label, value, x) {
    const labelText = `${label}: `;
    const labelWidth = estimateTextWidth(labelText, META_FONT_SIZE, { monospace: true });
    const firstLineWidth = Math.max(60, metaColWidth - labelWidth);
    const safeValue = value || '\u2014';

    // Try the whole value on one line first (after the label); only
    // fall back to wrapping across the full column width if it
    // genuinely doesn't fit next to the label.
    let valueLines;
    if (estimateTextWidth(safeValue, META_FONT_SIZE, { monospace: true }) <= firstLineWidth) {
      valueLines = [safeValue];
    } else {
      const wrapped = wrapText(safeValue, META_FONT_SIZE, firstLineWidth, { monospace: true, maxLines: 1 });
      const restWrapped = wrapText(safeValue, META_FONT_SIZE, metaColWidth, { monospace: true, maxLines: 2 });
      // First line must respect the narrower "next to label" width;
      // remaining lines can use the full column width.
      valueLines = [wrapped[0], ...restWrapped.slice(1)].filter(Boolean);
      if (valueLines.length > 2) valueLines = valueLines.slice(0, 2);
    }

    return { label: labelText, valueLines, x };
  }

  const row1 = [metaCell('DATE', timestampLabel, metaLeftX), metaCell('LABEL', entryTypeLabel, metaRightX)];
  const row2 = [
    metaCell('REF', reference, metaLeftX),
    metaCell('CUSTOMER', counterpartyName, metaRightX),
  ];

  function renderMetaRow(cells, rowTopY) {
    const baselineY = rowTopY + META_FONT_SIZE;
    let svg = '';
    let maxLines = 1;
    for (const cell of cells) {
      const labelWidth = estimateTextWidth(cell.label, META_FONT_SIZE, { monospace: true });
      svg += `<text x="${cell.x}" y="${baselineY}" font-family="${FONT_BODY}" font-size="${META_FONT_SIZE}" font-weight="600" fill="${THEME.inkMuted}">${escapeXml(cell.label)}</text>`;
      // First value line sits right after the label, same baseline.
      svg += `<text x="${cell.x + labelWidth}" y="${baselineY}" font-family="${FONT_BODY}" font-size="${META_FONT_SIZE}" font-weight="500" fill="${THEME.ink}">${escapeXml(cell.valueLines[0])}</text>`;
      // Any overflow lines wrap below, left-aligned to the cell.
      cell.valueLines.slice(1).forEach((line, i) => {
        const vY = baselineY + (i + 1) * META_LINE_HEIGHT;
        svg += `<text x="${cell.x}" y="${vY}" font-family="${FONT_BODY}" font-size="${META_FONT_SIZE}" font-weight="500" fill="${THEME.ink}">${escapeXml(line)}</text>`;
      });
      maxLines = Math.max(maxLines, cell.valueLines.length);
    }
    const rowHeight = (maxLines - 1) * META_LINE_HEIGHT + META_LINE_HEIGHT + 16;
    return { svg, rowHeight };
  }

  const metaRow1 = renderMetaRow(row1, y);
  y += metaRow1.rowHeight;
  const metaRow2 = renderMetaRow(row2, y);
  y += metaRow2.rowHeight;

  const dividerAfterMetaY = y + 10;
  y = dividerAfterMetaY + 56;

  // Items — one block per item: name (wraps to a second line if long)
  // on the left, price right-aligned to the first name line's baseline.
  const ITEM_NAME_SIZE = 30;
  const ITEM_BLOCK_GAP = 30;
  const ITEM_PRICE_COL_WIDTH = 240;
  const itemNameMaxWidth = CONTENT_WIDTH - ITEM_PRICE_COL_WIDTH;

  const itemBlocks = (items || []).map((item) => {
    const label = formatItemLabel(item);
    const nameLines = wrapText(label, ITEM_NAME_SIZE, itemNameMaxWidth, { monospace: true, maxLines: 2 });
    const priceLabel = item.priceLabel || '';
    return { nameLines, priceLabel };
  });

  let itemsSvg = '';
  for (const block of itemBlocks) {
    const firstBaselineY = y + ITEM_NAME_SIZE;
    block.nameLines.forEach((line, i) => {
      const ly = firstBaselineY + i * (ITEM_NAME_SIZE + 6);
      itemsSvg += `<text x="${MARGIN_X}" y="${ly}" font-family="${FONT_BODY}" font-size="${ITEM_NAME_SIZE}" font-weight="500" fill="${THEME.ink}">${escapeXml(line)}</text>`;
    });
    if (block.priceLabel) {
      itemsSvg += `<text x="${CARD_WIDTH - MARGIN_X}" y="${firstBaselineY}" text-anchor="end" font-family="${FONT_BODY}" font-weight="600" fill="${THEME.ink}">${amountMarkup(block.priceLabel, { fontSize: ITEM_NAME_SIZE, weight: 600 })}</text>`;
    }
    y += block.nameLines.length * (ITEM_NAME_SIZE + 6) + ITEM_BLOCK_GAP;
  }

  const itemsEndY = y - (itemBlocks.length > 0 ? ITEM_BLOCK_GAP : 0);

  // --- Bottom block (divider + Total/Paid/Outstanding + footer) --------
  // This block is anchored to the BOTTOM of the card, not stacked
  // directly under the items — so Total always reads as the final,
  // grounded word on the receipt, whether there's one item or twelve.
  // Any leftover vertical space becomes whitespace between the items
  // and the divider that precedes Total, instead of a gap after it.
  const SUMMARY_LABEL_SIZE = 30;
  const SUMMARY_VALUE_SIZE = 32;
  const SUMMARY_ROW_HEIGHT = 52;
  const GAP_BEFORE_TOTAL_DIVIDER_MIN = 56;
  const GAP_AFTER_TOTAL_DIVIDER = 46;
  const GAP_BEFORE_FOOTER_DIVIDER = 60;
  const GAP_AFTER_FOOTER_DIVIDER = 42;
  const BOTTOM_PAD = 60;

  const summaryRows = [
    { label: 'TOTAL', value: totalLabel, color: THEME.total, weight: 700 },
    { label: 'PAID', value: paidLabel, color: THEME.paid, weight: 700 },
  ];
  if (outstandingLabel != null) {
    summaryRows.push({ label: 'OUTSTANDING', value: outstandingLabel, color: THEME.outstanding, weight: 700 });
  }

  // Fixed-size chunk from "divider before Total" down to the bottom
  // padding — its size depends only on the row count (2 or 3), never
  // on how much content came before it.
  const bottomBlockHeight =
    GAP_AFTER_TOTAL_DIVIDER +
    summaryRows.length * SUMMARY_ROW_HEIGHT +
    GAP_BEFORE_FOOTER_DIVIDER +
    GAP_AFTER_FOOTER_DIVIDER +
    BOTTOM_PAD;

  const naturalHeight = itemsEndY + GAP_BEFORE_TOTAL_DIVIDER_MIN + bottomBlockHeight;
  const height = Math.max(MIN_HEIGHT, naturalHeight);

  // Divider-before-Total sits wherever it needs to for the bottom block
  // to end exactly at the card's bottom padding — pinning Total/Paid/
  // Outstanding and the footer to the bottom regardless of item count.
  const dividerBeforeTotalY = height - bottomBlockHeight;

  let summarySvg = '';
  let sy = dividerBeforeTotalY + GAP_AFTER_TOTAL_DIVIDER;
  for (const row of summaryRows) {
    const rowY = sy + SUMMARY_LABEL_SIZE - 8;
    summarySvg += `<text x="${MARGIN_X}" y="${rowY}" font-family="${FONT_BODY}" font-size="${SUMMARY_LABEL_SIZE}" font-weight="${row.weight}" fill="${row.color}">${escapeXml(row.label)}</text>`;
    summarySvg += `<text x="${CARD_WIDTH - MARGIN_X}" y="${rowY}" text-anchor="end" fill="${row.color}">${amountMarkup(row.value, { fontSize: SUMMARY_VALUE_SIZE, weight: row.weight })}</text>`;
    sy += SUMMARY_ROW_HEIGHT;
  }

  const footerDividerY = sy + GAP_BEFORE_FOOTER_DIVIDER - SUMMARY_ROW_HEIGHT + SUMMARY_LABEL_SIZE;
  const footerTextY = footerDividerY + GAP_AFTER_FOOTER_DIVIDER;

  const watermarkSvg = buildWatermarkSvg({
    tier,
    businessName,
    merchantLogoDataUri: logoDataUri,
    kikaWordmarkDataUri,
    height,
  });

  const dashedLine = (lineY) =>
    `<line x1="${MARGIN_X}" y1="${lineY}" x2="${CARD_WIDTH - MARGIN_X}" y2="${lineY}" stroke="${THEME.hairline}" stroke-width="2" stroke-dasharray="10,8" />`;

  return `
<svg width="${CARD_WIDTH}" height="${height}" viewBox="0 0 ${CARD_WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${CARD_WIDTH}" height="${height}" fill="${THEME.background}" />

  ${watermarkSvg}

  ${logoBadgeSvg}
  ${bizNameSvg}

  ${dashedLine(dividerAfterHeaderY)}
  ${metaRow1.svg}
  ${metaRow2.svg}
  ${dashedLine(dividerAfterMetaY)}

  ${itemsSvg}
  ${dashedLine(dividerBeforeTotalY)}

  ${summarySvg}

  ${dashedLine(footerDividerY)}
  <text x="${CARD_WIDTH / 2}" y="${footerTextY}" text-anchor="middle" font-family="${FONT_BODY}" font-size="22" font-weight="500" fill="${THEME.footer}">Powered by Kika AI</text>
</svg>`.trim();
}

// --- Font self-test ------------------------------------------------------
//
// The single most common way receipts break in production is silent:
// fontconfig/the bundled fonts aren't actually reachable (see the long
// comment near the top of this file), sharp/librsvg renders without
// error, and the output is a technically-valid PNG that's just...
// blank except for vector lines. Nothing throws, nothing shows up as a
// 500, so it can go unnoticed for a while. This renders one throwaway
// glyph and checks whether any ink actually landed, logging a loud,
// specific warning if not — so this is a line in the logs on day one,
// not a support ticket three weeks later. Runs once (result cached) the
// first time a receipt is generated, and never blocks/fails the actual
// receipt render even if the self-test itself errors.
let fontSelfTestPromise = null;
function verifyFontsRenderable() {
  if (fontSelfTestPromise) return fontSelfTestPromise;
  fontSelfTestPromise = (async () => {
    try {
      const probeSvg = `<svg width="120" height="60" xmlns="http://www.w3.org/2000/svg"><rect width="120" height="60" fill="#fff"/><text x="10" y="40" font-family="${FONT_BODY}" font-size="36" fill="#000">Aa1</text></svg>`;
      const { data, info } = await sharp(Buffer.from(probeSvg)).raw().toBuffer({ resolveWithObject: true });
      let inkPixels = 0;
      for (let i = 0; i < data.length; i += info.channels) {
        if (data[i] < 200) inkPixels++; // anything meaningfully darker than the white background
      }
      if (inkPixels < 20) {
        logger.error(
          {
            FONTCONFIG_FILE: process.env.FONTCONFIG_FILE,
            FONTCONFIG_PATH: process.env.FONTCONFIG_PATH,
            fontsDir: FONTS_DIR,
            fontsDirExists: fssync.existsSync(FONTS_DIR),
          },
          'RECEIPT FONT SELF-TEST FAILED: no glyph ink detected when rendering test text. ' +
            'Receipts will render as blank cards (vector lines only, no text). ' +
            'Most likely cause: the "assets" folder was not copied into this deployment image, ' +
            'or the "fontconfig" OS package is not installed. See Dockerfile / Dockerfile.worker ' +
            'for the required "COPY assets" step and "apt-get install fontconfig".'
        );
      } else {
        logger.info({ inkPixels }, 'Receipt font self-test passed');
      }
    } catch (err) {
      logger.error({ err: err.message }, 'Receipt font self-test itself failed to run (non-fatal, continuing)');
    }
  })();
  return fontSelfTestPromise;
}

/**
 * Resolves the display items (name/quantity/unit + priceLabel) for ONE
 * ledger entry — extracted out of generateReceipt so a combined,
 * multi-entry receipt (see below) can apply the exact same per-entry
 * logic to each entry in a batch before merging them into one item list.
 */
function resolveDisplayItemsForEntry(ledgerEntry) {
  // Both the AI parser and the regex fallback are now responsible for
  // always populating a clean, receipt-safe item name (see
  // aiTransactionParser.js's RECORD_TRANSACTION_TOOL and
  // ledgerParser.js's extractBareItemName) — a receipt must only ever
  // show items/units/amounts, never the merchant's raw message text or
  // an AI-written description sentence. So this simply trusts
  // ledgerEntry.items completely; the only case with legitimately zero
  // items is DEBT_SETTLEMENT (a payment against an existing debt isn't
  // an "item" being sold). If items is somehow still empty for any
  // other entry type — a bug upstream, not the normal case — "Item" is
  // a safe, generic last resort that is still never raw merchant text.
  const structuredItems = ledgerEntry.items || [];
  if (structuredItems.length > 0) {
    return structuredItems.map((it) => ({
      ...it,
      priceLabel:
        it.total_kobo != null
          ? formatNaira(it.total_kobo)
          : it.unit_price_kobo != null && it.quantity != null
            ? formatNaira(Number(it.unit_price_kobo) * Number(it.quantity))
            : formatNaira(ledgerEntry.total_kobo),
    }));
  }
  if (ledgerEntry.entry_type !== 'DEBT_SETTLEMENT') {
    return [{ name: 'Item', priceLabel: formatNaira(ledgerEntry.total_kobo) }];
  }
  return [];
}

/**
 * Renders a receipt PNG and returns a safe, unguessable, expiring URL
 * suitable for handing straight to the WhatsApp message broker as a
 * media attachment.
 *
 * Pass EITHER `ledgerEntry` (a single entry — the original, still most
 * common case) OR `ledgerEntries` (an array — used by worker.js's
 * DONE-triggered receipt-confirmation flow when a merchant logged
 * several things before asking for one receipt covering all of them).
 * A multi-entry receipt merges every entry's own display items into one
 * list and sums their totals/paid/outstanding — it reads as one
 * consolidated card, not several stapled together.
 */
async function generateReceipt({ merchant, ledgerEntry, ledgerEntries }) {
  // Fire-and-forget: don't make every single receipt wait on this, but
  // do make sure it's running so the warning above shows up promptly.
  verifyFontsRenderable();

  const entries = ledgerEntries && ledgerEntries.length > 0 ? ledgerEntries : [ledgerEntry];
  const isCombined = entries.length > 1;
  const primaryEntry = entries[0];

  const storageDir = process.env.RECEIPT_STORAGE_DIR || path.join(process.cwd(), 'public', 'receipts');
  await fs.mkdir(storageDir, { recursive: true });

  const logoDataUri = await loadDataUri(merchant.logo_file_path);
  const kikaWordmarkDataUri = await getKikaWordmarkDataUri();

  const items = entries.flatMap((e) => resolveDisplayItemsForEntry(e));

  const totalKobo = entries.reduce((sum, e) => sum + Number(e.total_kobo), 0);
  const paidKobo = entries.reduce((sum, e) => sum + Number(e.paid_kobo), 0);

  // For a single entry, prefer the customer's rolling debt balance
  // (balance_after_kobo, computed under row lock — the correct figure
  // when they have multiple open debts) over this one entry's own
  // leftover balance_kobo. A combined receipt has no single rolling
  // figure to point to, so it sums each entry's own balance instead —
  // still an accurate "how much is left outstanding from this batch".
  const outstandingKobo = isCombined
    ? entries.reduce((sum, e) => sum + Number(e.balance_kobo), 0) || null
    : (() => {
        const rollingKobo = primaryEntry.balance_after_kobo != null ? Number(primaryEntry.balance_after_kobo) : null;
        const shownKobo = rollingKobo != null ? rollingKobo : Number(primaryEntry.balance_kobo);
        return shownKobo > 0 ? shownKobo : null;
      })();

  const allSameType = entries.every((e) => e.entry_type === primaryEntry.entry_type);
  const allSameCounterparty = entries.every((e) => e.counterparty_name === primaryEntry.counterparty_name);
  const entryTypeLabel = isCombined
    ? allSameType
      ? ENTRY_TYPE_LABELS[primaryEntry.entry_type] || 'Transaction'
      : 'Transaction Summary'
    : ENTRY_TYPE_LABELS[primaryEntry.entry_type] || 'Transaction';

  const latestCreatedAt = entries.reduce(
    (latest, e) => (new Date(e.created_at) > latest ? new Date(e.created_at) : latest),
    new Date(primaryEntry.created_at)
  );

  const svg = buildReceiptSvg({
    businessName: merchant.business_name || merchant.whatsapp_display_name || merchant.display_name,
    entryTypeLabel,
    counterpartyName: allSameCounterparty ? primaryEntry.counterparty_name : null,
    reference: primaryEntry.id.slice(0, 8).toUpperCase(),
    timestampLabel: latestCreatedAt.toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }),
    items,
    totalLabel: formatNaira(totalKobo),
    paidLabel: formatNaira(paidKobo),
    outstandingLabel: outstandingKobo != null ? formatNaira(outstandingKobo) : null,
    logoDataUri,
    tier: merchant.plan,
    kikaWordmarkDataUri,
  });

  const publicToken = crypto.randomBytes(24).toString('hex');
  const fileName = `${uuidv4()}.png`;
  const filePath = path.join(storageDir, fileName);

  // No density override: the SVG's width/height attributes are already
  // in the exact target pixels (1080 x >=1350), so rasterizing at the
  // default 72dpi maps 1 SVG unit -> 1 output pixel, keeping dimensions
  // exact.
  await sharp(Buffer.from(svg)).png({ quality: 92 }).toFile(filePath);

  const ttlHours = Number(process.env.RECEIPT_URL_TTL_HOURS || 72);
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);

  const receiptRecord = await queries.createReceiptRecord({
    merchantId: merchant.id,
    ledgerEntryId: primaryEntry.id, // for a combined receipt, the anchor entry — worker.js separately links ALL batch entries' receipt_id to this record
    filePath,
    publicToken,
    expiresAt,
  });

  await queries.attachReceiptToLedgerEntry(primaryEntry.id, receiptRecord.id);

  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const safeUrl = `${baseUrl}/api/v1/receipts/${publicToken}.png`;

  logger.info({ merchantId: merchant.id, receiptId: receiptRecord.id, entryCount: entries.length }, 'Receipt generated');

  return { url: safeUrl, receiptId: receiptRecord.id, expiresAt };
}

/**
 * Builds the invoice card SVG — a distinct layout from buildReceiptSvg
 * above, matching a reference invoice template: left-aligned masthead
 * (INVOICE + number, with the merchant's logo badge top-right on
 * Standard/Premium), a three-column Issued/Due, Billed to, From block,
 * an itemized table with real Qty/Rate/Line-total columns, then a
 * right-aligned Subtotal/Tax/Total/Amount-due stack with the amount
 * actually owed picked out in the accent color.
 *
 * "Billed to" intentionally shows only the customer's name and phone
 * (if one was given) — never an address, which Kika never collects for
 * a customer. "From" always shows the merchant's business name and
 * WhatsApp number, address included nowhere either — consistent with
 * the rest of the product never asking a merchant for a street address.
 */
function buildInvoiceSvg({
  businessName,
  businessPhone,
  invoiceNumber,
  issuedAt,
  dueAt,
  customerName,
  customerPhone,
  logoDataUri,
  tier,
  items,
  subtotalLabel,
  taxLabel,
  totalLabel,
}) {
  const T = INVOICE_THEME;
  let y = 90;

  // --- Masthead: "INVOICE" + number, logo badge top-right -------------
  const TITLE_SIZE = 56;
  const titleY = y + TITLE_SIZE;
  const NUMBER_SIZE = 26;
  const numberY = titleY + NUMBER_SIZE + 14;

  // Per product decision, the logo badge only appears for Standard/
  // Premium merchants who've actually uploaded one — Free tier gets no
  // substitute mark here (the card's branding lives entirely in the
  // "Powered by Kika" footer line instead).
  const showLogoBadge = ['standard', 'premium'].includes(String(tier || '').toLowerCase()) && !!logoDataUri;
  const LOGO_BADGE_SIZE = 96;
  let logoBadgeSvg = '';
  if (showLogoBadge) {
    const badgeX = CARD_WIDTH - MARGIN_X - LOGO_BADGE_SIZE;
    const badgeY = y;
    logoBadgeSvg = `
  <clipPath id="invLogoClip"><rect x="${badgeX}" y="${badgeY}" width="${LOGO_BADGE_SIZE}" height="${LOGO_BADGE_SIZE}" rx="16" /></clipPath>
  <image href="${logoDataUri}" x="${badgeX}" y="${badgeY}" width="${LOGO_BADGE_SIZE}" height="${LOGO_BADGE_SIZE}" clip-path="url(#invLogoClip)" preserveAspectRatio="xMidYMid slice" />`;
  }

  const mastheadSvg = `
  <text x="${MARGIN_X}" y="${titleY}" font-family="${FONT_BRAND}" font-size="${TITLE_SIZE}" font-weight="800" fill="${T.ink}">INVOICE</text>
  <text x="${MARGIN_X}" y="${numberY}" font-family="${FONT_BODY}" font-size="${NUMBER_SIZE}" font-weight="500" fill="${T.inkMuted}">#${escapeXml(invoiceNumber)}</text>
  ${logoBadgeSvg}`;

  y = Math.max(numberY, y + LOGO_BADGE_SIZE) + 50;
  const dividerAfterMastheadY = y;
  y += 56;

  // --- Three-column meta: Issued/Due | Billed to | From ----------------
  const COL_GAP = 40;
  const colWidth = (CONTENT_WIDTH - COL_GAP * 2) / 3;
  const col1X = MARGIN_X;
  const col2X = MARGIN_X + colWidth + COL_GAP;
  const col3X = MARGIN_X + (colWidth + COL_GAP) * 2;

  const META_LABEL_SIZE = 22;
  const META_VALUE_SIZE = 27;
  const META_LINE_GAP = 8;
  const META_GROUP_GAP = 34;

  // A "group" is one label + its value line(s) — Issued/Due are two
  // small groups stacked in column 1; Billed to/From are each one
  // group (name, then an optional second line) in columns 2 and 3.
  function metaGroup(label, lines) {
    const safeLines = (lines || []).filter(Boolean);
    return { label, lines: safeLines.length ? safeLines : ['\u2014'] };
  }

  function renderMetaGroups(groups, x, colW) {
    let gy = y;
    let svg = '';
    for (const group of groups) {
      svg += `<text x="${x}" y="${gy + META_LABEL_SIZE}" font-family="${FONT_BODY}" font-size="${META_LABEL_SIZE}" font-weight="700" fill="${T.ink}">${escapeXml(group.label)}</text>`;
      let ly = gy + META_LABEL_SIZE + META_VALUE_SIZE + META_LINE_GAP;
      for (const line of group.lines) {
        const wrapped = wrapText(line, META_VALUE_SIZE, colW, { monospace: true, maxLines: 1 });
        svg += `<text x="${x}" y="${ly}" font-family="${FONT_BODY}" font-size="${META_VALUE_SIZE}" font-weight="500" fill="${T.inkMuted}">${escapeXml(wrapped[0])}</text>`;
        ly += META_VALUE_SIZE + META_LINE_GAP;
      }
      gy = ly + META_GROUP_GAP - META_LINE_GAP;
    }
    return { svg, height: gy - y - META_GROUP_GAP + META_LINE_GAP };
  }

  const col1Groups = [metaGroup('ISSUED', [issuedAt]), metaGroup('DUE', [dueAt])];
  // "Billed to" — name only, then phone on its own line if given. No
  // address line ever, by design (see function doc comment above).
  const col2Groups = [metaGroup('BILLED TO', [customerName, customerPhone].filter(Boolean))];
  // "From" — business name, then the merchant's own WhatsApp number,
  // always (not conditional on it being "given", since every merchant
  // has one by definition).
  const col3Groups = [metaGroup('FROM', [businessName, businessPhone].filter(Boolean))];

  const r1 = renderMetaGroups(col1Groups, col1X, colWidth);
  const r2 = renderMetaGroups(col2Groups, col2X, colWidth);
  const r3 = renderMetaGroups(col3Groups, col3X, colWidth);
  const metaSvg = r1.svg + r2.svg + r3.svg;
  y += Math.max(r1.height, r2.height, r3.height);

  const dividerAfterMetaY = y + 10;
  y = dividerAfterMetaY + 54;

  // --- Item table --------------------------------------------------------
  // Column right-edges (Qty/Rate/Line total are right-aligned within
  // their own column, matching the reference); Service name + its
  // description line occupy the remaining left-hand space.
  const totalColRightX = CARD_WIDTH - MARGIN_X;
  const rateColRightX = totalColRightX - 190;
  const qtyColRightX = rateColRightX - 170;
  const serviceMaxWidth = qtyColRightX - 90 - MARGIN_X;

  const HEADER_SIZE = 22;
  const headerY = y + HEADER_SIZE;
  const headerSvg = `
  <text x="${MARGIN_X}" y="${headerY}" font-family="${FONT_BODY}" font-size="${HEADER_SIZE}" font-weight="700" fill="${T.inkMuted}">SERVICE</text>
  <text x="${qtyColRightX}" y="${headerY}" text-anchor="end" font-family="${FONT_BODY}" font-size="${HEADER_SIZE}" font-weight="700" fill="${T.inkMuted}">QTY</text>
  <text x="${rateColRightX}" y="${headerY}" text-anchor="end" font-family="${FONT_BODY}" font-size="${HEADER_SIZE}" font-weight="700" fill="${T.inkMuted}">RATE</text>
  <text x="${totalColRightX}" y="${headerY}" text-anchor="end" font-family="${FONT_BODY}" font-size="${HEADER_SIZE}" font-weight="700" fill="${T.inkMuted}">LINE TOTAL</text>`;
  y = headerY + 20;
  const dividerAfterHeaderY = y;
  y += 40;

  const ITEM_NAME_SIZE = 28;
  const ITEM_DESC_SIZE = 22;
  const ITEM_ROW_GAP = 34;

  let itemsSvg = '';
  for (const item of items) {
    const nameLines = wrapText(titleCaseFirst(item.name || 'Item'), ITEM_NAME_SIZE, serviceMaxWidth, { monospace: true, maxLines: 2 });
    const nameBaselineY = y + ITEM_NAME_SIZE;
    nameLines.forEach((line, i) => {
      const ly = nameBaselineY + i * (ITEM_NAME_SIZE + 6);
      itemsSvg += `<text x="${MARGIN_X}" y="${ly}" font-family="${FONT_BODY}" font-size="${ITEM_NAME_SIZE}" font-weight="600" fill="${T.ink}">${escapeXml(line)}</text>`;
    });
    let rowBottomY = nameBaselineY + (nameLines.length - 1) * (ITEM_NAME_SIZE + 6);

    if (item.descriptionLabel) {
      const descY = rowBottomY + ITEM_DESC_SIZE + 8;
      itemsSvg += `<text x="${MARGIN_X}" y="${descY}" font-family="${FONT_BODY}" font-size="${ITEM_DESC_SIZE}" font-weight="400" fill="${T.inkMuted}">${escapeXml(item.descriptionLabel)}</text>`;
      rowBottomY = descY;
    }

    // Qty/Rate/Line total sit on the item name's first baseline,
    // matching the reference (they don't shift down for a wrapped name
    // or a description line below).
    if (item.qtyLabel != null) {
      itemsSvg += `<text x="${qtyColRightX}" y="${nameBaselineY}" text-anchor="end" font-family="${FONT_BODY}" font-size="${ITEM_NAME_SIZE}" font-weight="500" fill="${T.inkMuted}">${escapeXml(item.qtyLabel)}</text>`;
    }
    if (item.rateLabel) {
      itemsSvg += `<text x="${rateColRightX}" y="${nameBaselineY}" text-anchor="end" fill="${T.inkMuted}">${amountMarkup(item.rateLabel, { fontSize: ITEM_NAME_SIZE, weight: 500 })}</text>`;
    }
    itemsSvg += `<text x="${totalColRightX}" y="${nameBaselineY}" text-anchor="end" fill="${T.ink}">${amountMarkup(item.lineTotalLabel, { fontSize: ITEM_NAME_SIZE, weight: 600 })}</text>`;

    y = rowBottomY + ITEM_ROW_GAP;
  }
  const itemsEndY = y - ITEM_ROW_GAP;

  // --- Totals block (right-aligned) + footer, anchored to the bottom ---
  const TOTALS_LABEL_SIZE = 27;
  const TOTALS_ROW_HEIGHT = 46;
  const totalsBlockX = MARGIN_X + CONTENT_WIDTH * 0.5;
  const GAP_BEFORE_TOTALS_MIN = 40;
  const GAP_ABOVE_TOTAL_DIVIDER = 22;
  const GAP_ABOVE_DUE_DIVIDER = 26;
  const GAP_AFTER_TOTALS = 60;
  const FOOTER_NOTE_SIZE = 24;
  const FOOTER_SUBNOTE_SIZE = 21;
  const FOOTER_LINE_HEIGHT = 34;
  const GAP_BEFORE_FOOTER_DIVIDER = 50;
  const GAP_AFTER_FOOTER_DIVIDER = 44;
  const BOTTOM_PAD = 60;

  const totalsRowsHeight = 2 * TOTALS_ROW_HEIGHT + GAP_ABOVE_TOTAL_DIVIDER + TOTALS_ROW_HEIGHT + GAP_ABOVE_DUE_DIVIDER + TOTALS_ROW_HEIGHT;
  const footerBlockHeight =
    FOOTER_LINE_HEIGHT + FOOTER_LINE_HEIGHT + GAP_BEFORE_FOOTER_DIVIDER + GAP_AFTER_FOOTER_DIVIDER + FOOTER_LINE_HEIGHT + BOTTOM_PAD;
  const bottomBlockHeight = totalsRowsHeight + GAP_AFTER_TOTALS + footerBlockHeight;

  const naturalHeight = itemsEndY + GAP_BEFORE_TOTALS_MIN + bottomBlockHeight;
  const height = Math.max(MIN_HEIGHT, naturalHeight);

  let ty = height - bottomBlockHeight;

  function totalsRow(label, valueLabel, { weight = 500, color = T.inkMuted, valueSize = TOTALS_LABEL_SIZE } = {}) {
    const rowY = ty + TOTALS_LABEL_SIZE - 4;
    const svg =
      `<text x="${totalsBlockX}" y="${rowY}" font-family="${FONT_BODY}" font-size="${TOTALS_LABEL_SIZE}" font-weight="${weight}" fill="${color}">${escapeXml(label)}</text>` +
      `<text x="${CARD_WIDTH - MARGIN_X}" y="${rowY}" text-anchor="end" fill="${color}">${amountMarkup(valueLabel, { fontSize: valueSize, weight })}</text>`;
    ty += TOTALS_ROW_HEIGHT;
    return svg;
  }

  let totalsSvg = '';
  totalsSvg += totalsRow('Subtotal', subtotalLabel);
  totalsSvg += totalsRow('Tax (0%)', taxLabel);
  ty += GAP_ABOVE_TOTAL_DIVIDER - TOTALS_ROW_HEIGHT;
  const dividerAboveTotalY = ty;
  ty += TOTALS_ROW_HEIGHT - (GAP_ABOVE_TOTAL_DIVIDER - TOTALS_ROW_HEIGHT);
  totalsSvg += totalsRow('Total', totalLabel, { weight: 700, color: T.ink });
  ty += GAP_ABOVE_DUE_DIVIDER - TOTALS_ROW_HEIGHT;
  const dividerAboveDueY = ty;
  ty += TOTALS_ROW_HEIGHT - (GAP_ABOVE_DUE_DIVIDER - TOTALS_ROW_HEIGHT);
  totalsSvg += totalsRow('Amount due', totalLabel, { weight: 700, color: T.accent, valueSize: 30 });

  const footerTopY = ty + GAP_AFTER_TOTALS - TOTALS_ROW_HEIGHT;
  const thankYouY = footerTopY + FOOTER_NOTE_SIZE;
  const payNoteY = thankYouY + FOOTER_LINE_HEIGHT;
  const footerDividerY = payNoteY + GAP_BEFORE_FOOTER_DIVIDER - FOOTER_LINE_HEIGHT + FOOTER_SUBNOTE_SIZE - 10;
  const kikaFooterY = footerDividerY + GAP_AFTER_FOOTER_DIVIDER;

  const thinLine = (lineY, x1 = MARGIN_X, x2 = CARD_WIDTH - MARGIN_X, color = T.hairline, strokeWidth = 2) =>
    `<line x1="${x1}" y1="${lineY}" x2="${x2}" y2="${lineY}" stroke="${color}" stroke-width="${strokeWidth}" />`;

  return `
<svg width="${CARD_WIDTH}" height="${height}" viewBox="0 0 ${CARD_WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${CARD_WIDTH}" height="${height}" fill="${T.background}" />

  ${mastheadSvg}
  ${thinLine(dividerAfterMastheadY)}

  ${metaSvg}
  ${thinLine(dividerAfterMetaY)}

  ${headerSvg}
  ${thinLine(dividerAfterHeaderY)}
  ${itemsSvg}

  ${thinLine(dividerAboveTotalY, totalsBlockX, CARD_WIDTH - MARGIN_X)}
  ${thinLine(dividerAboveDueY, totalsBlockX, CARD_WIDTH - MARGIN_X, T.accent, 3)}
  ${totalsSvg}

  <text x="${MARGIN_X}" y="${thankYouY}" font-family="${FONT_BODY}" font-size="${FOOTER_NOTE_SIZE}" font-weight="700" fill="${T.ink}">Thank you for the business!</text>
  <text x="${MARGIN_X}" y="${payNoteY}" font-family="${FONT_BODY}" font-size="${FOOTER_SUBNOTE_SIZE}" font-weight="400" fill="${T.inkMuted}">Please arrange payment directly with your customer.</text>
  ${thinLine(footerDividerY)}
  <text x="${CARD_WIDTH / 2}" y="${kikaFooterY}" text-anchor="middle" font-family="${FONT_BODY}" font-size="22" font-weight="500" fill="${T.footer}">Powered by Kika</text>
</svg>`.trim();
}

/**
 * Renders an invoice card — its own visual template (see buildInvoiceSvg
 * above), distinct from the receipt card: an invoice represents money
 * NOT yet collected, billed to a named customer, with Qty/Rate/Line
 * total columns and a Subtotal/Tax/Total/Amount-due stack, rather than a
 * completed-transaction receipt.
 *
 * This card is handed to the MERCHANT, never sent directly to the
 * customer — see worker.js's invoice-flow handling. Kika does not create
 * a payment link for it; how the customer actually pays the merchant is
 * arranged directly between them (Paystack is reserved for merchant
 * subscription upgrades only). Stored in the same `receipts` table as
 * ordinary receipts (with a NULL ledger_entry_id, since an invoice
 * doesn't correspond to one) so it gets the same public-token URL scheme
 * and expiry sweep for free.
 */
async function generateInvoiceCard({ merchant, invoiceNumber, customerName, customerPhone, items, totalKobo, dueInDays = 14 }) {
  verifyFontsRenderable();

  const storageDir = process.env.RECEIPT_STORAGE_DIR || path.join(process.cwd(), 'public', 'receipts');
  await fs.mkdir(storageDir, { recursive: true });

  // Logo badge is a Standard/Premium perk (see buildInvoiceSvg — Free
  // tier shows no substitute mark here, unlike the receipt's watermark
  // which brands every tier). Loading it unconditionally is harmless;
  // buildInvoiceSvg itself gates on tier before ever using it.
  const logoDataUri = await loadDataUri(merchant.logo_file_path);

  const subtotalKobo = items.reduce((sum, it) => sum + Number(it.totalKobo), 0);

  const displayItems = items.map((it) => ({
    name: it.name,
    // "3 sacks @ ₦1,500/unit" — real per-unit context on its own line,
    // rather than folded into the item name — since Qty/Rate now have
    // their own dedicated columns (see buildInvoiceSvg).
    descriptionLabel:
      it.quantity != null && it.unitPriceKobo != null
        ? `${it.quantity}${it.unit ? ` ${it.unit}` : ''} @ ${formatNaira(it.unitPriceKobo)}/unit`
        : null,
    qtyLabel: it.quantity != null ? String(it.quantity) : '1',
    rateLabel: it.unitPriceKobo != null ? formatNaira(it.unitPriceKobo) : formatNaira(it.totalKobo),
    lineTotalLabel: formatNaira(it.totalKobo),
  }));

  const now = new Date();
  const dueDate = new Date(now.getTime() + dueInDays * 24 * 3600 * 1000);
  const dateFmt = { dateStyle: 'medium' };

  const svg = buildInvoiceSvg({
    businessName: merchant.business_name || merchant.whatsapp_display_name || merchant.display_name || 'Merchant',
    businessPhone: merchant.whatsapp_number,
    invoiceNumber: `${String(invoiceNumber).padStart(4, '0')}`,
    issuedAt: now.toLocaleDateString('en-NG', dateFmt),
    dueAt: dueDate.toLocaleDateString('en-NG', dateFmt),
    customerName,
    customerPhone,
    logoDataUri,
    tier: merchant.plan,
    items: displayItems,
    subtotalLabel: formatNaira(subtotalKobo),
    taxLabel: formatNaira(0),
    totalLabel: formatNaira(totalKobo),
  });

  const publicToken = crypto.randomBytes(24).toString('hex');
  const fileName = `${uuidv4()}.png`;
  const filePath = path.join(storageDir, fileName);
  await sharp(Buffer.from(svg)).png({ quality: 92 }).toFile(filePath);

  const ttlHours = Number(process.env.RECEIPT_URL_TTL_HOURS || 72);
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);

  const record = await queries.createReceiptRecord({
    merchantId: merchant.id,
    ledgerEntryId: null,
    filePath,
    publicToken,
    expiresAt,
  });

  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const safeUrl = `${baseUrl}/api/v1/receipts/${publicToken}.png`;

  logger.info({ merchantId: merchant.id, invoiceNumber }, 'Invoice card generated');

  return { url: safeUrl, receiptId: record.id, expiresAt };
}

module.exports = { generateReceipt, generateInvoiceCard, formatNaira };
