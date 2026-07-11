'use strict';

const { randomUUID } = require('crypto');
const auditLogService = require('../services/auditLogService');
const logger = require('../utils/logger');

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
    // Defense in depth: this must NEVER throw back into the 'finish'
    // event (an uncaught exception here would escape Express entirely,
    // since 'finish' listeners aren't part of the normal error-handling
    // middleware chain). auditLogService.log() already swallows and
    // logs its own failures once at error level — the .catch() below is
    // a deliberate silent no-op so a temporarily-unavailable database
    // doesn't double-log the same failure for every single request,
    // which is what actually produces "error spam" under an outage.
    try {
      auditLogService
        .log({
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
        })
        .catch(() => {
          /* already logged once inside auditLogService.log — swallow here */
        });
    } catch (err) {
      // A synchronous failure building the log entry itself (e.g.
      // unexpected req/res state) must never crash the request/response
      // cycle this listener is attached to.
      logger.debug({ err: err.message }, 'Audit logger failed synchronously — request unaffected');
    }
  });

  next();
}

module.exports = auditLogger;
