'use strict';
const { Router } = require('express');
const net = require('node:net');
const domains = require('../../../services/domains');
const settings = require('../../../services/settings');
const activity = require('../../../services/activity');
const { getDb } = require('../../../db/connection');
const logger = require('../../../utils/logger');
const router = Router();

router.get('/domains', async (req, res) => {
  try {
    const server = await domains.getServerPublicIps();
    res.json({ ok: true, data: {
      domains: domains.list(),
      serverIp: server.v4,
      serverIpv6: server.v6,
      serverIps: server,
      serverIpOverride: (settings.get('server.public_ip', '') || '').trim(),
      serverIpv6Override: (settings.get('server.public_ipv6', '') || '').trim(),
      serverIpWarning: settings.get('domains.server_ip_warning', '0') === '1',
    } });
  } catch (err) {
    logger.warn({ err: err.message }, 'GET /domains failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

router.post('/domains', async (req, res) => {
  const domain = String(req.body?.domain || '').trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return res.status(400).json({ ok: false, error: req.t('settings.domains.invalid') });
  }
  try {
    const row = await domains.add(domain);
    activity.log('domain_added', `Domain ${domain} (${row.status})`, {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'info',
    });
    res.json({ ok: true, data: row });
  } catch (err) {
    logger.warn({ err: err.message, domain }, 'POST /domains failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

router.post('/domains/:id/verify', async (req, res) => {
  try {
    const rowById = getDb()
      .prepare('SELECT domain FROM domains WHERE id = ?')
      .get(Number(req.params.id));
    if (!rowById) return res.status(404).json({ ok: false, error: req.t('error.not_found') });
    const updated = await domains.add(rowById.domain);
    res.json({ ok: true, data: updated });
  } catch (err) {
    logger.warn({ err: err.message, id: req.params.id }, 'POST /domains/:id/verify failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

router.delete('/domains/:id', (req, res) => {
  try {
    const row = getDb().prepare('SELECT domain FROM domains WHERE id = ?').get(Number(req.params.id));
    if (row && String(settings.get('portal.base_domain', '')).toLowerCase() === String(row.domain).toLowerCase()) {
      return res.status(409).json({ ok: false, error: req.t('settings.domains.in_use_portal') });
    }
    domains.remove(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    logger.warn({ err: err.message, id: req.params.id }, 'DELETE /domains/:id failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

// Body: { ip?: IPv4|'' , ipv6?: IPv6|'' } — each key is applied only when
// present ('' clears the override). A body with neither key clears the IPv4
// override, as before.
router.put('/domains/server-ip', async (req, res) => {
  const body = req.body || {};
  const hasIp = body.ip !== undefined || body.ipv6 === undefined;
  const ip = String(body.ip ?? '').trim();
  const ipv6 = body.ipv6 === undefined ? undefined : String(body.ipv6 ?? '').trim();
  if (hasIp && ip !== '' && !net.isIP(ip)) {
    return res.status(400).json({ ok: false, error: req.t('settings.domains.invalid_ip') });
  }
  if (ipv6 !== undefined && ipv6 !== '' && !net.isIPv6(ipv6)) {
    return res.status(400).json({ ok: false, error: req.t('settings.domains.invalid_ip') });
  }
  try {
    if (hasIp) settings.set('server.public_ip', ip);
    if (ipv6 !== undefined) settings.set('server.public_ipv6', ipv6);
    // Best-effort: re-verify all domains against the new IP so the
    // server-IP warning is refreshed immediately (without restart).
    try {
      await require('../../../services/domainBoot').reverifyAllAndReflag();
    } catch (verifyErr) {
      logger.warn({ err: verifyErr.message }, 'reverifyAllAndReflag failed after server-ip save');
    }
    res.json({ ok: true });
  } catch (err) {
    logger.warn({ err: err.message }, 'PUT /domains/server-ip failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

module.exports = router;
