'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Database = require('better-sqlite3');
const { migrations } = require('../src/db/migrationList');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-mig-ext-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let getDb;
before(() => {
  require('../src/db/migrations').runMigrations();
  getDb = require('../src/db/connection').getDb;
});

describe('migration: route_external_exposure', () => {
  it('adds external_enabled column with NOT NULL DEFAULT 0 to routes', () => {
    const cols = getDb().prepare('PRAGMA table_info(routes)').all();
    const col = cols.find((c) => c.name === 'external_enabled');
    assert.ok(col, 'external_enabled column must exist');
    assert.equal(col.notnull, 1, 'external_enabled must be NOT NULL');
    assert.equal(col.dflt_value, '0', 'external_enabled must default to 0');
  });

  it('new routes default to external_enabled = 0', () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO routes (domain, target_ip, target_port) VALUES ('new.example.com', '10.8.0.99', 8080)"
    ).run();
    const row = db
      .prepare("SELECT external_enabled FROM routes WHERE domain = 'new.example.com'")
      .get();
    assert.equal(row.external_enabled, 0);
  });

  it('is recorded as version 51', () => {
    const row = getDb()
      .prepare('SELECT version, name FROM migration_history WHERE version = 51')
      .get();
    assert.ok(row, 'migration 51 must be recorded');
    assert.equal(row.name, 'route_external_exposure');
  });

  it('backfills pre-existing routes to external_enabled = 1', () => {
    // Simulate the one-time backfill: build a DB up to v50, insert a legacy
    // route (no external_enabled column yet), then apply v51 SQL directly
    // to prove the UPDATE sets all pre-existing rows to external_enabled = 1.
    const db = new Database(':memory:');
    for (const m of migrations) {
      if (m.version <= 50) db.exec(m.sql);
    }
    db.prepare(
      "INSERT INTO routes (domain, target_ip, target_port, route_type) VALUES ('legacy.example.com', '127.0.0.1', 80, 'http')"
    ).run();
    const m51 = migrations.find((m) => m.version === 51);
    db.exec(m51.sql);
    const legacy = db
      .prepare("SELECT external_enabled FROM routes WHERE domain = 'legacy.example.com'")
      .get();
    assert.equal(legacy.external_enabled, 1, 'existing route backfilled to external_enabled = 1');
    db.close();
  });
});

describe('routes service: external_enabled persistence', () => {
  let routes, db;

  before(async () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-ext-svc-'));
    process.env.GC_DB_PATH = path.join(tmp2, 'test.db');
    process.env.GC_DATA_DIR = tmp2;
    process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
    process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
    [
      '../config/default',
      '../src/db/connection',
      '../src/db/migrations',
      '../src/services/gateways',
      '../src/services/routes',
      '../src/services/caddyConfig',
      '../src/services/license',
    ].forEach((p) => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({
      http_routes: -1,
      l4_routes: -1,
    });

    // Stub Caddy sync — no real HTTP calls in tests
    const caddy = require('../src/services/caddyConfig');
    caddy.syncToCaddy = async () => {};

    routes = require('../src/services/routes');
    db = require('../src/db/connection').getDb();
  });

  it('create without external_enabled stores 0 (default)', async () => {
    const created = await routes.create({
      domain: 'ext-default.example.com',
      target_ip: '10.8.0.10',
      target_port: 80,
    });
    const row = db.prepare('SELECT external_enabled FROM routes WHERE id = ?').get(created.id);
    assert.equal(row.external_enabled, 0, 'omitting external_enabled must default to 0');
  });

  it('create with external_enabled: true stores 1', async () => {
    const created = await routes.create({
      domain: 'ext-enabled.example.com',
      target_ip: '10.8.0.11',
      target_port: 80,
      external_enabled: true,
    });
    const row = db.prepare('SELECT external_enabled FROM routes WHERE id = ?').get(created.id);
    assert.equal(row.external_enabled, 1, 'external_enabled: true must persist as 1');
  });

  it('update toggles external_enabled; omitting the field preserves value via COALESCE', async () => {
    const created = await routes.create({
      domain: 'ext-update.example.com',
      target_ip: '10.8.0.12',
      target_port: 80,
    });

    // enable
    await routes.update(created.id, { external_enabled: true });
    const row1 = db.prepare('SELECT external_enabled FROM routes WHERE id = ?').get(created.id);
    assert.equal(row1.external_enabled, 1, 'after update with true → 1');

    // disable
    await routes.update(created.id, { external_enabled: false });
    const row2 = db.prepare('SELECT external_enabled FROM routes WHERE id = ?').get(created.id);
    assert.equal(row2.external_enabled, 0, 'after update with false → 0');

    // omit field — COALESCE preserves current value (0)
    await routes.update(created.id, { description: 'no-external-field' });
    const row3 = db.prepare('SELECT external_enabled FROM routes WHERE id = ?').get(created.id);
    assert.equal(row3.external_enabled, 0, 'update without field must leave value unchanged (COALESCE)');
  });
});

describe('routes service: DNS rebuild on mutations', () => {
  let routes, db, dnsMod;
  let rebuildCalls = 0;
  let originalRebuild;

  before(async () => {
    const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-ext-dns-'));
    process.env.GC_DB_PATH = path.join(tmp3, 'test.db');
    process.env.GC_DATA_DIR = tmp3;
    process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
    process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
    [
      '../config/default',
      '../src/db/connection',
      '../src/db/migrations',
      '../src/services/gateways',
      '../src/services/routes',
      '../src/services/caddyConfig',
      '../src/services/license',
      '../src/services/dns',
    ].forEach((p) => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });

    require('../src/db/migrations').runMigrations();

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({
      http_routes: -1,
      l4_routes: -1,
    });

    const caddy = require('../src/services/caddyConfig');
    caddy.syncToCaddy = async () => {};

    routes = require('../src/services/routes');
    db = require('../src/db/connection').getDb();

    // Patch dns.rebuildNow so tests don't touch the real hosts file.
    // routes.js holds a reference to the same module object, so mutating
    // rebuildNow here intercepts every call from routes.js.
    dnsMod = require('../src/services/dns');
    originalRebuild = dnsMod.rebuildNow;
    dnsMod.rebuildNow = () => { rebuildCalls++; };
  });

  after(() => { dnsMod.rebuildNow = originalRebuild; });

  it('create() without skipSync triggers a DNS rebuild', async () => {
    rebuildCalls = 0;
    await routes.create({
      domain: 'dns-create.example.com',
      target_ip: '10.8.0.20',
      target_port: 80,
    });
    assert.equal(rebuildCalls, 1, 'create should trigger exactly one rebuild');
  });

  it('create() with skipSync does NOT trigger a DNS rebuild', async () => {
    rebuildCalls = 0;
    await routes.create({
      domain: 'dns-create-skip.example.com',
      target_ip: '10.8.0.21',
      target_port: 80,
    }, { skipSync: true });
    assert.equal(rebuildCalls, 0, 'create with skipSync must not rebuild DNS');
  });

  it('update() triggers a DNS rebuild', async () => {
    const r = await routes.create({
      domain: 'dns-update.example.com',
      target_ip: '10.8.0.22',
      target_port: 80,
    });
    rebuildCalls = 0;
    await routes.update(r.id, { description: 'updated' });
    assert.equal(rebuildCalls, 1, 'update should trigger exactly one rebuild');
  });

  it('toggle() triggers a DNS rebuild', async () => {
    const r = await routes.create({
      domain: 'dns-toggle.example.com',
      target_ip: '10.8.0.23',
      target_port: 80,
    });
    rebuildCalls = 0;
    await routes.toggle(r.id);
    assert.equal(rebuildCalls, 1, 'toggle should trigger exactly one rebuild');
  });

  it('remove() triggers a DNS rebuild', async () => {
    const r = await routes.create({
      domain: 'dns-remove.example.com',
      target_ip: '10.8.0.24',
      target_port: 80,
    });
    rebuildCalls = 0;
    await routes.remove(r.id);
    assert.equal(rebuildCalls, 1, 'remove should trigger exactly one rebuild');
  });

  it('batch(enable) triggers exactly ONE rebuild for a multi-route batch', async () => {
    const r1 = await routes.create({
      domain: 'dns-batch-en-a.example.com',
      target_ip: '10.8.0.25',
      target_port: 80,
    });
    const r2 = await routes.create({
      domain: 'dns-batch-en-b.example.com',
      target_ip: '10.8.0.26',
      target_port: 80,
    });
    // disable them first so batch enable has something to do
    await routes.toggle(r1.id);
    await routes.toggle(r2.id);
    rebuildCalls = 0;
    await routes.batch('enable', [r1.id, r2.id]);
    assert.equal(rebuildCalls, 1, 'batch enable of 2 routes must trigger exactly 1 rebuild');
  });

  it('batch(disable) triggers exactly ONE rebuild for a multi-route batch', async () => {
    const r1 = await routes.create({
      domain: 'dns-batch-dis-a.example.com',
      target_ip: '10.8.0.27',
      target_port: 80,
    });
    const r2 = await routes.create({
      domain: 'dns-batch-dis-b.example.com',
      target_ip: '10.8.0.28',
      target_port: 80,
    });
    rebuildCalls = 0;
    await routes.batch('disable', [r1.id, r2.id]);
    assert.equal(rebuildCalls, 1, 'batch disable of 2 routes must trigger exactly 1 rebuild');
  });

  it('batch(delete) triggers exactly ONE rebuild for a multi-route batch', async () => {
    const r1 = await routes.create({
      domain: 'dns-batch-del-a.example.com',
      target_ip: '10.8.0.29',
      target_port: 80,
    });
    const r2 = await routes.create({
      domain: 'dns-batch-del-b.example.com',
      target_ip: '10.8.0.30',
      target_port: 80,
    });
    rebuildCalls = 0;
    await routes.batch('delete', [r1.id, r2.id]);
    assert.equal(rebuildCalls, 1, 'batch delete of 2 routes must trigger exactly 1 rebuild');
  });
});

describe('caddyConfig: external-exposure gate (remote_ip fail-closed)', () => {
  // Find a route by EXACT host equality (single-element host array). Exact
  // field comparison avoids js/incomplete-url-substring-sanitization that a
  // .includes()/.split() of a host literal would trip.
  function findRouteByHost(cfg, host) {
    return cfg.apps.http.servers.srv0.routes.find(
      (r) => Array.isArray(r.match) && r.match[0] && Array.isArray(r.match[0].host)
        && r.match[0].host[0] === host && r.match[0].host.length === 1
    );
  }

  // Own isolated DB so the prior describes' DB swaps / cache deletions can't
  // bleed in. Mirrors the caddyConfig_contract harness.
  before(() => {
    const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-ext-gate-'));
    process.env.GC_DB_PATH = path.join(tmp4, 'test.db');
    process.env.GC_DATA_DIR = tmp4;
    process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
    process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
    [
      '../config/default',
      '../src/db/connection',
      '../src/db/migrations',
      '../src/services/caddyConfig',
      '../src/services/caddyAcl',
    ].forEach((p) => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
  });

  it('restricts internal-only http route to VPN subnet only (no client_ip)', () => {
    const { buildCaddyConfig } = require('../src/services/caddyConfig');
    const cfg = buildCaddyConfig([
      { id: 1, domain: 'int.example.com', route_type: 'http', https_enabled: 1,
        target_kind: 'peer', target_ip: '10.8.0.7', target_port: 80,
        external_enabled: 0, enabled: 1 },
    ]);
    // STRUCTURAL: prove the gate is Caddy AND (ONE match object carrying BOTH
    // host and remote_ip), NOT OR (two sibling match objects). The OR form
    // (match:[{host},{remote_ip}]) would let a correct host arriving from ANY
    // source IP match and BYPASS the gate — AND-vs-OR IS the security boundary,
    // and a string .includes() check cannot distinguish the two.
    const route = findRouteByHost(cfg, 'int.example.com');
    assert.ok(route, 'route for int.example.com present in srv0');
    assert.equal(route.match.length, 1, 'exactly ONE match object (AND, not OR sibling objects)');
    const keys = Object.keys(route.match[0]);
    assert.ok(keys.includes('host'), 'match object carries host');
    assert.ok(keys.includes('remote_ip'), 'uses remote_ip matcher in the SAME match object (AND)');
    assert.ok(!keys.includes('client_ip'), 'does NOT use client_ip for the gate');
    assert.ok(route.match[0].remote_ip.ranges.includes('10.8.0.0/24'),
      'gate restricts to the VPN subnet');
  });

  it('does NOT restrict an external route', () => {
    const { buildCaddyConfig } = require('../src/services/caddyConfig');
    const cfg = buildCaddyConfig([
      { id: 2, domain: 'ext.example.com', route_type: 'http', https_enabled: 1,
        target_kind: 'peer', target_ip: '10.8.0.7', target_port: 80,
        external_enabled: 1, enabled: 1 },
    ]);
    const route = findRouteByHost(cfg, 'ext.example.com');
    assert.ok(route, 'route for ext.example.com present in srv0');
    assert.ok(!Object.keys(route.match[0]).includes('remote_ip'), 'external route is not subnet-restricted');
  });

  it('internal-only route with acl_enabled but ZERO peers still fails closed (subnet-restricted)', () => {
    const { buildCaddyConfig } = require('../src/services/caddyConfig');
    const cfg = buildCaddyConfig([
      { id: 3, domain: 'acl0.example.com', route_type: 'http', https_enabled: 1,
        target_kind: 'peer', target_ip: '10.8.0.7', target_port: 80,
        external_enabled: 0, acl_enabled: 1, enabled: 1 },
    ]);
    const route = findRouteByHost(cfg, 'acl0.example.com');
    assert.ok(route, 'route for acl0.example.com present in srv0');
    assert.ok(route.match[0].remote_ip.ranges.includes('10.8.0.0/24'), 'falls closed to VPN subnet, not open');
  });

  it('internal-only route with acl_enabled AND a selected peer keeps the stricter /32 matcher', () => {
    const db = require('../src/db/connection').getDb();
    const { setAclPeers, buildCaddyConfig } = require('../src/services/caddyConfig');
    // Seed a real route + peer + ACL selection (route_peer_acl has FKs to both
    // routes and peers) so getAclPeers(route.id) returns a non-empty set.
    db.prepare('INSERT INTO routes (id, domain, target_ip, target_port, route_type, acl_enabled, external_enabled) VALUES (?,?,?,?,?,?,?)')
      .run(4004, 'aclp.example.com', '10.8.0.7', 80, 'http', 1, 0);
    db.prepare('INSERT INTO peers (id, name, public_key, allowed_ips, enabled) VALUES (?,?,?,?,?)')
      .run(950, 'acl-peer', 'pkAcl', '10.8.0.42/32', 1);
    setAclPeers(4004, [950]);
    const cfg = buildCaddyConfig([
      { id: 4004, domain: 'aclp.example.com', route_type: 'http', https_enabled: 1,
        target_kind: 'peer', target_ip: '10.8.0.7', target_port: 80,
        external_enabled: 0, acl_enabled: 1, enabled: 1 },
    ]);
    // STRUCTURAL: same AND-not-OR proof for the ACL /32 — host and remote_ip
    // must live in ONE match object, else a correct host from any source IP
    // would bypass the ACL.
    const route = findRouteByHost(cfg, 'aclp.example.com');
    assert.ok(route, 'route for aclp.example.com present in srv0');
    assert.equal(route.match.length, 1, 'exactly ONE match object (AND, not OR sibling objects)');
    const keys = Object.keys(route.match[0]);
    assert.ok(keys.includes('host'), 'match object carries host');
    assert.ok(keys.includes('remote_ip'), 'SAME match object carries remote_ip (AND)');
    assert.ok(route.match[0].remote_ip.ranges.includes('10.8.0.42/32'),
      'keeps the per-peer /32 matcher');
    assert.ok(!route.match[0].remote_ip.ranges.includes('10.8.0.0/24'),
      'is NOT widened to the whole VPN subnet');
  });

  it('forward-auth (compound) internal-only route keeps the remote_ip gate on the inner content route', () => {
    const { buildCaddyConfig } = require('../src/services/caddyConfig');
    // ip_filter_enabled forces needsForwardAuth=true → the route takes the
    // compound 2-element subroute branch (route-auth sibling + content route),
    // so the gate sits on the inner routeConfig, not the top-level host match.
    // This proves the gate survives the forward-auth path too.
    const cfg = buildCaddyConfig([
      { id: 7007, domain: 'fa.example.com', route_type: 'http', https_enabled: 1,
        target_kind: 'peer', target_ip: '10.8.0.7', target_port: 80,
        external_enabled: 0, ip_filter_enabled: 1, enabled: 1 },
    ]);
    const outer = findRouteByHost(cfg, 'fa.example.com');
    assert.ok(outer, 'outer host route for fa.example.com present in srv0');
    // It must be a compound subroute (forward-auth), NOT the folded single-match form.
    const subroute = outer.handle.find((h) => h.handler === 'subroute');
    assert.ok(subroute, 'compound route wraps content in a subroute (forward-auth path)');
    // Drill into the inner routes and prove the content route retains the gate.
    const gated = subroute.routes.find(
      (r) => Array.isArray(r.match) && r.match.some((m) => m.remote_ip)
    );
    assert.ok(gated, 'inner content route retains a remote_ip gate');
    const gateMatch = gated.match.find((m) => m.remote_ip);
    assert.ok(gateMatch.remote_ip.ranges.includes('10.8.0.0/24'),
      'forward-auth content route gated to the VPN subnet');
  });
});
