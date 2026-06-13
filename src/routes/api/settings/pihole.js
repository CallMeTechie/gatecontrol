'use strict';

const { Router } = require('express');
const { requireFeature } = require('../../../middleware/license');
const piholeConfig = require('../../../services/piholeConfig');
const pihole = require('../../../services/pihole');

const router = Router();

router.use(requireFeature('pihole_integration'));

/**
 * GET /api/v1/settings/pihole — Return redacted pihole config
 */
router.get('/pihole', (req, res) => {
  const cfg = piholeConfig.load();
  res.json({ ok: true, data: piholeConfig.redact(cfg) });
});

/**
 * PUT /api/v1/settings/pihole — Save pihole config, preserving stored passwords
 */
router.put('/pihole', (req, res) => {
  const body = req.body || {};

  if (!Array.isArray(body.instances)) {
    return res.status(400).json({ ok: false, error: 'instances must be an array' });
  }

  // Load existing config to preserve passwords where client sends password_set but no new app_password
  const existing = piholeConfig.load();
  const existingById = {};
  for (const inst of existing.instances || []) {
    existingById[inst.id] = inst;
  }

  const instances = body.instances.map((inst) => {
    if (!inst.app_password && inst.password_set && existingById[inst.id]) {
      return { ...inst, app_password: existingById[inst.id].app_password };
    }
    return inst;
  });

  piholeConfig.save({
    enabled: !!body.enabled,
    sync_interval_sec: Number(body.sync_interval_sec) || 30,
    manage_dns_chain: body.manage_dns_chain !== false,
    instances,
  });

  try { pihole.applyDnsChain(); } catch { /* dnsmasq conf may not exist */ }
  pihole._sync.triggerResync().catch(() => {});

  res.json({ ok: true });
});

/**
 * POST /api/v1/settings/pihole/test — Test connection to a pihole instance
 */
router.post('/pihole/test', async (req, res) => {
  try {
    const result = await pihole.testConnection(req.body);
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
