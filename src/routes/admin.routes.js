'use strict';

const express = require('express');
const { body, param } = require('express-validator');
const queries = require('../db/queries');
const accessControlService = require('../services/accessControlService');
const auditLogService = require('../services/auditLogService');
const { requireAdminKey } = require('../middleware/adminAuth');
const { validate, asyncHandler } = require('../middleware/validation');

const router = express.Router();
router.use(requireAdminKey);

// --- Access control ---------------------------------------------------

router.post(
  '/admin/access-control/blacklist',
  [body('phoneNumber').isString().notEmpty(), body('reason').optional().isString()],
  validate,
  asyncHandler(async (req, res) => {
    const row = await accessControlService.blacklistNumber(req.body.phoneNumber, req.body.reason, 'admin');
    await auditLogService.logEvent({
      actorType: 'ADMIN',
      actorId: 'admin',
      action: 'access_control.blacklist',
      metadata: { phoneNumber: req.body.phoneNumber, reason: req.body.reason },
    });
    res.json({ entry: row });
  })
);

router.post(
  '/admin/access-control/whitelist',
  [body('phoneNumber').isString().notEmpty(), body('reason').optional().isString()],
  validate,
  asyncHandler(async (req, res) => {
    const row = await accessControlService.whitelistNumber(req.body.phoneNumber, req.body.reason, 'admin');
    await auditLogService.logEvent({
      actorType: 'ADMIN',
      actorId: 'admin',
      action: 'access_control.whitelist',
      metadata: { phoneNumber: req.body.phoneNumber, reason: req.body.reason },
    });
    res.json({ entry: row });
  })
);

router.delete(
  '/admin/access-control/:phoneNumber',
  [param('phoneNumber').isString().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const removed = await accessControlService.removeFromList(req.params.phoneNumber);
    await auditLogService.logEvent({
      actorType: 'ADMIN',
      actorId: 'admin',
      action: 'access_control.remove',
      metadata: { phoneNumber: req.params.phoneNumber },
    });
    res.json({ removed });
  })
);

// --- Conversation labels (human handoff) ----------------------------------

router.post(
  '/admin/merchants/:merchantId/labels',
  [param('merchantId').isUUID(), body('label').isString().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const row = await queries.addConversationLabel(req.params.merchantId, req.body.label, 'admin');
    await auditLogService.logEvent({
      merchantId: req.params.merchantId,
      actorType: 'ADMIN',
      actorId: 'admin',
      action: 'conversation_label.add',
      metadata: { label: req.body.label },
    });
    res.json({ label: row });
  })
);

router.delete(
  '/admin/merchants/:merchantId/labels/:label',
  [param('merchantId').isUUID(), param('label').isString().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const rows = await queries.removeConversationLabel(req.params.merchantId, req.params.label);
    await auditLogService.logEvent({
      merchantId: req.params.merchantId,
      actorType: 'ADMIN',
      actorId: 'admin',
      action: 'conversation_label.remove',
      metadata: { label: req.params.label },
    });
    res.json({ removed: rows });
  })
);

// --- Ledger disputes -------------------------------------------------------

router.post(
  '/admin/disputes/:disputeId/resolve',
  [
    param('disputeId').isUUID(),
    body('status').isIn(['RESOLVED', 'REJECTED']),
    body('resolutionNotes').optional().isString(),
    body('adjustmentAmountKobo').optional().isInt(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const dispute = await queries.resolveLedgerDispute(req.params.disputeId, {
      status: req.body.status,
      resolutionNotes: req.body.resolutionNotes,
      resolvedBy: 'admin',
      adjustmentAmountKobo: req.body.adjustmentAmountKobo,
    });
    await auditLogService.logEvent({
      merchantId: dispute?.merchant_id,
      actorType: 'ADMIN',
      actorId: 'admin',
      action: 'dispute.resolve',
      metadata: { disputeId: req.params.disputeId, status: req.body.status },
    });
    res.json({ dispute });
  })
);

router.get(
  '/admin/merchants/:merchantId/disputes',
  [param('merchantId').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const disputes = await queries.listOpenLedgerDisputes(req.params.merchantId);
    res.json({ disputes });
  })
);

module.exports = router;
