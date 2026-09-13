'use strict';

// HSTS API (docs/feature-hsts.md):
//   PUT /api/v1/routes/:id with valid / invalid hsts_* combinations,
//   PUT /api/v1/domains/:id/defaults with hsts_default + apply_hsts_to_existing
//   (every affected entry changed, exactly one sync, rollback on sync failure),
//   new entries inherit the zone default, GET /zones carries entry.hsts and
//   zone.hsts_default.
// Syncs are counted by wrapping caddyConfig.syncToCaddy (domainZones/hosts
// look it up at call time).

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf, db;
let gw1, zoneId, hostA, hostB, hostPlain, routeA, routeB, routePlain, l4Route;
let syncCount = 0;
let failNextSync = false;

const POST = (p, body) => agent.post('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const PUT = (p, body) => agent.put('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const GET = (p) => agent.get('/api/v1' + p);

const zoneView = async (id) => (await GET('/zones').expect(200)).body.zones.find((z) => z.domain_id === id);
const routeRow = (id) => db.prepare('SELECT * FROM routes WHERE id = ?').get(id);
const hstsCols = (id) => {
  const r = routeRow(id);
  return { hsts_enabled: r.hsts_enabled, hsts_max_age: r.hsts_max_age, hsts_subdomains: r.hsts_subdomains, hsts_preload: r.hsts_preload };
};
const httpEntryOf = (host) => host.entries.find((e) => e.route_type !== 'l4');

before(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  require('../src/services/license')._overrideForTest({ gateway_tcp_routing: true, gateway_http_targets: -1, gateway_peers: -1 });

  const caddy = require('../src/services/caddyConfig');
  const orig = caddy.syncToCaddy;
  caddy.syncToCaddy = async () => {
    syncCount++;
    if (failNextSync) { failNextSync = false; throw new Error('sync boom'); }
    return orig();
  };

  gw1 = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('Home', ?, '10.8.0.2/32', 1, 'gateway')")
    .run(crypto.randomBytes(16).toString('hex')).lastInsertRowid;
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, last_health, alive)
    VALUES (?, 9876, 'h', 'e', strftime('%s','now')*1000, ?, 1)`)
    .run(gw1, JSON.stringify({ telemetry: { lan_subnets: [{ cidr: '192.168.1.0/24' }] } }));
  zoneId = db.prepare(`INSERT INTO domains (domain, status, gateway_kind, gateway_peer_id, default_external_enabled)
    VALUES ('example.com', 'verified', 'gateway', ?, 1)`).run(gw1).lastInsertRowid;

  const a = await POST(`/domains/${zoneId}/hosts`, {
    subdomain: 'a', lan_host: '192.168.1.10',
    entries: [{ type: 'http', target_port: 80 }, { type: 'tcp', target_port: 22, listen_port: 2022 }],
  });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  hostA = a.body.host;
  routeA = httpEntryOf(hostA).id;
  l4Route = hostA.entries.find((e) => e.route_type === 'l4').id;

  const b = await POST(`/domains/${zoneId}/hosts`, {
    subdomain: 'b', lan_host: '192.168.1.11', entries: [{ type: 'http', target_port: 8080 }],
  });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  hostB = b.body.host;
  routeB = httpEntryOf(hostB).id;

  // An HTTP entry without HTTPS: never touched by the zone default.
  const p = await POST(`/domains/${zoneId}/hosts`, {
    subdomain: 'plain', lan_host: '192.168.1.12', entries: [{ type: 'http', target_port: 8081 }],
  });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  hostPlain = p.body.host;
  routePlain = httpEntryOf(hostPlain).id;
  const off = await PUT(`/routes/${routePlain}`, { https_enabled: false });
  assert.equal(off.status, 200, JSON.stringify(off.body));
});

after(teardown);

test('new HTTPS entries start without HSTS when the zone has no default; GET /zones shape', async () => {
  assert.deepEqual(hstsCols(routeA), { hsts_enabled: 0, hsts_max_age: 31536000, hsts_subdomains: 0, hsts_preload: 0 });
  const zone = await zoneView(zoneId);
  assert.equal(zone.hsts_default, null);
  const host = zone.hosts.find((h) => h.id === hostA.id);
  const http = httpEntryOf(host);
  assert.deepEqual(http.hsts, { enabled: false, max_age: 31536000, include_subdomains: false, preload: false });
  const l4 = host.entries.find((e) => e.route_type === 'l4');
  assert.equal('hsts' in l4, false, 'L4 entries carry no hsts');
});

test('PUT /routes/:id: valid combinations are stored and returned', async () => {
  let res = await PUT(`/routes/${routeA}`, { hsts_enabled: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.route.hsts_enabled, 1);
  assert.equal(res.body.route.hsts_max_age, 31536000);
  assert.deepEqual(hstsCols(routeA), { hsts_enabled: 1, hsts_max_age: 31536000, hsts_subdomains: 0, hsts_preload: 0 });

  res = await PUT(`/routes/${routeA}`, { hsts_max_age: 15552000, hsts_subdomains: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(hstsCols(routeA), { hsts_enabled: 1, hsts_max_age: 15552000, hsts_subdomains: 1, hsts_preload: 0 });

  res = await PUT(`/routes/${routeA}`, { hsts_max_age: 63072000, hsts_subdomains: true, hsts_preload: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(hstsCols(routeA), { hsts_enabled: 1, hsts_max_age: 63072000, hsts_subdomains: 1, hsts_preload: 1 });

  const entry = httpEntryOf((await zoneView(zoneId)).hosts.find((h) => h.id === hostA.id));
  assert.deepEqual(entry.hsts, { enabled: true, max_age: 63072000, include_subdomains: true, preload: true });

  // GET /routes/:id exposes the raw columns for the entry editor
  const g = await GET(`/routes/${routeA}`).expect(200);
  assert.equal(g.body.route.hsts_enabled, 1);
  assert.equal(g.body.route.hsts_preload, 1);

  // an unrelated patch leaves the HSTS fields alone
  res = await PUT(`/routes/${routeA}`, { description: 'Host A' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(hstsCols(routeA), { hsts_enabled: 1, hsts_max_age: 63072000, hsts_subdomains: 1, hsts_preload: 1 });
});

test('PUT /routes/:id: invalid combinations → 400 with code', async () => {
  const before = hstsCols(routeA);
  let res = await PUT(`/routes/${routeA}`, { hsts_max_age: 299 });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, 'HSTS_MAX_AGE_INVALID');
  res = await PUT(`/routes/${routeA}`, { hsts_max_age: 63072001 });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'HSTS_MAX_AGE_INVALID');
  res = await PUT(`/routes/${routeA}`, { hsts_max_age: 'soon' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'HSTS_MAX_AGE_INVALID');

  res = await PUT(`/routes/${routeA}`, { hsts_preload: true, hsts_subdomains: false });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'HSTS_PRELOAD_REQUIREMENTS');
  res = await PUT(`/routes/${routeA}`, { hsts_preload: true, hsts_subdomains: true, hsts_max_age: 15552000 });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'HSTS_PRELOAD_REQUIREMENTS');

  // enabling HSTS on an entry without HTTPS
  res = await PUT(`/routes/${routePlain}`, { hsts_enabled: true });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'HSTS_REQUIRES_HTTPS');
  // enabling HSTS on an L4 entry
  res = await PUT(`/routes/${l4Route}`, { hsts_enabled: true });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'HSTS_REQUIRES_HTTPS');
  // explicit HSTS on while switching HTTPS off in the same request
  res = await PUT(`/routes/${routeA}`, { https_enabled: false, hsts_enabled: true });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'HSTS_REQUIRES_HTTPS');

  assert.deepEqual(hstsCols(routeA), before, 'nothing written on a 400');
  assert.equal(res.body.ok, false);
});

test('turning https_enabled off clears hsts_enabled; the entry can be re-armed after HTTPS is back', async () => {
  let res = await PUT(`/routes/${routeA}`, { https_enabled: false });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.route.https_enabled, 0);
  assert.equal(res.body.route.hsts_enabled, 0);
  assert.equal(hstsCols(routeA).hsts_preload, 1, 'flags are kept for a later re-enable');

  res = await PUT(`/routes/${routeA}`, { https_enabled: true, hsts_enabled: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(hstsCols(routeA), { hsts_enabled: 1, hsts_max_age: 63072000, hsts_subdomains: 1, hsts_preload: 1 });
});

test('PUT /domains/:id/defaults stores hsts_default without touching entries', async () => {
  const before = { a: hstsCols(routeA), b: hstsCols(routeB) };
  syncCount = 0;
  let res = await PUT(`/domains/${zoneId}/defaults`, { hsts_default: { enabled: true, max_age: 15552000, include_subdomains: true, preload: false } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.zone.hsts_default, { enabled: true, max_age: 15552000, include_subdomains: true, preload: false });
  assert.equal('applied' in res.body, false, 'no applied without apply_hsts_to_existing');
  assert.equal(syncCount, 0, 'no sync when only the default changes');
  assert.deepEqual({ a: hstsCols(routeA), b: hstsCols(routeB) }, before);
  assert.equal(db.prepare('SELECT hsts_default FROM domains WHERE id = ?').get(zoneId).hsts_default,
    JSON.stringify({ enabled: true, max_age: 15552000, include_subdomains: true, preload: false }));

  // default_external_enabled still works alone and keeps the HSTS default
  res = await PUT(`/domains/${zoneId}/defaults`, { default_external_enabled: false });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.zone.default_external_enabled, false);
  assert.equal(res.body.zone.hsts_default.enabled, true);

  // validation
  res = await PUT(`/domains/${zoneId}/defaults`, { hsts_default: { enabled: true, max_age: 10 } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'HSTS_MAX_AGE_INVALID');
  res = await PUT(`/domains/${zoneId}/defaults`, { hsts_default: { enabled: true, preload: true, include_subdomains: false } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'HSTS_PRELOAD_REQUIREMENTS');
  res = await PUT(`/domains/${zoneId}/defaults`, {});
  assert.equal(res.status, 400);
  res = await PUT('/domains/99999/defaults', { hsts_default: null });
  assert.equal(res.status, 404);
});

test('new entries inherit the zone default (hosts, host entries, POST /routes); explicit fields win', async () => {
  const c = await POST(`/domains/${zoneId}/hosts`, {
    subdomain: 'c', lan_host: '192.168.1.13', entries: [{ type: 'http', target_port: 81 }, { type: 'tcp', target_port: 23, listen_port: 2023 }],
  });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const cHttp = httpEntryOf(c.body.host);
  assert.deepEqual(cHttp.hsts, { enabled: true, max_age: 15552000, include_subdomains: true, preload: false });
  assert.deepEqual(hstsCols(cHttp.id), { hsts_enabled: 1, hsts_max_age: 15552000, hsts_subdomains: 1, hsts_preload: 0 });
  const cL4 = c.body.host.entries.find((e) => e.route_type === 'l4');
  assert.equal(hstsCols(cL4.id).hsts_enabled, 0, 'L4 entries never get HSTS');

  // POST /hosts/:id/entries — an L4 host gets its HTTP entry
  const d = await POST(`/domains/${zoneId}/hosts`, {
    subdomain: 'd', lan_host: '192.168.1.14', entries: [{ type: 'tcp', target_port: 22, listen_port: 2024 }],
  });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const e = await POST(`/hosts/${d.body.host.id}/entries`, { type: 'http', target_port: 82 });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  assert.deepEqual(e.body.entry.hsts, { enabled: true, max_age: 15552000, include_subdomains: true, preload: false });

  // POST /routes (legacy create) in the zone: inherits too
  const r = await POST('/routes', {
    route_type: 'http', domain: 'legacy.example.com', target_kind: 'gateway', target_peer_id: gw1,
    target_lan_host: '192.168.1.15', target_port: 3001, target_lan_port: 3001,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.route.hsts_enabled, 1);
  assert.equal(r.body.route.hsts_max_age, 15552000);
  assert.equal(r.body.route.hsts_subdomains, 1);

  // explicit hsts_* on create wins over the default
  const r2 = await POST('/routes', {
    route_type: 'http', domain: 'explicit.example.com', target_kind: 'gateway', target_peer_id: gw1,
    target_lan_host: '192.168.1.16', target_port: 3002, target_lan_port: 3002, hsts_enabled: false,
  });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.equal(r2.body.route.hsts_enabled, 0);

  // invalid explicit fields on create → 400 with code
  const r3 = await POST('/routes', {
    route_type: 'http', domain: 'bad.example.com', target_kind: 'gateway', target_peer_id: gw1,
    target_lan_host: '192.168.1.17', target_port: 3003, target_lan_port: 3003, hsts_enabled: true, hsts_max_age: 1,
  });
  assert.equal(r3.status, 400, JSON.stringify(r3.body));
  assert.equal(r3.body.code, 'HSTS_MAX_AGE_INVALID');

  // no HTTPS on create → no inherited HSTS
  const r4 = await POST('/routes', {
    route_type: 'http', domain: 'nohttps.example.com', target_kind: 'gateway', target_peer_id: gw1,
    target_lan_host: '192.168.1.18', target_port: 3004, target_lan_port: 3004, https_enabled: false,
  });
  assert.equal(r4.status, 201, JSON.stringify(r4.body));
  assert.equal(r4.body.route.hsts_enabled, 0);

  // outside the zone: no default
  db.prepare("INSERT INTO domains (domain, status) VALUES ('other.org', 'verified')").run();
  const r5 = await POST('/routes', {
    route_type: 'http', domain: 'x.other.org', target_kind: 'gateway', target_peer_id: gw1,
    target_lan_host: '192.168.1.19', target_port: 3005, target_lan_port: 3005,
  });
  assert.equal(r5.status, 201, JSON.stringify(r5.body));
  assert.equal(r5.body.route.hsts_enabled, 0);
});

test('apply_hsts_to_existing: every HTTPS HTTP entry of the zone changes, exactly one sync', async () => {
  // Make host B a gateway_override host: the override must not matter for HSTS.
  db.prepare('UPDATE service_bundles SET gateway_override = 1 WHERE id = ?').run(hostB.id);
  // Host A currently: preload variant; B: off; plain: no HTTPS.
  const plainBefore = hstsCols(routePlain);
  const l4Before = hstsCols(l4Route);

  syncCount = 0;
  const def = { enabled: true, max_age: 31536000, include_subdomains: false, preload: false };
  const res = await PUT(`/domains/${zoneId}/defaults`, { hsts_default: def, apply_hsts_to_existing: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(syncCount, 1, 'exactly one Caddy sync for the whole cascade');
  assert.deepEqual(res.body.zone.hsts_default, def);
  const httpsEntries = db.prepare(`
    SELECT r.id FROM routes r JOIN service_bundles sb ON sb.id = r.bundle_id
    WHERE sb.domain_id = ? AND r.route_type != 'l4' AND r.https_enabled = 1`).all(zoneId).map((r) => r.id);
  assert.equal(res.body.applied, httpsEntries.length);
  assert.ok(httpsEntries.includes(routeA) && httpsEntries.includes(routeB));
  for (const id of httpsEntries) {
    assert.deepEqual(hstsCols(id), { hsts_enabled: 1, hsts_max_age: 31536000, hsts_subdomains: 0, hsts_preload: 0 }, 'route ' + id);
  }
  assert.deepEqual(hstsCols(routePlain), plainBefore, 'entry without HTTPS untouched');
  assert.deepEqual(hstsCols(l4Route), l4Before, 'L4 entry untouched');
  for (const h of res.body.zone.hosts) {
    const http = httpEntryOf(h);
    if (http && http.https_enabled) assert.equal(http.hsts.enabled, true, h.fqdn);
  }

  // Switching the default off with apply clears the flag on every entry.
  syncCount = 0;
  const off = await PUT(`/domains/${zoneId}/defaults`, { hsts_default: null, apply_hsts_to_existing: true });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.zone.hsts_default, null);
  assert.equal(off.body.applied, httpsEntries.length);
  assert.equal(syncCount, 1);
  for (const id of httpsEntries) assert.equal(hstsCols(id).hsts_enabled, 0, 'route ' + id);
  assert.equal(db.prepare('SELECT hsts_default FROM domains WHERE id = ?').get(zoneId).hsts_default, null);
});

test('apply_hsts_to_existing: a failing sync restores every entry and the zone default', async () => {
  const routesBefore = db.prepare('SELECT * FROM routes ORDER BY id').all();
  const zoneBefore = db.prepare('SELECT * FROM domains WHERE id = ?').get(zoneId);
  failNextSync = true;
  const res = await PUT(`/domains/${zoneId}/defaults`, {
    hsts_default: { enabled: true, max_age: 63072000, include_subdomains: true, preload: true },
    apply_hsts_to_existing: true,
  });
  assert.equal(res.status, 500, JSON.stringify(res.body));
  assert.equal(res.body.ok, false);
  assert.deepEqual(db.prepare('SELECT * FROM routes ORDER BY id').all(), routesBefore);
  assert.deepEqual(db.prepare('SELECT * FROM domains WHERE id = ?').get(zoneId), zoneBefore);
});

test('the generated Caddy config carries the header for an armed entry only', async () => {
  let res = await PUT(`/routes/${routeA}`, { hsts_enabled: true, hsts_max_age: 31536000, hsts_subdomains: true, hsts_preload: false });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const cfg = JSON.stringify(require('../src/services/caddyConfig').buildCaddyConfig());
  assert.ok(cfg.includes('"Strict-Transport-Security":["max-age=31536000; includeSubDomains"]'), 'header in config');
  res = await PUT(`/routes/${routeA}`, { hsts_enabled: false });
  assert.equal(res.status, 200);
  const cfg2 = JSON.stringify(require('../src/services/caddyConfig').buildCaddyConfig());
  assert.ok(!cfg2.includes('Strict-Transport-Security'), 'no header once every entry is off');
});
