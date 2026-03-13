'use strict';

const { Router } = require('express');
const wg = require('../../services/wireguard');
const activity = require('../../services/activity');

const router = Router();

/**
 * GET /api/wg/status
 */
router.get('/status', async (req, res) => {
  try {
    const status = await wg.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: req.t('error.wireguard.status') });
  }
});

/**
 * GET /api/wg/config
 * Returns masked wg0.conf content
 */
router.get('/config', async (req, res) => {
  try {
    const config = await wg.getConfig();
    if (!config) return res.status(404).json({ error: req.t('error.wireguard.config_not_found') });
    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: req.t('error.wireguard.config_read') });
  }
});

/**
 * POST /api/wg/restart
 */
router.post('/restart', async (req, res) => {
  try {
    const success = await wg.restart();
    activity.log('wg_restart', 'WireGuard interface restarted', {
      source: 'admin',
      ipAddress: req.ip,
      severity: success ? 'info' : 'error',
    });
    res.json({ success });
  } catch (err) {
    res.status(500).json({ error: req.t('error.wireguard.restart') });
  }
});

/**
 * POST /api/wg/stop
 */
router.post('/stop', async (req, res) => {
  try {
    const success = await wg.stop();
    activity.log('wg_stop', 'WireGuard interface stopped', {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'warning',
    });
    res.json({ success });
  } catch (err) {
    res.status(500).json({ error: req.t('error.wireguard.stop') });
  }
});

module.exports = router;
