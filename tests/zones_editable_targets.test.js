'use strict';

// Editable targets and multi-entry hosts (docs/feature-domain-zones.md,
// "Ziele bearbeiten", "Neuer Host mit mehreren Weiterleitungen",
// "Header-Vorlagen"):
//   * PUT /api/routes/:id changes target port, listen port, protocol and type
//     of an existing entry; gateway targets keep target_port and
//     target_lan_port in step; listen-port clashes answer 409 with a
//     suggestion; type changes keep the host rules (domain, listen port, one
//     HTTP entry per host) and the licence gates.
//   * POST /api/v1/domains/:id/hosts with several entries: validation,
//     licence, port conflicts and rollback leave nothing behind.
//   * custom_headers: '-Name' removals and the {host}/{remote_host}
//     placeholders are accepted and reach the Caddy config; anything else in
//     braces is refused.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf, db, license, caddy;
let gw1, zoneId, peerZoneId, peerTarget;
let failNextSync = false;

const POST = (p, body) => agent.post('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const PUT = (p, body) => agent.put('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const routeRow = (id) => db.prepare('SELECT * FROM routes WHERE id = ?').get(id);
const hostRow = (id) => db.prepare('SELECT * FROM service_bundles WHERE id = ?').get(id);
const members = (hostId) => db.prepare('SELECT * FROM routes WHERE bundle_id = ? ORDER BY id').all(hostId);
const count = (sql, ...a) => db.prepare(sql).get(...a).n;

function gateway(name, ip) {
  const id = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES (?, ?, ?, 1, 'gateway')")
    .run(name, crypto.randomBytes(16).toString('hex'), ip + '/32').lastInsertRowid;
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, last_health, alive)
    VALUES (?, 9876, ?, 'e', strftime('%s','now')*1000, ?, 1)`)
    .run(id, 'h' + id, JSON.stringify({ telemetry: { lan_subnets: [{ cidr: '192.168.1.0/24' }] } }));
  return id;
}

async function createHost(sub, entries, extra = {}) {
  const res = await POST(`/domains/${zoneId}/hosts`, { subdomain: sub, lan_host: '192.168.1.' + (20 + sub.length), entries, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.host;
}

before(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  license = require('../src/services/license');
  license._overrideForTest({ gateway_tcp_routing: true, gateway_http_targets: -1, gateway_peers: -1 });
  caddy = require('../src/services/caddyConfig');
  const orig = caddy.syncToCaddy;
  caddy.syncToCaddy = async () => {
    if (failNextSync) { failNextSync = false; throw new Error('sync boom'); }
    return orig();
  };
  gw1 = gateway('Home GW', '10.8.0.2');
  peerTarget = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled) VALUES ('server', ?, '10.8.0.60/32', 1)")
    .run(crypto.randomBytes(16).toString('hex')).lastInsertRowid;
  zoneId = db.prepare(`INSERT INTO domains (domain, status, gateway_kind, gateway_peer_id, default_external_enabled)
    VALUES ('edit.example.com', 'verified', 'gateway', ?, 0)`).run(gw1).lastInsertRowid;
  peerZoneId = db.prepare(`INSERT INTO domains (domain, status, gateway_kind, gateway_peer_id, default_external_enabled)
    VALUES ('peer.example.com', 'verified', 'peer', ?, 0)`).run(peerTarget).lastInsertRowid;
});

after(teardown);

describe('PUT /api/routes/:id — editable target of an existing entry', () => {
  test('gateway HTTP entry: a new target port moves target_port AND target_lan_port', async () => {
    const host = await createHost('web', [{ type: 'http', target_port: 8080 }]);
    const id = host.entries[0].id;
    assert.equal(routeRow(id).target_lan_port, 8080);
    const res = await PUT('/routes/' + id, { target_port: '8443' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = routeRow(id);
    assert.equal(r.target_port, 8443);
    assert.equal(r.target_lan_port, 8443, 'gateway forwarding port follows');
    // Only target_lan_port given: target_port mirrors it.
    await PUT('/routes/' + id, { target_lan_port: 9000 }).expect(200);
    assert.equal(routeRow(id).target_port, 9000);
    assert.equal(routeRow(id).target_lan_port, 9000);
    // Both given (what the dialogs send): stored as sent.
    await PUT('/routes/' + id, { target_port: '9001', target_lan_port: 9001 }).expect(200);
    assert.deepEqual([routeRow(id).target_port, routeRow(id).target_lan_port], [9001, 9001]);
    assert.equal(routeRow(id).bundle_id, host.id, 'still in its host');
  });

  test('TCP entry: listen port, protocol and target port are editable', async () => {
    const host = await createHost('rdp', [{ type: 'tcp', target_port: 3389, listen_port: 33891 }]);
    const id = host.entries[0].id;
    const res = await PUT('/routes/' + id, {
      route_type: 'l4', l4_protocol: 'udp', l4_listen_port: '33892', target_port: '3390', target_lan_port: 3390,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = routeRow(id);
    assert.equal(r.l4_protocol, 'udp');
    assert.equal(r.l4_listen_port, '33892');
    assert.equal(r.target_port, 3390);
    assert.equal(r.target_lan_port, 3390);
    assert.equal(r.bundle_id, host.id);
  });

  test('a listen port another enabled entry uses → 409 with a free-port suggestion', async () => {
    const a = await createHost('ssh-a', [{ type: 'tcp', target_port: 22, listen_port: 2201 }]);
    const b = await createHost('ssh-b', [{ type: 'tcp', target_port: 22, listen_port: 2202 }]);
    const res = await PUT('/routes/' + b.entries[0].id, { l4_listen_port: '2201' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'BUNDLE_PORT_CONFLICT');
    assert.equal(res.body.conflict.port, 2201);
    assert.equal(res.body.conflict.conflictRouteId, a.entries[0].id);
    assert.ok(res.body.conflict.suggestedPort > 2201);
    assert.equal(routeRow(b.entries[0].id).l4_listen_port, '2202', 'nothing written');
    // Same port on the other protocol is free.
    await PUT('/routes/' + b.entries[0].id, { l4_protocol: 'udp', l4_listen_port: '2201' }).expect(200);
    // Re-saving an entry with its own port is no conflict.
    await PUT('/routes/' + a.entries[0].id, { l4_listen_port: '2201', description: 'x' }).expect(200);
  });

  test('reserved listen ports are refused', async () => {
    const host = await createHost('res', [{ type: 'tcp', target_port: 22, listen_port: 2299 }]);
    const res = await PUT('/routes/' + host.entries[0].id, { l4_listen_port: '2019' });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(routeRow(host.entries[0].id).l4_listen_port, '2299');
  });

  test('TCP → HTTP: needs a domain; the entry keeps its host and zone', async () => {
    const host = await createHost('svc', [{ type: 'tcp', target_port: 8080, listen_port: 18080 }]);
    const id = host.entries[0].id;
    let res = await PUT('/routes/' + id, { route_type: 'http' });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'TYPE_DOMAIN_REQUIRED');
    res = await PUT('/routes/' + id, { route_type: 'http', domain: 'svc.edit.example.com', https_enabled: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = routeRow(id);
    assert.equal(r.route_type, 'http');
    assert.equal(r.l4_listen_port, null, 'L4 columns cleared');
    assert.equal(r.bundle_id, host.id);
    assert.equal(hostRow(host.id).domain_id, zoneId, 'host still in the zone');
    assert.equal(hostRow(host.id).subdomain, 'svc');
  });

  test('a host keeps ONE HTTP entry: TCP → HTTP next to an HTTP entry → 409 HOST_HAS_HTTP', async () => {
    const host = await createHost('two', [{ type: 'http', target_port: 80 }, { type: 'tcp', target_port: 22, listen_port: 2222 }]);
    const tcp = host.entries.find((e) => e.route_type === 'l4');
    const res = await PUT('/routes/' + tcp.id, { route_type: 'http', domain: 'two.edit.example.com' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'HOST_HAS_HTTP');
    assert.equal(routeRow(tcp.id).route_type, 'l4');
  });

  test('HTTP → TCP: needs protocol + listen port; the entry stays in its zoned host', async () => {
    const host = await createHost('flip', [{ type: 'http', target_port: 8080 }]);
    const id = host.entries[0].id;
    let res = await PUT('/routes/' + id, { route_type: 'l4', l4_protocol: 'tcp' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'TYPE_LISTEN_PORT_REQUIRED');
    res = await PUT('/routes/' + id, { route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '18081', l4_tls_mode: 'none', domain: '' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = routeRow(id);
    assert.equal(r.route_type, 'l4');
    assert.equal(r.l4_listen_port, '18081');
    assert.equal(r.bundle_id, host.id, 'not moved out of its host');
    assert.equal(hostRow(host.id).domain_id, zoneId, 'host keeps its zone');
    assert.equal(hostRow(host.id).subdomain, 'flip');
  });

  test('type change counts against the other type\'s licence limit', async () => {
    const host = await createHost('lic', [{ type: 'http', target_port: 8080 }]);
    const l4 = count("SELECT COUNT(*) AS n FROM routes WHERE route_type = 'l4'");
    license._overrideForTest({ l4_routes: l4 });
    try {
      const res = await PUT('/routes/' + host.entries[0].id, { route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '18090', domain: '' });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.feature, 'l4_routes');
      assert.equal(routeRow(host.entries[0].id).route_type, 'http');
    } finally {
      license._overrideForTest({ l4_routes: -1 });
    }
  });

  test('peer target: the target port is plain target_port (no LAN port)', async () => {
    const res = await agent.post('/api/v1/domains/' + peerZoneId + '/hosts').set('X-CSRF-Token', csrf)
      .send({ subdomain: 'app', entries: [{ type: 'http', target_port: 3000 }] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body.host.entries[0].id;
    await PUT('/routes/' + id, { target_port: '3001' }).expect(200);
    assert.equal(routeRow(id).target_port, 3001);
    assert.equal(routeRow(id).target_lan_port, null);
  });
});

describe('POST /api/v1/domains/:id/hosts — several entries at once', () => {
  test('creates the host with every entry and the chosen access', async () => {
    const host = await createHost('multi', [
      { type: 'http', target_port: 5001, backend_https: true },
      { type: 'tcp', target_port: 22, listen_port: 2322 },
      { type: 'udp', target_port: 53, listen_port: 5353 },
    ], { external_enabled: true });
    const rows = members(host.id);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.route_type).sort(), ['http', 'l4', 'l4']);
    assert.ok(rows.every((r) => r.external_enabled === 1), 'external_enabled from the dialog, not the zone default (0)');
    assert.ok(rows.every((r) => r.target_lan_host === host.lan_host));
    const udp = rows.find((r) => r.l4_protocol === 'udp');
    assert.equal(udp.target_lan_port, 53);
    assert.equal(udp.target_port, 53);
  });

  test('without external_enabled the zone default applies; a non-boolean is refused', async () => {
    const host = await createHost('dflt', [{ type: 'tcp', target_port: 22, listen_port: 2422 }]);
    assert.equal(members(host.id)[0].external_enabled, 0);
    const res = await POST(`/domains/${zoneId}/hosts`, { subdomain: 'bad-ext', lan_host: '192.168.1.9', external_enabled: 'yes', entries: [{ type: 'tcp', target_port: 22, listen_port: 2423 }] });
    assert.equal(res.status, 400);
  });

  test('validation: two HTTP entries, a duplicate listen port, a missing listen port', async () => {
    const before = count('SELECT COUNT(*) AS n FROM routes');
    const hostsBefore = count('SELECT COUNT(*) AS n FROM service_bundles');
    let res = await POST(`/domains/${zoneId}/hosts`, { subdomain: 'v1', lan_host: '192.168.1.5', entries: [{ type: 'http', target_port: 80 }, { type: 'http', target_port: 81 }] });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'HOST_HAS_HTTP');
    res = await POST(`/domains/${zoneId}/hosts`, { subdomain: 'v2', lan_host: '192.168.1.5', entries: [{ type: 'tcp', target_port: 22, listen_port: 2522 }, { type: 'tcp', target_port: 23, listen_port: 2522 }] });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /Duplicate listen port/);
    res = await POST(`/domains/${zoneId}/hosts`, { subdomain: 'v3', lan_host: '192.168.1.5', entries: [{ type: 'tcp', target_port: 22 }] });
    assert.equal(res.status, 400);
    assert.equal(count('SELECT COUNT(*) AS n FROM routes'), before, 'no route written');
    assert.equal(count('SELECT COUNT(*) AS n FROM service_bundles'), hostsBefore, 'no host written');
  });

  test('licence: the combined count of all entries is checked before anything is written', async () => {
    const l4 = count("SELECT COUNT(*) AS n FROM routes WHERE route_type = 'l4'");
    license._overrideForTest({ l4_routes: l4 + 1 });
    try {
      const res = await POST(`/domains/${zoneId}/hosts`, { subdomain: 'lic2', lan_host: '192.168.1.6', entries: [
        { type: 'tcp', target_port: 22, listen_port: 2622 }, { type: 'tcp', target_port: 23, listen_port: 2623 },
      ] });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.feature, 'l4_routes');
      assert.equal(count("SELECT COUNT(*) AS n FROM service_bundles WHERE subdomain = 'lic2'"), 0);
    } finally {
      license._overrideForTest({ l4_routes: -1 });
    }
  });

  test('a listen port in use → 409 with suggestion, nothing created', async () => {
    await createHost('taken', [{ type: 'tcp', target_port: 22, listen_port: 2722 }]);
    const res = await POST(`/domains/${zoneId}/hosts`, { subdomain: 'clash', lan_host: '192.168.1.7', entries: [
      { type: 'http', target_port: 80 }, { type: 'tcp', target_port: 22, listen_port: 2722 },
    ] });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'BUNDLE_PORT_CONFLICT');
    assert.ok(res.body.conflict.suggestedPort);
    assert.equal(count("SELECT COUNT(*) AS n FROM service_bundles WHERE subdomain = 'clash'"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM routes WHERE domain = 'clash.edit.example.com'"), 0);
  });

  test('a failed Caddy sync rolls the whole host back', async () => {
    const routesBefore = count('SELECT COUNT(*) AS n FROM routes');
    failNextSync = true;
    const res = await POST(`/domains/${zoneId}/hosts`, { subdomain: 'boom', lan_host: '192.168.1.8', entries: [
      { type: 'http', target_port: 80 }, { type: 'tcp', target_port: 22, listen_port: 2822 },
    ] });
    assert.ok(res.status >= 400, JSON.stringify(res.body));
    assert.equal(count('SELECT COUNT(*) AS n FROM routes'), routesBefore, 'member routes removed');
    assert.equal(count("SELECT COUNT(*) AS n FROM service_bundles WHERE subdomain = 'boom'"), 0, 'host removed');
  });
});

describe('custom headers: removal and placeholders', () => {
  test('-Server removal and {host}/{remote_host} reach the Caddy config', async () => {
    const host = await createHost('hdr', [{ type: 'http', target_port: 8080 }]);
    const id = host.entries[0].id;
    const res = await PUT('/routes/' + id, { custom_headers: {
      request: [{ name: 'X-Forwarded-Host', value: '{host}' }, { name: 'X-Real-IP', value: '{remote_host}' }, { name: '-X-Debug', value: '' }],
      response: [{ name: '-Server', value: '' }, { name: '-X-Powered-By', value: '' }, { name: 'X-Robots-Tag', value: 'noindex, nofollow' }],
    } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const cfg = caddy.buildCaddyConfig([caddy.getRouteForConfig ? caddy.getRouteForConfig(id) : routeRow(id)]);
    const json = JSON.stringify(cfg);
    assert.ok(json.includes('"X-Forwarded-Host":["{http.request.host}"]'), 'short placeholder expanded');
    assert.ok(json.includes('"X-Real-IP":["{http.request.remote.host}"]'));
    assert.ok(json.includes('"delete":["X-Debug"]'), 'request removal');
    assert.ok(json.includes('"response":{"delete":["Server","X-Powered-By"],"deferred":true}'), 'deferred response removal');
    assert.ok(json.includes('"X-Robots-Tag":["noindex, nofollow"]'));
    assert.ok(!json.includes('"-Server"'), 'no literal "-Server" header');
  });

  test('other placeholders, CR/LF and bad names are refused with CUSTOM_HEADER_INVALID', async () => {
    const host = await createHost('hdr2', [{ type: 'http', target_port: 8080 }]);
    const id = host.entries[0].id;
    for (const bad of [
      { request: [{ name: 'X-Leak', value: '{env.GC_SECRET}' }] },
      { response: [{ name: 'X-Leak', value: '{file./etc/passwd}' }] },
      { response: [{ name: 'X-Split', value: 'a\r\nSet-Cookie: x=1' }] },
      { response: [{ name: '--bad', value: '' }] },
      { response: [{ name: 'X Bad', value: 'v' }] },
      { response: [{ name: 'X-Empty', value: '' }] },
    ]) {
      const res = await PUT('/routes/' + id, { custom_headers: bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(res.body.code, 'CUSTOM_HEADER_INVALID', JSON.stringify(res.body));
    }
    assert.equal(routeRow(id).custom_headers, null, 'nothing stored');
  });
});
