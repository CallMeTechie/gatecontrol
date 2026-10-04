'use strict';

// Gateway-failover settings: down-threshold slider persisted to settings table.

const { Router } = require('express');
const settings = require('../../../services/settings');

const router = Router();

/**
 * GET /api/settings/gateway-failover — gateway down-detection threshold
 */
router.get('/gateway-failover', (req, res) => {
  const n = parseInt(settings.get('gateway_down_threshold_s', '90'), 10);
  res.json({ ok: true, data: { gateway_down_threshold_s: Number.isFinite(n) ? n : 90 } });
});

/**
 * PUT /api/settings/gateway-failover — Update gateway down-detection threshold (30–600 s)
 */
router.put('/gateway-failover', (req, res) => {
  const { gateway_down_threshold_s } = req.body || {};
  if (!Number.isInteger(gateway_down_threshold_s) || gateway_down_threshold_s < 30 || gateway_down_threshold_s > 600) {
    const msg = req.t('error.settings.range', { min: '30', max: '600' });
    return res.status(400).json({ ok: false, error: msg, code: 'invalid_value', fields: { gateway_down_threshold_s: msg } });
  }
  settings.set('gateway_down_threshold_s', String(gateway_down_threshold_s));
  res.json({ ok: true });
});

module.exports = router;
