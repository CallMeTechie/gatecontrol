'use strict';

const express = require('express');
const { requireGateway } = require('../../middleware/gatewayAuth');
const { gatewayApiLimiter, gatewayAuthLimiter, gatewayPairLimiter } = require('../../middleware/rateLimit');
const gateways = require('../../services/gateways');
const peers = require('../../services/peers');
const { hasFeature } = require('../../services/license');
const { isPrivateIpv4 } = require('../../utils/validate');
const logger = require('../../utils/logger');

const router = express.Router();

/**
 * POST /api/v1/gateway/pair — public, unauthenticated. Trades a one-shot
 * pairing code (issued by the dashboard's Gateway-Peer modal) for the
 * gateway.env content. Mounted BEFORE requireGateway so the installer
 * can call it without already having a token.
 *
 * Body: { "code": "XXXX-XXXX-XXXX-XXXX" }   — bare code, no @host suffix
 * On success: 200 + { ok: true, envContent: "<full gateway.env>" }
 * On invalid/expired/consumed: 400 + { ok: false, error: 'invalid_or_expired' }
 *
 * Rate-limited by gatewayPairLimiter (10/IP/5min).
 */
router.post('/pair', gatewayPairLimiter, express.json({ limit: '1kb' }), (req, res) => {
  const code = req.body && typeof req.body.code === 'string' ? req.body.code.trim().toUpperCase() : '';
  try {
    const { envContent } = gateways.redeemPairingCode(code, req.ip);
    res.json({ ok: true, envContent });
  } catch (err) {
    if (err.code === 'invalid_or_expired') {
      return res.status(400).json({ ok: false, error: 'invalid_or_expired' });
    }
    logger.error({ error: err.message }, 'Failed to redeem gateway pairing code');
    res.status(500).json({ ok: false, error: 'pair_failed' });
  }
});

router.use(gatewayAuthLimiter);
router.use(requireGateway);
router.use(gatewayApiLimiter);

/** GET /api/v1/gateway/config */
router.get('/config', (req, res) => {
  const peerId = req.gateway.peer_id;
  const cfg = gateways.getGatewayConfig(peerId);
  const hash = gateways.computeConfigHash(peerId);
  res.json({ ...cfg, config_hash: hash });
});

/** GET /api/v1/gateway/config/check?hash=sha256:... */
router.get('/config/check', (req, res) => {
  const peerId = req.gateway.peer_id;
  const clientHash = req.query.hash;
  const currentHash = gateways.computeConfigHash(peerId);
  if (clientHash === currentHash) {
    return res.status(304).end();
  }
  res.status(200).json({ config_hash: currentHash });
});

/** POST /api/v1/gateway/status — traffic counters */
router.post('/status', express.json({ limit: '4kb' }), (req, res) => {
  const peerId = req.gateway.peer_id;
  const { rx_bytes, tx_bytes, active_connections } = req.body || {};
  gateways.recordTrafficSnapshot(peerId, { rx_bytes, tx_bytes, active_connections });
  res.json({ ok: true });
});

/** POST /api/v1/gateway/probe — echo for end-to-end health-probe from Server */
router.post('/probe', express.json({ limit: '4kb' }), (req, res) => {
  const peerId = req.gateway.peer_id;
  // Der Gateway ruft diesen Endpoint als Teil seines End-to-End Self-Checks auf
  res.json({
    server_timestamp: Date.now(),
    peer_id: peerId,
    echo: req.body,
  });
});

/** POST /api/v1/gateway/heartbeat */
router.post('/heartbeat', express.json({ limit: '16kb' }), (req, res) => {
  const peerId = req.gateway.peer_id;
  const body = req.body || {};

  // Minimal type validation
  if (body.uptime_s !== undefined && typeof body.uptime_s !== 'number') {
    return res.status(400).json({ error: 'uptime_s must be number' });
  }
  if (body.tcp_listeners !== undefined && !Array.isArray(body.tcp_listeners)) {
    return res.status(400).json({ error: 'tcp_listeners must be array' });
  }
  if (body.http_proxy_healthy !== undefined && typeof body.http_proxy_healthy !== 'boolean') {
    return res.status(400).json({ error: 'http_proxy_healthy must be boolean' });
  }

  // Opportunistic hostname capture via heartbeat (feature: internal_dns).
  // Mirrors client.js heartbeat behaviour so a gateway peer shows up in the
  // internal DNS zone within one heartbeat cycle. Sticky-admin policy is
  // enforced inside setHostname (admin-source writes aren't overwritten).
  // Rate-limit hostname-change acceptance so a compromised gateway can't
  // spam activity-log entries + DNS rebuilds on every heartbeat: only
  // accept one hostname change per peer per minute and skip no-op writes.
  if (body.hostname && typeof body.hostname === 'string' && hasFeature('internal_dns')) {
    const now = Date.now();
    if (!peers._hostnameAcceptWindow) peers._hostnameAcceptWindow = new Map();
    const last = peers._hostnameAcceptWindow.get(peerId) || 0;
    if (now - last >= 60 * 1000) {
      try {
        const row = peers.getById ? peers.getById(peerId) : null;
        if (!row || row.hostname !== body.hostname) {
          peers.setHostname(peerId, body.hostname, 'agent');
          peers._hostnameAcceptWindow.set(peerId, now);
        }
      } catch (err) {
        logger.debug({ peerId, err: err.message }, 'Gateway heartbeat hostname rejected');
      }
    }
  }

  // Opportunistic LAN-IP capture. Used to rewrite a loopback X-Gateway-Target
  // to this gateway's real LAN address when one of its co-located routes has
  // failed over to a sibling (see caddyConfig loopback resolution). Only
  // accept RFC1918 private IPv4 — a heartbeat is authenticated but the value
  // is self-reported and becomes a forwarding target for OTHER gateways.
  // Write only on change to avoid needless churn.
  //
  // The companion nests all of collectTelemetry() under `telemetry`
  // (gateway bootstrap: `health.telemetry = collectTelemetry()`), so lan_ip
  // arrives as body.telemetry.lan_ip — a sibling of telemetry.lan_subnets /
  // telemetry.gateway_version. Read it there; keep a top-level fallback so a
  // companion that reports it at the root still works.
  const reportedLanIp = (body.telemetry && body.telemetry.lan_ip) || body.lan_ip;
  if (reportedLanIp && typeof reportedLanIp === 'string' && isPrivateIpv4(reportedLanIp.trim())) {
    const ip = reportedLanIp.trim();
    const db = require('../../db/connection').getDb();
    const cur = db.prepare('SELECT lan_ip FROM gateway_meta WHERE peer_id = ?').get(peerId);
    if (cur && cur.lan_ip !== ip) {
      db.prepare('UPDATE gateway_meta SET lan_ip = ? WHERE peer_id = ?').run(ip, peerId);
    }
  }

  gateways.handleHeartbeat(peerId, body);

  // UPS status in the telemetry (phase 3a): a change to battery / back is a notice
  try { require('../../services/inetq').onHeartbeat(peerId, body); } catch (err) {
    logger.warn({ err: err.message, peerId }, 'UPS status not processed');
  }

  // Persist companion-reported config_hash so the pool-mutation
  // confirm-loop in gatewayPoolSync can detect when companions have
  // applied a new config. Companion sends config_hash in heartbeat
  // payload.
  if (req.body && typeof req.body.config_hash === 'string') {
    require('../../db/connection').getDb()
      .prepare('UPDATE gateway_meta SET last_config_hash = ? WHERE peer_id = ?')
      .run(req.body.config_hash, peerId);
  }

  // Event-driven pool-aware evaluation
  const gatewayHealth = require('../../services/gatewayHealth');
  gatewayHealth.onHeartbeatReceived(peerId).catch(err => {
    require('../../utils/logger').warn({ err: err.message, peerId }, 'gatewayHealth.onHeartbeatReceived failed');
  });

  // Live state (online again after an outage, an update or a restart): push
  // the change to open pages at once instead of waiting for their poll.
  try { require('../../services/gatewayLiveState').publishChanges([peerId]); } catch (err) {
    logger.debug({ err: err.message, peerId }, 'gateway live state publish failed');
  }

  res.status(200).json({ ok: true });
});

/**
 * POST /api/v1/gateway/going-down — the gateway stops right now (graceful
 * shutdown: container recreated for an update, docker restart, host reboot).
 * Body: { reason: 'update' | 'restart' }. The pages show "Update läuft" /
 * "startet neu" at once instead of "online" until the heartbeat goes stale and
 * "offline" after that (services/gatewayLiveState.js). The next heartbeat ends
 * it. Routing is not touched: failover still waits for the down threshold.
 * Gateways before this endpoint simply never call it.
 */
router.post('/going-down', express.json({ limit: '1kb' }), (req, res) => {
  const peerId = req.gateway.peer_id;
  const reason = req.body && req.body.reason === 'update' ? 'update' : 'restart';
  const liveState = require('../../services/gatewayLiveState');
  const r = liveState.recordGoingDown(peerId, reason);
  require('../../services/activity').log('gateway_going_down',
    `Gateway ${req.gateway.peer_name || peerId} is stopping (${r.reason === 'update' ? 'update' : 'restart'})`,
    { source: 'system', severity: 'info', details: { peerId, reason: r.reason } });
  try { liveState.publishChanges([peerId]); } catch (err) {
    logger.debug({ err: err.message, peerId }, 'gateway live state publish failed');
  }
  res.status(200).json({ ok: true, reason: r.reason });
});

/** POST /api/v1/gateway/discovery — LAN-scan results stream from the gateway. */
router.post('/discovery', express.json({ limit: '512kb' }), (req, res) => {
  const peerId = req.gateway.peer_id;
  const { request_id, devices, done } = req.body || {};
  if (typeof request_id !== 'string' || !request_id) return res.status(400).json({ error: 'request_id_required' });
  const r = require('../../services/discoveryCache').ingest(peerId, request_id, devices, done === true);
  if (!r.accepted) return res.status(202).json({ ok: true, accepted: false, reason: r.reason }); // dropped (stale/rate) — not an error
  const snap = require('../../services/discoveryCache').get(peerId);
  // Scoped to admin SSE sessions (the /api/v1/events stream is requireAuth-only);
  // the UI filters by peer_id. Spec §5.3.
  require('../../services/eventBus').publish('gateway_discovery', {
    peer_id: peerId, request_id, devices: snap.devices, done: snap.done, timed_out: snap.timed_out,
  });
  res.status(200).json({ ok: true });
});

// ─── Phase 3a: network watch, internet quality, presence, speed test ───────
// (contract "Phase 3a", services/netwatch.js, inetq.js, homePresence.js).
// Bodies are checked by the services; a wrong shape → 400 { error }.

function phase3a(fn) {
  return (req, res) => {
    try {
      res.json({ ok: true, ...fn(req.gateway.peer_id, req.body || {}) });
    } catch (err) {
      if (err && (err.code === 'invalid' || err.code === 'ERR_INVALID' || err.code === 'invalid_domain')) return res.status(400).json({ ok: false, error: err.message });
      logger.error({ err: err && err.message, peerId: req.gateway.peer_id }, 'gateway phase 3a report failed');
      return res.status(500).json({ ok: false, error: 'internal' });
    }
  };
}

/** POST /api/v1/gateway/netwatch — { scanAt, full, devices: [...] } */
router.post('/netwatch', express.json({ limit: '1mb' }), phase3a((peerId, body) => {
  const r = require('../../services/netwatch').ingest(peerId, body);
  return { devices: r.devices };
}));

/** POST /api/v1/gateway/inetq — { samples, outages, speedtests } */
router.post('/inetq', express.json({ limit: '512kb' }), phase3a((peerId, body) => {
  require('../../services/inetq').ingest(peerId, body);
  return {};
}));

/** POST /api/v1/gateway/presence — { events: [{ mac, online, at }] } */
router.post('/presence', express.json({ limit: '64kb' }), phase3a((peerId, body) => {
  require('../../services/homePresence').ingest(peerId, body);
  return {};
}));

/** GET /api/v1/gateway/speedtest/down?bytes=N — random bytes (≤ 100 MB), streamed */
router.get('/speedtest/down', (req, res) => require('../../services/inetq').speedDown(req, res));

/** POST /api/v1/gateway/speedtest/up — counted and discarded (≤ 100 MB) */
router.post('/speedtest/up', (req, res) => require('../../services/inetq').speedUp(req, res));

// ─── Phase 3b: DNS filter statistics, home cache ──────────────────────────
// (contract "Phase 3b", services/homeDns.js, homeCache.js)

/** POST /api/v1/gateway/dns — { period: { from, to }, queries, blocked, cached, avgMs, topBlocked, byProfile, clientsSeen } */
router.post('/dns', express.json({ limit: '256kb' }), phase3a((peerId, body) => {
  require('../../services/homeDns').ingest(peerId, body);
  return {};
}));

/** GET /api/v1/gateway/cache/want — the stock this gateway should keep (ETag) */
router.get('/cache/want', (req, res) => {
  try {
    const w = require('../../services/homeCache').want(req.gateway.peer_id);
    res.set('ETag', w.etag);
    res.set('Cache-Control', 'no-cache');
    if (req.headers['if-none-match'] === w.etag) return res.status(304).end();
    return res.json({ ok: true, maxBytes: w.maxBytes, items: w.items });
  } catch (err) {
    logger.error({ err: err && err.message, peerId: req.gateway.peer_id }, 'home cache want failed');
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

/** GET /api/v1/gateway/cache/blob/<sha256> — one blob of its stock, streamed (Range) */
router.get('/cache/blob/:sha', async (req, res) => {
  try { await require('../../services/homeCache').sendBlob(req.gateway.peer_id, req.params.sha, req, res); } catch (err) {
    logger.error({ err: err && err.message, peerId: req.gateway.peer_id }, 'home cache blob failed');
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'internal' });
  }
});

/** POST /api/v1/gateway/cache — { have, gone?, full?, usedBytes, hits, misses, bytesServed, bytesFetched } */
router.post('/cache', express.json({ limit: '1mb' }), phase3a((peerId, body) => {
  require('../../services/homeCache').report(peerId, body);
  return {};
}));

// ─── Phase 3c: Drucken & Scannen (contract "Phase 3c", services/homePrint.js) ──

const print = () => require('../../services/homePrint');

function printFail(res, err, peerId) {
  const code = err && err.code;
  const status = { invalid: 400, not_found: 404, unsupported_type: 415, length_required: 411, too_large: 413, quota: 507 }[code];
  if (status) return res.status(status).json({ ok: false, error: code });
  logger.error({ err: err && err.message, peerId }, 'gateway print report failed');
  return res.status(500).json({ ok: false, error: 'internal' });
}

/** POST /api/v1/gateway/print/devices — { scannedAt, devices: [...] } (the complete list) */
router.post('/print/devices', express.json({ limit: '256kb' }), (req, res) => {
  try { res.json({ ok: true, ...print().ingestDevices(req.gateway.peer_id, req.body || {}) }); } catch (err) { printFail(res, err, req.gateway.peer_id); }
});

/** POST /api/v1/gateway/radio/ble — { scannedAt, adapter, sensors: [...] } (phase 3c, step 2: the Bluetooth sensors it hears) */
router.post('/radio/ble', express.json({ limit: '64kb' }), (req, res) => {
  try {
    res.json({ ok: true, ...require('../../services/homeRadio').ingestBle(req.gateway.peer_id, req.body || {}) });
  } catch (err) {
    if (err && err.code === 'invalid') return res.status(400).json({ ok: false, error: 'invalid' });
    logger.error({ err: err && err.message, peerId: req.gateway.peer_id }, 'gateway radio report failed');
    res.status(500).json({ ok: false, error: 'internal' });
  }
});

/** POST /api/v1/gateway/radio/zigbee — { stack: 'zigbee2mqtt', devices: [...] } (the complete device list of its zigbee2mqtt) */
router.post('/radio/zigbee', express.json({ limit: '256kb' }), (req, res) => {
  try {
    res.json({ ok: true, ...require('../../services/homeRadio').ingestZigbee(req.gateway.peer_id, req.body || {}) });
  } catch (err) {
    if (err && err.code === 'invalid') return res.status(400).json({ ok: false, error: 'invalid' });
    logger.error({ err: err && err.message, peerId: req.gateway.peer_id }, 'gateway zigbee report failed');
    res.status(500).json({ ok: false, error: 'internal' });
  }
});

/** GET /api/v1/gateway/radio/ble/keys — the keys of this gateway's encrypted Bluetooth sensors (never logged, never cached) */
router.get('/radio/ble/keys', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { return res.json(require('../../services/homeRadio').keysFor(req.gateway.peer_id)); } catch (err) {
    logger.error({ err: err && err.message, peerId: req.gateway.peer_id }, 'gateway radio keys failed');
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

// ─── Phase 3c, step 4: Kameras (the gateway's docs/cameras.md §2, services/homeCameras.js) ──

const cams = () => require('../../services/homeCameras');

function camFail(res, err, peerId) {
  if (err && err.code === 'invalid') return res.status(400).json({ ok: false, error: 'invalid' });
  logger.error({ err: err && err.message, peerId }, 'gateway camera report failed');
  return res.status(500).json({ ok: false, error: 'internal' });
}

/** GET /api/v1/gateway/cameras/credentials — user and password of this gateway's cameras (never logged, never cached) */
router.get('/cameras/credentials', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { return res.json(cams().credentialsFor(req.gateway.peer_id)); } catch (err) { return camFail(res, err, req.gateway.peer_id); }
});

// ─── Phase 3c, step 3: Lokale KI — the API key of the LAN server (services/ai/local.js) ──

/** GET /api/v1/gateway/ai/credentials — { rev, key } only for the gateway that forwards to the LAN server (never logged, never cached) */
router.get('/ai/credentials', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { return res.json(require('../../services/ai/local').credentialsFor(req.gateway.peer_id)); } catch (err) {
    logger.error({ err: err && err.message, peerId: req.gateway.peer_id }, 'gateway AI credentials failed');
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

/** POST /api/v1/gateway/cameras/report — { at, service, storage, cameras: [...] } */
router.post('/cameras/report', express.json({ limit: '64kb' }), (req, res) => {
  try { res.json({ ok: true, ...cams().ingestReport(req.gateway.peer_id, req.body || {}) }); } catch (err) { camFail(res, err, req.gateway.peer_id); }
});

/** POST /api/v1/gateway/cameras/events — { events: [...] } (≤ 32) */
router.post('/cameras/events', express.json({ limit: '64kb' }), (req, res) => {
  try { res.json({ ok: true, ...cams().ingestEvents(req.gateway.peer_id, req.body || {}) }); } catch (err) { camFail(res, err, req.gateway.peer_id); }
});

/** GET /api/v1/gateway/print/jobs — the open jobs of this gateway (ETag) */
router.get('/print/jobs', (req, res) => {
  try {
    const q = print().queueFor(req.gateway.peer_id);
    res.set('ETag', q.etag);
    res.set('Cache-Control', 'no-cache');
    if (req.headers['if-none-match'] === q.etag) return res.status(304).end();
    return res.json({ ok: true, jobs: q.jobs });
  } catch (err) { return printFail(res, err, req.gateway.peer_id); }
});

/** GET /api/v1/gateway/print/jobs/:id/file — the file of an open job of this gateway */
router.get('/print/jobs/:id/file', (req, res) => {
  try { print().sendFile(req.gateway.peer_id, req.params.id, res); } catch (err) { if (!res.headersSent) printFail(res, err, req.gateway.peer_id); }
});

/** POST /api/v1/gateway/print/jobs/:id — { state, error?, message?, ippJobId? } */
router.post('/print/jobs/:id', express.json({ limit: '4kb' }), (req, res) => {
  try { res.json({ ok: true, ...print().jobReport(req.gateway.peer_id, req.params.id, req.body || {}) }); } catch (err) { printFail(res, err, req.gateway.peer_id); }
});

/** PUT /api/v1/gateway/print/scans/:id/pages/:n — one scanned page (raw body, ≤ 50 MB) */
router.put('/print/scans/:id/pages/:n', async (req, res) => {
  try { res.json({ ok: true, ...(await print().storePage(req.gateway.peer_id, req.params.id, req.params.n, req)) }); } catch (err) {
    if (!res.headersSent) printFail(res, err, req.gateway.peer_id);
    req.resume();
  }
});

/** POST /api/v1/gateway/print/scans/:id — { state: scanning | done | failed, pages?, error? } */
router.post('/print/scans/:id', express.json({ limit: '4kb' }), (req, res) => {
  try { res.json({ ok: true, ...print().scanReport(req.gateway.peer_id, req.params.id, req.body || {}) }); } catch (err) { printFail(res, err, req.gateway.peer_id); }
});

/** GET /api/v1/gateway/print/ocr/:id/pages/:n — a page of an open text recognition of this gateway (JPEG/PNG) */
router.get('/print/ocr/:id/pages/:n', async (req, res) => {
  try { await print().ocrPage(req.gateway.peer_id, req.params.id, req.params.n, res); } catch (err) { if (!res.headersSent) printFail(res, err, req.gateway.peer_id); }
});

/** PUT /api/v1/gateway/print/ocr/:id/document|text — the searchable PDF (≤ 100 MB) or the recognised text (≤ 1 MB) */
router.put('/print/ocr/:id/:kind', async (req, res) => {
  try { res.json({ ok: true, ...(await print().storeOcr(req.gateway.peer_id, req.params.id, req.params.kind, req)) }); } catch (err) {
    if (!res.headersSent) printFail(res, err, req.gateway.peer_id);
    req.resume();
  }
});

/** POST /api/v1/gateway/print/ocr/:id — { state: running | done | failed, page?, pages?, error? } */
router.post('/print/ocr/:id', express.json({ limit: '4kb' }), (req, res) => {
  try { res.json({ ok: true, ...print().ocrReport(req.gateway.peer_id, req.params.id, req.body || {}) }); } catch (err) { printFail(res, err, req.gateway.peer_id); }
});

/**
 * GET /api/v1/gateway/edge/packages/:id/:version — the signed package of a
 * plugin's edge part, byte for byte as installed (its sha256 is in the
 * `state` of the edge channel). Only for a gateway this plugin is switched on
 * for (docs/plugins.md "Edge part"); the gateway verifies the signature itself.
 */
router.get('/edge/packages/:id/:version', (req, res) => {
  const peerId = req.gateway.peer_id;
  // 1. the path parameters (never req.query): plain strings of the expected shape
  const { ID_RE } = require('../../services/plugins/constants');
  const askedId = req.params.id;
  const askedVersion = req.params.version;
  if (typeof askedId !== 'string' || typeof askedVersion !== 'string') return res.status(400).json({ error: 'invalid_request' });
  if (!ID_RE.test(askedId) || askedId.length > 64 || !/^[0-9A-Za-z.+-]{1,64}$/.test(askedVersion)) return res.status(404).json({ error: 'not_found' });
  // 2. the assignment of THIS gateway for that plugin, from the database — the request values are only compared,
  //    every later step (rules, registry, file) uses the stored ones
  const row = require('../../services/edge/store').assignmentsOfGateway(peerId).find((a) => a.pluginId === askedId);
  if (!row) return res.status(403).json({ error: 'not_enabled', reason: 'not_assigned' });
  const eff = require('../../services/edge/state').effective(row.pluginId, peerId);
  if (!eff.ok) return res.status(403).json({ error: 'not_enabled', reason: eff.reason });
  const plugin = eff.plugin; // the registry entry of row.pluginId
  if (plugin.version !== askedVersion) return res.status(404).json({ error: 'version_not_installed', installed: plugin.version });
  // 3. the file only from the registry entry (id and installed version)
  let pk;
  try { pk = require('../../services/edge/packages').open(plugin.id, plugin.version); } catch (e) {
    logger.warn({ plugin: plugin.id, err: e.message }, 'edge package not readable');
    return res.status(500).json({ error: 'package_unavailable' });
  }
  if (!pk) return res.status(404).json({ error: 'not_found' });
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(pk.size),
    'Content-Disposition': `attachment; filename="${plugin.id}-${plugin.version}.gcplugin"`,
    'X-Content-SHA256': pk.sha256,
    ETag: `"${pk.sha256}"`,
    'Cache-Control': 'no-store',
  });
  // streamed from the descriptor that was measured and hashed (closed at the end)
  require('node:fs').createReadStream(null, { fd: pk.fd, start: 0, end: Math.max(0, pk.size - 1), autoClose: true })
    .on('error', () => res.destroy()).pipe(res);
});

module.exports = router;
