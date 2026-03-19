'use strict';

const { Router } = require('express');
const activity = require('../../services/activity');
const { caddyApi, syncToCaddy } = require('../../services/routes');

const router = Router();

/**
 * GET /api/caddy/status
 */
router.get('/status', async (req, res) => {
  try {
    const caddyConfig = await caddyApi('/config/');
    res.json({
      ok: true,
      running: caddyConfig !== null,
      config: caddyConfig,
    });
  } catch (err) {
    res.json({ ok: true, running: false, config: null });
  }
});

/**
 * POST /api/caddy/reload — rebuild and push full config to Caddy
 */
router.post('/reload', async (req, res) => {
  try {
    await syncToCaddy();
    activity.log('caddy_reload', 'Caddy configuration reloaded', {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'info',
    });
    res.json({ ok: true, success: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('error.caddy.reload') });
  }
});

module.exports = router;
