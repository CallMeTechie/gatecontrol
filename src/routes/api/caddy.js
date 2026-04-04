'use strict';

const { Router } = require('express');
const activity = require('../../services/activity');
const { caddyApi, syncToCaddy } = require('../../services/routes');

const router = Router();

/**
 * GET /api/caddy/status
 * Returns running state and route counts (no full config to avoid information disclosure)
 */
router.get('/status', async (req, res) => {
  try {
    const caddyConfig = await caddyApi('/config/');
    const running = caddyConfig !== null;
    let httpRoutes = 0;
    let l4Routes = 0;
    if (running && caddyConfig.apps) {
      if (caddyConfig.apps.http && caddyConfig.apps.http.servers) {
        for (const srv of Object.values(caddyConfig.apps.http.servers)) {
          if (srv.routes) httpRoutes += srv.routes.length;
        }
      }
      if (caddyConfig.apps.layer4 && caddyConfig.apps.layer4.servers) {
        l4Routes = Object.keys(caddyConfig.apps.layer4.servers).length;
      }
    }
    res.json({ ok: true, running, httpRoutes, l4Routes });
  } catch (err) {
    res.json({ ok: true, running: false, httpRoutes: 0, l4Routes: 0 });
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
