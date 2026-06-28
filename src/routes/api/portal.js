// src/routes/api/portal.js
'use strict';
const { Router } = require('express');
const peers = require('../../services/peers');
const routesSvc = require('../../services/routes');
const caddyAcl = require('../../services/caddyAcl');
const { getDb } = require('../../db/connection');
const logger = require('../../utils/logger');
const portalConfig = require('../../services/portalConfig');
const pihole = require('../../services/pihole');
const license = require('../../services/license');
const mideaOwners = require('../../services/midea/mideaOwners');
const midea = require('../../services/midea');
const mideaDevices = require('../../services/midea/mideaDevices');

const router = Router();

// Master portal gate — 404 if the portal is disabled globally.
router.use((req, res, next) => {
  if (!portalConfig().enabled) return res.status(404).json({ ok: false });
  next();
});

function unidentified(res) {
  return res.json({ ok: true, data: null, reason: 'unidentified' });
}

function piholeUnavailable(cache) {
  return !license.hasFeature('pihole_integration') || !cache.instances || cache.instances.length === 0;
}

function mideaUnavailable() {
  return !license.hasFeature('midea_integration') || mideaDevices.listDevices().length === 0;
}
// Redact to portal-safe fields only (drop cloud_appliance_id / any secrets).
function redactMideaDevice(id) {
  const d = mideaDevices.getDevice(id);
  return d ? { id: d.id, name: d.name, transport: d.transport } : null;
}

const MIDEA_MODES = new Set(['auto', 'cool', 'heat', 'dry', 'fan']);
// Whitelist + range/type-check; returns a clean patch or null (→ 400). At least one valid field required.
function validateMideaPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const patch = {};
  if ('power' in raw) { if (typeof raw.power !== 'boolean') return null; patch.power = raw.power; }
  if ('targetTemp' in raw) { const t = Number(raw.targetTemp); if (!Number.isFinite(t) || t < 16 || t > 30) return null; patch.targetTemp = t; }
  if ('mode' in raw) { if (!MIDEA_MODES.has(raw.mode)) return null; patch.mode = raw.mode; }
  return Object.keys(patch).length ? patch : null;
}

// Convert JS Date to 'YYYY-MM-DD HH:MM:SS' (UTC, no ms) for comparison
// with SQLite's datetime('now') output format.
function toSQLite(date) {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

router.get('/device', async (req, res) => {
  try {
    if (!portalConfig().widgets.device) return res.status(404).json({ ok: false });
    if (req.portalPeerId == null) return unidentified(res);
    // Use a high limit so any identified peer is found regardless of total peer count.
    const all = await peers.getAll({ limit: 1000000 }); // async — merges live wg status
    const p = all.find(x => x.id === req.portalPeerId);
    if (!p) return unidentified(res);
    res.json({ ok: true, data: {
      id: p.id,
      name: p.name,
      isOnline: p.isOnline,
      latestHandshake: p.latestHandshake,
      transferRx: p.transferRx,
      transferTx: p.transferTx,
      allowed_ips: p.allowed_ips,
      dns: p.dns,
    } });
  } catch (err) {
    logger.error({ error: err.message }, 'portal /device failed');
    return unidentified(res);
  }
});

router.get('/traffic', (req, res) => {
  try {
    if (!portalConfig().widgets.traffic) return res.status(404).json({ ok: false });
    if (req.portalPeerId == null) return unidentified(res);
    const p = peers.getById(req.portalPeerId); // sync
    if (!p) return unidentified(res);
    const db = getDb();
    const peerId = Number(req.portalPeerId);

    // Period totals (back-compat)
    const periods = [
      ['last24h', '-24 hours'],
      ['last7d', '-7 days'],
      ['last30d', '-30 days'],
    ];
    const traffic = { total: { rx: p.total_rx || 0, tx: p.total_tx || 0 } };
    for (const [key, interval] of periods) {
      const row = db.prepare(`
        SELECT COALESCE(SUM(download_bytes),0) rx, COALESCE(SUM(upload_bytes),0) tx
        FROM peer_traffic_snapshots WHERE peer_id = ? AND recorded_at >= datetime('now', ?)
      `).get(peerId, interval);
      traffic[key] = { rx: row.rx, tx: row.tx };
    }

    // Time-series buckets — stable counts regardless of data density.
    // Shape: { t: ISO-string (bucket start), rx: number, tx: number }
    // Buckets with no data → rx:0, tx:0 (axis stability).
    //
    // Prepare once; called 8 + 7 + 5 = 20 times — all parameterised.
    const bucketStmt = db.prepare(`
      SELECT COALESCE(SUM(download_bytes), 0) rx, COALESCE(SUM(upload_bytes), 0) tx
      FROM peer_traffic_snapshots
      WHERE peer_id = ? AND recorded_at >= ? AND recorded_at < ?
    `);
    function buildSeries(startMs, count, widthMs) {
      return Array.from({ length: count }, (_, i) => {
        const s = new Date(startMs + i * widthMs);
        const e = new Date(startMs + (i + 1) * widthMs);
        const row = bucketStmt.get(peerId, toSQLite(s), toSQLite(e));
        return { t: s.toISOString(), rx: row.rx, tx: row.tx };
      });
    }
    const nowMs = Date.now();
    const H = 3600000;   // 1 h in ms
    const D = 86400000;  // 1 d in ms
    traffic.series = {
      '24h': buildSeries(nowMs - 24 * H, 8, 3 * H),  // 8 x 3 h
      '7d':  buildSeries(nowMs - 7 * D,  7, D),       // 7 x 1 d
      '30d': buildSeries(nowMs - 30 * D, 5, 6 * D),   // 5 x 6 d
    };

    res.json({ ok: true, data: traffic });
  } catch (err) {
    logger.error({ error: err.message }, 'portal /traffic failed');
    return unidentified(res);
  }
});

router.get('/services', (req, res) => {
  try {
    if (!portalConfig().widgets.services) return res.status(404).json({ ok: false });
    if (req.portalPeerId == null) return unidentified(res);
    const all = routesSvc.getAll().filter(r => r.enabled && r.route_type === 'http');
    const visible = all.filter(r => {
      if (!r.acl_enabled) return true; // open route — always reachable
      const aclPeers = caddyAcl.getAclPeers(r.id) || [];
      return aclPeers.some(p => p.peer_id === req.portalPeerId);
    }).map(r => ({
      id: r.id,
      name: r.description || r.domain,
      domain: r.domain,
      kind: 'http',
    }));
    res.json({ ok: true, data: visible });
  } catch (err) {
    logger.error({ error: err.message }, 'portal /services failed');
    return unidentified(res);
  }
});

router.get('/pihole', (req, res) => {
  try {
    if (!portalConfig().widgets.pihole) return res.status(404).json({ ok: false });
    // Reuse the existing Pro feature gate; INLINE (not requireFeature middleware) so the
    // frontend gets a clean "hide" signal (data:null) instead of a 403.
    const cache = pihole.getCache();
    if (piholeUnavailable(cache)) {
      return res.json({ ok: true, data: null, reason: 'unavailable' });
    }
    if (req.portalPeerId == null) return unidentified(res); // reuse the existing helper (siblings do too)
    if (cache.attribution === 'collapsed') return res.json({ ok: true, data: null, reason: 'collapsed' });

    const pid = req.portalPeerId;
    const allowedEntry = (cache.topClients || []).find(c => c.peerId === pid);
    const blockedEntry = (cache.topClientsBlocked || []).find(c => c.peerId === pid);
    // Device present in NEITHER top-N list → no_data. Do NOT fake zeros (would lie that
    // Pi-hole saw this device). Keep this null-check — do not collapse back to flat 0.
    if (!allowedEntry && !blockedEntry) return res.json({ ok: true, data: null, reason: 'no_data' });

    const allowed = allowedEntry ? allowedEntry.count : 0;
    const blocked = blockedEntry ? blockedEntry.count : 0;
    const total = allowed + blocked;
    const blockedPct = total ? Math.round((blocked / total) * 100) : 0;
    res.json({ ok: true, data: { total, blocked, allowed, blockedPct, asOf: cache.lastSyncAt } });
  } catch (err) {
    logger.error({ error: err.message }, 'portal /pihole failed');
    // intentional: a service/cache error is 'unavailable', NOT 'unidentified'
    return res.json({ ok: true, data: null, reason: 'unavailable' });
  }
});

router.get('/pihole/owner', (req, res) => {
  try {
    if (!portalConfig().widgets.pihole) return res.status(404).json({ ok: false });
    const cache = pihole.getCache();
    if (piholeUnavailable(cache)) {
      return res.json({ ok: true, data: null, reason: 'unavailable' });
    }
    if (req.portalOwnerId == null) return res.json({ ok: true, data: null, reason: 'no_owner' });
    if (cache.attribution === 'collapsed') return res.json({ ok: true, data: null, reason: 'collapsed' });
    const ownerPeerIds = new Set(peers.peersOfOwner(req.portalOwnerId)); // owner id NEVER from req body/query
    let allowed = 0;
    let blocked = 0;
    const seen = new Set();
    for (const c of (cache.topClients || [])) {
      if (ownerPeerIds.has(c.peerId)) { allowed += c.count; seen.add(c.peerId); }
    }
    for (const c of (cache.topClientsBlocked || [])) {
      if (ownerPeerIds.has(c.peerId)) { blocked += c.count; seen.add(c.peerId); }
    }
    if (seen.size === 0) return res.json({ ok: true, data: null, reason: 'no_data' });
    const total = allowed + blocked;
    const blockedPct = total ? Math.round((blocked / total) * 100) : 0;
    res.json({ ok: true, data: { total, blocked, allowed, blockedPct, deviceCount: seen.size, asOf: cache.lastSyncAt } });
  } catch (err) {
    logger.error({ error: err.message }, 'portal /pihole/owner failed');
    return res.json({ ok: true, data: null, reason: 'unavailable' });
  }
});

router.get('/pihole/household', (req, res) => {
  try {
    if (!portalConfig().widgets.pihole) return res.status(404).json({ ok: false });
    const cache = pihole.getCache();
    if (piholeUnavailable(cache)) {
      return res.json({ ok: true, data: null, reason: 'unavailable' });
    }
    if (!req.portalLoggedIn) return res.json({ ok: true, data: null, reason: 'login_required' }); // trust switch never relaxes household
    const s = cache.summary;
    if (!s || !s.queries) return res.json({ ok: true, data: null, reason: 'unavailable' });
    const total = s.queries.total || 0, blocked = s.queries.blocked || 0;
    const blockedPct = total ? Math.round((blocked / total) * 100) : 0;
    res.json({ ok: true, data: { total, blocked, blockedPct, activeClients: (s.clients && s.clients.active != null) ? s.clients.active : null, asOf: cache.lastSyncAt } });
  } catch (err) {
    logger.error({ error: err.message }, 'portal /pihole/household failed');
    return res.json({ ok: true, data: null, reason: 'unavailable' });
  }
});

// GET /midea — owner-scoped device list (trust allowed). Owner id from middleware only.
router.get('/midea', async (req, res) => {
  try {
    if (!portalConfig().widgets.midea) return res.status(404).json({ ok: false });
    if (mideaUnavailable()) return res.json({ ok: true, data: null, reason: 'unavailable' });
    if (req.portalOwnerId == null) return res.json({ ok: true, data: null, reason: 'no_owner' });
    const ids = mideaOwners.devicesOwnedBy(req.portalOwnerId);
    if (!ids.length) return res.json({ ok: true, data: null, reason: 'no_data' });
    // Parallel live state — O(1) roundtrip; per-device offline never aborts the list.
    const states = await Promise.all(ids.map((id) => midea.getState(id).catch(() => ({ offline: true }))));
    const devices = ids.map((id, i) => {
      const d = redactMideaDevice(id);
      return d ? { ...d, state: states[i] } : null;
    }).filter(Boolean);
    res.json({ ok: true, data: { devices, loggedIn: req.portalLoggedIn } });
  } catch (err) {
    logger.error({ error: err.message }, 'portal /midea failed');
    return res.json({ ok: true, data: null, reason: 'unavailable' });
  }
});

// GET /midea/:id/state — single-card refresh for the auto-poll (trust allowed, read-only).
router.get('/midea/:id/state', async (req, res) => {
  try {
    if (!portalConfig().widgets.midea) return res.status(404).json({ ok: false });
    if (!license.hasFeature('midea_integration')) return res.json({ ok: true, data: null, reason: 'unavailable' });
    const id = Number(req.params.id);
    if (!mideaOwners.isOwner(id, req.portalOwnerId)) return res.status(403).json({ ok: false, error: 'MIDEA_NOT_OWNER' });
    const state = await midea.getState(id); // {offline:true} is a known state → passes through
    res.json({ ok: true, data: { state } });
  } catch (err) {
    logger.error({ error: err.message }, 'portal /midea state failed');
    return res.json({ ok: true, data: null, reason: 'unavailable' });
  }
});

// POST /midea/:id/state — control. Login-required (trust does NOT control) + isOwner.
router.post('/midea/:id/state', async (req, res) => {
  try {
    if (!portalConfig().widgets.midea) return res.status(404).json({ ok: false });
    if (!license.hasFeature('midea_integration')) return res.json({ ok: true, data: null, reason: 'unavailable' });
    if (!req.portalLoggedIn) return res.json({ ok: true, data: null, reason: 'login_required' });
    const id = Number(req.params.id);
    if (!mideaOwners.isOwner(id, req.session.userId)) return res.status(403).json({ ok: false, error: 'MIDEA_NOT_OWNER' });
    const patch = validateMideaPatch(req.body && req.body.patch);
    if (!patch) return res.status(400).json({ ok: false, error: 'MIDEA_INVALID_PATCH' });
    const state = await midea.setState(id, patch);
    if (!state || state.offline) return res.json({ ok: true, data: null, reason: 'unavailable' });
    res.json({ ok: true, data: { state } });
  } catch (err) {
    logger.error({ error: err.message }, 'portal /midea control failed');
    return res.json({ ok: true, data: null, reason: 'unavailable' });
  }
});

module.exports = router;
