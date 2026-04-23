'use strict';

const config = require('../../config/default');
const logger = require('../utils/logger');
const { renderMaintenancePage } = require('./caddyMaintenance');
const { getDb } = require('../db/connection');

const CADDY_ADMIN = config.caddy.adminUrl;

const RUNTIME_JSON_PATH = (config.caddy && config.caddy.dataDir
  ? config.caddy.dataDir
  : '/data/caddy') + '/runtime.json';

// Caddy Admin API fetch wrapper.
// Production-safety: in NODE_ENV=test, never open a real HTTP connection.
// The container uses network_mode: host, so 127.0.0.1:2019 from a
// host-side test process IS the live Caddy and would get overwritten
// with test-seeded routes. Return null to mimic the ECONNREFUSED branch
// — all callers already handle null.
async function caddyApi(path, options = {}) {
  if (process.env.NODE_ENV === 'test') return null;

  const url = `${CADDY_ADMIN}${path}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(config.timeouts.caddyApi),
      ...options,
      headers: { 'Content-Type': 'application/json', 'Origin': 'http://127.0.0.1:2019', ...options.headers },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Caddy API ${res.status}: ${text}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.cause && err.cause.code === 'ECONNREFUSED') {
      logger.warn('Caddy admin API not reachable');
      return null;
    }
    throw err;
  }
}

// Write the generated Caddy config to /data/caddy/runtime.json atomically.
// entrypoint.sh boots Caddy from this file and a restart falls back to it
// if /load leaves Caddy in a bad state.
function _persistRuntimeJson(caddyConfig) {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmp = RUNTIME_JSON_PATH + '.tmp';
  try {
    fs.mkdirSync(path.dirname(RUNTIME_JSON_PATH), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(caddyConfig, null, 2));
    fs.renameSync(tmp, RUNTIME_JSON_PATH);
    return true;
  } catch (err) {
    logger.warn({ err: err.message, path: RUNTIME_JSON_PATH }, 'Could not persist runtime.json (not fatal)');
    return false;
  }
}

// Quick TLS-handshake self-test against 127.0.0.1:443 with the given SNI.
// POST /load occasionally leaves Caddy answering the admin API but
// killing every new TLS handshake with `internal error`.
function _verifyLocalTls(sniHost, timeoutMs = 4000) {
  const tls = require('node:tls');
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    // rejectUnauthorized: false is intentional — this is a local-loopback
    // TLS-liveness probe, not a request for data. We only care whether
    // Caddy's TLS stack is responsive; the cert may be self-signed mid-
    // provision and validation here would make the health check useless.
    const socket = tls.connect({
      host: '127.0.0.1',
      port: 443,
      servername: sniHost,
      rejectUnauthorized: false,
      timeout: timeoutMs,
      ALPNProtocols: ['http/1.1'],
    });
    socket.once('secureConnect', () => { socket.end(); done(true); });
    socket.once('error', () => done(false));
    socket.once('timeout', () => { socket.destroy(); done(false); });
  });
}

// Kill Caddy so supervisord's autorestart brings it back from scratch.
// Caddy then boots from runtime.json (just written), giving a clean TLS
// state and re-triggering cert provisioning for new hosts. Brief
// downtime (~2-3s) but recovers. Uses execFile with fixed argv — no
// shell, no injection. (Alpine's supervisor doesn't ship the RPC
// interface for supervisorctl so we use pkill + autorestart.)
function _restartCaddyViaSupervisor() {
  const { execFile } = require('node:child_process');
  return new Promise((resolve, reject) => {
    execFile('pkill', ['-TERM', '-x', 'caddy'], { timeout: 10000 }, (err, stdout, stderr) => {
      // exit code 1 = no process matched; still success (supervisord will respawn).
      if (err && err.code !== 1) {
        return reject(new Error(`pkill caddy failed: ${err.message} ${stderr || ''}`.trim()));
      }
      resolve(stdout);
    });
  });
}

// The management UI domain is the canary for TLS health — it has a
// provisioned cert from day one, so a failed TLS handshake against it
// means Caddy's listener state is broken (not just "cert still
// provisioning for a new subdomain"). Prefer GC_BASE_URL's hostname;
// fall back to the first route's first host.
function _managementHost(caddyConfig) {
  try {
    const baseUrl = config.app && config.app.baseUrl;
    if (baseUrl) {
      try {
        const host = new URL(baseUrl).hostname;
        if (host) return host;
      } catch { /* fall through */ }
    }
    const servers = caddyConfig && caddyConfig.apps && caddyConfig.apps.http && caddyConfig.apps.http.servers;
    if (!servers) return null;
    for (const name of Object.keys(servers)) {
      const srv = servers[name];
      const routes = Array.isArray(srv.routes) ? srv.routes : [];
      for (const r of routes) {
        const match = Array.isArray(r.match) ? r.match[0] : null;
        const hosts = match && Array.isArray(match.host) ? match.host : null;
        if (hosts && hosts.length > 0) return hosts[0];
      }
    }
    return null;
  } catch { return null; }
}

// ─── Gateway-aware partial patching of Caddy Admin API ──────
// Uses @id route markers so status transitions can be applied without
// a full config reload — PATCH /id/gc_route_<id>/handle.
const _caddyApi = {
  async patch(patchPath, body) {
    // Same production-safety guard as caddyApi().
    if (process.env.NODE_ENV === 'test') return;

    const http = require('node:http');
    return new Promise((resolve, reject) => {
      const url = new URL((process.env.GC_CADDY_ADMIN_URL || config.caddy.adminUrl || 'http://127.0.0.1:2019') + patchPath);
      const payload = body === null || body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
      const req = http.request({
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Origin': 'http://127.0.0.1:2019',
        },
      }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  },
};

async function patchGatewayRouteHandlers({ peerId, offline, gatewayName, lastSeen }) {
  const db = getDb();
  const routes = db.prepare(`
    SELECT id, domain FROM routes
    WHERE target_peer_id = ? AND target_kind = 'gateway' AND enabled = 1
  `).all(peerId);

  for (const route of routes) {
    const routeId = `gc_route_${route.id}`;
    const handler = offline
      ? {
          handler: 'static_response',
          status_code: 502,
          headers: { 'Content-Type': ['text/html; charset=utf-8'] },
          body: renderMaintenancePage({ gateway_name: gatewayName, gateway_last_seen: lastSeen }),
        }
      : null;

    try {
      await module.exports._caddyApi.patch(`/id/${routeId}/handle`, handler || 'revert');
    } catch (err) {
      logger.warn({ err: err.message, routeId }, 'Caddy partial patch failed');
    }
  }
}

module.exports = {
  caddyApi,
  _caddyApi,
  _persistRuntimeJson,
  _verifyLocalTls,
  _restartCaddyViaSupervisor,
  _managementHost,
  patchGatewayRouteHandlers,
};
