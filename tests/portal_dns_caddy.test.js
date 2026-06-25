'use strict';

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-portal-dns-caddy-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;
process.env.GC_DNS_DOMAIN = 'gc.internal';
process.env.GC_WG_GATEWAY_IP = '10.8.0.1';
process.env.GC_WG_SUBNET = '10.8.0.0/24';
process.env.GC_BASE_URL = 'http://localhost:3000';
process.env.NODE_ENV = 'test';
process.env.GC_LOG_LEVEL = 'silent';

let dns, caddyConfigMod, config;

before(() => {
  require('../src/db/migrations').runMigrations();
  dns = require('../src/services/dns');
  caddyConfigMod = require('../src/services/caddyConfig');
  config = require('../config/default');
});

after(() => {
  try { require('../src/db/connection').closeDb(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// ─── 1. dnsmasq friendly name ────────────────────────────────────────────
test('renderHostsContent includes a home.<domain> A-record at the gateway IP', () => {
  const out = dns.renderHostsContent();
  // Plain substring checks (no regex building from the domain — avoids a
  // sanitization-heuristic false positive in static analysis).
  assert.ok(out.includes(`home.${config.dns.domain}`),
    'home.<domain> A-record missing from dnsmasq hosts output');
  assert.ok(out.includes(config.wireguard.gatewayIp),
    'home A-record should use the gateway IP');
  // The home line should map gatewayIp → home.<domain>
  assert.ok(out.includes(`home.${config.dns.domain}`),
    'home A-record FQDN missing');
});

// ─── 2. Caddy site with reserved-header handling ─────────────────────────
test('buildCaddyConfig adds an internal home.<domain> site with strip+set of reserved header', () => {
  const cfg = caddyConfigMod.buildCaddyConfig();
  const wantHost = `home.${config.dns.domain}`;
  const json = JSON.stringify(cfg);

  assert.ok(json.includes(wantHost),
    `home.<domain> site missing from Caddy config (looked for ${wantHost})`);
  assert.ok(json.includes('X-GC-Portal-Peer-IP'),
    'reserved header X-GC-Portal-Peer-IP handling missing from Caddy config');
  assert.ok(json.includes('{http.request.remote.host}'),
    'real-IP placeholder {http.request.remote.host} missing from Caddy config');
});

// ─── 3. Internal-only (remote_ip gate in inner subroute + 404 fallback) ──────────
test('home.<domain> site is internal-only and absent from external-exposure routes', () => {
  const cfg = caddyConfigMod.buildCaddyConfig();
  const wantHost = `home.${config.dns.domain}`;

  const serverRoutes = cfg?.apps?.http?.servers?.srv0?.routes || [];

  // Find the outer route by host matcher (outer match is host-only; gate lives inside subroute)
  const homeRoute = serverRoutes.find(r =>
    Array.isArray(r.match) && r.match.some(m => Array.isArray(m.host) && m.host.includes(wantHost))
  );
  assert.ok(homeRoute, `home.<domain> route not found in srv0.routes`);

  // The outer handle must contain a subroute that wraps the three inner routes
  const outerSubroute = (homeRoute.handle || []).find(h => h.handler === 'subroute');
  assert.ok(outerSubroute, 'outer subroute handler missing from home.<domain> route handle');

  const innerRoutes = outerSubroute.routes || [];

  // (a) Exactly one inner route carries a remote_ip matcher whose ranges deepEqual internalOnlyRanges
  const gateRoutes = innerRoutes.filter(r =>
    Array.isArray(r.match) && r.match.some(m => m.remote_ip && Array.isArray(m.remote_ip.ranges) && m.remote_ip.ranges.length > 0)
  );
  assert.equal(gateRoutes.length, 1,
    'expected exactly one inner route with a remote_ip (gate) matcher inside the subroute');
  const gateRoute = gateRoutes[0];
  const remoteIpMatch = gateRoute.match.find(m => m.remote_ip);
  assert.deepEqual(remoteIpMatch.remote_ip.ranges, config.wireguard.internalOnlyRanges,
    'remote_ip ranges do not match config.wireguard.internalOnlyRanges');

  // (b) An inner route returns static_response 404 behind a not-path matcher
  //     (external/non-internal sources get 404, not portal content)
  const notPathFallback = innerRoutes.find(r =>
    Array.isArray(r.match) &&
    r.match.some(m => Array.isArray(m.not) && m.not.some(n => Array.isArray(n.path))) &&
    (r.handle || []).some(h => h.handler === 'static_response' && h.status_code === 404)
  );
  assert.ok(notPathFallback,
    'no inner fallback route returning 404 for non-internal/non-ACME sources (external sources must get 404)');

  // (c) The portal reverse_proxy lives INSIDE the gate route only — never in any ungated inner route
  const reverseProxyOutsideGate = innerRoutes
    .filter(r => r !== gateRoute)
    .some(r => JSON.stringify(r).includes('"reverse_proxy"'));
  assert.ok(!reverseProxyOutsideGate,
    'reverse_proxy handler found outside the remote_ip gate — portal content is NOT internal-only');
});

// ─── 4. Root-path rewrite to /portal (inside the remote_ip gate) ────────────────────────────────────
test('home.<domain> site rewrites root path / to /portal without touching asset/API paths', () => {
  const cfg = caddyConfigMod.buildCaddyConfig();
  const wantHost = `home.${config.dns.domain}`;

  const serverRoutes = cfg?.apps?.http?.servers?.srv0?.routes || [];
  const homeRoute = serverRoutes.find(r =>
    Array.isArray(r.match) && r.match.some(m => Array.isArray(m.host) && m.host.includes(wantHost))
  );
  assert.ok(homeRoute, 'home.<domain> route not found');

  // Drill into the outer subroute (host wrapper)
  const outerSubroute = (homeRoute.handle || []).find(h => h.handler === 'subroute');
  assert.ok(outerSubroute, 'outer subroute handler missing');

  // Find the remote_ip gate route inside the outer subroute
  const gateRoute = (outerSubroute.routes || []).find(r =>
    Array.isArray(r.match) && r.match.some(m => m.remote_ip)
  );
  assert.ok(gateRoute, 'remote_ip gate route not found inside outer subroute');

  // Find the nested subroute handler inside the gate route (path-conditional rewrite)
  const innerSubroute = (gateRoute.handle || []).find(h => h.handler === 'subroute');
  assert.ok(innerSubroute, 'inner subroute handler for path-conditional rewrite missing from gate route');

  // Find the path-matched route for '/' inside the inner subroute
  const rewriteRoute = (innerSubroute.routes || []).find(r =>
    Array.isArray(r.match) && r.match.some(m => Array.isArray(m.path) && m.path.includes('/'))
  );
  assert.ok(rewriteRoute, 'path-matched route for / not found in inner subroute');

  const rewriteHandler = (rewriteRoute.handle || []).find(h => h.handler === 'rewrite');
  assert.ok(rewriteHandler, 'rewrite handler not found inside path-matched inner subroute');
  assert.equal(rewriteHandler.uri, '/portal', 'rewrite URI should be /portal');
});

// ─── 5. SECURITY: management-UI vhost strips the portal identity header ───
// Defense-in-depth for the identity-forgery class: every non-home Caddy vhost
// that reverse-proxies to the local Node app must DELETE X-GC-Portal-Peer-IP,
// so a forged header on e.g. the management host can never establish identity
// even if req.hostname were spoofed. GC_BASE_URL=http://localhost:3000 here, so
// the management vhost host is 'localhost'.
test('management-UI vhost strips X-GC-Portal-Peer-IP (anti-forgery defense-in-depth)', () => {
  const cfg = caddyConfigMod.buildCaddyConfig();
  const gcHost = new URL(config.app.baseUrl).hostname;
  const serverRoutes = cfg?.apps?.http?.servers?.srv0?.routes || [];

  const mgmtRoute = serverRoutes.find(r =>
    Array.isArray(r.match) && r.match.some(m => Array.isArray(m.host) && m.host.includes(gcHost))
  );
  assert.ok(mgmtRoute, `management vhost route for ${gcHost} not found`);

  // Find the reverse_proxy to the local Node app and assert it deletes the header.
  const rp = (mgmtRoute.handle || []).find(h => h.handler === 'reverse_proxy');
  assert.ok(rp, 'management vhost has no reverse_proxy handler');
  const del = rp.headers?.request?.delete || [];
  assert.ok(del.includes('X-GC-Portal-Peer-IP'),
    'management vhost must delete X-GC-Portal-Peer-IP to prevent identity forgery');
});

// ─── 5. home.<domain> included in TLS automation (internal CA) ───────────
test('TLS automation includes home.<domain> under the internal issuer policy', () => {
  // Set a Caddy email so buildTlsAutomation is active (it returns null without one).
  process.env.GC_CADDY_EMAIL = 'test@example.com';
  try {
    // Re-require config so the new env var is picked up.
    delete require.cache[require.resolve('../config/default')];
    delete require.cache[require.resolve('../src/services/caddyConfig')];
    const freshConfig = require('../config/default');
    const freshCaddyConfig = require('../src/services/caddyConfig');

    const cfg = freshCaddyConfig.buildCaddyConfig();
    const wantHost = `home.${freshConfig.dns.domain}`; // 'home.gc.internal'

    const policies = cfg?.apps?.tls?.automation?.policies || [];
    assert.ok(policies.length > 0, 'TLS automation policies must be present when email is set');

    // home.gc.internal ends in '.internal' — NON_PUBLIC_TLDS — so it must fall
    // into the internal-CA policy, NOT the public ACME policy.
    const internalPolicy = policies.find(p =>
      Array.isArray(p.subjects) &&
      p.subjects.includes(wantHost) &&
      Array.isArray(p.issuers) &&
      p.issuers.some(i => i.module === 'internal')
    );
    assert.ok(internalPolicy,
      `home.<domain> (${wantHost}) must appear in an internal-CA TLS policy — ` +
      'it was missing, meaning it would fall through to public ACME and get a broken cert');
  } finally {
    delete process.env.GC_CADDY_EMAIL;
    // Restore original modules so other tests are unaffected.
    delete require.cache[require.resolve('../config/default')];
    delete require.cache[require.resolve('../src/services/caddyConfig')];
  }
});
