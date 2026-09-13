'use strict';

// API contract of docs/feature-security-options.md:
//   A  PUT /hosts/:id { aliases, alias_mode } (+ POST /domains/:id/hosts),
//      GET /zones host.aliases / alias_mode / alias_fqdns, GET /tls/status
//      alias rows (alias_of), preflight per alias, conflicts, removal/rename/delete
//   B/D/F  PUT /routes/:id security fields + error codes + mTLS feature gate,
//      GET /zones entry.mtls_enabled
//   E  PUT /domains/:id/defaults { tls_min_version } (one sync, rollback), zone.tls_min_version
//   G  GET /tls/preflight/:host caa_status / caa_suggestion
// Syncs are counted by wrapping caddyConfig.syncToCaddy (looked up at call time).

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_CADDY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-secopt-api-caddy-'));

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');
const { CA_PEM, BUNDLE_PEM } = require('./helpers/secopt_ca');

const V4 = '198.51.100.7';
const FOREIGN6 = '2001:41d0:301:1::29';

let agent, csrf, db, domains, license, tlsGuard;
let gw1, zoneId, hostA, hostB, hostL4, routeA, routeB;
let syncCount = 0;
let failNextSync = false;
const dnsMap = {};
const nodata = () => { const e = new Error('ENODATA'); e.code = 'ENODATA'; throw e; };

const POST = (p, body) => agent.post('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const PUT = (p, body) => agent.put('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const DEL = (p) => agent.delete('/api/v1' + p).set('X-CSRF-Token', csrf);
const GET = (p) => agent.get('/api/v1' + p);

const zoneView = async (id) => (await GET('/zones').expect(200)).body.zones.find((z) => z.domain_id === id);
const hostView = async (id) => (await zoneView(zoneId)).hosts.find((h) => h.id === id);
const httpEntryOf = (host) => host.entries.find((e) => e.route_type !== 'l4');
const tlsRow = (host) => db.prepare('SELECT * FROM tls_status WHERE host = ?').get(host) || null;
const statusRow = async (host) => (await GET('/tls/status').expect(200)).body.hosts.find((h) => h.host === host) || null;
const routeRow = (id) => db.prepare('SELECT * FROM routes WHERE id = ?').get(id);

before(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  domains = require('../src/services/domains');
  license = require('../src/services/license');
  tlsGuard = require('../src/services/tlsGuard');
  license._overrideForTest({ gateway_tcp_routing: true, gateway_http_targets: -1, gateway_peers: -1 });

  // Preflight with an injected resolver: every name resolves to this server
  // unless dnsMap says otherwise.
  domains._setServerIpsForTest({ v4: V4, v6: null });
  domains._setCaaResolverForTest(async () => nodata());
  domains._setResolverForTest(async (host, family) => {
    const r = dnsMap[host] || { a: [V4], aaaa: [] };
    return family === 4 ? r.a : r.aaaa;
  });

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

  let r = await POST(`/domains/${zoneId}/hosts`, {
    subdomain: 'a', lan_host: '192.168.1.10',
    entries: [{ type: 'http', target_port: 80 }, { type: 'tcp', target_port: 22, listen_port: 2022 }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  hostA = r.body.host; routeA = httpEntryOf(hostA).id;

  r = await POST(`/domains/${zoneId}/hosts`, { subdomain: 'b', lan_host: '192.168.1.11', entries: [{ type: 'http', target_port: 8080 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  hostB = r.body.host; routeB = httpEntryOf(hostB).id;

  r = await POST(`/domains/${zoneId}/hosts`, { subdomain: 'ssh', lan_host: '192.168.1.12', entries: [{ type: 'tcp', target_port: 22, listen_port: 2023 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  hostL4 = r.body.host;
});

after(() => { domains._setServerIpsForTest(null); teardown(); });

// ─── A. aliases ─────────────────────────────────────────

test('GET /zones: alias and security fields with their defaults', async () => {
  const zone = await zoneView(zoneId);
  assert.equal(zone.tls_min_version, '1.2');
  const host = zone.hosts.find((h) => h.id === hostA.id);
  assert.deepEqual(host.aliases, []);
  assert.equal(host.alias_mode, 'redirect');
  assert.deepEqual(host.alias_fqdns, []);
  const e = httpEntryOf(host);
  assert.equal(e.mtls_enabled, 0);
  assert.equal(e.max_body_mb, 0);
  assert.equal(e.backend_tls_verify, 0);
});

test('PUT /hosts/:id { aliases }: normalised labels, one sync, tls_status rows and GET /tls/status alias rows', async () => {
  const before = syncCount;
  const res = await PUT(`/hosts/${hostA.id}`, { aliases: ['www', 'WWW', ' Old. ', ''] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.host.aliases, ['www', 'old']);
  assert.equal(res.body.host.alias_mode, 'redirect');
  assert.deepEqual(res.body.host.alias_fqdns, ['www.a.example.com', 'old.a.example.com']);
  assert.equal(syncCount, before + 1, 'exactly one sync');
  // preflight passed → tls: last alias verdict, with the alias name
  assert.deepEqual(res.body.tls, { state: 'pending', code: 'ok', detail: null, host: 'old.a.example.com' });
  assert.equal(db.prepare('SELECT aliases, alias_mode FROM service_bundles WHERE id = ?').get(hostA.id).aliases, '["www","old"]');
  assert.ok(tlsRow('www.a.example.com'), 'alias tls_status row');
  assert.ok(tlsRow('old.a.example.com'));

  const s = await statusRow('www.a.example.com');
  assert.ok(s, 'alias listed in /tls/status');
  assert.equal(s.alias_of, 'a.example.com');
  assert.equal(s.host_id, hostA.id);
  assert.equal(s.route_id, routeA);
  assert.equal(s.domain_id, zoneId);
  assert.equal(s.kind, 'acme');
  assert.equal(s.state, 'pending');
  assert.equal((await statusRow('a.example.com')).alias_of, null);

  const host = await hostView(hostA.id);
  assert.deepEqual(host.aliases, ['www', 'old']);
});

test('PUT /hosts/:id: alias_mode serve/redirect, unchanged patch = no sync', async () => {
  let before = syncCount;
  let res = await PUT(`/hosts/${hostA.id}`, { alias_mode: 'serve' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.host.alias_mode, 'serve');
  assert.equal(syncCount, before + 1);
  assert.equal(res.body.tls, undefined, 'no new alias → no preflight verdict');

  before = syncCount;
  res = await PUT(`/hosts/${hostA.id}`, { alias_mode: 'serve', aliases: ['www', 'old'] });
  assert.equal(res.status, 200);
  assert.equal(syncCount, before, 'nothing changed → no sync');

  res = await PUT(`/hosts/${hostA.id}`, { alias_mode: 'redirect' });
  assert.equal(res.status, 200);
  assert.equal(res.body.host.alias_mode, 'redirect');
});

test('PUT /hosts/:id: invalid aliases → 400 with code', async () => {
  for (const [body, code] of [
    [{ aliases: 'www' }, 'ALIAS_INVALID'],
    [{ aliases: ['@'] }, 'ALIAS_INVALID'],
    [{ aliases: ['bad host'] }, 'ALIAS_INVALID'],
    [{ aliases: ['-x'] }, 'ALIAS_INVALID'],
    [{ aliases: Array.from({ length: 11 }, (_, i) => 'a' + i) }, 'ALIAS_LIMIT'],
    [{ alias_mode: 'proxy' }, 'ALIAS_INVALID'],
  ]) {
    const res = await PUT(`/hosts/${hostA.id}`, body);
    assert.equal(res.status, 400, JSON.stringify(body) + ' → ' + JSON.stringify(res.body));
    assert.equal(res.body.code, code, JSON.stringify(body));
  }
  // a host without HTTP entry cannot have aliases
  const res = await PUT(`/hosts/${hostL4.id}`, { aliases: ['www'] });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, 'ALIAS_REQUIRES_HTTP');
  // unchanged
  assert.deepEqual((await hostView(hostA.id)).aliases, ['www', 'old']);
});

test('alias conflicts → 409 ALIAS_CONFLICT; a host name must not take an alias → 409 HOST_EXISTS', async () => {
  // host B wants alias "x" → x.b.example.com fine; host A's alias space is *.a.example.com
  let res = await PUT(`/hosts/${hostB.id}`, { aliases: ['x'] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // host "@" with alias "www.a" → www.a.example.com = alias of host A
  res = await POST(`/domains/${zoneId}/hosts`, { subdomain: '@', lan_host: '192.168.1.20', entries: [{ type: 'http', target_port: 80 }], aliases: ['www.a'] });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'ALIAS_CONFLICT');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM service_bundles WHERE domain_id = ? AND subdomain = '@'").get(zoneId).n, 0, 'host not created');
  // alias "b" on host "@" would be b.example.com = host B
  res = await POST(`/domains/${zoneId}/hosts`, { subdomain: '@', lan_host: '192.168.1.20', entries: [{ type: 'http', target_port: 80 }], aliases: ['b'] });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ALIAS_CONFLICT');
  // alias "x.b" on host "@" = alias of host B
  res = await POST(`/domains/${zoneId}/hosts`, { subdomain: '@', lan_host: '192.168.1.20', entries: [{ type: 'http', target_port: 80 }], aliases: ['x.b'] });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ALIAS_CONFLICT');
  // a new host named "www.a" collides with host A's alias
  res = await POST(`/domains/${zoneId}/hosts`, { subdomain: 'www.a', lan_host: '192.168.1.21', entries: [{ type: 'http', target_port: 80 }] });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'HOST_EXISTS');
  // renaming host B to an alias name of A
  res = await PUT(`/hosts/${hostB.id}`, { subdomain: 'old.a' });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'HOST_EXISTS');
  // a legacy route with the alias name (no host)
  const rid = db.prepare("INSERT INTO routes (domain, target_ip, target_port, enabled) VALUES ('legacy.b.example.com', '10.8.0.5', 80, 1)").run().lastInsertRowid;
  try {
    res = await PUT(`/hosts/${hostB.id}`, { aliases: ['x', 'legacy'] });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'ALIAS_CONFLICT');
  } finally {
    db.prepare('DELETE FROM routes WHERE id = ?').run(rid);
  }
  await PUT(`/hosts/${hostB.id}`, { aliases: [] }).expect(200);
});

test('POST /domains/:id/hosts with aliases creates host + aliases (www on @)', async () => {
  const res = await POST(`/domains/${zoneId}/hosts`, {
    subdomain: '@', lan_host: '192.168.1.20', entries: [{ type: 'http', target_port: 80 }], aliases: ['www'],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body.host.aliases, ['www']);
  assert.deepEqual(res.body.host.alias_fqdns, ['www.example.com']);
  assert.deepEqual(res.body.tls, { state: 'pending', code: 'ok', detail: null }, 'primary verdict wins');
  assert.ok(tlsRow('www.example.com'));
  assert.equal((await statusRow('www.example.com')).alias_of, 'example.com');
  const del = await DEL(`/hosts/${res.body.host.id}`);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(tlsRow('www.example.com'), null, 'alias tls row removed with the host');
  assert.equal(await statusRow('www.example.com'), null);
});

test('a paused alias never blocks the primary; removing it drops its row', async () => {
  dnsMap['bad.a.example.com'] = { a: [V4], aaaa: [FOREIGN6] };
  const res = await PUT(`/hosts/${hostA.id}`, { aliases: ['www', 'old', 'bad'] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.tls, { state: 'paused', code: 'aaaa_without_ipv6', detail: `AAAA ${FOREIGN6} but this server has no IPv6 address`, host: 'bad.a.example.com' });
  assert.equal(tlsRow('bad.a.example.com').state, 'paused');
  assert.notEqual((tlsRow('a.example.com') || { state: 'pending' }).state, 'paused', 'primary untouched');
  const s = await statusRow('bad.a.example.com');
  assert.equal(s.state, 'paused'); assert.equal(s.paused_reason, 'preflight'); assert.equal(s.alias_of, 'a.example.com');
  assert.ok(tlsGuard.pausedHosts().includes('bad.a.example.com'));
  const cfg = require('../src/services/caddyConfig').buildCaddyConfig();
  const srv0 = cfg.apps.http.servers.srv0;
  assert.ok(srv0.automatic_https.skip.includes('bad.a.example.com'));
  const redirect = srv0.routes.find((r) => r['@id'] === 'gc_https_redirect');
  assert.ok(redirect.match[0].host.includes('www.a.example.com') && !redirect.match[0].host.includes('bad.a.example.com'));
  assert.ok(srv0.routes.find((r) => r['@id'] === `gc_alias_${routeA}`).match[0].host.includes('bad.a.example.com'), 'still served');

  const rm = await PUT(`/hosts/${hostA.id}`, { aliases: ['www', 'old'] });
  assert.equal(rm.status, 200, JSON.stringify(rm.body));
  assert.equal(tlsRow('bad.a.example.com'), null, 'row removed');
  assert.equal(await statusRow('bad.a.example.com'), null);
  assert.ok(!tlsGuard.pausedHosts().includes('bad.a.example.com'));
  delete dnsMap['bad.a.example.com'];
});

test('renaming a host re-derives its alias FQDNs', async () => {
  const res = await PUT(`/hosts/${hostA.id}`, { subdomain: 'app' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.host.fqdn, 'app.example.com');
  assert.deepEqual(res.body.host.alias_fqdns, ['www.app.example.com', 'old.app.example.com']);
  assert.deepEqual(res.body.tls, { state: 'pending', code: 'ok', detail: null }, 'primary verdict, not the alias one');
  assert.equal(tlsRow('www.a.example.com'), null);
  assert.equal(tlsRow('old.a.example.com'), null);
  assert.ok(tlsRow('www.app.example.com'));
  assert.equal((await statusRow('www.app.example.com')).alias_of, 'app.example.com');
  assert.equal(await statusRow('www.a.example.com'), null);
  await PUT(`/hosts/${hostA.id}`, { subdomain: 'a' }).expect(200);
  assert.ok(tlsRow('www.a.example.com'));
});

test('sync failure rolls the alias change back', async () => {
  failNextSync = true;
  const res = await PUT(`/hosts/${hostA.id}`, { aliases: ['www'] });
  assert.ok(res.status >= 500, JSON.stringify(res.body));
  assert.deepEqual((await hostView(hostA.id)).aliases, ['www', 'old']);
  assert.equal(db.prepare('SELECT aliases FROM service_bundles WHERE id = ?').get(hostA.id).aliases, '["www","old"]');
});

test('deleting the last entry dissolves the host and its alias rows', async () => {
  const r = await POST(`/domains/${zoneId}/hosts`, { subdomain: 'tmp', lan_host: '192.168.1.30', entries: [{ type: 'http', target_port: 80 }], aliases: ['www'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(tlsRow('www.tmp.example.com'));
  const del = await agent.delete(`/api/v1/routes/${httpEntryOf(r.body.host).id}`).set('X-CSRF-Token', csrf);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(db.prepare('SELECT 1 FROM service_bundles WHERE id = ?').get(r.body.host.id), undefined);
  assert.equal(tlsRow('www.tmp.example.com'), null);
});

// ─── B/D/F. route fields ─────────────────────────────────

test('PUT /routes/:id: security fields stored, returned and visible in GET /zones', async () => {
  let res = await PUT(`/routes/${routeA}`, {
    backend_https: true, backend_tls_verify: true, backend_tls_server_name: 'NAS.lan', backend_tls_ca_pem: CA_PEM,
    max_body_mb: '50', mtls_enabled: true, mtls_ca_pem: BUNDLE_PEM,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const r = res.body.route;
  assert.equal(r.backend_tls_verify, 1);
  assert.equal(r.backend_tls_server_name, 'nas.lan');
  assert.equal(r.backend_tls_ca_pem, CA_PEM);
  assert.equal(r.max_body_mb, 50);
  assert.equal(r.mtls_enabled, 1);
  assert.equal(r.mtls_ca_pem, BUNDLE_PEM);
  assert.equal(r.mtls_mode, 'require');
  const entry = httpEntryOf(await hostView(hostA.id));
  assert.equal(entry.mtls_enabled, 1);
  assert.equal(entry.max_body_mb, 50);
  // unrelated patch keeps everything
  res = await PUT(`/routes/${routeA}`, { description: 'Host A' });
  assert.equal(res.status, 200);
  assert.equal(routeRow(routeA).mtls_enabled, 1);
  assert.equal(routeRow(routeA).backend_tls_ca_pem, CA_PEM);
  // clearing
  res = await PUT(`/routes/${routeA}`, { backend_tls_server_name: '', backend_tls_ca_pem: '', max_body_mb: 0, mtls_enabled: false });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(routeRow(routeA).backend_tls_server_name, null);
  assert.equal(routeRow(routeA).backend_tls_ca_pem, null);
  assert.equal(routeRow(routeA).max_body_mb, 0);
  assert.equal(routeRow(routeA).mtls_enabled, 0);
  assert.equal(routeRow(routeA).mtls_ca_pem, BUNDLE_PEM, 'CA kept for a later re-enable');
});

test('PUT /routes/:id: invalid values → 400 with code, nothing stored', async () => {
  const before = routeRow(routeB);
  for (const [body, code] of [
    [{ backend_tls_ca_pem: 'garbage' }, 'BACKEND_CA_INVALID'],
    [{ backend_tls_server_name: 'not a host' }, 'BACKEND_SERVER_NAME_INVALID'],
    [{ max_body_mb: 4097 }, 'MAX_BODY_INVALID'],
    [{ max_body_mb: -1 }, 'MAX_BODY_INVALID'],
    [{ max_body_mb: 'big' }, 'MAX_BODY_INVALID'],
    [{ mtls_enabled: true }, 'MTLS_CA_INVALID'],
    [{ mtls_enabled: true, mtls_ca_pem: 'nope' }, 'MTLS_CA_INVALID'],
    [{ mtls_enabled: true, mtls_ca_pem: CA_PEM, mtls_mode: 'optional' }, 'MTLS_MODE_INVALID'],
    [{ mtls_enabled: true, mtls_ca_pem: CA_PEM, https_enabled: false }, 'MTLS_REQUIRES_HTTPS'],
  ]) {
    const res = await PUT(`/routes/${routeB}`, body);
    assert.equal(res.status, 400, JSON.stringify(body) + ' → ' + JSON.stringify(res.body));
    assert.equal(res.body.code, code, JSON.stringify(body));
  }
  assert.deepEqual(routeRow(routeB), before);
  // an L4 entry cannot get mTLS
  const l4 = hostA.entries.find((e) => e.route_type === 'l4').id;
  const res = await PUT(`/routes/${l4}`, { mtls_enabled: true, mtls_ca_pem: CA_PEM });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, 'MTLS_REQUIRES_HTTPS');
});

test('turning HTTPS off clears an inherited mtls_enabled; POST /routes accepts the fields', async () => {
  let res = await PUT(`/routes/${routeB}`, { mtls_enabled: true, mtls_ca_pem: CA_PEM });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  res = await PUT(`/routes/${routeB}`, { https_enabled: false });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(routeRow(routeB).mtls_enabled, 0);
  await PUT(`/routes/${routeB}`, { https_enabled: true }).expect(200);

  res = await agent.post('/api/v1/routes').set('X-CSRF-Token', csrf).send({
    domain: 'direct.example.com', target_ip: '203.0.113.10', target_port: 8443, https_enabled: true, backend_https: true,
    backend_tls_verify: true, backend_tls_ca_pem: CA_PEM, max_body_mb: 8, mtls_enabled: true, mtls_ca_pem: CA_PEM,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.route.backend_tls_verify, 1);
  assert.equal(res.body.route.max_body_mb, 8);
  assert.equal(res.body.route.mtls_enabled, 1);
  await agent.delete(`/api/v1/routes/${res.body.route.id}`).set('X-CSRF-Token', csrf).expect(200);
});

test('mtls_enabled is gated by the route_auth feature (403), disabling is always allowed', async () => {
  license._overrideForTest({ route_auth: false });
  try {
    let res = await PUT(`/routes/${routeB}`, { mtls_enabled: true, mtls_ca_pem: CA_PEM });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.feature, 'route_auth');
    res = await PUT(`/routes/${routeB}`, { mtls_enabled: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    res = await PUT(`/routes/${routeB}`, { max_body_mb: 5 });
    assert.equal(res.status, 200, 'other security fields are not gated');
  } finally {
    license._overrideForTest({ route_auth: true });
  }
});

// ─── E. zone TLS profile ─────────────────────────────────

test('PUT /domains/:id/defaults { tls_min_version }: stored, one sync, rollback on sync failure, validation', async () => {
  let before = syncCount;
  let res = await PUT(`/domains/${zoneId}/defaults`, { tls_min_version: '1.3' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.zone.tls_min_version, '1.3');
  assert.equal(syncCount, before + 1, 'one sync for the profile change');
  assert.equal(db.prepare('SELECT tls_min_version FROM domains WHERE id = ?').get(zoneId).tls_min_version, '1.3');
  const cfg = require('../src/services/caddyConfig').buildCaddyConfig();
  const pol = cfg.apps.http.servers.srv0.tls_connection_policies;
  assert.ok(Array.isArray(pol) && pol[pol.length - 1] && Object.keys(pol[pol.length - 1]).length === 0, 'catch-all last');
  const zonePol = pol.find((p) => p.protocol_min === 'tls1.3' && !p.client_authentication);
  assert.ok(zonePol.match.sni.includes('a.example.com') && zonePol.match.sni.includes('www.a.example.com'), 'zone policy covers hosts and aliases');

  before = syncCount;
  res = await PUT(`/domains/${zoneId}/defaults`, { tls_min_version: '1.3' });
  assert.equal(res.status, 200);
  assert.equal(syncCount, before, 'same value → no sync');

  res = await PUT(`/domains/${zoneId}/defaults`, { default_external_enabled: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.zone.tls_min_version, '1.3', 'other defaults leave the profile alone');
  await PUT(`/domains/${zoneId}/defaults`, { default_external_enabled: true }).expect(200);

  failNextSync = true;
  res = await PUT(`/domains/${zoneId}/defaults`, { tls_min_version: '1.2' });
  assert.ok(res.status >= 500, JSON.stringify(res.body));
  assert.equal(db.prepare('SELECT tls_min_version FROM domains WHERE id = ?').get(zoneId).tls_min_version, '1.3', 'rolled back');

  for (const bad of ['1.1', 'tls1.3', 13, '']) {
    res = await PUT(`/domains/${zoneId}/defaults`, { tls_min_version: bad });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'TLS_MIN_VERSION_INVALID');
  }
  res = await PUT(`/domains/${zoneId}/defaults`, { tls_min_version: '1.2' });
  assert.equal(res.status, 200);
  assert.equal(res.body.zone.tls_min_version, '1.2');
  assert.equal('tls_connection_policies' in require('../src/services/caddyConfig').buildCaddyConfig().apps.http.servers.srv0, false);
});

// ─── G. CAA ──────────────────────────────────────────────

test('GET /tls/preflight/:host: caa_status and caa_suggestion', async () => {
  let res = await GET('/tls/preflight/a.example.com').expect(200);
  assert.equal(res.body.result.ok, true);
  assert.equal(res.body.result.caa_status, 'none');
  assert.equal(res.body.result.caa_suggestion, 'example.com. CAA 0 issue "letsencrypt.org"');

  domains._setCaaResolverForTest(async (n) => (n === 'example.com' ? [{ critical: 0, issue: 'letsencrypt.org' }] : nodata()));
  res = await GET('/tls/preflight/a.example.com').expect(200);
  assert.equal(res.body.result.ok, true);
  assert.equal(res.body.result.caa_status, 'allows');
  assert.equal(res.body.result.caa_suggestion, null);

  domains._setCaaResolverForTest(async (n) => (n === 'a.example.com' ? [{ critical: 128, issue: 'digicert.com' }] : nodata()));
  res = await GET('/tls/preflight/a.example.com').expect(200);
  assert.equal(res.body.result.ok, false);
  assert.equal(res.body.result.code, 'caa_blocks');
  assert.equal(res.body.result.caa_status, 'blocks');
  assert.equal(res.body.result.caa_suggestion, null);
  domains._setCaaResolverForTest(async () => nodata());

  // an earlier rule ends the check → no CAA verdict
  dnsMap['x.example.com'] = { a: ['203.0.113.9'], aaaa: [] };
  res = await GET('/tls/preflight/x.example.com').expect(200);
  assert.equal(res.body.result.code, 'a_mismatch');
  assert.equal(res.body.result.caa_status, null);
  assert.equal(res.body.result.caa_suggestion, null);
  // private names carry no CAA verdict either; base domain falls back to the last two labels without a zone
  res = await GET('/tls/preflight/printer.lan').expect(200);
  assert.equal(res.body.result.caa_status, null);
  res = await GET('/tls/preflight/host.other-zone.net').expect(200);
  assert.equal(res.body.result.caa_suggestion, 'other-zone.net. CAA 0 issue "letsencrypt.org"');
});
