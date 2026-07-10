'use strict';

const { validationResult } = require('express-validator');
const logger = require('../utils/logger');

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Invalid request', details: errors.array() });
  }
  next();
}

/**
 * Wraps async route handlers so rejected promises are forwarded to
 * Express's error middleware instead of crashing the process or hanging
 * the request — critical once every handler is async/await.
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  logger.error({ err: err.message, stack: err.stack, path: req.path }, 'Unhandled request error');
  if (res.headersSent) return next(err);
  res.status(err.statusCode || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
}

module.exports = { validate, asyncHandler, errorHandler };
