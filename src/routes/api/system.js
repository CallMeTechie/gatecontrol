'use strict';

const { Router } = require('express');
const system = require('../../services/system');
const dns = require('../../services/dns');

const router = Router();

/**
 * GET /api/system/resources
 * Returns CPU, RAM, uptime, disk usage
 */
router.get('/resources', async (req, res) => {
  try {
    const resources = await system.getResources();
    res.json({ ok: true, ...resources });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('error.system.resources') });
  }
});

/**
 * GET /api/system/dns/status
 * Returns internal DNS status: peer counts by hostname source, hosts
 * file metadata, feature flag. Used by the admin UI DNS widget.
 */
router.get('/dns/status', (req, res) => {
  try {
    const status = dns.getStatus();
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'DNS status unavailable' });
  }
});

module.exports = router;
