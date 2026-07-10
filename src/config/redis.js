'use strict';

const IORedis = require('ioredis');
const logger = require('../utils/logger');

/**
 * BullMQ requires maxRetriesPerRequest: null on the connection it manages.
 * This single instance is reused by both the API process (to enqueue jobs)
 * and the worker process (to consume them), so producer and consumer never
 * fight over separate pools.
 */
const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

connection.on('error', (err) => {
  logger.error({ err }, 'Redis connection error');
});

module.exports = { connection };
