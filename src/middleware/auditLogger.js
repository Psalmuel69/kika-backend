'use strict';

const { randomUUID } = require('crypto');
const auditLogService = require('../services/auditLogService');

/**
 * Logs every request's endpoint/method/status/actor to audit_logs once
 * the response finishes. Runs on `res.on('finish')` so it never delays
 * the actual response, and the write itself is fire-and-forget (see
 * auditLogService.log) so a logging hiccup can never fail a request.
 */
function auditLogger(req, res, next) {
  req.requestId = req.get('X-Request-Id') || randomUUID();
  res.set('X-Request-Id', req.requestId);

  const start = Date.now();
  res.on('finish', () => {
    auditLogService.log({
      merchantId: req.auditMerchantId || null,
      actorType: req.auditActorType || 'SYSTEM',
      actorId: req.auditActorId || req.ip,
      action: req.auditAction || `${req.method} ${req.path}`,
      endpoint: req.originalUrl,
      httpMethod: req.method,
      statusCode: res.statusCode,
      isSuccess: res.statusCode < 400,
      requestId: req.requestId,
      ipAddress: req.ip,
      metadata: { durationMs: Date.now() - start },
    });
  });

  next();
}

module.exports = auditLogger;
