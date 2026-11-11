'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { getDb } = require('../db/connection');
const { encrypt, decrypt } = require('../utils/crypto');
const { hashToken } = require('../middleware/gatewayAuth');
const { isLoopbackHost } = require('../utils/validate');
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
// A fingerprint that does not match this never reaches the gateway config
// (config-hash >= 1.3.0 would reject the whole payload).
const GATEWAY_FINGERPRINT_RE = /^[0-9a-f]{64}$/;

function _peerIp(allowedIps) {
  return (allowedIps || '').split('/')[0].split(',')[0].trim();
}

// Decrypt a gateway push token without ever throwing. A corrupt/partial-enrollment
// row (undecryptable push_token_encrypted) must not crash the server when an admin
// triggers a push action — callers treat null as "gateway unreachable".
function _decryptPushToken(encrypted, peerId) {
  try {
    return decrypt(encrypted);
  } catch (err) {
    logger.warn({ err: err.message, peerId }, 'Gateway push token decrypt failed — treating gateway as unreachable');
    return null;
  }
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
// Where a gateway runs (gateway assistant, docs/feature-gateway-wizard.md);
// NULL for gateways created before it.
const PLATFORMS = ['rpi', 'synology', 'proxmox', 'linux'];
function normalizePlatform(v) {
  return PLATFORMS.includes(v) ? v : null;
}

async function createGateway({ name, apiPort = DEFAULT_API_PORT, proxyPort = 8080, platform = null, groupId = null, locationId = null }) {
  const db = getDb();

  const limit = license.getFeatureLimit('gateway_peers');
  const current = db.prepare("SELECT COUNT(*) AS n FROM peers WHERE peer_type='gateway'").get().n;
  if (limit !== -1 && current >= limit) {
    throw new Error(`License limit reached: gateway_peers=${limit} (current=${current})`);
  }

  // peers.create() is the existing async factory — we extend its param list to accept peerType
  const peer = await peers.create({ name, peerType: 'gateway', ...(groupId ? { groupId } : {}) });

  const { apiToken, apiTokenHash, pushToken, pushTokenEncrypted } = generateTokens();

  db.prepare(`
    INSERT INTO gateway_meta (peer_id, api_port, proxy_port, api_token_hash, push_token_encrypted, created_at, platform, location_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(peer.id, apiPort, proxyPort, apiTokenHash, pushTokenEncrypted, Date.now(), normalizePlatform(platform), locationId || null);

  logger.info({ peerId: peer.id, peerName: name, apiPort, proxyPort, platform: normalizePlatform(platform), locationId: locationId || null }, 'Gateway created');

  return { peer, apiToken, pushToken };
}

/**
 * Build the gateway-config payload sent to a Gateway on poll.
 * Includes all HTTP + L4 routes with target_peer_id=peerId.
 */
function getGatewayConfig(peerId) {
  const db = getDb();

  // Failover for peer-pinned routes happens via DB pivot in gatewayHealth:
  // when the pinned peer goes offline the route's target_peer_id is moved
  // to the alive sibling. By the time a companion polls, target_peer_id
  // already names whoever is currently serving the route — no sibling
  // lookup needed here. target_pool_id (explicit pool routing for
  // load-balancing) still surfaces in every pool member's config.
  const httpRoutes = db.prepare(`
    SELECT id, domain, target_kind, target_lan_host, target_lan_port,
           backend_https, backend_tls_fingerprint, wol_enabled, wol_mac
    FROM routes
    WHERE target_kind = 'gateway' AND enabled = 1
      AND (route_type = 'http' OR route_type IS NULL)
      AND (
        target_peer_id = ?
        OR target_pool_id IN (SELECT pool_id FROM gateway_pool_members WHERE peer_id = ?)
      )
    ORDER BY id
  `).all(peerId, peerId);

  const l4Routes = db.prepare(`
    SELECT r.id, r.l4_listen_port AS listen_port, r.target_lan_host, r.target_lan_port,
           r.original_peer_id, gm_home.lan_ip AS home_lan_ip,
           r.wol_enabled, r.wol_mac
    FROM routes r
    LEFT JOIN gateway_meta gm_home ON gm_home.peer_id = r.original_peer_id
    WHERE r.target_kind = 'gateway' AND r.enabled = 1
      AND r.route_type = 'l4'
      AND (
        r.target_peer_id = ?
        OR r.target_pool_id IN (SELECT pool_id FROM gateway_pool_members WHERE peer_id = ?)
      )
    ORDER BY r.id
  `).all(peerId, peerId);

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
      // Pinned SHA-256 of the LAN certificate (docs/feature-release-b.md
      // §13b), only when set. Since config-hash 1.3.0 the schema KNOWS the
      // field: a route without it hashes exactly as before, a route with it
      // hashes differently (that is what makes the gateway re-fetch). The
      // schema also REJECTS a malformed value now — the whole gateway-config
      // response would throw — so the shape is checked here as well. Writes
      // normalise to 64 lowercase hex (routesValidation), this guards a row
      // that came from a hand-edited database or an old restore.
      ...(r.backend_https && GATEWAY_FINGERPRINT_RE.test(String(r.backend_tls_fingerprint || ''))
        ? { backend_tls_fingerprint: r.backend_tls_fingerprint }
        : {}),
      wol_enabled: !!r.wol_enabled,
      ...(r.wol_mac ? { wol_mac: r.wol_mac } : {}),
    })),
    l4_routes: l4Routes.map(r => {
      // Loopback L4 target that has failed over to a sibling: rewrite to the
      // home gateway's LAN IP (this peer is the sibling, not the home). If the
      // home LAN IP is unknown, omit the listener (fail closed — no header /
      // 502 possible at layer 4; a missing listener = connection refused).
      let lanHost = r.target_lan_host;
      if (isLoopbackHost(lanHost) && r.original_peer_id != null) {
        if (r.home_lan_ip) lanHost = r.home_lan_ip;
        else return null;
      }
      return {
        id: r.id,
        // SQLite stores l4_listen_port as TEXT (so Caddy-side range syntax
        // like "8000-8100" fits). The shared config-hash schema however
        // requires a plain number — ranges don't apply to gateway L4
        // anyway (a Node net.createServer listener binds a single port).
        // Coerce to number; fall through to the original value if that
        // fails so a misuse surfaces loudly instead of silently hashing
        // wrong data.
        listen_port: Number.isFinite(Number(r.listen_port)) ? Number(r.listen_port) : r.listen_port,
        target_lan_host: lanHost,
        target_lan_port: r.target_lan_port,
        wol_enabled: !!r.wol_enabled,
        ...(r.wol_mac ? { wol_mac: r.wol_mac } : {}),
      };
    }).filter(Boolean),
    egress_routes: require('./egressRoutes').resolveForPeer(peerId, db),
    // Phase 3a: network watch, internet quality, presence, UPS (services/gatewayFeatures.js).
    // Not part of the shared config-hash schema — computeConfigHash adds it to the hash itself.
    features: require('./gatewayFeatures').configPayload(peerId),
  };
}

/**
 * Compute SHA-256 hash of the gateway config for a peer. Delegates to the
 * shared library for byte-identical results with the Gateway side.
 */
function computeConfigHash(peerId) {
  return hashOfConfig(getGatewayConfig(peerId));
}

/** JSON with object keys sorted at every level, no whitespace (arrays keep their order). */
function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
}

/**
 * Hash of a config payload. The shared library strips keys its schema does
 * not know, so `features` (phase 3a) would not change the hash: it is folded
 * in here — sha256(libHash + "\n" + stableJson(features)). Without
 * `features` the hash is exactly the library's (older gateways and configs
 * without the key stay byte-identical). The gateway computes the same.
 */
function hashOfConfig(cfg) {
  const { features, ...rest } = cfg || {};
  const base = libComputeConfigHash(rest);
  if (features === undefined || features === null) return base;
  return 'sha256:' + crypto.createHash('sha256').update(base + '\n' + stableJson(features), 'utf8').digest('hex');
}

/**
 * Record a heartbeat from a Gateway. Updates last_seen_at and last_health,
 * and feeds the sliding-window health state-machine (Task 15/16).
 * On status transitions fires activity.log + email alerts + webhooks.
 */
/**
 * Decide whether a heartbeat represents a healthy gateway.
 *
 * Liveness ≠ reachability. The gateway is "healthy" if its own process is
 * up and its TCP listeners are bound. Whether individual LAN targets answer
 * (`route_reachability`) is per-route information for the UI; it must NOT
 * gate the gateway's own status. Otherwise one bad target behind the
 * gateway makes the whole gateway look down — exact opposite of intent.
 *
 * Definition:
 *   unhealthy ⇔ malformed payload OR any tcp_listener with status='listener_failed'
 *   healthy   otherwise (heartbeat arrived + no broken listener)
 *
 * Notes:
 * - `http_proxy_healthy:false` alone (NAS1-style self-check noise) is
 *   tolerated. It only counts when accompanied by a real listener_failed.
 * - `route_reachability` is intentionally ignored here. It is surfaced
 *   verbatim through `/api/v1/gateways` for per-route UI badges and is
 *   force-marked stale by the API layer when the gateway is offline.
 */
function _isHeartbeatHealthy(health) {
  if (!health || typeof health !== 'object') return false;

  const tcp = Array.isArray(health.tcp_listeners) ? health.tcp_listeners : [];
  if (tcp.some((l) => l && l.status === 'listener_failed')) return false;

  return true;
}

function handleHeartbeat(peerId, health) {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    UPDATE gateway_meta
    SET last_seen_at = ?, last_health = ?, first_seen_at = COALESCE(first_seen_at, ?)
    WHERE peer_id = ?
  `).run(now, JSON.stringify(health || {}), now, peerId);

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
  // Pool-member peers are managed by the new gatewayHealth.evaluatePeer
  // system (threshold-based, with pool-specific cooldown). Skip the
  // legacy sliding-window transition path entirely for them — otherwise
  // we get double Caddy renders and duplicate activity-log/webhook events.
  // Late-require to avoid circular import at module-load.
  try {
    if (require('./gatewayPool').isPeerInAnyPool(peerId)) return;
  } catch (err) {
    // Logged at warn so a broken gatewayPool module doesn't silently
    // route every pool-member peer through the legacy path.
    logger.warn({ err: err.message, peerId }, 'gatewayPool require failed in legacy transition path; falling through to legacy');
  }

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

  const liveState = require('./gatewayLiveState');
  if (to === 'offline') {
    // An update GateControl asked for is under way: hold the alarm back
    // (gatewayHealth logs the expected restart; gatewayLiveState sends it late
    // when the gateway does not come back in time). The Caddy patch above runs
    // either way.
    if (liveState.restartExpectedFor(peerId)) {
      liveState.holdAlarm(peerId, 'legacy');
      return;
    }
    _sendLegacyOfflineAlarm(peerId, peerName, health, false);
  } else if (to === 'online') {
    // back from an expected restart whose alarm was held: no "back online" alarm
    if (liveState.takeHeldAlarm(peerId, 'legacy') != null) return;
    activity.log('gateway_recovered', `Gateway ${peerName} is back online`, {
      source: 'system',
      severity: 'info',
      details: { peer_id: peerId, peer_name: peerName },
    });
    try {
      if (typeof email.sendMonitoringAlert === 'function') {
        email.sendMonitoringAlert({ subject: `Gateway ${peerName} wieder online`, body: '' }).catch((err) => { logger.debug({ err: err.message, peerId }, 'gateway recovered alert email failed'); });
      }
    } catch (err) { logger.warn({ err: err.message, peerId }, 'gateway recovered alert email failed'); }
    try {
      if (typeof webhook.notify === 'function') {
        webhook.notify('gateway.recovered', { peer_id: peerId, peer_name: peerName }).catch((err) => { logger.debug({ err: err.message, peerId }, 'gateway recovered webhook failed'); });
      }
    } catch (err) { logger.warn({ err: err.message, peerId }, 'gateway recovered webhook failed'); }
  }
}

function _sendLegacyOfflineAlarm(peerId, peerName, health, late) {
  activity.log('gateway_offline', late ? `Gateway ${peerName} went offline (did not come back after its update)` : `Gateway ${peerName} went offline`, {
    source: 'system',
    severity: 'warning',
    details: { peer_id: peerId, peer_name: peerName, last_health: health, ...(late ? { after_update: true } : {}) },
  });
  try {
    if (typeof email.sendMonitoringAlert === 'function') {
      email.sendMonitoringAlert({ subject: `Gateway ${peerName} offline`, body: JSON.stringify(health || {}, null, 2) }).catch((err) => { logger.debug({ err: err.message, peerId }, 'gateway offline alert email failed'); });
    }
  } catch (err) { logger.warn({ err: err.message, peerId }, 'gateway offline alert email failed'); }
  try {
    if (typeof webhook.notify === 'function') {
      webhook.notify('gateway.offline', { peer_id: peerId, peer_name: peerName, health }).catch((err) => { logger.debug({ err: err.message, peerId }, 'gateway offline webhook failed'); });
    }
  } catch (err) { logger.warn({ err: err.message, peerId }, 'gateway offline webhook failed'); }
}

/**
 * A legacy offline alarm held for an expected restart that is over without
 * the gateway coming back (gatewayHealth.releaseHeldAlarms). Sent only when the
 * sliding window still says offline — after a server restart it starts from
 * 'unknown' and raises its own alarm when it gets there.
 */
function _releaseLegacyOfflineAlarm(peerId) {
  if (_getSm(peerId).status !== 'offline') return false;
  const peer = getDb().prepare('SELECT name FROM peers WHERE id=?').get(peerId);
  const row = getDb().prepare('SELECT last_health FROM gateway_meta WHERE peer_id=?').get(peerId);
  let health = null; try { health = row && row.last_health ? JSON.parse(row.last_health) : null; } catch { health = null; }
  _sendLegacyOfflineAlarm(peerId, peer ? peer.name : `peer-${peerId}`, health, true);
  return true;
}

/** Store where a gateway runs (assistant: a gateway created before it gets one on "Einrichtung fortsetzen"). */
function setPlatform(peerId, platform) {
  const p = normalizePlatform(platform);
  if (!p) throw new Error('invalid_platform');
  const r = getDb().prepare('UPDATE gateway_meta SET platform = ? WHERE peer_id = ?').run(p, peerId);
  return r.changes > 0;
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

  const pushToken = _decryptPushToken(row.push_token_encrypted, peerId);
  if (!pushToken) return;
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

  const pushToken = _decryptPushToken(row.push_token_encrypted, peerId);
  if (!pushToken) return null;
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
 * Push a LAN scan command to a Gateway over the tunnel.
 * Returns the Gateway's response body or null on error.
 */
async function notifyLanScan(peerId, { request_id, subnets, category_mode, categories, active_scan, timeout_ms = 45000 }) {
  const db = getDb();
  const row = db.prepare(`
    SELECT p.allowed_ips, gm.api_port, gm.push_token_encrypted
    FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id
    WHERE gm.peer_id = ?
  `).get(peerId);
  if (!row) return null;
  const pushToken = _decryptPushToken(row.push_token_encrypted, peerId);
  if (!pushToken) return null;
  const ip = _peerIp(row.allowed_ips);
  const payload = JSON.stringify({ request_id, subnets, category_mode, categories, active_scan, timeout_ms });
  return new Promise((resolve) => {
    const req = http.request({
      host: ip, port: row.api_port, path: '/api/lan-scan', method: 'POST', timeout: 7000,
      headers: { 'X-Gateway-Token': pushToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', (err) => { logger.warn({ err: err.message, peerId }, 'Gateway lan-scan trigger failed'); resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(payload);
  });
}

/**
 * POST a management call to a gateway over the tunnel (phase 3a: "Jetzt
 * scannen" → /api/netwatch/scan, "Jetzt messen" → /api/inetq/speedtest),
 * X-Gateway-Token like the other calls. → { status, body } or null when the
 * gateway cannot be reached (no token, network error, timeout).
 */
/** Management call: POST JSON to the gateway's API (tunnel, X-Gateway-Token) → { status, body } or null. maxBytes: the answer kept (16 KB). */
async function mgmtCall(peerId, path, payload = {}, timeoutMs = 7000, { maxBytes = 16384 } = {}) {
  const db = getDb();
  const row = db.prepare(`
    SELECT p.allowed_ips, gm.api_port, gm.push_token_encrypted
    FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id
    WHERE gm.peer_id = ?
  `).get(peerId);
  if (!row) return null;
  const pushToken = _decryptPushToken(row.push_token_encrypted, peerId);
  if (!pushToken) return null;
  const ip = _peerIp(row.allowed_ips);
  const data = JSON.stringify(payload || {});
  return new Promise((resolve) => {
    const req = http.request({
      host: ip, port: row.api_port, path, method: 'POST', timeout: timeoutMs,
      headers: { 'X-Gateway-Token': pushToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < maxBytes) body += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(body); } catch { j = null; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', (err) => { logger.warn({ err: err.message, peerId, path }, 'Gateway management call failed'); resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(data);
  });
}

/**
 * A streamed management call (phase 3c, step 3 — the local AI, the gateway's
 * docs/local-ai.md): POST JSON, the answer is NDJSON, one object per line to
 * onLine. Long answers (CPU inference takes minutes) are fine as long as lines
 * keep coming: idleMs without a line, totalMs overall, connectMs to connect
 * (a gateway that is offline fails fast). A gateway that answers anything but
 * 200 gives { status, body } (JSON, ≤ 16 KB). Never follows a redirect, never
 * leaves the gateway's tunnel address.
 * → { status, body? }; rejects with code unreachable | timeout | too_large | bad_response | aborted.
 */
function mgmtStream(peerId, path, payload, { totalMs = 600000, idleMs = 120000, connectMs = 5000, maxBytes = 2 * 1024 * 1024, onLine, signal } = {}) {
  const fail = (code, message) => Object.assign(new Error(message || code), { code });
  const row = getDb().prepare(`
    SELECT p.allowed_ips, gm.api_port, gm.push_token_encrypted
    FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id
    WHERE gm.peer_id = ?
  `).get(peerId);
  if (!row) return Promise.reject(fail('unreachable', 'not a gateway'));
  const pushToken = _decryptPushToken(row.push_token_encrypted, peerId);
  if (!pushToken) return Promise.reject(fail('unreachable', 'no gateway token'));
  const ip = _peerIp(row.allowed_ips);
  const data = JSON.stringify(payload || {});
  return new Promise((resolve, reject) => {
    let done = false;
    let idle = null;
    const timers = [];
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      clearTimeout(idle);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(v);
    };
    const stop = (code, message) => { req.destroy(); finish(reject, fail(code, message)); };
    const kick = () => { clearTimeout(idle); idle = setTimeout(() => stop('timeout', 'no progress from the gateway'), idleMs); };
    const req = http.request({
      host: ip, port: row.api_port, path, method: 'POST', agent: false,
      headers: { 'X-Gateway-Token': pushToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Accept: 'application/x-ndjson' },
    }, (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (body.length < 16384) body += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(body); } catch { j = null; } finish(resolve, { status: res.statusCode, body: j }); });
        res.on('error', () => finish(reject, fail('unreachable', 'gateway connection lost')));
        return;
      }
      let size = 0;
      let buf = '';
      res.setEncoding('utf8');
      kick();
      const line = (l) => {
        const t = l.trim();
        if (!t) return;
        let o;
        try { o = JSON.parse(t); } catch { throw fail('bad_response', 'the gateway sent no JSON line'); }
        if (o && typeof o === 'object') onLine(o);
      };
      res.on('data', (c) => {
        if (done) return;
        size += Buffer.byteLength(c);
        if (size > maxBytes) { stop('too_large', 'answer too large'); return; }
        kick();
        buf += c;
        let i;
        try {
          while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); line(l); }
        } catch (e) { req.destroy(); finish(reject, e.code ? e : fail('bad_response', e.message)); }
      });
      res.on('end', () => {
        if (done) return;
        try { line(buf); } catch (e) { finish(reject, e.code ? e : fail('bad_response', e.message)); return; }
        finish(resolve, { status: 200 });
      });
      res.on('error', () => finish(reject, fail('unreachable', 'gateway connection lost')));
    });
    timers.push(setTimeout(() => stop('timeout', 'the gateway did not answer in time'), totalMs));
    req.on('socket', (sock) => {
      if (!sock.connecting) return;
      const t = setTimeout(() => stop('unreachable', 'the gateway does not answer'), connectMs);
      timers.push(t);
      sock.once('connect', () => clearTimeout(t));
    });
    const onAbort = () => stop('aborted', 'aborted');
    if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener('abort', onAbort, { once: true }); }
    req.on('error', (err) => { logger.debug({ err: err.message, peerId, path }, 'Gateway stream call failed'); finish(reject, fail('unreachable', 'the gateway does not answer')); });
    req.end(data);
  });
}

/**
 * A raw management request (phase 3c, step 4 — the cameras, the gateway's docs/cameras.md §3):
 * GET or POST to the gateway's API over the tunnel; resolves with the answer stream (http.IncomingMessage)
 * as soon as the headers are there — the caller buffers it (mgmtBinary) or pipes it on (live video, clips)
 * and must consume or destroy it. Never follows a redirect, never leaves the gateway's tunnel address.
 * opts: { method, body (JSON), headers (only Range / Accept), connectMs, headerMs, signal }.
 * Rejects with code unreachable | timeout | aborted.
 */
function mgmtRequest(peerId, path, { method = 'GET', body = null, headers = {}, connectMs = 5000, headerMs = 15000, signal } = {}) {
  const fail = (code, message) => Object.assign(new Error(message || code), { code });
  const row = getDb().prepare(`
    SELECT p.allowed_ips, gm.api_port, gm.push_token_encrypted
    FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id
    WHERE gm.peer_id = ?
  `).get(peerId);
  if (!row) return Promise.reject(fail('unreachable', 'not a gateway'));
  const pushToken = _decryptPushToken(row.push_token_encrypted, peerId);
  if (!pushToken) return Promise.reject(fail('unreachable', 'no gateway token'));
  const ip = _peerIp(row.allowed_ips);
  const data = body == null ? null : JSON.stringify(body);
  const extra = {};
  if (typeof headers.range === 'string' && /^bytes=\d*-\d*$/.test(headers.range)) extra.Range = headers.range;
  return new Promise((resolve, reject) => {
    let done = false;
    const timers = [];
    const finish = (fn, v) => { if (done) return; done = true; for (const t of timers) clearTimeout(t); fn(v); };
    const req = http.request({
      host: ip, port: row.api_port, path, method, agent: false,
      headers: { 'X-Gateway-Token': pushToken, ...extra, ...(data != null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => finish(resolve, res));
    timers.push(setTimeout(() => { req.destroy(); finish(reject, fail('timeout', 'the gateway did not answer in time')); }, headerMs));
    req.on('socket', (sock) => {
      if (!sock.connecting) return;
      const t = setTimeout(() => { req.destroy(); finish(reject, fail('unreachable', 'the gateway does not answer')); }, connectMs);
      timers.push(t);
      sock.once('connect', () => clearTimeout(t));
    });
    if (signal) {
      if (signal.aborted) { req.destroy(); finish(reject, fail('aborted')); return; }
      signal.addEventListener('abort', () => { req.destroy(); finish(reject, fail('aborted')); }, { once: true });
    }
    req.on('error', (err) => { logger.debug({ err: err.message, peerId, path }, 'Gateway request failed'); finish(reject, fail('unreachable', 'the gateway does not answer')); });
    req.end(data == null ? undefined : data);
  });
}

/** mgmtRequest buffered: → { status, type, headers, body (Buffer) }; rejects with too_large over maxBytes. */
async function mgmtBinary(peerId, path, opts = {}) {
  const { maxBytes = 4 * 1024 * 1024, totalMs = 20000 } = opts;
  const res = await mgmtRequest(peerId, path, opts);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    const t = setTimeout(() => { res.destroy(); reject(Object.assign(new Error('timeout'), { code: 'timeout' })); }, totalMs);
    res.on('data', (c) => {
      n += c.length;
      if (n > maxBytes) { clearTimeout(t); res.destroy(); reject(Object.assign(new Error('answer too large'), { code: 'too_large' })); return; }
      chunks.push(c);
    });
    res.on('end', () => { clearTimeout(t); resolve({ status: res.statusCode, type: String(res.headers['content-type'] || ''), headers: res.headers, body: Buffer.concat(chunks) }); });
    res.on('error', () => { clearTimeout(t); reject(Object.assign(new Error('gateway connection lost'), { code: 'unreachable' })); });
  });
}

/**
 * Ask a gateway to TCP-probe a target host:port inside its physical LAN.
 * Returns the parsed gateway response (with `probed_target` + `probe_result`)
 * or null on any failure. Used by rdpMonitor for true end-to-end health of
 * gateway-mode RDP routes (the local L4 listener cannot tell a dead host
 * from a live one).
 */
async function probeGatewayTarget(peerId, host, port) {
  const db = getDb();
  const row = db.prepare(`
    SELECT p.allowed_ips, gm.api_port, gm.push_token_encrypted
    FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id
    WHERE gm.peer_id = ?
  `).get(peerId);
  if (!row) return null;
  const pushToken = _decryptPushToken(row.push_token_encrypted, peerId);
  if (!pushToken) return null;
  const ip = _peerIp(row.allowed_ips);
  const payload = JSON.stringify({ host, port });
  return new Promise((resolve) => {
    const req = http.request({
      host: ip, port: row.api_port, path: '/api/probe', method: 'POST', timeout: 5000,
      headers: { 'X-Gateway-Token': pushToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', (err) => { logger.warn({ err: err.message, peerId }, 'Gateway probe failed'); resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(payload);
  });
}

/**
 * Get the LAN discovery settings for a gateway peer.
 * Returns the parsed settings object or null if not found.
 */
function getDiscoverySettings(peerId) {
  const db = getDb();
  const r = db.prepare(`SELECT discovery_enabled, discovery_active_scan, discovery_subnets, discovery_category_mode, discovery_categories FROM gateway_meta WHERE peer_id=?`).get(peerId);
  if (!r) return null;
  const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  return {
    enabled: r.discovery_enabled, active_scan: r.discovery_active_scan,
    subnets: parse(r.discovery_subnets) || [],
    category_mode: r.discovery_category_mode || 'include',
    categories: parse(r.discovery_categories) || [],
  };
}

/**
 * Persist LAN discovery settings for a gateway peer.
 */
function setDiscoverySettings(peerId, { enabled, active_scan, subnets, category_mode, categories }) {
  const db = getDb();
  db.prepare(`UPDATE gateway_meta SET discovery_enabled=?, discovery_active_scan=?, discovery_subnets=?, discovery_category_mode=?, discovery_categories=? WHERE peer_id=?`)
    .run(enabled ? 1 : 0, active_scan ? 1 : 0, JSON.stringify(subnets || []), category_mode === 'exclude' ? 'exclude' : 'include', JSON.stringify(categories || []), peerId);
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
    `GC_PROXY_PORT=${row.proxy_port || 8080}`,
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
    SELECT p.*, gm.api_port, gm.proxy_port FROM peers p
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
    SELECT p.*, gm.api_port, gm.proxy_port FROM peers p
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
  } catch (err) { logger.warn({ err: err.message, peerId }, 'activity log write failed (gateway_tokens_rotated)'); }

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

// ─── Pairing codes (one-shot bootstrap for install-pve.sh) ────────────

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes — hardcoded

// 16 hex chars (64 bits) formatted XXXX-XXXX-XXXX-XXXX. Cleartext only,
// hashed before persisting. Capital letters because that's what the
// installer regex expects.
function _generatePairingCodePlaintext() {
  const hex = crypto.randomBytes(8).toString('hex').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

function _hashPairingCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/**
 * Generate a single-active pairing code for a gateway peer. The cleartext
 * code is returned ONCE and never persisted — only its SHA-256 hash hits
 * the DB. Any existing code for this peer is invalidated atomically so
 * "regenerate" really does revoke the old one.
 *
 * Returns the full token in `code@host` form (the installer parses on @
 * to know which server to redeem against).
 */
function createPairingCode(peerId) {
  const db = getDb();
  const peer = db.prepare("SELECT id, name, peer_type FROM peers WHERE id=?").get(peerId);
  if (!peer || peer.peer_type !== 'gateway') throw new Error('not_a_gateway');

  // Single active code per peer — wipe any previous unconsumed entries.
  db.prepare('DELETE FROM gateway_pairing_codes WHERE peer_id=?').run(peerId);

  const code = _generatePairingCodePlaintext();
  const codeHash = _hashPairingCode(code);
  const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;

  db.prepare(`
    INSERT INTO gateway_pairing_codes (code_hash, peer_id, expires_at)
    VALUES (?, ?, ?)
  `).run(codeHash, peerId, expiresAt);

  // Compose the cleartext token with the public hostname suffix so the
  // installer learns where to redeem without a separate prompt.
  const config = require('../../config/default');
  let host;
  try { host = new URL(config.app.baseUrl).host; } catch { host = require('os').hostname(); }
  const token = `${code}@${host}`;
  // The setup page of the gateway (gateway docs/setup-page.md) takes the two
  // parts in separate fields: the address as the admin opens GateControl.
  const server = host;

  try {
    activity.log('gateway_pairing_code_created',
      `Pairing code generated for gateway "${peer.name}"`,
      { source: 'admin', severity: 'info', details: { peerId, peerName: peer.name, expires_at: expiresAt } });
  } catch (err) { logger.warn({ err: err.message, peerId }, 'activity log write failed (gateway_pairing_code_created)'); }

  return { code, token, server, expiresAt };
}

/**
 * "Zugang erneuern": the access of the gateway ends now (tokens rotated, the
 * new ones are thrown away) and a pairing code is issued. The running gateway
 * gets `invalid_token`, opens the code entry of its setup page and redeems
 * the code there — which rotates once more and hands the gateway its new
 * gateway.env. Nothing with access data leaves the server here.
 */
function renewAccess(peerId) {
  rotateGatewayTokens(peerId);
  const { code, server, expiresAt } = createPairingCode(peerId);
  return { code, server, expiresAt };
}

/** State of the current pairing code of a gateway (assistant: "geht von selbst weiter"). */
function pairingState(peerId) {
  const row = getDb().prepare('SELECT expires_at, consumed_at FROM gateway_pairing_codes WHERE peer_id=? ORDER BY expires_at DESC LIMIT 1').get(peerId);
  return row ? { expires_at: row.expires_at, consumed_at: row.consumed_at || null } : null;
}

/**
 * Atomically consume a pairing code and rotate the gateway's tokens.
 * Same end result as the dashboard's "Download Config" flow — fresh
 * api/push tokens + freshly-built env content. Caller passes the source
 * IP (from the public endpoint) so the activity log captures who
 * redeemed it.
 *
 * Throws an Error with .code = 'invalid_or_expired' | 'consumed' on any
 * non-success path so callers can distinguish 410 (already used) from
 * 400 (never existed / expired) without leaking which is which to the
 * client — both surface as 400.
 */
function redeemPairingCode(rawCode, sourceIp) {
  const db = getDb();
  if (typeof rawCode !== 'string' || !/^[A-F0-9]{4}(-[A-F0-9]{4}){3}$/.test(rawCode)) {
    const err = new Error('invalid_format');
    err.code = 'invalid_or_expired';
    throw err;
  }

  const codeHash = _hashPairingCode(rawCode);
  const now = Date.now();

  // Atomic mark-consumed: only succeeds if the code is unconsumed and
  // unexpired. Two concurrent installers redeeming the same code can
  // therefore not both win.
  const update = db.prepare(`
    UPDATE gateway_pairing_codes
    SET consumed_at = ?, consumed_from_ip = ?
    WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?
  `).run(now, sourceIp || null, codeHash, now);

  if (update.changes === 0) {
    const err = new Error('not_redeemable');
    err.code = 'invalid_or_expired';
    throw err;
  }

  const row = db.prepare('SELECT peer_id FROM gateway_pairing_codes WHERE code_hash=?').get(codeHash);
  const peerId = row.peer_id;
  const peer = db.prepare('SELECT name FROM peers WHERE id=?').get(peerId);

  // Rotate tokens — same effect as a manual "Download Config" click.
  // The previously running gateway (if any) is forcibly disconnected.
  const { envContent } = rotateGatewayTokens(peerId);

  try {
    activity.log('gateway_pairing_code_redeemed',
      `Pairing code redeemed for gateway "${peer ? peer.name : peerId}"${sourceIp ? ` from ${sourceIp}` : ''}`,
      { source: 'system', severity: 'info', details: { peerId, peerName: peer ? peer.name : null, sourceIp } });
  } catch (err) { logger.warn({ err: err.message, peerId }, 'activity log write failed (gateway_pairing_code_redeemed)'); }

  return { envContent };
}

/**
 * Delete pairing codes whose TTL is in the past. Cheap, can run as a
 * periodic janitor or just opportunistically on each create.
 */
function cleanupExpiredPairingCodes() {
  const db = getDb();
  return db.prepare('DELETE FROM gateway_pairing_codes WHERE expires_at <= ?').run(Date.now()).changes;
}

// Self-check fields the gateway's GET /api/status returns. NOT telemetry/
// hostname/config_hash — those are heartbeat-only and MUST be preserved.
const SELF_CHECK_FIELDS = ['http_proxy_healthy', 'api_healthy', 'tcp_listeners', 'wg_handshake_age_s', 'dns_resolve_ok', 'route_reachability', 'overall_healthy'];

// ─── Gateway self-update lifecycle helpers ────────────────────────────────

const { compareVersions } = require('../utils/version');
const UPDATE_TIMEOUT_MS = Number(process.env.GC_UPDATE_TIMEOUT_MS || 15 * 60 * 1000);

function _normalizeTargetVersion(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/^v/i, '');
  return s || null;
}

// Pure: derive update lifecycle. Completion matched by request_id (skew-proof);
// timestamps are display-only. The reported version must always parse — an
// `unknown`/unparseable build is never "done".
function _deriveUpdateState(row, telemetry) {
  const rid = row && row.update_request_id;
  if (!rid) return { state: 'idle' };
  const t = telemetry || {};
  const matched = t.last_pull_request_id && t.last_pull_request_id === rid;
  if (matched) {
    const ok = t.last_pull_ok === true;
    const target = row.update_target_version;
    const reported = t.gateway_version;
    const parses = (x) => /^\d+(\.\d+){0,2}$/.test(String(x == null ? '' : x).replace(/^v/i, '').split('-')[0]);
    const versionOk = target
      ? (parses(reported) && parses(target) && compareVersions(reported, target) >= 0)
      : parses(reported);
    if (ok && versionOk) return { state: 'done' };
    return { state: 'failed' };
  }
  if (Date.now() - (row.update_requested_at || 0) > UPDATE_TIMEOUT_MS) return { state: 'unknown' };
  return { state: 'updating' };
}

function markUpdateRequested(peerId, requestId, targetVersion) {
  getDb().prepare(`UPDATE gateway_meta SET update_request_id=?, update_requested_at=?, update_target_version=? WHERE peer_id=?`)
    .run(requestId, Date.now(), _normalizeTargetVersion(targetVersion), peerId);
}

function _clearUpdateTracking(peerId) {
  getDb().prepare(`UPDATE gateway_meta SET update_request_id=NULL, update_requested_at=NULL, update_target_version=NULL WHERE peer_id=?`).run(peerId);
}

async function notifySelfUpdate(peerId, { request_id, target_version } = {}) {
  const db = getDb();
  const row = db.prepare(`SELECT p.allowed_ips, gm.api_port, gm.push_token_encrypted
    FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id WHERE gm.peer_id = ?`).get(peerId);
  if (!row) return { ok: false };
  const pushToken = _decryptPushToken(row.push_token_encrypted, peerId);
  if (!pushToken) return { ok: false };
  const ip = _peerIp(row.allowed_ips);
  const payload = JSON.stringify({ request_id, target_version });
  return new Promise((resolve) => {
    let body = '';
    const req = http.request({
      host: ip, port: row.api_port, path: '/api/self-update', method: 'POST', timeout: 5000,
      headers: { 'X-Gateway-Token': pushToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { const j = JSON.parse(body); resolve({ ok: res.statusCode === 200, skipped: j.skipped, queued: j.queued }); } catch { resolve({ ok: res.statusCode === 200 }); } });
    });
    req.on('error', (err) => { logger.warn({ err: err.message, peerId }, 'Gateway self-update push failed'); resolve({ ok: false }); });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.end(payload);
  });
}

function _mergeHealth(stored, fresh) {
  const merged = { ...(stored && typeof stored === 'object' ? stored : {}) };
  if (fresh && typeof fresh === 'object') for (const k of SELF_CHECK_FIELDS) if (k in fresh) merged[k] = fresh[k];
  return merged;
}

async function refreshHealth(peerId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT p.allowed_ips, p.peer_type, gm.api_port, gm.push_token_encrypted, gm.last_health
    FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id WHERE gm.peer_id = ?
  `).get(peerId);
  if (!row || row.peer_type !== 'gateway') return null;

  const pushToken = _decryptPushToken(row.push_token_encrypted, peerId);
  if (!pushToken) return null;
  const ip = _peerIp(row.allowed_ips);
  const fresh = await new Promise((resolve) => {
    let body = '';
    const req = http.request({ host: ip, port: row.api_port, path: '/api/status', method: 'GET', timeout: 5000,
      headers: { 'X-Gateway-Token': pushToken } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      res.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });

  if (!fresh) {
    // Connect failure → feed a SINGLE probe failure into the state machine
    // (consistent with the background prober; respects the SM's hysteresis &
    // cooldown — do NOT pump synthetic failures, which corrupt flap/window
    // tracking). The caller surfaces `reachable: false` for immediate UI feedback.
    recordProbeResult(peerId, false);
    return { reachable: false };
  }
  let stored = {};
  try { stored = row.last_health ? JSON.parse(row.last_health) : {}; } catch { stored = {}; }
  const merged = _mergeHealth(stored, fresh);
  db.prepare('UPDATE gateway_meta SET last_health = ?, last_seen_at = ? WHERE peer_id = ?')
    .run(JSON.stringify(merged), Date.now(), peerId);
  recordProbeResult(peerId, true);
  return { reachable: true };
}

module.exports = {
  DEFAULT_API_PORT,
  PLATFORMS,
  normalizePlatform,
  setPlatform,
  createGateway,
  getGatewayConfig,
  computeConfigHash,
  hashOfConfig,
  stableJson,
  handleHeartbeat,
  recordProbeResult,
  _isHeartbeatHealthy, // exported for tests
  recordTrafficSnapshot,
  notifyConfigChanged,
  notifyWol,
  notifyLanScan,
  mgmtCall,
  mgmtStream,
  mgmtRequest,
  mgmtBinary,
  probeGatewayTarget,
  getDiscoverySettings,
  setDiscoverySettings,
  getHealthStatus,
  _releaseLegacyOfflineAlarm,
  rotateGatewayTokens,
  buildEnvForPeer,
  createPairingCode,
  renewAccess,
  pairingState,
  redeemPairingCode,
  cleanupExpiredPairingCodes,
  _mergeHealth,
  refreshHealth,
  _forceCooldownExhaustedForTest,
  _resetSmCacheForTest,
  _smCache,
  notifySelfUpdate,
  markUpdateRequested,
  _clearUpdateTracking,
  _deriveUpdateState,
  _normalizeTargetVersion,
  UPDATE_TIMEOUT_MS,
};
