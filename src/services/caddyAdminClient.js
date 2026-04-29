'use strict';

const config = require('../../config/default');
const logger = require('../utils/logger');
const { renderMaintenancePage } = require('./caddyMaintenance');
const { getDb } = require('../db/connection');

const CADDY_ADMIN = config.caddy.adminUrl;

const RUNTIME_JSON_PATH = (config.caddy && config.caddy.dataDir
  ? config.caddy.dataDir
  : '/data/caddy') + '/runtime.json';

// HTTP statuses where a retry has a meaningful chance of succeeding.
// 4xx are caller bugs and never retryable; 501 is "not implemented" and
// retrying won't change the answer.
const RETRYABLE_STATUS = new Set([502, 503, 504]);

const DEFAULT_RETRY = {
  maxRetries: 2,    // 1 initial attempt + 2 retries = 3 total attempts
  baseDelayMs: 500,
  maxDelayMs: 4000,
};

/**
 * Common retry wrapper for both fetch- and node:http-based Caddy admin
 * calls. Bail-with-null on ECONNREFUSED preserves the legacy contract:
 * "Caddy not running" is a routine signal during early boot, not an
 * error worth retrying.
 *
 * Retries on:
 *   - timeout (AbortError / TimeoutError)
 *   - mid-request connection drop (ECONNRESET)
 *   - 5xx responses tagged via err.retryable
 *
 * Exponential backoff: baseDelayMs * 2^attempt, clamped by maxDelayMs.
 */
async function _caddyAdminWithRetry(attemptFn, label, opts = {}) {
  const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULT_RETRY, ...opts };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await attemptFn();
    } catch (err) {
      const code = err.cause && err.cause.code;

      // ECONNREFUSED → Caddy not running, bail immediately and let
      // caller treat it as "skip". Retrying just delays the obvious.
      if (code === 'ECONNREFUSED' || err.code === 'ECONNREFUSED') {
        logger.warn({ label }, 'Caddy admin API not reachable');
        return null;
      }

      const isRetryable =
        err.name === 'AbortError' ||
        err.name === 'TimeoutError' ||
        code === 'ECONNRESET' ||
        err.code === 'ECONNRESET' ||
        err.retryable === true;

      if (!isRetryable || attempt === maxRetries) throw err;

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      logger.warn(
        { label, attempt: attempt + 1, retryInMs: delay, error: err.message },
        'Caddy admin API call failed, retrying',
      );
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Single-attempt fetch against the Caddy admin API. Returns parsed JSON
// or {} on empty body. Throws Error with err.retryable=true for 5xx.
async function _caddyApiAttempt(url, options, timeoutMs) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    ...options,
    headers: { 'Content-Type': 'application/json', 'Origin': 'http://127.0.0.1:2019', ...options.headers },
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Caddy API ${res.status}: ${text}`);
    err.status = res.status;
    err.retryable = RETRYABLE_STATUS.has(res.status);
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// Caddy Admin API fetch wrapper.
// Production-safety: in NODE_ENV=test, never open a real HTTP connection.
// The container uses network_mode: host, so 127.0.0.1:2019 from a
// host-side test process IS the live Caddy and would get overwritten
// with test-seeded routes. Return null to mimic the ECONNREFUSED branch
// — all callers already handle null.
async function caddyApi(path, options = {}) {
  if (process.env.NODE_ENV === 'test') return null;

  const url = `${CADDY_ADMIN}${path}`;
  return _caddyAdminWithRetry(
    () => _caddyApiAttempt(url, options, config.timeouts.caddyApi),
    `${(options.method || 'GET').toUpperCase()} ${path}`,
  );
}

// Single-attempt PATCH via node:http. Adds an explicit socket-timeout
// (the inline pre-fix version had none, so a hung Caddy admin would
// leave the patch promise hanging forever). The settled-guard makes
// 'timeout' and 'error' coexist safely.
function _patchAttempt(urlString, body, timeoutMs) {
  const http = require('node:http');
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const url = new URL(urlString);
    const payload = body === null || body === undefined
      ? ''
      : (typeof body === 'string' ? body : JSON.stringify(body));
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
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      res.on('end', () => settle(resolve));
    });
    req.on('error', (err) => settle(reject, err));
    req.on('timeout', () => {
      const err = new Error('Caddy admin patch timeout');
      err.name = 'TimeoutError';
      req.destroy();
      settle(reject, err);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Gateway-aware partial patching of Caddy Admin API ──────
// Uses @id route markers so status transitions can be applied without
// a full config reload — PATCH /id/gc_route_<id>/handle.
const _caddyApi = {
  async patch(patchPath, body) {
    // Same production-safety guard as caddyApi().
    if (process.env.NODE_ENV === 'test') return;

    const url = (process.env.GC_CADDY_ADMIN_URL || config.caddy.adminUrl || 'http://127.0.0.1:2019') + patchPath;
    return _caddyAdminWithRetry(
      () => _patchAttempt(url, body, config.timeouts.caddyApi),
      `PATCH ${patchPath}`,
    );
  },
};

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
  _caddyAdminWithRetry,
  _persistRuntimeJson,
  _verifyLocalTls,
  _restartCaddyViaSupervisor,
  _managementHost,
  patchGatewayRouteHandlers,
};
