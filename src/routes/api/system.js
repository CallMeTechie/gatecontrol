'use strict';

const { Router } = require('express');
const system = require('../../services/system');
const dns = require('../../services/dns');
const autoUpdate = require('../../services/autoUpdate');
const systemSetup = require('../../services/systemSetup');
const { requireFeature } = require('../../middleware/license');

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
router.get('/dns/status', requireFeature('internal_dns'), (req, res) => {
  try {
    const status = dns.getStatus();
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'DNS status unavailable' });
  }
});

/**
 * GET /api/system/dns/records
 * Full zone snapshot for the DNS admin page: static gateway records,
 * peer records (name, hostname, fqdn, ip, source, reported_at),
 * + status summary. Read-only, admin session only.
 */
router.get('/dns/records', requireFeature('internal_dns'), (req, res) => {
  try {
    const { getDb } = require('../../db/connection');
    const config = require('../../../config/default');
    const status = dns.getStatus();

    const gateway = config.wireguard.gatewayIp;
    const domain = config.dns.domain;
    const staticRecords = [
      { fqdn: `gateway.${domain}`, ip: gateway },
      { fqdn: `server.${domain}`, ip: gateway },
      { fqdn: `gc-server.${domain}`, ip: gateway },
    ];

    const peerRows = getDb().prepare(`
      SELECT id, name, hostname, hostname_source, hostname_reported_at, allowed_ips
      FROM peers
      ORDER BY name COLLATE NOCASE
    `).all();

    const peers = peerRows.map((p) => {
      const ip = (p.allowed_ips || '').split(',')[0].split('/')[0].trim();
      return {
        id: p.id,
        name: p.name,
        hostname: p.hostname,
        hostname_source: p.hostname_source,
        hostname_reported_at: p.hostname_reported_at,
        ip,
        fqdn: p.hostname ? `${p.hostname}.${domain}` : null,
      };
    });

    res.json({ ok: true, status, staticRecords, peers });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'DNS records unavailable' });
  }
});

// ── Auto-Update ──────────────────────────────────────────────
router.get('/auto-update', (req, res) => {
  try { res.json({ ok: true, ...autoUpdate.getStatus() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.put('/auto-update', (req, res) => {
  try {
    const { mode } = req.body || {};
    const out = autoUpdate.setMode(mode);   // throws on invalid
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/auto-update/trigger', (req, res) => {
  if (autoUpdate.getMode() !== 'manual') {
    return res.status(409).json({ ok: false, error: 'not_manual_mode' });
  }
  try { res.json({ ok: true, ...autoUpdate.requestUpdate() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/update-sh', (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="update.sh"');
  res.send(systemSetup.readUpdateSh());
});

module.exports = router;
