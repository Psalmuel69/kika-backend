'use strict';

const { Pool } = require('pg');
const logger = require('../utils/logger');

/**
 * ---------------------------------------------------------------------
 * CONNECTION CONFIG — Cloud (Render + Neon) vs Docker Compose
 * ---------------------------------------------------------------------
 * This module is the ONLY place a `pg.Pool` is constructed anywhere in
 * the codebase (verified — grep for `new Pool(` and it only ever
 * appears here). Every other file imports `{ pool }` or `{ query,
 * withTransaction }` FROM this module rather than creating its own
 * connection — that is what "one shared pool" actually means in
 * practice, and it's also what prevents the self-import footgun this
 * comment is warning future edits away from: nothing in this file
 * should ever `require('../config/db')` (i.e. require itself) — if you
 * see that appear during a refactor, it's a sign a Pool got duplicated
 * somewhere and needs to be routed back through this single module
 * instead of re-declared.
 *
 * Two supported ways to point at Postgres, auto-selected by whether
 * DATABASE_URL is set:
 *
 * 1) CLOUD (current deployment target — Render + Neon Postgres):
 *      DATABASE_URL=postgresql://user:pass@host/db?sslmode=require&channel_binding=require
 *    This is what's active whenever DATABASE_URL is present in the
 *    environment — Render injects this automatically if you link a Neon
 *    database, or you set it directly in the Render dashboard.
 *
 * 2) DOCKER / LOCAL (docker-compose.yml, self-hosted Postgres):
 *    Leave DATABASE_URL UNSET and populate the discrete PG* vars
 *    instead (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD) — see the
 *    commented block in .env.example. docker-compose.yml sets these via
 *    the `postgres` service automatically; nothing else to configure.
 *
 * The exact same application code runs in both environments — only this
 * one branch differs.
 * ---------------------------------------------------------------------
 */
const usingCloudConnectionString = Boolean(process.env.DATABASE_URL);

const connectionConfig = usingCloudConnectionString
  ? {
      // --- CLOUD: Render + Neon (or any managed Postgres via connection string) ---
      connectionString: process.env.DATABASE_URL,
      // Neon (and most managed providers) terminate TLS with a cert
      // chain that isn't always in Node's default trust store.
      // rejectUnauthorized:false keeps the connection encrypted (already
      // enforced by `sslmode=require` in the URL itself) without
      // requiring the full CA bundle to be installed in the container.
      // Set PG_SSL_REJECT_UNAUTHORIZED=true if you've provisioned the
      // provider's CA cert and want full chain verification instead.
      ssl:
        String(process.env.PG_SSL_REJECT_UNAUTHORIZED || 'false').toLowerCase() === 'true'
          ? true
          : { rejectUnauthorized: false },
    }
  : {
      // --- DOCKER / LOCAL: docker-compose.yml `postgres` service ---
      // Populate these in .env when NOT using DATABASE_URL. Commented
      // reference values live in .env.example; docker-compose.yml
      // already sets PGHOST=postgres for you automatically.
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
    };

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
  ...connectionConfig,
  max: Number(process.env.PG_POOL_MAX || 20),
  idleTimeoutMillis: Number(process.env.PG_POOL_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PG_POOL_CONN_TIMEOUT_MS || 5000),
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 8000),
  application_name: 'kika-backend',
});

logger.info(
  { mode: usingCloudConnectionString ? 'cloud (DATABASE_URL)' : 'docker/local (PG* vars)' },
  'Postgres pool initialized'
);

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
