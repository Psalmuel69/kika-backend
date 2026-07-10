'use strict';

const express = require('express');
const { healthCheck } = require('../config/db');
const { connection } = require('../config/redis');
const { asyncHandler } = require('../middleware/validation');

const router = express.Router();

router.get(
  '/health',
  asyncHandler(async (req, res) => {
    const dbOk = await healthCheck().catch(() => false);
    const redisOk = connection.status === 'ready' || connection.status === 'connect';

    const healthy = dbOk && redisOk;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      postgres: dbOk,
      redis: redisOk,
      uptimeSeconds: process.uptime(),
    });
  })
);

module.exports = router;
