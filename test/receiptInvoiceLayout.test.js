'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// receiptService.js talks to the database via db/queries and reads real
// font files off disk — neither is available/desired in a unit test —
// and rasterizes its generated SVG via `sharp`. Rather than mock
// receiptService's internals (which would test a rewritten version of
// the code instead of the real thing), this stubs db/queries and
// intercepts sharp's input at the module-require level, BEFORE
// receiptService is ever required: a module's own `const sharp =
// require('sharp')` binds to whatever require.cache holds at THAT
// moment, so swapping the cache entry any later has no effect on an
// already-loaded module's already-resolved binding.
let receiptService;
const capture = { svg: null };

before(() => {
  const originalRequire = Module.prototype.require;
  const sharpPath = require.resolve('sharp');
  const realSharp = require(sharpPath);

  function capturingSharp(input, ...rest) {
    if (Buffer.isBuffer(input)) capture.svg = input.toString('utf8');
    return realSharp(input, ...rest);
  }
  Object.assign(capturingSharp, realSharp);
  require.cache[sharpPath] = { id: sharpPath, filename: sharpPath, loaded: true, exports: capturingSharp };

  Module.prototype.require = function (id) {
    if (id.endsWith('db/queries')) {
      return { createReceiptRecord: async () => ({ id: 'test-receipt' }) };
    }
    return originalRequire.apply(this, arguments);
  };

  process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://example.com';
  process.env.RECEIPT_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kika-receipt-test-'));

  receiptService = require('../src/services/receiptService');

  Module.prototype.require = originalRequire; // db/queries stub only needed for the load above
});

const merchant = {
  id: 'm-test',
  business_name: 'Sam Sam Ltd',
  whatsapp_number: '+2349029170826',
  plan: 'FREE',
  logo_file_path: null,
  default_currency: 'NGN',
};

/** Every right-anchored <text> element's x coordinate, in document order. */
function extractRightAnchoredXs(svg) {
  const xs = [];
  const re = /<text x="([0-9.]+)"[^>]*text-anchor="end"/g;
  let m;
  while ((m = re.exec(svg)) !== null) xs.push(parseFloat(m[1]));
  return xs;
}

describe('invoice column spacing (regression: columns must never collide)', () => {
  test('a large invoice (40 units, wide rate and total) keeps clear gaps between QTY/RATE/LINE TOTAL', async () => {
    // This exact shape (large quantity, $5,000/unit rate, $200,000
    // total) is what surfaced the original bug — a fixed 190px gap
    // between the Rate and Line Total columns was sized for "typical"
    // amounts and left only ~5px of real clearance once the actual
    // glyphs were this wide, causing the two values to visually run
    // into each other.
    const items = [{ name: 'Sockets', unit: null, quantity: 40, unitPriceKobo: 500000, totalKobo: 20000000, currency: 'USD' }];

    capture.svg = null;
    await receiptService.generateInvoiceCard({
      merchant,
      invoiceNumber: 7,
      customerName: 'OBI',
      customerPhone: '+2347012345678',
      items,
      totalKobo: 20000000,
    });

    assert.ok(capture.svg, 'expected the SVG passed to sharp to have been captured');

    const anchors = extractRightAnchoredXs(capture.svg);
    const uniqueAnchors = [...new Set(anchors)].sort((a, b) => a - b);
    assert.equal(uniqueAnchors.length, 3, `expected exactly 3 distinct column anchors, got: ${uniqueAnchors}`);
    const [qtyX, rateX, totalX] = uniqueAnchors;

    // Checking raw anchor-to-anchor distance alone would NOT have caught
    // the original bug (the anchors themselves were still ~190px apart;
    // the actual problem was that the CONTENT drawn at those anchors was
    // wide enough to eat that entire gap). So this reconstructs each
    // column's real content width the same way production code does —
    // Fira Code's monospace ratio (28px font, 0.6 factor, matching
    // estimateTextWidth in receiptService.js) — from the item's actual
    // known values, and checks the anchors leave that much clearance
    // PLUS a real minimum gap, not just "some positive number."
    const FONT_SIZE = 28;
    const MONOSPACE_RATIO = 0.6;
    const estimatedWidth = (text) => text.length * FONT_SIZE * MONOSPACE_RATIO;
    const MIN_ACCEPTABLE_GAP = 20; // generous floor, well below the 32px design target, but well above the ~5px that caused the original visible collision

    const qtyContentWidth = estimatedWidth('40');
    const rateContentWidth = estimatedWidth('$5,000.00');

    assert.ok(
      rateX - qtyX >= qtyContentWidth + MIN_ACCEPTABLE_GAP,
      `QTY column content ("40", ~${qtyContentWidth}px) plus minimum gap doesn't fit before RATE's anchor: gap is only ${rateX - qtyX}px`
    );
    assert.ok(
      totalX - rateX >= rateContentWidth + MIN_ACCEPTABLE_GAP,
      `RATE column content ("$5,000.00", ~${rateContentWidth}px) plus minimum gap doesn't fit before LINE TOTAL's anchor: gap is only ${totalX - rateX}px`
    );
  });

  test('an even wider total (7-figure amount) still keeps clear gaps', async () => {
    const items = [{ name: 'Generator', unit: null, quantity: 1, unitPriceKobo: 350000000, totalKobo: 350000000, currency: 'NGN' }];

    capture.svg = null;
    await receiptService.generateInvoiceCard({
      merchant,
      invoiceNumber: 8,
      customerName: 'Tunde',
      customerPhone: null,
      items,
      totalKobo: 350000000,
    });

    const anchors = [...new Set(extractRightAnchoredXs(capture.svg))].sort((a, b) => a - b);
    assert.equal(anchors.length, 3);
    const [qtyX, rateX, totalX] = anchors;

    const estimatedWidth = (text) => text.length * 28 * 0.6;
    const MIN_ACCEPTABLE_GAP = 20;

    assert.ok(rateX - qtyX >= estimatedWidth('1') + MIN_ACCEPTABLE_GAP);
    assert.ok(totalX - rateX >= estimatedWidth('\u20a63,500,000.00') + MIN_ACCEPTABLE_GAP);
  });
});
