'use strict';

// Gateway-failover settings: down-threshold slider persisted to settings table.

const { Router } = require('express');
const settings = require('../../../services/settings');

const router = Router();

/**
 * PUT /api/settings/gateway-failover — Update gateway down-detection threshold
 */
router.put('/gateway-failover', (req, res) => {
  const { gateway_down_threshold_s } = req.body || {};
  if (!Number.isInteger(gateway_down_threshold_s) || gateway_down_threshold_s < 30 || gateway_down_threshold_s > 600) {
    return res.status(400).json({ error: 'invalid_value' });
  }
  settings.set('gateway_down_threshold_s', String(gateway_down_threshold_s));
  res.json({ ok: true });
});

module.exports = router;
