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
 * When there's no structured {name, quantity, unit} item (the common
 * case — see the comment in generateReceipt), the entry's own
 * `description` is used as the item line instead. For a regex-parsed
 * entry that description is the raw merchant message verbatim (e.g.
 * "sold rice 5000"), which reads oddly sitting next to its own price
 * ("sold rice 5000 — ₦5,000"). This strips the leading transaction verb
 * and the trailing amount (already shown in the price column) so it
 * reads as a normal item name ("Rice"). AI-parsed / invoice descriptions
 * are already clean prose ("Fuel purchase") and pass through unchanged
 * — the strips below are no-ops on text that doesn't match them.
 */
const DESCRIPTION_LEADING_VERB_RE =
  /^(sold|bought|buy|sell|selling|sale of|purchase of|paid for|spent on|gave|received)\s+/i;
const DESCRIPTION_TRAILING_AMOUNT_RE = /\s*(?:\u20a6|ngn)?\s*[\d][\d,.]*\s*(?:k|m)?\.?\s*$/i;

function cleanDescriptionForDisplay(description) {
  let text = String(description || '').trim();
  text = text.replace(DESCRIPTION_LEADING_VERB_RE, '');
  text = text.replace(DESCRIPTION_TRAILING_AMOUNT_RE, '');
  text = text.trim();
  if (!text) return 'Transaction';
  return text.charAt(0).toUpperCase() + text.slice(1);
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
    metaCell('CUSTOMER', counterpartyName || 'Walk-in customer', metaRightX),
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
 * Renders a receipt PNG for a ledger entry, stores it, and returns a
 * safe, unguessable, expiring URL suitable for handing straight to the
 * WhatsApp message broker as a media attachment.
 */
async function generateReceipt({ merchant, ledgerEntry }) {
  // Fire-and-forget: don't make every single receipt wait on this, but
  // do make sure it's running so the warning above shows up promptly.
  verifyFontsRenderable();

  const storageDir = process.env.RECEIPT_STORAGE_DIR || path.join(process.cwd(), 'public', 'receipts');
  await fs.mkdir(storageDir, { recursive: true });

  const logoDataUri = await loadDataUri(merchant.logo_file_path);
  const kikaWordmarkDataUri = await getKikaWordmarkDataUri();

  // The upstream parsers (regex and AI) only ever extract AT MOST one
  // structured {name, quantity, unit} item, and never a per-item price
  // (there's no concept of itemized pricing yet — the whole message is
  // one total). Two things follow from that:
  //   1. A lone structured item's price is that whole entry total —
  //      it's the only line, so it IS the total.
  //   2. Most real merchant messages have no quantity+unit at all
  //      ("sold rice 5000" — no "bags"/"cartons"/etc for the regex
  //      parser to latch onto), so ledgerEntry.items is simply [].
  //      Previously that meant the items section of the receipt just...
  //      didn't render anything, which reads as broken even though it
  //      was "working as designed" — the fix is to fall back to a
  //      single display line built from the entry's own description
  //      (already a merchant-readable summary like "Rice") priced at
  //      the entry total, so there's always a legible items section.
  // DEBT_SETTLEMENT entries are the one exception: "Payment from John"
  // isn't an item being sold, so no synthetic line is added for them —
  // the Total/Paid summary already says everything there is to say.
  const structuredItems = ledgerEntry.items || [];
  let items;
  if (structuredItems.length > 0) {
    items = structuredItems.map((it) => ({
      ...it,
      priceLabel:
        it.total_kobo != null
          ? formatNaira(it.total_kobo)
          : it.unit_price_kobo != null && it.quantity != null
            ? formatNaira(Number(it.unit_price_kobo) * Number(it.quantity))
            : formatNaira(ledgerEntry.total_kobo),
    }));
  } else if (ledgerEntry.entry_type !== 'DEBT_SETTLEMENT') {
    items = [
      {
        name: cleanDescriptionForDisplay(ledgerEntry.description),
        priceLabel: formatNaira(ledgerEntry.total_kobo),
      },
    ];
  } else {
    items = [];
  }

  const outstandingKobo = (() => {
    // Prefer the customer's rolling total (balance_after_kobo, computed
    // under an explicit row lock in queries.lockCustomerBalance) over
    // this single entry's own leftover balance_kobo — the rolling
    // figure is what's correct when a customer has multiple open debts.
    const rollingKobo = ledgerEntry.balance_after_kobo != null ? Number(ledgerEntry.balance_after_kobo) : null;
    const shownKobo = rollingKobo != null ? rollingKobo : Number(ledgerEntry.balance_kobo);
    return shownKobo > 0 ? shownKobo : null;
  })();

  const svg = buildReceiptSvg({
    businessName: merchant.business_name || merchant.whatsapp_display_name || merchant.display_name,
    entryTypeLabel: ENTRY_TYPE_LABELS[ledgerEntry.entry_type] || 'Transaction',
    counterpartyName: ledgerEntry.counterparty_name,
    reference: ledgerEntry.id.slice(0, 8).toUpperCase(),
    timestampLabel: new Date(ledgerEntry.created_at).toLocaleString('en-NG', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
    items,
    totalLabel: formatNaira(ledgerEntry.total_kobo),
    paidLabel: formatNaira(ledgerEntry.paid_kobo),
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
