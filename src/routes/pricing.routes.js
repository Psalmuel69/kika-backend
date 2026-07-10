'use strict';

const express = require('express');
const queries = require('../db/queries');
const { asyncHandler } = require('../middleware/validation');

const router = express.Router();

/**
 * Public pricing feed — active tiers only, sorted by display_order, for
 * the marketing/pricing page (or the app's in-chat plan picker) to render
 * without hardcoding prices or feature copy on the client.
 */
router.get(
  '/pricing',
  asyncHandler(async (req, res) => {
    const tiers = await queries.listActiveSubscriptionTiers();
    res.json({
      tiers: tiers.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        price: Number(t.price),
        currency: t.currency,
        interval: t.interval,
        featureList: t.feature_list,
        displayOrder: t.display_order,
      })),
    });
  })
);

module.exports = router;
