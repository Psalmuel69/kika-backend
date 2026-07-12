'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const queries = require('../db/queries');
const { query } = require('../config/db');
const logger = require('../utils/logger');

function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function formatNairaPlain(kobo) {
  return (Number(kobo) / 100).toFixed(2);
}

const CSV_HEADERS = [
  'Date',
  'Type',
  'Description',
  'Customer/Supplier',
  'Total (NGN)',
  'Paid (NGN)',
  'Balance (NGN)',
];

/**
 * Pulls every non-voided ledger entry for a merchant (optionally bounded
 * to a date range) and writes it out as a CSV file, tracked in
 * data_exports the same way receipts are tracked — unguessable token,
 * documented expiry, swept by the same disk-cleanup job once expired.
 */
async function generateLedgerCsvExport(merchant, { startDate, endDate, periodLabel } = {}) {
  const conditions = ['merchant_id = $1', 'is_voided = false'];
  const params = [merchant.id];
  if (startDate) {
    params.push(startDate);
    conditions.push(`created_at >= $${params.length}`);
  }
  if (endDate) {
    params.push(endDate);
    conditions.push(`created_at < $${params.length}`);
  }

  const res = await query(
    `SELECT created_at, entry_type, description, counterparty_name, total_kobo, paid_kobo, balance_kobo
     FROM ledger_entries
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at ASC`,
    params
  );

  const lines = [CSV_HEADERS.map(csvEscape).join(',')];
  for (const row of res.rows) {
    lines.push(
      [
        new Date(row.created_at).toISOString(),
        row.entry_type,
        row.description,
        row.counterparty_name || '',
        formatNairaPlain(row.total_kobo),
        formatNairaPlain(row.paid_kobo),
        formatNairaPlain(row.balance_kobo),
      ]
        .map(csvEscape)
        .join(',')
    );
  }
  const csvContent = lines.join('\n');

  const storageDir = process.env.RECEIPT_STORAGE_DIR || path.join(process.cwd(), 'public', 'receipts');
  const exportsDir = path.join(storageDir, 'exports');
  await fs.mkdir(exportsDir, { recursive: true });

  const publicToken = crypto.randomBytes(24).toString('hex');
  const fileName = `${publicToken}.csv`;
  const filePath = path.join(exportsDir, fileName);
  await fs.writeFile(filePath, csvContent, 'utf8');

  const ttlHours = Number(process.env.EXPORT_URL_TTL_HOURS || 24);
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);

  await queries.createDataExport({
    merchantId: merchant.id,
    filePath,
    publicToken,
    periodLabel: periodLabel || 'all-time',
    expiresAt,
  });

  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const downloadUrl = `${baseUrl}/api/v1/exports/${publicToken}.csv`;

  logger.info({ merchantId: merchant.id, rowCount: res.rows.length }, 'Ledger CSV export generated');

  return { downloadUrl, rowCount: res.rows.length, expiresAt };
}

module.exports = { generateLedgerCsvExport };
