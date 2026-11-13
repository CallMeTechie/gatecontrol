'use strict';

// "Namen im VPN" (Einstellungen › VPN & Netzwerk): under which zone the VPN
// devices are named, and the state of those names (services/vpnNames.js,
// services/dns.js). Keys: dns.names.base_domain, dns.names.sub

const { Router } = require('express');
const dnsPromises = require('node:dns').promises;
const fs = require('node:fs');
const vpnNames = require('../../../services/vpnNames');
const activity = require('../../../services/activity');
const { getDb } = require('../../../db/connection');
const { hasFeature } = require('../../../services/license');
const config = require('../../../../config/default');
const logger = require('../../../utils/logger');

const router = Router();

function view() {
  const s = vpnNames.current();
  return {
    base_domain: s.base,
    sub: s.sub,
    default_sub: vpnNames.DEFAULT_SUB,
    custom: s.custom,
    removed: s.removed,
    primary: s.primary,
    legacy: s.legacy,
    zones: s.zones,
    licensed: hasFeature('internal_dns'),
    enabled: config.dns.enabled,
  };
}

// The message for a refused choice, in the admin's words.
function refusal(req, v, sub) {
  const error = req.t('st.names.err.' + v.error, { fqdn: v.fqdn || '', sub: sub || '', legacy: vpnNames.legacyZone() })
    + (v.suggestion ? ' ' + req.t('st.names.err.suggest', { sub: v.suggestion }) : '');
  return { ok: false, code: v.error, error, fqdn: v.fqdn || null, suggestion: v.suggestion || null, fields: { [v.field]: error } };
}

/** GET /api/v1/settings/vpn-names — the choice and the zones in effect */
router.get('/vpn-names', (req, res) => {
  try {
    res.json({ ok: true, data: view() });
  } catch (err) {
    logger.warn({ err: err.message }, 'GET /vpn-names failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * POST /api/v1/settings/vpn-names/check { base_domain, sub } — the checks of
 * the save, without saving (live preview). Always 200: `ok` says whether the
 * choice is free.
 */
router.post('/vpn-names/check', (req, res) => {
  try {
    const body = req.body || {};
    const v = vpnNames.check(body.base_domain, body.sub);
    if (!v.ok) return res.json({ ok: true, data: Object.assign(refusal(req, v, String(body.sub || '').trim().toLowerCase()), { free: false }) });
    res.json({ ok: true, data: { free: true, primary: v.primary, legacy: v.legacy, custom: v.custom } });
  } catch (err) {
    logger.warn({ err: err.message }, 'POST /vpn-names/check failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * PUT /api/v1/settings/vpn-names { base_domain, sub } — '' as base_domain goes
 * back to the legacy zone. Takes effect at once: dnsmasq.conf is rewritten
 * and dnsmasq restarted (no container restart).
 */
router.put('/vpn-names', (req, res) => {
  try {
    const body = req.body || {};
    const base = String(body.base_domain == null ? '' : body.base_domain).trim().toLowerCase();
    // The device names are part of the licence feature; going back to the
    // legacy zone is always possible.
    if (base && !hasFeature('internal_dns')) {
      return res.status(403).json({ ok: false, error: req.t('error.license.feature_not_available'), feature: 'internal_dns' });
    }
    const before = vpnNames.current().primary;
    const r = vpnNames.save(base, body.sub);
    if (!r.ok) return res.status(400).json(refusal(req, r, String(body.sub || '').trim().toLowerCase()));
    if (r.primary !== before) {
      activity.log('vpn_names_zone_changed', `Device names: ${before} → ${r.primary}`, {
        source: 'admin', ipAddress: req.ip, severity: 'info', details: { before, primary: r.primary, legacy: r.legacy },
      });
    }
    res.json({ ok: true, data: view() });
  } catch (err) {
    logger.warn({ err: err.message }, 'PUT /vpn-names failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

// Does the DNS service of the VPN answer, and does it know the primary zone?
//   running — answers `gateway.<primary>` with the gateway address
//   stale   — answers, but not for the primary zone (dnsmasq still runs with
//             an older dnsmasq.conf)
//   down    — no answer
//   off     — GC_DNS_ENABLED=false
async function probeService(primary) {
  if (!config.dns.enabled) return 'off';
  const [host, port] = String(process.env.GC_DNS_PROBE || '127.0.0.1').split('#');
  const resolver = new dnsPromises.Resolver({ timeout: 1500, tries: 1 });
  try {
    resolver.setServers([port ? `${host}:${port}` : host]);
    const addrs = await resolver.resolve4(`gateway.${primary}`);
    return addrs.includes(config.wireguard.gatewayIp) ? 'running' : 'stale';
  } catch (err) {
    // NXDOMAIN / no data: something answers on that port, but not for this zone
    if (err && (err.code === 'ENOTFOUND' || err.code === 'ENODATA' || err.code === 'ESERVFAIL' || err.code === 'EREFUSED')) return 'stale';
    return 'down';
  }
}

/**
 * GET /api/v1/settings/vpn-names/status — "Zustand der Namen": service, last
 * rewrite of the hosts file, what is in it, stale names, the fixed names.
 */
router.get('/vpn-names/status', async (req, res) => {
  try {
    const s = vpnNames.current();
    const db = getDb();
    const peerRow = db.prepare(`
      SELECT
        SUM(CASE WHEN hostname IS NOT NULL AND hostname != '' THEN 1 ELSE 0 END) AS named,
        SUM(CASE WHEN hostname IS NOT NULL AND hostname != '' AND hostname_source = 'stale' THEN 1 ELSE 0 END) AS stale
      FROM peers
    `).get();
    const routes = db.prepare("SELECT COUNT(DISTINCT domain) AS n FROM routes WHERE enabled = 1 AND domain IS NOT NULL AND domain != ''").get().n;
    let written = null;
    try { written = fs.statSync(config.dns.hostsFile).mtime.toISOString(); } catch { /* not written yet */ }
    const devices = (peerRow && peerRow.named) || 0;
    res.json({ ok: true, data: {
      service: await probeService(s.primary),
      written,
      entries: { total: devices + routes + 1, devices, routes, portal: 1 },
      stale: (peerRow && peerRow.stale) || 0,
      zones: s.zones,
      fixed: vpnNames.fixedRecords(),
    } });
  } catch (err) {
    logger.warn({ err: err.message }, 'GET /vpn-names/status failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

module.exports = router;
