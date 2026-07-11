'use strict';

const IORedis = require('ioredis');
const logger = require('../utils/logger');

/**
 * ---------------------------------------------------------------------
 * CONNECTION CONFIG — Cloud (Upstash) vs Docker Compose
 * ---------------------------------------------------------------------
 * Single shared connection, reused by both the API process (to enqueue
 * jobs) and the worker process (to consume them). Exactly one place
 * constructs this client — nothing else in the codebase should call
 * `new IORedis(...)` directly.
 *
 * 1) CLOUD (current deployment target — Upstash Redis):
 *      REDIS_URL=rediss://default:<password>@<host>.upstash.io:6379
 *    Note the `rediss://` scheme (double "s") — ioredis auto-detects
 *    this and enables TLS, which Upstash requires. No extra config
 *    needed beyond the URL itself.
 *
 * 2) DOCKER / LOCAL (docker-compose.yml `redis` service, or a local
 *    `redis-server`):
 *      REDIS_URL=redis://redis:6379        (inside docker-compose)
 *      REDIS_URL=redis://localhost:6379    (running the API directly)
 *    Plain `redis://` (single "s") — no TLS, matching a self-hosted
 *    instance with no auth by default.
 *
 * Same code path either way; only the URL scheme/host changes.
 * ---------------------------------------------------------------------
 * BullMQ requires maxRetriesPerRequest: null on the connection it manages.
 */
const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

logger.info(
  { tls: (process.env.REDIS_URL || '').startsWith('rediss://') },
  'Redis connection initializing'
);

connection.on('error', (err) => {
  logger.error({ err }, 'Redis connection error');
});

connection.on('ready', () => {
  logger.info('Redis connection ready');
});

module.exports = { connection };
