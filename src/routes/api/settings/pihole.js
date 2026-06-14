'use strict';

const { Router } = require('express');
const { requireFeature } = require('../../../middleware/license');
const piholeConfig = require('../../../services/piholeConfig');
const pihole = require('../../../services/pihole');
const logger = require('../../../utils/logger');

const router = Router();

/**
 * GET /api/v1/settings/pihole — Return redacted pihole config
 */
router.get('/pihole', requireFeature('pihole_integration'), (req, res) => {
  const cfg = piholeConfig.load();
  res.json({ ok: true, data: piholeConfig.redact(cfg) });
});

/**
 * PUT /api/v1/settings/pihole — Save pihole config, preserving stored passwords
 */
router.put('/pihole', requireFeature('pihole_integration'), (req, res) => {
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

  try { pihole.applyDnsChain(); } catch (err) { logger.warn({ error: err.message }, 'applyDnsChain failed after pihole save'); }
  pihole._sync.triggerResync().catch((err) => { logger.warn({ error: err.message }, 'triggerResync failed after pihole save'); });

  res.json({ ok: true });
});

/**
 * POST /api/v1/settings/pihole/test — Test connection to a pihole instance
 */
router.post('/pihole/test', requireFeature('pihole_integration'), async (req, res) => {
  try {
    const result = await pihole.testConnection(req.body);
    const dnsResult = await pihole.testDns(req.body.dns_ip, req.body.dns_port);
    res.json({ ok: true, data: { ...result, dns: dnsResult } });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/v1/settings/pihole/test/:id — Test connection using the STORED password for an instance
 */
router.post('/pihole/test/:id', requireFeature('pihole_integration'), async (req, res) => {
  const cfg = piholeConfig.load();
  const inst = (cfg.instances || []).find(i => String(i.id) === String(req.params.id));
  if (!inst) return res.status(404).json({ ok: false, error: 'instance not found' });
  try {
    const result = await pihole.testConnection({ url: inst.url, app_password: inst.app_password, verify_tls: inst.verify_tls });
    const dnsResult = await pihole.testDns(inst.dns_ip, inst.dns_port);
    res.json({ ok: true, data: { ...result, dns: dnsResult } });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
