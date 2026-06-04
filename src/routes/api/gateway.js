'use strict';

const express = require('express');
const { requireGateway } = require('../../middleware/gatewayAuth');
const { gatewayPairLimiter } = require('../../middleware/rateLimit');
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
 * Rate-limited by gatewayPairLimiter (10/IP/5min) on top of the apiLimiter
 * the parent router already applies.
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

router.use(requireGateway);

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
  if (body.lan_ip && typeof body.lan_ip === 'string' && isPrivateIpv4(body.lan_ip.trim())) {
    const ip = body.lan_ip.trim();
    const db = require('../../db/connection').getDb();
    const cur = db.prepare('SELECT lan_ip FROM gateway_meta WHERE peer_id = ?').get(peerId);
    if (cur && cur.lan_ip !== ip) {
      db.prepare('UPDATE gateway_meta SET lan_ip = ? WHERE peer_id = ?').run(ip, peerId);
    }
  }

  gateways.handleHeartbeat(peerId, body);

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

  res.status(200).json({ ok: true });
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

module.exports = router;
