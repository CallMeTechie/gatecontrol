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
  const escapedDomain = config.dns.domain.replace('.', '\\.');
  assert.match(out, new RegExp(`home\\.${escapedDomain}`),
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

// ─── 3. Internal-only (remote_ip matcher + no external exposure) ──────────
test('home.<domain> site is internal-only and absent from external-exposure routes', () => {
  const cfg = caddyConfigMod.buildCaddyConfig();
  const wantHost = `home.${config.dns.domain}`;

  const serverRoutes = cfg?.apps?.http?.servers?.srv0?.routes || [];

  // Find the route that matches home.<domain>
  const homeRoute = serverRoutes.find(r =>
    Array.isArray(r.match) && r.match.some(m => Array.isArray(m.host) && m.host.includes(wantHost))
  );
  assert.ok(homeRoute, `home.<domain> route not found in srv0.routes`);

  // Must carry a remote_ip matcher (not just a host matcher)
  const hasRemoteIp = homeRoute.match.some(
    m => m.remote_ip && Array.isArray(m.remote_ip.ranges) && m.remote_ip.ranges.length > 0
  );
  assert.ok(hasRemoteIp,
    'home.<domain> route is missing remote_ip matcher — it is NOT internal-only');

  // The remote_ip ranges must match config.wireguard.internalOnlyRanges
  const remoteIpMatch = homeRoute.match.find(m => m.remote_ip);
  assert.deepEqual(remoteIpMatch.remote_ip.ranges, config.wireguard.internalOnlyRanges,
    'remote_ip ranges do not match config.wireguard.internalOnlyRanges');

  // home.<domain> must NOT appear as a bare host-only route (no external-block fallback)
  const externalExposedRoutes = serverRoutes.filter(r =>
    Array.isArray(r.match) &&
    r.match.some(m => Array.isArray(m.host) && m.host.includes(wantHost) && !m.remote_ip)
  );
  assert.equal(externalExposedRoutes.length, 0,
    `home.<domain> appears in an external-exposure route (should be internal-only)`);
});

// ─── 4. Root-path rewrite to /portal ────────────────────────────────────
test('home.<domain> site rewrites root path / to /portal without touching asset/API paths', () => {
  const cfg = caddyConfigMod.buildCaddyConfig();
  const wantHost = `home.${config.dns.domain}`;

  const serverRoutes = cfg?.apps?.http?.servers?.srv0?.routes || [];
  const homeRoute = serverRoutes.find(r =>
    Array.isArray(r.match) && r.match.some(m => Array.isArray(m.host) && m.host.includes(wantHost))
  );
  assert.ok(homeRoute, 'home.<domain> route not found');

  const json = JSON.stringify(homeRoute);
  assert.ok(json.includes('rewrite'), 'rewrite handler missing from home site');
  assert.ok(json.includes('/portal'), 'rewrite target /portal missing from home site');

  // The rewrite must be path-matched (only on '/'), not a blanket rewrite
  // Verify by checking that a path matcher containing '/' is present alongside 'rewrite'
  const handlers = homeRoute.handle || [];
  // find subroute handler containing the rewrite
  const subrouteHandler = handlers.find(h => h.handler === 'subroute');
  assert.ok(subrouteHandler, 'subroute handler for path-conditional rewrite missing');
  const rewriteRoute = subrouteHandler.routes?.find(r =>
    Array.isArray(r.match) && r.match.some(m => Array.isArray(m.path) && m.path.includes('/'))
  );
  assert.ok(rewriteRoute, 'path-matched route for / not found in subroute');
  const rewriteHandler = rewriteRoute.handle?.find(h => h.handler === 'rewrite');
  assert.ok(rewriteHandler, 'rewrite handler not found inside path-matched subroute');
  assert.equal(rewriteHandler.uri, '/portal', 'rewrite URI should be /portal');
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
