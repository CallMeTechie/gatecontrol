'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { getDb } = require('../db/connection');
const { encrypt, decrypt } = require('../utils/crypto');
const { hashToken } = require('../middleware/gatewayAuth');
const license = require('./license');
const peers = require('./peers');
const activity = require('./activity');
const email = require('./email');
const webhook = require('./webhook');
const { StateMachine } = require('./gatewayHealth');
const logger = require('../utils/logger');
const {
  computeConfigHash: libComputeConfigHash,
  CONFIG_HASH_VERSION,
} = require('@callmetechie/gatecontrol-config-hash');

/** Extract the bare IP (drop CIDR) from peers.allowed_ips. */
function _peerIp(allowedIps) {
  return (allowedIps || '').split('/')[0].split(',')[0].trim();
}

const _smCache = new Map(); // peerId → StateMachine

function _getSm(peerId) {
  let sm = _smCache.get(peerId);
  if (!sm) {
    sm = new StateMachine();
    _smCache.set(peerId, sm);
  }
  return sm;
}

const DEFAULT_API_PORT = 9876;

/**
 * Generate cryptographically-random tokens and hashes.
 */
function generateTokens() {
  const apiTokenRaw = crypto.randomBytes(32).toString('hex');
  const apiToken = `gc_gw_${apiTokenRaw}`;
  const apiTokenHash = hashToken(apiToken);

  const pushToken = crypto.randomBytes(32).toString('hex');
  const pushTokenEncrypted = encrypt(pushToken);

  return { apiToken, apiTokenHash, pushToken, pushTokenEncrypted };
}

/**
 * Create a Gateway-Peer with its metadata. Enforces license limit gateway_peers.
 * Returns { peer, apiToken, pushToken } (plaintext tokens only shown ONCE at creation
 * for inclusion in gateway.env file).
 *
 * ASYNC because peers.create() generates WireGuard keys asynchronously.
 */
async function createGateway({ name, apiPort = DEFAULT_API_PORT }) {
  const db = getDb();

  const limit = license.getFeatureLimit('gateway_peers');
  const current = db.prepare("SELECT COUNT(*) AS n FROM peers WHERE peer_type='gateway'").get().n;
  if (limit !== -1 && current >= limit) {
    throw new Error(`License limit reached: gateway_peers=${limit} (current=${current})`);
  }

  // peers.create() is the existing async factory — we extend its param list to accept peerType
  const peer = await peers.create({ name, peerType: 'gateway' });

  const { apiToken, apiTokenHash, pushToken, pushTokenEncrypted } = generateTokens();

  db.prepare(`
    INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(peer.id, apiPort, apiTokenHash, pushTokenEncrypted, Date.now());

  logger.info({ peerId: peer.id, peerName: name, apiPort }, 'Gateway created');

  return { peer, apiToken, pushToken };
}

/**
 * Build the gateway-config payload sent to a Gateway on poll.
 * Includes all HTTP + L4 routes with target_peer_id=peerId.
 */
function getGatewayConfig(peerId) {
  const db = getDb();

  const httpRoutes = db.prepare(`
    SELECT id, domain, target_kind, target_lan_host, target_lan_port,
           backend_https, wol_enabled, wol_mac
    FROM routes
    WHERE target_peer_id = ? AND target_kind = 'gateway' AND enabled = 1
      AND (route_type = 'http' OR route_type IS NULL)
    ORDER BY id
  `).all(peerId);

  const l4Routes = db.prepare(`
    SELECT id, l4_listen_port AS listen_port, target_lan_host, target_lan_port,
           wol_enabled, wol_mac
    FROM routes
    WHERE target_peer_id = ? AND target_kind = 'gateway' AND enabled = 1
      AND route_type = 'l4'
    ORDER BY id
  `).all(peerId);

  return {
    config_hash_version: CONFIG_HASH_VERSION,
    peer_id: peerId,
    routes: httpRoutes.map(r => ({
      id: r.id,
      domain: r.domain,
      target_kind: r.target_kind,
      target_lan_host: r.target_lan_host,
      target_lan_port: r.target_lan_port,
      // LAN-side scheme. When set, the gateway speaks https:// to the
      // LAN target (with cert verification disabled — self-signed is
      // the LAN norm). Omitted from the JSON when false so config-hash
      // stays byte-identical for the common case and older gateways
      // without support don't diverge.
      ...(r.backend_https ? { backend_https: true } : {}),
      // Derive protocol strictly from backend_https — never read
      // l4_protocol here even if the row has a stale value from a
      // route_type=l4 → http transition. The shared config-hash schema
      // requires 'http'|'https' for HTTP routes; a leftover 'tcp' would
      // throw ZodError, /api/v1/gateway/config returns 500, and the
      // gateway never picks up the new route → "No route for domain X".
      protocol: r.backend_https ? 'https' : 'http',
      wol_enabled: !!r.wol_enabled,
      ...(r.wol_mac ? { wol_mac: r.wol_mac } : {}),
    })),
    l4_routes: l4Routes.map(r => ({
      id: r.id,
      // SQLite stores l4_listen_port as TEXT (so Caddy-side range syntax
      // like "8000-8100" fits). The shared config-hash schema however
      // requires a plain number — ranges don't apply to gateway L4
      // anyway (a Node net.createServer listener binds a single port).
      // Coerce to number; fall through to the original value if that
      // fails so a misuse surfaces loudly instead of silently hashing
      // wrong data.
      listen_port: Number.isFinite(Number(r.listen_port)) ? Number(r.listen_port) : r.listen_port,
      target_lan_host: r.target_lan_host,
      target_lan_port: r.target_lan_port,
      wol_enabled: !!r.wol_enabled,
      ...(r.wol_mac ? { wol_mac: r.wol_mac } : {}),
    })),
  };
}

/**
 * Compute SHA-256 hash of the gateway config for a peer. Delegates to the
 * shared library for byte-identical results with the Gateway side.
 */
function computeConfigHash(peerId) {
  const cfg = getGatewayConfig(peerId);
  return libComputeConfigHash(cfg);
}

/**
 * Record a heartbeat from a Gateway. Updates last_seen_at and last_health,
 * and feeds the sliding-window health state-machine (Task 15/16).
 * On status transitions fires activity.log + email alerts + webhooks.
 */
/**
 * Decide whether a heartbeat represents a healthy gateway.
 *
 * Priority of signals (first-match wins):
 *   1. route_reachability — ground truth. If the gateway was asked to probe
 *      LAN targets for each configured route, the empirical result is more
 *      trustworthy than any localhost self-check. We treat the gateway as
 *      healthy when every reachability entry reports reachable:true.
 *   2. self-check — if no route_reachability is present (older gateway
 *      agent, or no routes configured yet), fall back to the previous
 *      definition: http_proxy_healthy:true AND no listener_failed entries.
 *   3. bare heartbeat — if neither signal is present at all (very early
 *      heartbeat before the first self-check completed), trust the heartbeat
 *      itself; the process is up.
 *
 * Rationale: NAS1-style deployments ship heartbeats where the localhost
 * probes fail (self-check bug or proxy binds to specific iface) even though
 * every configured route's LAN target answers. The old definition would
 * flag those gateways offline despite them doing their job.
 */
function _isHeartbeatHealthy(health) {
  if (!health || typeof health !== 'object') return false;

  const reach = Array.isArray(health.route_reachability) ? health.route_reachability : null;
  if (reach && reach.length > 0) {
    // Empirical: all configured LAN targets must answer.
    return reach.every((r) => r && r.reachable);
  }

  const hasSelfCheckSignal = typeof health.http_proxy_healthy === 'boolean';
  if (hasSelfCheckSignal) {
    const tcp = Array.isArray(health.tcp_listeners) ? health.tcp_listeners : [];
    const anyListenerFailed = tcp.some((l) => l && l.status === 'listener_failed');
    return !!health.http_proxy_healthy && !anyListenerFailed;
  }

  // No probes, no self-check → the heartbeat arrived, consider the process alive.
  return true;
}

function handleHeartbeat(peerId, health) {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    UPDATE gateway_meta
    SET last_seen_at = ?, last_health = ?
    WHERE peer_id = ?
  `).run(now, JSON.stringify(health || {}), peerId);

  const sm = _getSm(peerId);
  const prevStatus = sm.status;
  const healthy = _isHeartbeatHealthy(health);
  sm.recordHeartbeat(healthy);

  if (sm.status !== prevStatus) {
    _onStatusTransition(peerId, prevStatus, sm.status, health);
  }

  // Flap-Metric
  if (sm.flapCountLastHour() > 4) {
    activity.log('gateway_flap_warning', `Gateway peer ${peerId} flapping`, {
      source: 'system',
      severity: 'warning',
      details: { peer_id: peerId, flap_count: sm.flapCountLastHour() },
    });
  }
}

function _onStatusTransition(peerId, from, to, health) {
  const peer = getDb().prepare('SELECT name FROM peers WHERE id=?').get(peerId);
  const peerName = peer ? peer.name : `peer-${peerId}`;

  // Delegate Caddy patch (Task 20) — late-require to avoid cycle
  try {
    const meta = getDb().prepare('SELECT last_seen_at FROM gateway_meta WHERE peer_id=?').get(peerId);
    const caddyConfig = require('./caddyConfig');
    if (typeof caddyConfig.patchGatewayRouteHandlers === 'function') {
      caddyConfig.patchGatewayRouteHandlers({
        peerId,
        offline: to === 'offline',
        gatewayName: peerName,
        lastSeen: meta && meta.last_seen_at ? new Date(meta.last_seen_at).toISOString() : '',
      }).catch(err => logger.warn({ err: err.message, peerId }, 'Caddy patch failed'));
    }
  } catch (err) {
    logger.debug({ err: err.message }, 'caddyConfig patch not available');
  }

  if (to === 'offline') {
    activity.log('gateway_offline', `Gateway ${peerName} went offline`, {
      source: 'system',
      severity: 'warning',
      details: { peer_id: peerId, peer_name: peerName, last_health: health },
    });
    try {
      if (typeof email.sendMonitoringAlert === 'function') {
        email.sendMonitoringAlert({ subject: `Gateway ${peerName} offline`, body: JSON.stringify(health || {}, null, 2) }).catch(() => {});
      }
    } catch {}
    try {
      if (typeof webhook.notify === 'function') {
        webhook.notify('gateway.offline', { peer_id: peerId, peer_name: peerName, health }).catch(() => {});
      }
    } catch {}
  } else if (to === 'online') {
    activity.log('gateway_recovered', `Gateway ${peerName} is back online`, {
      source: 'system',
      severity: 'info',
      details: { peer_id: peerId, peer_name: peerName },
    });
    try {
      if (typeof email.sendMonitoringAlert === 'function') {
        email.sendMonitoringAlert({ subject: `Gateway ${peerName} wieder online`, body: '' }).catch(() => {});
      }
    } catch {}
    try {
      if (typeof webhook.notify === 'function') {
        webhook.notify('gateway.recovered', { peer_id: peerId, peer_name: peerName }).catch(() => {});
      }
    } catch {}
  }
}

function getHealthStatus(peerId) {
  return _getSm(peerId).status;
}

// Testing helpers — not for production use
function _forceCooldownExhaustedForTest(peerId) {
  const sm = _getSm(peerId);
  sm._lastTransitionAt = Date.now() - 10 * 60 * 1000;
}

function _resetSmCacheForTest() {
  _smCache.clear();
}

/**
 * Record traffic counters reported by a Gateway. Stores latest snapshot in
 * gateway_meta.last_health JSON. Historisierung erfolgt später über peerStatus.
 */
function recordTrafficSnapshot(peerId, { rx_bytes, tx_bytes, active_connections }) {
  const db = getDb();
  const existing = db.prepare('SELECT last_health FROM gateway_meta WHERE peer_id=?').get(peerId);
  const health = existing && existing.last_health ? JSON.parse(existing.last_health) : {};
  health.rx_bytes = rx_bytes;
  health.tx_bytes = tx_bytes;
  health.active_connections = active_connections;
  health.traffic_updated_at = Date.now();
  db.prepare('UPDATE gateway_meta SET last_health=? WHERE peer_id=?').run(JSON.stringify(health), peerId);
}

/**
 * Best-effort push to notify a Gateway that its config changed.
 * Gateway will pull fresh config on receipt (debounced 500ms).
 * Failures are logged but NOT retried aggressively — next Gateway poll covers it.
 */
async function notifyConfigChanged(peerId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT p.allowed_ips, gm.api_port, gm.push_token_encrypted
    FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id
    WHERE gm.peer_id = ?
  `).get(peerId);
  if (!row) return;

  const pushToken = decrypt(row.push_token_encrypted);
  const ip = _peerIp(row.allowed_ips);

  await new Promise((resolve) => {
    const req = http.request({
      host: ip,
      port: row.api_port,
      path: '/api/config-changed',
      method: 'POST',
      timeout: 2000,
      headers: {
        'X-Gateway-Token': pushToken,
        'Content-Length': 0,
      },
    }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', (err) => {
      logger.warn({ err: err.message, peerId }, 'Gateway push failed (best-effort)');
      resolve();
    });
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end();
  });
}

/**
 * Push a WoL trigger to a Gateway, which will send the magic packet on LAN.
 * Returns the Gateway's response body ({ success, elapsed_ms }) or null on error.
 */
async function notifyWol(peerId, { mac, lan_host, timeout_ms = 60000 }) {
  const db = getDb();
  const row = db.prepare(`
    SELECT p.allowed_ips, gm.api_port, gm.push_token_encrypted
    FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id
    WHERE gm.peer_id = ?
  `).get(peerId);
  if (!row) return null;

  const pushToken = decrypt(row.push_token_encrypted);
  const ip = _peerIp(row.allowed_ips);
  const payload = JSON.stringify({ mac, lan_host, timeout_ms });

  return new Promise((resolve) => {
    const req = http.request({
      host: ip,
      port: row.api_port,
      path: '/api/wol',
      method: 'POST',
      timeout: timeout_ms + 5000,
      headers: {
        'X-Gateway-Token': pushToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', (err) => {
      logger.warn({ err: err.message, peerId, mac }, 'Gateway WoL trigger failed');
      resolve(null);
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(payload);
  });
}

/**
 * Build the gateway.env file content from peer data + tokens.
 * Shared helper used by createGateway (on initial creation) and
 * rotateGatewayTokens (on re-pairing).
 */
/**
 * Get the server's own WireGuard public key.
 * Tries (in order):
 *   1. Env GC_WG_SERVER_PUBLIC_KEY (explicit override)
 *   2. `wg show <interface> public-key` via execFileSync (runtime, most accurate)
 *   3. Empty string (causes Gateway bootstrap to reject — deliberate fail-loud)
 */
function _getServerWgPublicKey() {
  if (process.env.GC_WG_SERVER_PUBLIC_KEY) return process.env.GC_WG_SERVER_PUBLIC_KEY.trim();
  try {
    const { execFileSync } = require('node:child_process');
    const iface = (process.env.GC_WG_INTERFACE || 'wg0').replace(/[^a-zA-Z0-9_-]/g, '');
    const key = execFileSync('wg', ['show', iface, 'public-key'], { encoding: 'utf8', timeout: 3000 }).trim();
    if (key) return key;
  } catch (e) {
    logger.warn({ err: e.message }, 'Could not get server WireGuard public key via wg command');
  }
  return '';
}

/**
 * Get the server's WireGuard endpoint (host:port) for peer config.
 */
function _getServerWgEndpoint() {
  if (process.env.GC_WG_ENDPOINT) return process.env.GC_WG_ENDPOINT.trim();
  const host = process.env.GC_WG_HOST || '';
  const port = process.env.GC_WG_PORT || '51820';
  return host ? `${host}:${port}` : '';
}

function buildEnvContent(row, apiToken, pushToken) {
  const ip = _peerIp(row.allowed_ips);
  const privateKey = row.private_key_encrypted ? decrypt(row.private_key_encrypted) : '';
  const presharedKey = row.preshared_key_encrypted ? decrypt(row.preshared_key_encrypted) : '';
  const lines = [
    `# GateControl Home Gateway — Pairing Config`,
    `# Generated: ${new Date().toISOString()}`,
    `# Peer: ${row.name} (ID: ${row.id})`,
    ``,
    `GC_SERVER_URL=${process.env.GC_BASE_URL || 'https://gatecontrol.example.com'}`,
    `GC_API_TOKEN=${apiToken}`,
    `GC_GATEWAY_TOKEN=${pushToken}`,
    `GC_TUNNEL_IP=${ip}`,
    `GC_PROXY_PORT=8080`,
    `GC_API_PORT=${row.api_port}`,
    `GC_HEARTBEAT_INTERVAL_S=30`,
    `GC_POLL_INTERVAL_S=300`,
    ``,
    `# WireGuard config inline`,
    `WG_PRIVATE_KEY=${privateKey}`,
    `WG_PUBLIC_KEY=${row.public_key || ''}`,
    `WG_PRESHARED_KEY=${presharedKey}`,
    `WG_ENDPOINT=${_getServerWgEndpoint()}`,
    `WG_SERVER_PUBLIC_KEY=${_getServerWgPublicKey()}`,
    // Use /32 for both Address and AllowedIPs so the gateway's WG
    // interface doesn't add a blanket 10.8.0.0/24 route. Many gateway
    // hosts already run a regular WireGuard client for the same
    // tunnel (NAS with gatecontrol-client + gatecontrol-gateway side
    // by side) — two /24 routes on the same host cause the kernel to
    // pick the wrong interface for return traffic, and TCP from the
    // server to the gateway's proxy port silently times out. With a
    // /32 route for the server IP, the gateway tunnel is always the
    // most-specific match and always wins the routing lookup.
    `WG_ADDRESS=${ip}/32`,
    `WG_ALLOWED_IPS=10.8.0.1/32`,
    `WG_DNS=10.8.0.1`,
  ];
  return lines.join('\n') + '\n';
}

/**
 * Get the full gateway.env content for an EXISTING gateway with known tokens
 * (used by createGateway to include the env content in its response without
 * a second rotate-step).
 */
function buildEnvForPeer(peerId, apiToken, pushToken) {
  const db = getDb();
  const row = db.prepare(`
    SELECT p.*, gm.api_port FROM peers p
    JOIN gateway_meta gm ON gm.peer_id = p.id
    WHERE p.id=? AND p.peer_type='gateway'
  `).get(peerId);
  if (!row) throw new Error('not_a_gateway');
  return buildEnvContent(row, apiToken, pushToken);
}

/**
 * Regenerate both api_token and push_token for a gateway. Returns
 * { apiToken, pushToken, envContent } — old tokens are invalidated.
 */
function rotateGatewayTokens(peerId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT p.*, gm.api_port FROM peers p
    JOIN gateway_meta gm ON gm.peer_id = p.id
    WHERE p.id=? AND p.peer_type='gateway'
  `).get(peerId);
  if (!row) throw new Error('not_a_gateway');

  const { apiToken, apiTokenHash, pushToken, pushTokenEncrypted } = generateTokens();
  db.prepare('UPDATE gateway_meta SET api_token_hash=?, push_token_encrypted=?, needs_repair=0 WHERE peer_id=?')
    .run(apiTokenHash, pushTokenEncrypted, peerId);

  // Security-relevant operation — leave an audit trail, never the token
  // plaintext. Mirrors the peer_created audit entry so post-incident
  // review can see who rotated what and when.
  try {
    const activity = require('./activity');
    activity.log('gateway_tokens_rotated',
      `Gateway tokens rotated for peer "${row.name}"`,
      { source: 'admin', severity: 'warning', details: { peerId, peerName: row.name } });
  } catch {}

  const envContent = buildEnvContent(row, apiToken, pushToken);
  return { apiToken, pushToken, envContent };
}

/**
 * Feed a probe result into a gateway's health state machine WITHOUT
 * updating last_seen_at. Unlike handleHeartbeat — which treats the
 * arrival as fresh traffic from the gateway — a probe is initiated by
 * the server and tells us only whether the gateway's TCP port is
 * reachable. Keeping last_seen_at untouched preserves the "gateway is
 * stale" signal that drives the probe in the first place.
 *
 * Used by the gatewayProbe background poller to catch silently-dead
 * gateways (crashed without farewell heartbeat) and to detect recovery
 * before the next real heartbeat arrives.
 */
function recordProbeResult(peerId, healthy) {
  const sm = _getSm(peerId);
  const prevStatus = sm.status;
  sm.recordHeartbeat(!!healthy);
  if (sm.status !== prevStatus) {
    _onStatusTransition(peerId, prevStatus, sm.status, null);
  }
}

module.exports = {
  DEFAULT_API_PORT,
  createGateway,
  getGatewayConfig,
  computeConfigHash,
  handleHeartbeat,
  recordProbeResult,
  _isHeartbeatHealthy, // exported for tests
  recordTrafficSnapshot,
  notifyConfigChanged,
  notifyWol,
  getHealthStatus,
  rotateGatewayTokens,
  buildEnvForPeer,
  _forceCooldownExhaustedForTest,
  _resetSmCacheForTest,
  _smCache,
};
