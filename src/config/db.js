'use strict';

const { Pool } = require('pg');
const logger = require('../utils/logger');

/**
 * Single shared connection pool for the whole process.
 * Tuned so a burst of concurrent WhatsApp webhook deliveries cannot
 * exhaust Postgres connections or block the event loop.
 *
 * - max: hard ceiling on concurrent clients checked out from the pool
 * - idleTimeoutMillis: recycle idle clients so the pool doesn't hoard connections
 * - connectionTimeoutMillis: fail fast (instead of queueing forever) under load
 * - statement_timeout: server-side guard so a runaway query can't hold a
 *   connection indefinitely and starve the pool (a common deadlock precursor)
 */
const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: Number(process.env.PG_POOL_MAX || 20),
  idleTimeoutMillis: Number(process.env.PG_POOL_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PG_POOL_CONN_TIMEOUT_MS || 5000),
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 8000),
  application_name: 'kika-backend',
});

pool.on('error', (err) => {
  // Catches errors on idle clients (e.g. connection dropped by the DB host)
  // so a single bad connection never crashes the whole process.
  logger.error({ err }, 'Unexpected error on idle Postgres client');
});

/**
 * Executes a parameterized query using the shared pool.
 * ALWAYS pass values via the `params` array placeholder ($1, $2, ...) —
 * never interpolate user input into the `text` string. This is the single
 * choke point that keeps the whole codebase immune to SQL injection,
 * as long as every caller routes through here (enforced by code review /
 * the queries.js abstraction which never builds SQL from raw strings).
 */
async function query(text, params = []) {
  const start = Date.now();
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    const duration = Date.now() - start;
    if (duration > 200) {
      logger.warn({ text, duration, rows: result.rowCount }, 'Slow query');
    }
    return result;
  } finally {
    client.release();
  }
}

/**
 * Runs a callback inside a single transaction, with automatic
 * commit/rollback. Used for multi-statement ledger writes (e.g. record
 * a transaction + update the running balance atomically) so concurrent
 * bursts can never leave the ledger in a half-written state.
 */
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function healthCheck() {
  const res = await query('SELECT 1 AS ok');
  return res.rows[0].ok === 1;
}

module.exports = { pool, query, withTransaction, healthCheck };
