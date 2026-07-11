'use strict';

require('dotenv').config();
require('./queue/worker');
const app = require('./app');
const logger = require('./utils/logger');
const { pool } = require('./config/db');
const { connection } = require('./config/redis');

const PORT = process.env.PORT || 8080;

const server = app.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV }, 'Kika backend listening');
});

/**
 * Graceful shutdown: stop accepting new connections, let in-flight
 * requests finish, then drain the Postgres pool and close Redis — so a
 * rolling deploy or container restart never severs an in-progress
 * transaction mid-write.
 */
async function shutdown(signal) {
  logger.info({ signal }, 'Shutdown signal received, draining connections');
  server.close(async () => {
    try {
      await pool.end();
      connection.disconnect();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  });

  // Hard exit safety net if graceful close hangs.
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});
