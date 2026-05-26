'use strict';

/**
 * Task 8 — caddyConfig access-window integration.
 *
 * buildCaddyConfig must consult accessRules at build time (fail-closed
 * across restarts):
 *   - denied HTTP route  → its server-route handler is a static_response 403
 *                          (NOT a reverse_proxy chain, NOT forward_auth).
 *   - allowed HTTP route → normal reverse_proxy chain.
 *   - denied L4 route    → omitted from the layer4 app entirely.
 *   - no rules at all     → anyRulesExist() short-circuits, output byte-
 *                          identical to a baseline (the common case stays a
 *                          true no-op).
 *
 * isDenied / anyRulesExist are stubbed on the module export; buildCaddyConfig
 * resolves them via an inline require('./accessRules') so the stubs are seen.
 */

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cc-access-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let caddyConfig;
let buildCaddyConfig;
let accessRules;
let origIsDenied;
let origAnyRulesExist;

const HTTP_ROUTE = {
  id: 1, domain: 'a.example.com', route_type: 'http',
  target_kind: 'peer', target_ip: '10.8.0.7', target_port: 80,
  enabled: 1, https_enabled: 1,
};
const L4_ROUTE = {
  id: 10, route_type: 'l4', target_kind: 'peer',
  l4_protocol: 'tcp', l4_listen_port: '5022', l4_tls_mode: 'none',
  target_ip: '10.8.0.7', target_port: 22,
  enabled: 1,
};

before(() => {
  require('../src/db/migrations').runMigrations();
  caddyConfig = require('../src/services/caddyConfig');
  buildCaddyConfig = caddyConfig.buildCaddyConfig;
  accessRules = require('../src/services/accessRules');
  origIsDenied = accessRules.isDenied;
  origAnyRulesExist = accessRules.anyRulesExist;
});

beforeEach(() => {
  accessRules.isDenied = origIsDenied;
  accessRules.anyRulesExist = origAnyRulesExist;
});
afterEach(() => {
  accessRules.isDenied = origIsDenied;
  accessRules.anyRulesExist = origAnyRulesExist;
});

// Find the assembled server route for a given host in srv0.
function serverRouteFor(cfg, host) {
  const routes = cfg.apps?.http?.servers?.srv0?.routes || [];
  return routes.find(r => r.match?.[0]?.host?.[0] === host);
}
// Flatten a server route's handlers (including subroute children) to handler names.
function handlerNames(serverRoute) {
  const names = [];
  const walk = (handlers) => {
    for (const h of handlers || []) {
      names.push(h.handler);
      if (h.handler === 'subroute') for (const sr of h.routes || []) walk(sr.handle);
    }
  };
  walk(serverRoute && serverRoute.handle);
  return names;
}

describe('caddy access-window: denied HTTP route → static_response 403', () => {
  it('emits a static_response 403 (no reverse_proxy, no forward_auth)', () => {
    accessRules.anyRulesExist = () => true;
    accessRules.isDenied = (type, id) => type === 'route' && id === 1;

    const cfg = buildCaddyConfig([HTTP_ROUTE]);
    const sr = serverRouteFor(cfg, 'a.example.com');
    assert.ok(sr, 'denied route must still produce a host-matched server route');

    const names = handlerNames(sr);
    assert.ok(names.includes('static_response'),
      'denied route handler must be static_response');
    assert.ok(!names.includes('reverse_proxy'),
      'denied route must NOT proxy to the upstream');
    assert.ok(!names.includes('forward_auth'),
      'denied route must NOT run the forward_auth chain');

    const json = JSON.stringify(cfg);
    assert.ok(json.includes('"status_code":403'), '403 status_code must be set');
    assert.ok(!json.includes('10.8.0.7:80'), 'upstream must not appear for a denied route');
  });

  it('403 body has no timestamp/now (deterministic)', () => {
    accessRules.anyRulesExist = () => true;
    accessRules.isDenied = () => true;
    const cfg = buildCaddyConfig([HTTP_ROUTE]);
    const sr = serverRouteFor(cfg, 'a.example.com');
    const body = (sr.handle.find(h => h.handler === 'static_response') || {}).body || '';
    assert.ok(body.length > 0, 'static_response must have an HTML body');
    // No 4-digit year / ISO-ish timestamp / "GMT" should leak into the body.
    assert.doesNotMatch(body, /\b20\d{2}-\d{2}-\d{2}\b/, 'body must not contain a date');
    assert.doesNotMatch(body, /\b\d{2}:\d{2}:\d{2}\b/, 'body must not contain a clock time');
    assert.doesNotMatch(body, /GMT|UTC|T\d{2}:\d{2}/, 'body must not contain a timestamp');
    // Two builds must be byte-identical.
    const a = JSON.stringify(buildCaddyConfig([HTTP_ROUTE]));
    const b = JSON.stringify(buildCaddyConfig([HTTP_ROUTE]));
    assert.equal(a, b, '403 page output must be deterministic');
  });
});

describe('caddy access-window: allowed HTTP route → normal', () => {
  it('allowed route keeps its reverse_proxy chain', () => {
    accessRules.anyRulesExist = () => true;
    accessRules.isDenied = () => false; // nothing denied
    const cfg = buildCaddyConfig([HTTP_ROUTE]);
    const sr = serverRouteFor(cfg, 'a.example.com');
    const names = handlerNames(sr);
    assert.ok(names.includes('reverse_proxy'), 'allowed route must proxy normally');
    assert.ok(!names.includes('static_response'), 'allowed route must not be a 403 page');
    assert.ok(JSON.stringify(cfg).includes('10.8.0.7:80'), 'upstream must be present');
  });
});

describe('caddy access-window: denied L4 route → omitted from layer4', () => {
  it('denied l4 route is absent from the layer4 app', () => {
    accessRules.anyRulesExist = () => true;
    accessRules.isDenied = (type, id) => type === 'route' && id === 10;
    const cfg = buildCaddyConfig([L4_ROUTE]);
    assert.ok(!cfg.apps.layer4, 'no layer4 app when the only l4 route is denied');
  });

  it('allowed l4 route is present', () => {
    accessRules.anyRulesExist = () => true;
    accessRules.isDenied = () => false;
    const cfg = buildCaddyConfig([L4_ROUTE]);
    assert.ok(cfg.apps.layer4, 'allowed l4 route must produce a layer4 app');
    assert.ok(cfg.apps.layer4.servers, 'layer4.servers must be present');
  });
});

describe('caddy access-window: no-rules common case is a true no-op', () => {
  it('anyRulesExist=false → output byte-identical to baseline (isDenied never consulted)', () => {
    // Baseline: the real no-rules path (empty access_rules table → anyRulesExist false).
    accessRules.anyRulesExist = origAnyRulesExist;
    accessRules.isDenied = origIsDenied;
    const baseline = JSON.stringify(buildCaddyConfig([HTTP_ROUTE, L4_ROUTE]));

    // Force the short-circuit explicitly and make isDenied throw — if it is
    // ever consulted when anyRulesExist is false, the build would blow up.
    let isDeniedCalled = false;
    accessRules.anyRulesExist = () => false;
    accessRules.isDenied = () => { isDeniedCalled = true; throw new Error('isDenied must not run when no rules exist'); };
    const guarded = JSON.stringify(buildCaddyConfig([HTTP_ROUTE, L4_ROUTE]));

    assert.equal(isDeniedCalled, false, 'isDenied must be skipped when anyRulesExist is false');
    assert.equal(guarded, baseline, 'no-rules path must be byte-identical to baseline');
  });
});
