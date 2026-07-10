'use strict';

const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    // Never let secrets or full customer PII leak into log sinks.
    paths: [
      'req.headers.authorization',
      'req.headers["x-hub-signature-256"]',
      '*.access_token',
      '*.WHATSAPP_ACCESS_TOKEN',
      '*.PAYSTACK_SECRET_KEY',
      '*.password',
    ],
    censor: '[REDACTED]',
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
