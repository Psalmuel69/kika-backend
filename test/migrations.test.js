'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');

describe('migrations directory', () => {
  test('every migration filename follows the NNNN_description.sql convention', () => {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    assert.ok(files.length > 0, 'expected at least one migration file');
    for (const f of files) {
      assert.match(f, /^\d{4}_[a-z0-9_]+\.sql$/, `${f} does not follow the NNNN_description.sql convention`);
    }
  });

  test('filenames sort into the correct numeric run order', () => {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    const sorted = [...files].sort();
    const numbers = sorted.map((f) => parseInt(f.slice(0, 4), 10));
    for (let i = 1; i < numbers.length; i += 1) {
      assert.ok(numbers[i] > numbers[i - 1], `migration ${sorted[i]} is not numbered after ${sorted[i - 1]}`);
    }
  });

  test('the baseline migration exists and is non-empty', () => {
    const baselinePath = path.join(MIGRATIONS_DIR, '0001_baseline.sql');
    assert.ok(fs.existsSync(baselinePath));
    const content = fs.readFileSync(baselinePath, 'utf8');
    assert.ok(content.length > 1000, 'expected the baseline migration to contain the full schema');
    assert.match(content, /CREATE TABLE IF NOT EXISTS merchants/);
  });
});
