'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
// Deliberately import ONLY the shared pool from config/db.js — this file
// must never construct its own `new Pool(...)`. Whichever connection
// mode db.js resolved (cloud DATABASE_URL vs Docker PG* vars) is what
// migrate.js runs against automatically, with zero branching needed here.
const { pool } = require('../config/db');
const logger = require('../utils/logger');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Versioned, tracked schema migrations — replaces the old approach of
 * re-running one ever-growing schema.sql file in full on every deploy.
 * Each file in src/db/migrations/ is a focused, numbered, reviewable
 * change (0001_baseline.sql, 0002_*.sql, ...), applied in filename order,
 * exactly once, tracked in the schema_migrations table below. A NEW
 * migration file is how every future schema change ships — never by
 * editing an already-applied file or appending to a single monolith.
 *
 * Each migration still runs inside a transaction and is still written
 * to be idempotent (IF NOT EXISTS / DROP-then-ADD CONSTRAINT) as a
 * defense-in-depth habit, not because the tracking table needs it — but
 * the tracking table is what actually guarantees a migration runs once,
 * rather than relying on every statement inside it being a safe no-op
 * forever.
 */
async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        VARCHAR(255) PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrationNames(client) {
  const res = await client.query('SELECT name FROM schema_migrations');
  return new Set(res.rows.map((r) => r.name));
}

function listMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // numeric filename prefixes (0001_, 0002_, ...) sort correctly as plain strings
}

async function migrate() {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrationNames(client);
    const files = listMigrationFiles();

    if (files.length === 0) {
      logger.warn({ dir: MIGRATIONS_DIR }, 'No migration files found');
      return;
    }

    let ranCount = 0;
    for (const file of files) {
      if (applied.has(file)) {
        logger.info({ file }, 'Migration already applied — skipping');
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      logger.info({ file }, 'Applying migration');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        ranCount += 1;
        logger.info({ file }, 'Migration applied successfully');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    logger.info({ ranCount, totalMigrations: files.length }, 'Schema migration run complete');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  logger.error({ err }, 'Migration failed');
  process.exit(1);
});
