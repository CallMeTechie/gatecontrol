'use strict';

// Zone WAF default (docs/feature-release-b.md §2): PUT /api/v1/domains/:id/defaults
// with waf_default + apply_waf_to_existing (HTTP entries only, applied /
// applied_waf, one sync, rollback), licence gate `waf`, GET /zones carries
// zone.waf_default, new HTTP entries inherit the default (L4 entries do not),
// migration v77.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf, db, license;
let gw1, zoneId, routeA, routeB, l4Route;
let syncCount = 0;
let failNextSync = false;

const POST = (p, body) => agent.post('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const PUT = (p, body) => agent.put('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const GET = (p) => agent.get('/api/v1' + p);
const routeRow = (id) => db.prepare('SELECT * FROM routes WHERE id = ?').get(id);
const wafCols = (id) => { const r = routeRow(id); return [r.waf_enabled, r.waf_mode, r.waf_paranoia]; };
const zoneView = async (id) => (await GET('/zones').expect(200)).body.zones.find((z) => z.domain_id === id);

before(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  license = require('../src/services/license');
  license._overrideForTest({ waf: true, gateway_tcp_routing: true, gateway_http_targets: -1, gateway_peers: -1 });
  const caddy = require('../src/services/caddyConfig');
  const orig = caddy.syncToCaddy;
  caddy.syncToCaddy = async () => {
    syncCount++;
    if (failNextSync) { failNextSync = false; throw new Error('Caddy sync boom'); }
    return orig();
  };
  gw1 = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('Home', ?, '10.8.0.2/32', 1, 'gateway')")
    .run(crypto.randomBytes(16).toString('hex')).lastInsertRowid;
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, last_health, alive)
    VALUES (?, 9876, 'h', 'e', strftime('%s','now')*1000, ?, 1)`)
    .run(gw1, JSON.stringify({ telemetry: { lan_subnets: [{ cidr: '192.168.1.0/24' }] } }));
  zoneId = db.prepare(`INSERT INTO domains (domain, status, gateway_kind, gateway_peer_id, default_external_enabled)
    VALUES ('wafzone.com', 'verified', 'gateway', ?, 1)`).run(gw1).lastInsertRowid;
  const a = await POST(`/domains/${zoneId}/hosts`, {
    subdomain: 'a', lan_host: '192.168.1.10',
    entries: [{ type: 'http', target_port: 80 }, { type: 'tcp', target_port: 22, listen_port: 2122 }],
  });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  routeA = a.body.host.entries.find((e) => e.route_type !== 'l4').id;
  l4Route = a.body.host.entries.find((e) => e.route_type === 'l4').id;
  const b = await POST(`/domains/${zoneId}/hosts`, { subdomain: 'b', lan_host: '192.168.1.11', entries: [{ type: 'http', target_port: 8080 }] });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  routeB = b.body.host.entries[0].id;
});

after(() => { license._overrideForTest({ waf: false }); teardown(); });

test('migration v77: columns, waf_bans, indexes', () => {
  const cols = (t) => Object.fromEntries(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => [c.name, c]));
  assert.equal(cols('domains').waf_default.type, 'TEXT');
  assert.equal(cols('routes').waf_mode_changed_at.type, 'TEXT');
  assert.equal(cols('routes').backend_tls_fingerprint.type, 'TEXT');
  assert.deepEqual(db.prepare('PRAGMA table_info(waf_bans)').all().map((c) => c.name),
    ['ip', 'reason', 'hits', 'first_seen', 'banned_at', 'expires_at', 'manual']);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
  assert.ok(idx.includes('idx_waf_events_client') && idx.includes('idx_waf_events_route') && idx.includes('idx_waf_bans_expires'));
  assert.equal(db.prepare('SELECT name FROM migration_history WHERE version = 77').get().name, 'security_center');
});

test('migration v77 backfills waf_mode_changed_at from updated_at for WAF routes only', () => {
  const Database = require('better-sqlite3');
  const mem = new Database(':memory:');
  mem.exec(`CREATE TABLE domains (id INTEGER PRIMARY KEY, domain TEXT);
    CREATE TABLE routes (id INTEGER PRIMARY KEY, waf_enabled INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE waf_events (id INTEGER PRIMARY KEY, route_id INTEGER, client_ip TEXT, ts TEXT);
    INSERT INTO routes VALUES (1, 1, '2026-01-01 00:00:00', '2026-09-10 08:30:00'), (2, 0, '2026-01-01 00:00:00', '2026-09-10 08:30:00');`);
  const m = require('../src/db/migrationList').migrations.find((x) => x.version === 77);
  mem.exec(m.sql);
  assert.equal(mem.prepare('SELECT waf_mode_changed_at FROM routes WHERE id = 1').get().waf_mode_changed_at, '2026-09-10T08:30:00.000Z');
  assert.equal(mem.prepare('SELECT waf_mode_changed_at FROM routes WHERE id = 2').get().waf_mode_changed_at, null);
  mem.close();
});

test('GET /zones: waf_default null by default; PUT stores it without touching entries', async () => {
  assert.equal((await zoneView(zoneId)).waf_default, null);
  const before = syncCount;
  const res = await PUT(`/domains/${zoneId}/defaults`, { waf_default: { enabled: true, mode: 'detect', paranoia: 2 } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.zone.waf_default, { enabled: true, mode: 'detect', paranoia: 2 });
  assert.equal(res.body.applied, undefined);
  assert.equal(syncCount, before, 'no entry changed → no sync');
  assert.deepEqual(wafCols(routeA), [0, 'detect', 1]);
  assert.deepEqual((await zoneView(zoneId)).waf_default, { enabled: true, mode: 'detect', paranoia: 2 });
});

test('validation codes', async () => {
  let r = await PUT(`/domains/${zoneId}/defaults`, { waf_default: { enabled: true, mode: 'deny' } });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_MODE_INVALID');
  r = await PUT(`/domains/${zoneId}/defaults`, { waf_default: { enabled: true, paranoia: 7 } });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_PARANOIA_INVALID');
  r = await PUT(`/domains/${zoneId}/defaults`, { waf_default: 'on' });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_DEFAULT_INVALID');
  assert.deepEqual((await zoneView(zoneId)).waf_default, { enabled: true, mode: 'detect', paranoia: 2 }, 'unchanged');
});

test('licence gate: an enabling default needs `waf`, switching off does not', async () => {
  license._overrideForTest({ waf: false });
  try {
    let r = await PUT(`/domains/${zoneId}/defaults`, { waf_default: { enabled: true, mode: 'block', paranoia: 1 } });
    assert.equal(r.status, 403); assert.equal(r.body.feature, 'waf');
    r = await PUT(`/domains/${zoneId}/defaults`, { apply_waf_to_existing: true });
    assert.equal(r.status, 403, 'applying the stored enabled default needs the licence');
    // New entries do not inherit without the licence.
    const h = await POST(`/domains/${zoneId}/hosts`, { subdomain: 'nolic', lan_host: '192.168.1.30', entries: [{ type: 'http', target_port: 80 }] });
    assert.equal(h.status, 201, JSON.stringify(h.body));
    assert.equal(routeRow(h.body.host.entries[0].id).waf_enabled, 0);
  } finally { license._overrideForTest({ waf: true }); }
});

test('new HTTP entries inherit the default (waf_mode_changed_at set); L4 entries do not; explicit fields win', async () => {
  const h = await POST(`/domains/${zoneId}/hosts`, {
    subdomain: 'c', lan_host: '192.168.1.12',
    entries: [{ type: 'http', target_port: 80 }, { type: 'tcp', target_port: 22, listen_port: 2123 }],
  });
  assert.equal(h.status, 201, JSON.stringify(h.body));
  const http = h.body.host.entries.find((e) => e.route_type !== 'l4');
  const l4 = h.body.host.entries.find((e) => e.route_type === 'l4');
  assert.deepEqual(wafCols(http.id), [1, 'detect', 2]);
  assert.match(routeRow(http.id).waf_mode_changed_at, /^\d{4}-/);
  assert.equal(routeRow(l4.id).waf_enabled, 0);

  const r = await POST('/routes', { domain: 'x.wafzone.com', target_ip: '93.184.216.34', target_port: 8080, https_enabled: false, waf_enabled: false });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(routeRow(r.body.route.id).waf_enabled, 0, 'explicit waf_enabled:false wins over the default');
  const r2 = await POST('/routes', { domain: 'y.wafzone.com', target_ip: '93.184.216.34', target_port: 8080, https_enabled: false });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.deepEqual(wafCols(r2.body.route.id), [1, 'detect', 2], 'plain POST /routes inherits too');
});

test('apply_waf_to_existing: every HTTP entry of the zone, one sync, applied + applied_waf', async () => {
  const httpIds = db.prepare(`SELECT r.id FROM routes r JOIN service_bundles sb ON sb.id = r.bundle_id
    WHERE sb.domain_id = ? AND r.route_type != 'l4'`).all(zoneId).map((r) => r.id);
  const before = syncCount;
  const res = await PUT(`/domains/${zoneId}/defaults`, { waf_default: { enabled: true, mode: 'block', paranoia: 3 }, apply_waf_to_existing: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.applied, httpIds.length);
  assert.equal(res.body.applied_waf, httpIds.length);
  assert.equal(syncCount, before + 1);
  for (const id of httpIds) assert.deepEqual(wafCols(id), [1, 'block', 3]);
  assert.equal(routeRow(l4Route).waf_enabled, 0, 'L4 untouched');
  const log = db.prepare("SELECT * FROM activity_log WHERE event_type = 'zone_waf_applied' ORDER BY id DESC LIMIT 1").get();
  assert.ok(log);
});

test('switching the default off + apply clears waf_enabled only; HSTS + WAF apply = one sync', async () => {
  const before = syncCount;
  const res = await PUT(`/domains/${zoneId}/defaults`, { waf_default: null, apply_waf_to_existing: true, hsts_default: { enabled: true, max_age: 31536000 }, apply_hsts_to_existing: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(syncCount, before + 1, 'one sync for both');
  assert.equal(res.body.zone.waf_default, null);
  assert.deepEqual(wafCols(routeA), [0, 'block', 3], 'mode/paranoia kept for a later re-enable');
  assert.equal(routeRow(routeA).hsts_enabled, 1);
  assert.ok(res.body.applied >= res.body.applied_waf);
});

test('sync failure rolls back routes and zone row', async () => {
  const snapA = routeRow(routeA);
  const snapB = routeRow(routeB);
  const zoneBefore = db.prepare('SELECT waf_default, hsts_default FROM domains WHERE id = ?').get(zoneId);
  failNextSync = true;
  const res = await PUT(`/domains/${zoneId}/defaults`, { waf_default: { enabled: true, mode: 'detect', paranoia: 1 }, apply_waf_to_existing: true });
  assert.equal(res.status, 502, JSON.stringify(res.body));
  const strip = (x) => { const o = { ...x }; for (const k of Object.keys(o)) if (k.startsWith('monitoring_')) delete o[k]; return o; };
  assert.deepEqual(strip(routeRow(routeA)), strip(snapA));
  assert.deepEqual(strip(routeRow(routeB)), strip(snapB));
  assert.deepEqual(db.prepare('SELECT waf_default, hsts_default FROM domains WHERE id = ?').get(zoneId), zoneBefore);
});
