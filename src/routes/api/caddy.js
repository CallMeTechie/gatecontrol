'use strict';

const { Router } = require('express');
const config = require('../../../config/default');
const activity = require('../../services/activity');
const logger = require('../../utils/logger');

const router = Router();

async function caddyRequest(path, options = {}) {
  const url = `${config.caddy.adminUrl}${path}`;
  try {
    const res = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    if (!res.ok) throw new Error(`Caddy API ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    logger.error({ url, error: err.message }, 'Caddy API request failed');
    return null;
  }
}

/**
 * GET /api/caddy/status
 */
router.get('/status', async (req, res) => {
  try {
    const caddyConfig = await caddyRequest('/config/');
    res.json({
      running: caddyConfig !== null,
      config: caddyConfig,
    });
  } catch (err) {
    res.json({ running: false, config: null });
  }
});

/**
 * POST /api/caddy/reload
 */
router.post('/reload', async (req, res) => {
  try {
    const result = await caddyRequest('/load', {
      method: 'POST',
    });
    activity.log('caddy_reload', 'Caddy configuration reloaded', {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'info',
    });
    res.json({ success: result !== null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reload Caddy' });
  }
});

module.exports = router;
