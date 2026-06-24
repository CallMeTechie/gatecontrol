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
    const server = await domains.getServerPublicIp();
    res.json({ ok: true, data: {
      domains: domains.list(),
      serverIp: server.ip,
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
    domains.remove(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    logger.warn({ err: err.message, id: req.params.id }, 'DELETE /domains/:id failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

router.put('/domains/server-ip', (req, res) => {
  const ip = String(req.body?.ip ?? '').trim();
  if (ip !== '' && !net.isIP(ip)) {
    return res.status(400).json({ ok: false, error: req.t('settings.domains.invalid_ip') });
  }
  try {
    settings.set('server.public_ip', ip);
    res.json({ ok: true });
  } catch (err) {
    logger.warn({ err: err.message }, 'PUT /domains/server-ip failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

module.exports = router;
