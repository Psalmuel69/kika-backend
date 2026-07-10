'use strict';

/**
 * Minimal shared-secret auth for internal/admin endpoints (managing the
 * blacklist, conversation labels, disputes). Not meant to replace a real
 * admin auth system — just enough to keep these endpoints from being
 * open to the public internet. Swap for proper session/JWT auth before
 * exposing this to a real admin panel with multiple operators.
 */
function requireAdminKey(req, res, next) {
  const provided = req.get('X-Admin-Key');
  const expected = process.env.ADMIN_API_KEY;

  if (!expected) {
    return res.status(503).json({ error: 'Admin API is not configured (ADMIN_API_KEY unset)' });
  }
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  req.auditActorType = 'ADMIN';
  req.auditActorId = 'admin';
  next();
}

module.exports = { requireAdminKey };
