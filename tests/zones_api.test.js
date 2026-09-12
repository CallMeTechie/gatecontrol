'use strict';

// /api/v1 domain zones endpoints (routes/api/domainZones.js).
// Syncs are counted by wrapping caddyConfig.syncToCaddy: domainZones/hosts
// look it up at call time, so the wrapper sees every sync they trigger.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf, db, license;
let gw1, gw2, gw3, peerA, zoneId, peerZoneId, poolId;
let syncCount = 0;
let failNextSync = false;

const POST = (p, body) => agent.post('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const PUT = (p, body) => agent.put('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const DEL = (p) => agent.delete('/api/v1' + p).set('X-CSRF-Token', csrf);
const GET = (p) => agent.get('/api/v1' + p);

function gateway(name, ip) {
  const id = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES (?, ?, ?, 1, 'gateway')")
    .run(name, crypto.randomBytes(16).toString('hex'), ip + '/32').lastInsertRowid;
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, last_health, alive)
    VALUES (?, 9876, ?, 'e', strftime('%s','now')*1000, ?, 1)`)
    .run(id, 'h' + id, JSON.stringify({ telemetry: { lan_subnets: [{ cidr: '192.168.1.0/24' }] } }));
  return id;
}

const zonesView = async () => (await GET('/zones').expect(200)).body;
const zoneView = async (id) => (await zonesView()).zones.find((z) => z.domain_id === id);
const hostRoutes = (hostId) => db.prepare('SELECT * FROM routes WHERE bundle_id = ? ORDER BY id').all(hostId);

before(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  license = require('../src/services/license');
  license._overrideForTest({ gateway_tcp_routing: true, gateway_scan_egress: true, gateway_http_targets: -1, gateway_peers: -1 });

  const caddy = require('../src/services/caddyConfig');
  const orig = caddy.syncToCaddy;
  caddy.syncToCaddy = async () => {
    syncCount++;
    if (failNextSync) { failNextSync = false; throw new Error('sync boom'); }
    return orig();
  };

  gw1 = gateway('Home Gateway', '10.8.0.2');
  gw2 = gateway('NAS Gateway', '10.8.0.3');
  gw3 = gateway('New Gateway', '10.8.0.4');
  peerA = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled) VALUES ('laptop', ?, '10.8.0.50/32', 1)")
    .run(crypto.randomBytes(16).toString('hex')).lastInsertRowid;
  zoneId = db.prepare(`INSERT INTO domains (domain, status, gateway_kind, gateway_peer_id, default_external_enabled)
    VALUES ('example.com', 'verified', 'gateway', ?, 1)`).run(gw1).lastInsertRowid;
  peerZoneId = db.prepare(`INSERT INTO domains (domain, status, gateway_kind, gateway_peer_id)
    VALUES ('peerzone.com', 'verified', 'gateway', ?)`).run(gw1).lastInsertRowid;
  const gatewayPool = require('../src/services/gatewayPool');
  poolId = gatewayPool.createPool({ name: 'pool-a', mode: 'failover', failback_cooldown_s: 60 });
  gatewayPool.addMember(poolId, gw1, 10);
});

after(teardown);

test('POST /domains/:id/hosts creates a host; GET /zones returns the contract shape', async () => {
  const res = await POST(`/domains/${zoneId}/hosts`, {
    subdomain: 'nas', description: 'NAS', lan_host: '192.168.1.10',
    entries: [{ type: 'http', target_port: 5001, backend_https: true }, { type: 'tcp', target_port: 22, listen_port: 2022 }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  const host = res.body.host;
  assert.equal(host.fqdn, 'nas.example.com');

  const view = await zonesView();
  assert.equal(view.ok, true);
  for (const k of ['zones', 'unassigned', 'gateways', 'pools']) assert.ok(Array.isArray(view[k]), k);
  const zone = view.zones.find((z) => z.domain_id === zoneId);
  for (const k of ['domain_id', 'domain', 'verification', 'gateway', 'default_external_enabled', 'counts', 'health', 'hosts']) {
    assert.ok(k in zone, 'zone.' + k);
  }
  assert.deepEqual(zone.gateway, { kind: 'gateway', peer_id: gw1, pool_id: null, name: 'Home Gateway', ip: '10.8.0.2', online: true });
  assert.equal(zone.default_external_enabled, true);
  assert.deepEqual(zone.counts, { hosts: 1, entries: 2, http: 1, l4: 1, disabled: 0 });
  assert.equal(zone.health, 'ok');

  const h = zone.hosts[0];
  for (const k of ['id', 'domain_id', 'subdomain', 'fqdn', 'name', 'description', 'template', 'lan_host',
    'gateway_override', 'entry_count', 'enabled_count', 'health', 'entries']) {
    assert.ok(k in h, 'host.' + k);
  }
  assert.equal(h.lan_host, '192.168.1.10');
  assert.equal(h.gateway_override, false);

  // Entries are exactly GET /api/routes rows (+ rdp_owned, rdp_route_id).
  const apiRows = (await GET('/routes').expect(200)).body.routes;
  for (const e of h.entries) {
    const row = apiRows.find((r) => r.id === e.id);
    assert.ok(row);
    for (const [k, v] of Object.entries(row)) assert.deepEqual(e[k], v, 'entry.' + k);
    assert.equal(e.rdp_owned, false);
    assert.equal(e.rdp_route_id, null);
    assert.equal('basic_auth_password_hash' in e, false);
  }

  assert.ok(view.gateways.some((g) => g.id === gw1 && g.name === 'Home Gateway' && g.ip === '10.8.0.2' && g.online === true));
  assert.ok(view.pools.some((p) => p.id === poolId && p.name === 'pool-a'));
});

test('PUT /domains/:id/gateway re-targets every non-override entry with exactly one sync', async () => {
  const b = await POST(`/domains/${zoneId}/hosts`, {
    subdomain: 'app', lan_host: '192.168.1.11',
    entries: [{ type: 'http', target_port: 80 }, { type: 'tcp', target_port: 8022, listen_port: 2122 }],
  });
  assert.equal(b.status, 201);
  // Legacy route on another gateway → host flagged gateway_override.
  const legacy = await POST('/routes', { route_type: 'http', domain: 'mail.example.com', target_kind: 'gateway',
    target_peer_id: gw2, target_lan_host: '192.168.1.12', target_port: 3001, target_lan_port: 3001 });
  assert.equal(legacy.status, 201, JSON.stringify(legacy.body));

  const zoneBefore = await zoneView(zoneId);
  const overrideHost = zoneBefore.hosts.find((h) => h.fqdn === 'mail.example.com');
  assert.equal(overrideHost.gateway_override, true);

  syncCount = 0;
  const res = await PUT(`/domains/${zoneId}/gateway`, { kind: 'gateway', peer_id: gw3 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(syncCount, 1, 'exactly one Caddy sync for the whole cascade');
  assert.equal(res.body.zone.gateway.peer_id, gw3);

  for (const h of res.body.zone.hosts) {
    for (const r of hostRoutes(h.id)) {
      if (h.id === overrideHost.id) assert.equal(r.target_peer_id, gw2, 'override host untouched');
      else {
        assert.equal(r.target_kind, 'gateway');
        assert.equal(r.target_peer_id, gw3);
        assert.equal(r.peer_id, null);
        assert.ok(r.target_lan_host, 'LAN host kept');
      }
    }
  }
});

test('a failing sync restores every route and the zone gateway', async () => {
  const before = db.prepare('SELECT * FROM routes ORDER BY id').all();
  failNextSync = true;
  const res = await PUT(`/domains/${zoneId}/gateway`, { kind: 'gateway', peer_id: gw1 });
  assert.equal(res.status, 500);
  assert.equal(res.body.ok, false);
  assert.deepEqual(db.prepare('SELECT * FROM routes ORDER BY id').all(), before);
  assert.equal(db.prepare('SELECT gateway_peer_id FROM domains WHERE id = ?').get(zoneId).gateway_peer_id, gw3);
});

test('gateway validation and peer targets', async () => {
  let res = await PUT(`/domains/${zoneId}/gateway`, { kind: 'gateway', peer_id: peerA });
  assert.equal(res.status, 400, 'a regular peer is not a gateway');
  res = await PUT('/domains/99999/gateway', { kind: 'gateway', peer_id: gw1 });
  assert.equal(res.status, 404);
  res = await PUT(`/domains/${zoneId}/gateway`, { kind: 'bogus' });
  assert.equal(res.status, 400);

  const host = await POST(`/domains/${peerZoneId}/hosts`, {
    subdomain: 'svc', lan_host: '192.168.1.30', entries: [{ type: 'http', target_port: 8080 }],
  });
  assert.equal(host.status, 201);
  res = await PUT(`/domains/${peerZoneId}/gateway`, { kind: 'peer', peer_id: peerA });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [row] = hostRoutes(host.body.host.id);
  assert.equal(row.target_kind, 'peer');
  assert.equal(row.peer_id, peerA);
  assert.equal(row.target_ip, '10.8.0.50');
  assert.equal(row.target_port, 8080);
  assert.equal(row.target_lan_host, null);
  assert.equal(res.body.zone.hosts[0].lan_host, null, 'no LAN address for peer targets');
  // Back behind a gateway needs a LAN address the entries no longer have.
  res = await PUT(`/domains/${peerZoneId}/gateway`, { kind: 'gateway', peer_id: gw1 });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'LAN_HOST_REQUIRED');
});

test('PUT /domains/:id/defaults only affects new entries', async () => {
  const res = await PUT(`/domains/${zoneId}/defaults`, { default_external_enabled: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.zone.default_external_enabled, false);
  const host = (await zoneView(zoneId)).hosts.find((h) => h.fqdn === 'app.example.com');
  const entry = await POST(`/hosts/${host.id}/entries`, { type: 'udp', target_port: 5353, listen_port: 5353 });
  assert.equal(entry.status, 201, JSON.stringify(entry.body));
  assert.equal(entry.body.entry.external_enabled, 0);
  assert.equal(entry.body.entry.target_peer_id, gw3, 'zone target');
  assert.equal(entry.body.entry.bundle_id, host.id);
});

test('POST /hosts/:id/entries: port conflict → 409 BUNDLE_PORT_CONFLICT with suggestedPort', async () => {
  const host = (await zoneView(zoneId)).hosts.find((h) => h.fqdn === 'app.example.com');
  const res = await POST(`/hosts/${host.id}/entries`, { type: 'tcp', target_port: 22, listen_port: 2022 });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'BUNDLE_PORT_CONFLICT');
  assert.equal(res.body.conflict.port, 2022);
  assert.equal(typeof res.body.conflict.suggestedPort, 'number');
  assert.ok(res.body.conflict.conflictRouteId);
});

test('license limits on the new endpoints', async () => {
  const host = (await zoneView(zoneId)).hosts.find((h) => h.fqdn === 'app.example.com');
  const httpCount = db.prepare("SELECT COUNT(*) c FROM routes WHERE route_type = 'http' OR route_type IS NULL").get().c;
  const l4Count = () => db.prepare("SELECT COUNT(*) c FROM routes WHERE route_type = 'l4'").get().c;
  try {
    license._overrideForTest({ http_routes: httpCount });
    let res = await POST(`/domains/${zoneId}/hosts`, { subdomain: 'lim', lan_host: '192.168.1.40', entries: [{ type: 'http', target_port: 80 }] });
    assert.equal(res.status, 403);
    assert.equal(res.body.feature, 'http_routes');
    res = await POST(`/domains/${zoneId}/hosts`, { subdomain: 'lim2', lan_host: '192.168.1.41', template: 'ssh' });
    assert.equal(res.status, 201, 'an L4-only template is not limited by http_routes');

    license._overrideForTest({ http_routes: -1, l4_routes: l4Count() + 1 });
    res = await POST(`/domains/${zoneId}/hosts`, { subdomain: 'lim3', lan_host: '192.168.1.42', template: 'printer' });
    assert.equal(res.status, 403, 'printer adds 2 L4 entries — combined check');
    res = await POST(`/hosts/${host.id}/entries`, { type: 'tcp', target_port: 21, listen_port: 2121 });
    assert.equal(res.status, 201, 'one more L4 entry still fits');
    res = await POST(`/hosts/${host.id}/entries`, { type: 'tcp', target_port: 23, listen_port: 2323 });
    assert.equal(res.status, 403);
    assert.equal(res.body.feature, 'l4_routes');

    license._overrideForTest({ l4_routes: -1, gateway_tcp_routing: false });
    res = await POST(`/hosts/${host.id}/entries`, { type: 'tcp', target_port: 23, listen_port: 2323 });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /gateway_tcp_routing/);

    license._overrideForTest({ gateway_tcp_routing: true, gateway_scan_egress: false });
    res = await POST(`/hosts/${host.id}/scan-to-folder`, { vip_ip: '192.168.1.200', target: { mode: 'existing', route_id: 1 } });
    assert.equal(res.status, 403);
    assert.equal(res.body.feature, 'gateway_scan_egress');

    license._overrideForTest({ gateway_scan_egress: true, gateway_pool_failover: false });
    res = await PUT(`/domains/${zoneId}/gateway`, { kind: 'pool', pool_id: poolId });
    assert.equal(res.status, 403);
    assert.equal(res.body.feature, 'gateway_pool_failover');
  } finally {
    license._overrideForTest({ http_routes: -1, l4_routes: -1, gateway_tcp_routing: true, gateway_scan_egress: true, gateway_pool_failover: true });
  }
});

test('host endpoints: rename, toggle, override reset, delete, 404', async () => {
  const zone = await zoneView(zoneId);
  const app = zone.hosts.find((h) => h.fqdn === 'app.example.com');
  let res = await PUT(`/hosts/${app.id}`, { subdomain: 'web', description: 'Web app' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.host.fqdn, 'web.example.com');
  assert.equal(res.body.host.description, 'Web app');
  res = await PUT(`/hosts/${app.id}`, { subdomain: 'nas' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'HOST_EXISTS');

  res = await PUT(`/hosts/${app.id}/toggle`, { enabled: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.host.enabled_count, 0);
  assert.equal(res.body.host.health, 'disabled');
  res = await PUT(`/hosts/${app.id}/toggle`, { enabled: 'no' });
  assert.equal(res.status, 400);

  const mail = zone.hosts.find((h) => h.fqdn === 'mail.example.com');
  res = await PUT(`/hosts/${mail.id}/gateway-override`, { override: true });
  assert.equal(res.status, 400);
  res = await PUT(`/hosts/${mail.id}/gateway-override`, { override: false });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.host.gateway_override, false);
  assert.equal(hostRoutes(mail.id)[0].target_peer_id, gw3);

  res = await DEL(`/hosts/${app.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(hostRoutes(app.id).length, 0);
  assert.equal((await zoneView(zoneId)).hosts.some((h) => h.id === app.id), false);

  assert.equal((await PUT('/hosts/99999', { description: 'x' })).status, 404);
  assert.equal((await DEL('/hosts/99999')).status, 404);
  assert.equal((await POST('/hosts/99999/entries', { type: 'http', target_port: 80 })).status, 404);
});

test('GET /host-templates lists templates', async () => {
  const res = await GET('/host-templates');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.templates.map((t) => t.id), ['printer', 'nas', 'proxmox', 'ssh']);
});
