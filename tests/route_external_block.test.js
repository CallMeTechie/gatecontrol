'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// --- Global migrated DB (REQUIRED for buildCaddyConfig/service tests) ---
// buildCaddyConfig() calls getDb() + accessRules.anyRulesExist() unconditionally
// (caddyConfig.js:171/196), so it needs a MIGRATED global connection — a local
// :memory: handle is NOT enough. Mirror tests/caddyConfig_contract.test.js:36-46.
// NODE_ENV=test makes _syncToCaddyInner() (caddyConfig.js) skip the live Caddy
// admin-API push, so routes.create()/update() in the service tests below don't
// race a `fetch failed` against a non-running Caddy on :2019 (flaky otherwise).
process.env.NODE_ENV = 'test';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-eblock-'));
process.env.GC_DB_PATH = path.join(tmpDir, 'test.db');
process.env.GC_DATA_DIR = tmpDir;
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || 'a'.repeat(64);
process.env.GC_SECRET = process.env.GC_SECRET || 'b'.repeat(64);

before(() => {
  require('../src/db/migrations').runMigrations(); // migrate the GLOBAL connection
});

const Database = require('better-sqlite3');
const { migrations } = require('../src/db/migrationList');

// Pure-schema helper for the migration column tests (independent :memory: handle).
function applyAll(db) {
  for (const m of migrations) db.exec(m.sql);
}

test('migration 52 adds external_block_* columns with inherit default', () => {
  const db = new Database(':memory:');
  applyAll(db);
  db.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type) VALUES ('r.example.com','127.0.0.1',80,'http')").run();
  const row = db.prepare("SELECT external_block_action, external_block_body, external_block_redirect_url FROM routes WHERE domain='r.example.com'").get();
  assert.strictEqual(row.external_block_action, 'inherit');
  assert.strictEqual(row.external_block_body, null);
  assert.strictEqual(row.external_block_redirect_url, null);
  db.close();
});

test('routes.create/update persist external_block_* at the correct columns', async () => {
  const routes = require('../src/services/routes');
  // create() mit gesetzten Block-Feldern
  // Use port 8080 (not in blockedPorts) so 127.0.0.1 passes the loopback guard.
  const created = await routes.create({
    domain: 'svc.example.com', target_ip: '127.0.0.1', target_port: 8080, route_type: 'http',
    external_block_action: 'custom', external_block_body: '<h1>nope</h1>',
  });
  const id = created.id ?? created;
  const r = routes.getById(id);
  // Bindings korrekt → action/body landen in den richtigen Spalten (nicht verschoben)
  assert.strictEqual(r.external_block_action, 'custom');
  assert.strictEqual(r.external_block_body, '<h1>nope</h1>');
  assert.strictEqual(r.target_ip, '127.0.0.1', 'binding shift would corrupt target_ip');

  // update() ändert die Aktion
  await routes.update(id, { external_block_action: 'redirect', external_block_redirect_url: 'https://example.org/x' });
  const u = routes.getById(id);
  assert.strictEqual(u.external_block_action, 'redirect');
  assert.strictEqual(u.external_block_redirect_url, 'https://example.org/x');
});

const caddyConfig = require('../src/services/caddyConfig');

test('buildExternalBlockHandler: external route → null', () => {
  assert.strictEqual(caddyConfig.__test.buildExternalBlockHandler({ external_enabled: 1 }), null);
});
test('buildExternalBlockHandler: not_found → 404', () => {
  const h = caddyConfig.__test.buildExternalBlockHandler({ external_enabled: 0, external_block_action: 'not_found' });
  assert.deepStrictEqual(h, [{ handler: 'static_response', status_code: 404 }]);
});
test('buildExternalBlockHandler: redirect → 302 + Location', () => {
  const h = caddyConfig.__test.buildExternalBlockHandler({ external_enabled: 0, external_block_action: 'redirect', external_block_redirect_url: 'https://example.org/x' });
  assert.strictEqual(h[0].status_code, 302);
  assert.deepStrictEqual(h[0].headers.Location, ['https://example.org/x']);
});
test('buildExternalBlockHandler: custom → 404 html body', () => {
  const h = caddyConfig.__test.buildExternalBlockHandler({ external_enabled: 0, external_block_action: 'custom', external_block_body: '<h1>x</h1>' });
  assert.strictEqual(h[0].status_code, 404);
  assert.strictEqual(h[0].body, '<h1>x</h1>');
});
test('buildExternalBlockHandler: empty → null (status quo)', () => {
  assert.strictEqual(caddyConfig.__test.buildExternalBlockHandler({ external_enabled: 0, external_block_action: 'empty' }), null);
});

const { buildCaddyConfig } = require('../src/services/caddyConfig');

function findHostRoutes(cfg, host) {
  const routes = cfg.apps.http.servers.srv0.routes;
  return routes.filter(r => JSON.stringify(r.match || []).includes(host));
}

test('internal-only + not_found → gated route (A) + host-only 404 fallback (B), B after A, B has no @id', () => {
  const cfg = buildCaddyConfig([
    { id: 1, domain: 'int.example.com', route_type: 'http', https_enabled: 1,
      target_kind: 'gateway', target_lan_host: '127.0.0.1', target_lan_port: 80,
      external_enabled: 0, external_block_action: 'not_found', enabled: 1 },
  ]);
  const hostRoutes = findHostRoutes(cfg, 'int.example.com');
  assert.strictEqual(hostRoutes.length, 2, 'two outer routes for the host');
  const a = hostRoutes[0], b = hostRoutes[1];
  assert.ok(JSON.stringify(a.match).includes('10.8.0.0/24'), '(A) is remote_ip gated');
  assert.ok(JSON.stringify(a).includes('gc_route_1'), '(A) carries the canonical @id');
  // (B): host-only static_response 404, NO @id
  const bStr = JSON.stringify(b);
  assert.ok(bStr.includes('static_response'), '(B) is static_response');
  assert.ok(bStr.includes('404'), '(B) returns 404');
  assert.ok(!bStr.includes('remote_ip'), '(B) is host-only (no remote_ip)');
  assert.ok(!bStr.includes('@id'), '(B) has NO @id');
});

test('internal-only + empty → single route, no fallback (status quo)', () => {
  const cfg = buildCaddyConfig([
    { id: 2, domain: 'emp.example.com', route_type: 'http', https_enabled: 1,
      target_kind: 'gateway', target_lan_host: '127.0.0.1', target_lan_port: 80,
      external_enabled: 0, external_block_action: 'empty', enabled: 1 },
  ]);
  assert.strictEqual(findHostRoutes(cfg, 'emp.example.com').length, 1);
});

test('internal-only + redirect → (B) 302 + Location', () => {
  const cfg = buildCaddyConfig([
    { id: 3, domain: 'red.example.com', route_type: 'http', https_enabled: 1,
      target_kind: 'gateway', target_lan_host: '127.0.0.1', target_lan_port: 80,
      external_enabled: 0, external_block_action: 'redirect',
      external_block_redirect_url: 'https://example.org/here', enabled: 1 },
  ]);
  const b = findHostRoutes(cfg, 'red.example.com')[1];
  assert.ok(JSON.stringify(b).includes('"status_code":302'));
  assert.ok(JSON.stringify(b).includes('example.org/here'));
});

test('external route → unchanged, no fallback', () => {
  const cfg = buildCaddyConfig([
    { id: 4, domain: 'ext.example.com', route_type: 'http', https_enabled: 1,
      target_kind: 'gateway', target_lan_host: '127.0.0.1', target_lan_port: 80,
      external_enabled: 1, external_block_action: 'not_found', enabled: 1 },
  ]);
  assert.strictEqual(findHostRoutes(cfg, 'ext.example.com').length, 1);
});

// SECURITY-CRITICAL: forward-auth internal-only route. ip_filter_enabled:1 forces
// needsForwardAuth=true without seeding a route_auth row, so the route takes the
// subroute branch and the gate must be HOISTED to the outer match — else an
// external scanner hits /route-auth/* (path-only, IP-independent) and sees the
// auth page instead of (B).
test('internal-only AUTH route: gate on OUTER subroute match, NOT inner; (B) appended', () => {
  const cfg = buildCaddyConfig([
    { id: 5, domain: 'auth.example.com', route_type: 'http', https_enabled: 1,
      target_kind: 'gateway', target_lan_host: '127.0.0.1', target_lan_port: 80,
      external_enabled: 0, external_block_action: 'not_found',
      ip_filter_enabled: 1, ip_filter_mode: 'allow', enabled: 1 },
  ]);
  const hostRoutes = findHostRoutes(cfg, 'auth.example.com');
  assert.strictEqual(hostRoutes.length, 2, 'gated subroute (A) + fallback (B)');
  const a = hostRoutes[0];
  // (A): OUTER match carries host AND remote_ip; handler is a subroute
  assert.ok(a.match[0].host && a.match[0].remote_ip, 'outer match has host + remote_ip (hoisted)');
  assert.ok(JSON.stringify(a.match[0].remote_ip).includes('10.8.0.0/24'), 'VPN ranges on outer');
  assert.strictEqual(a.handle[0].handler, 'subroute', '(A) wraps the auth subroute');
  // inner routeConfig (the content route inside the subroute) must NOT carry remote_ip
  const innerRoutes = a.handle[0].routes;
  const contentRoute = innerRoutes.find(r => r['@id'] === 'gc_route_5');
  assert.ok(contentRoute, 'inner content route present with canonical @id');
  assert.ok(!contentRoute.match || !JSON.stringify(contentRoute.match).includes('remote_ip'),
    'inner content route has NO remote_ip (gate lives only on the outer match)');
  // (B): host-only 404, no @id
  const b = hostRoutes[1];
  assert.ok(JSON.stringify(b).includes('404') && !JSON.stringify(b).includes('@id'));
});

const reconciler = require('../src/services/caddyReconciler');

// ── inherit → global resolution ──────────────────────────────────────────────
// These tests exercise the core effective-action contract: a route whose
// external_block_action === 'inherit' must resolve to the GLOBAL setting, not
// silently fall back to a hardcoded default.

test('inherit + global=redirect → (B) 302 with global Location', () => {
  const settings = require('../src/services/settings');
  settings.set('route_external_block_action', 'redirect');
  settings.set('route_external_block_redirect_url', 'https://global.example.org/x');
  try {
    const cfg = buildCaddyConfig([
      { id: 10, domain: 'inh-redir.example.com', route_type: 'http', https_enabled: 0,
        target_kind: 'gateway', target_lan_host: '127.0.0.1', target_lan_port: 8080,
        external_enabled: 0, external_block_action: 'inherit', enabled: 1 },
    ]);
    const hostRoutes = findHostRoutes(cfg, 'inh-redir.example.com');
    assert.strictEqual(hostRoutes.length, 2, 'gated route (A) + fallback (B)');
    const b = JSON.stringify(hostRoutes[1]);
    assert.ok(b.includes('"status_code":302'), '(B) must be 302 (inherited redirect)');
    assert.ok(b.includes('global.example.org/x'), '(B) carries global redirect URL');
  } finally {
    // Restore to a neutral state so other tests are not affected
    settings.set('route_external_block_action', 'not_found');
    settings.set('route_external_block_redirect_url', '');
  }
});

test('inherit + global=not_found → (B) 404 fallback', () => {
  const settings = require('../src/services/settings');
  // Explicitly set the global so the test is deterministic regardless of ordering
  settings.set('route_external_block_action', 'not_found');
  settings.set('route_external_block_redirect_url', '');
  const cfg = buildCaddyConfig([
    { id: 11, domain: 'inh-nf.example.com', route_type: 'http', https_enabled: 0,
      target_kind: 'gateway', target_lan_host: '127.0.0.1', target_lan_port: 8080,
      external_enabled: 0, external_block_action: 'inherit', enabled: 1 },
  ]);
  const hostRoutes = findHostRoutes(cfg, 'inh-nf.example.com');
  assert.strictEqual(hostRoutes.length, 2, 'gated route (A) + fallback (B)');
  const b = JSON.stringify(hostRoutes[1]);
  assert.ok(b.includes('"status_code":404'), '(B) must be 404 (inherited not_found)');
  assert.ok(!b.includes('302'), '(B) must NOT be a redirect');
});

test('fallback (B) does not introduce extra @id → no reconciler drift', () => {
  const cfg = buildCaddyConfig([
    { id: 7, domain: 'rec.example.com', route_type: 'http', https_enabled: 1,
      target_kind: 'gateway', target_lan_host: '127.0.0.1', target_lan_port: 80,
      external_enabled: 0, external_block_action: 'not_found', enabled: 1 },
  ]);
  // (1) static: exactly one gc_route_<id>, none for (B)
  const actual = reconciler.extractCaddyRouteIds(cfg);
  const routeIds = [...actual].filter(x => x.startsWith('gc_route_'));
  assert.deepStrictEqual(routeIds, ['gc_route_7']);

  // (2) dynamic: the REAL divergence check the reconciler runs each cycle.
  // expected = DB route @ids, actual = live-config @ids → must NOT diverge.
  const expected = new Set(['gc_route_7']);
  const div = reconciler.detectDivergence(expected, actual);
  assert.strictEqual(div.diverged, false, 'no permanent re-sync from the fallback');
  assert.deepStrictEqual([...(div.extraInCaddy || [])], [], 'no extra @id from (B)');
});
