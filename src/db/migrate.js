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

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query(sql);
    logger.info('Schema migration applied successfully');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  logger.error({ err }, 'Migration failed');
  process.exit(1);
});
