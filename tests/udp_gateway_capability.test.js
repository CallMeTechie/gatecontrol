'use strict';

// UDP through a gateway that can (capability `udp-routes`, services/gatewayUdp.js,
// docs/feature-domain-zones.md "UDP über ein Gateway"):
// - allowed on a gateway with the capability, on a pool with at least one
//   such member; otherwise 400 UDP_VIA_GATEWAY with "update the gateway
//   (from version …)" — the pool variant says so for the pool;
// - the config pull carries the UDP entries as `udp_routes` only for a capable
//   gateway, never in l4_routes; the hash covers them;
// - an existing UDP entry behind a gateway works after its update without a
//   step: the capability appears, the hash changes, gateway_udp turns true;
// - Caddy hands a pool's UDP entry only to capable members.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, teardown } = require('./helpers/setup');

let agent, csrf, db, routes, gateways, caddyConfig, gatewayUdp;
let oldGw, newGw, poolOld, poolMixed, zoneNew, zoneOld;

const post = (p, body) => agent.post('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const put = (p, body) => agent.put('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);

function gateway(name, ip, caps) {
  const id = Number(db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES (?, ?, ?, 1, 'gateway')")
    .run(name, crypto.randomBytes(16).toString('hex'), ip + '/32').lastInsertRowid);
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, alive, last_seen_at)
    VALUES (?, 9876, ?, 'e', ?, 1, ?)`).run(id, 'h' + id, Date.now(), Date.now());
  setCaps(id, caps);
  return id;
}
function setCaps(peerId, caps) {
  const health = caps ? { overall_healthy: true, telemetry: { gateway_version: '1.40.0', capabilities: caps } } : null;
  db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(health ? JSON.stringify(health) : null, peerId);
}

let port = 6100;
const l4 = (protocol, target) => ({
  route_type: 'l4', l4_protocol: protocol, l4_listen_port: String(port++), l4_tls_mode: 'none', ...target,
});
const viaGateway = (peerId) => ({ target_kind: 'gateway', target_peer_id: peerId, target_lan_host: '192.168.7.10', target_lan_port: 53, target_port: 53 });
const viaPool = (poolId) => ({ target_kind: 'gateway', target_pool_id: poolId, target_lan_host: '192.168.7.10', target_lan_port: 53, target_port: 53 });

before(async () => {
  const ctx = await setup();
  agent = ctx.agent;
  csrf = ctx.csrfToken;
  require('../src/services/license')._overrideForTest({
    gateway_tcp_routing: true, gateway_peers: -1, gateway_pool_failover: true, l4_routes: -1, http_routes: -1, gateway_http_targets: -1,
  });
  db = require('../src/db/connection').getDb();
  routes = require('../src/services/routes');
  gateways = require('../src/services/gateways');
  caddyConfig = require('../src/services/caddyConfig');
  gatewayUdp = require('../src/services/gatewayUdp');
  gateways.notifyConfigChanged = async () => {};
  require('../src/services/gatewayColocation')._setInterfacesForTest(() => ({ lo: [{ address: '127.0.0.1', family: 'IPv4' }] }));
  oldGw = gateway('gw-alt', '10.8.0.81', ['dns', 'cache']);
  newGw = gateway('gw-neu', '10.8.0.82', ['dns', 'cache', 'udp-routes']);
  const pool = require('../src/services/gatewayPool');
  poolOld = Number(pool.createPool({ name: 'pool-alt', mode: 'failover', failback_cooldown_s: 60 }));
  pool.addMember(poolOld, oldGw, 10);
  poolMixed = Number(pool.createPool({ name: 'pool-gemischt', mode: 'failover', failback_cooldown_s: 60 }));
  pool.addMember(poolMixed, oldGw, 10);
  pool.addMember(poolMixed, newGw, 20);
  zoneNew = Number(db.prepare(`INSERT INTO domains (domain, status, gateway_kind, gateway_peer_id, default_external_enabled)
    VALUES ('udp-neu.example.com', 'verified', 'gateway', ?, 0)`).run(newGw).lastInsertRowid);
  zoneOld = Number(db.prepare(`INSERT INTO domains (domain, status, gateway_kind, gateway_peer_id, default_external_enabled)
    VALUES ('udp-alt.example.com', 'verified', 'gateway', ?, 0)`).run(oldGw).lastInsertRowid);
});

after(() => {
  require('../src/services/gatewayColocation')._setInterfacesForTest(null);
  return teardown();
});

describe('gatewayUdp: who forwards UDP', () => {
  it('capability decides; a gateway without a heartbeat cannot', () => {
    assert.equal(gatewayUdp.peerSupportsUdp(newGw), true);
    assert.equal(gatewayUdp.peerSupportsUdp(oldGw), false);
    assert.equal(gatewayUdp.peerSupportsUdp(999999), false);
    assert.deepEqual(gatewayUdp.poolUdpPeers(poolMixed), [newGw]);
    assert.deepEqual(gatewayUdp.poolUdpPeers(poolOld), []);
    assert.equal(gatewayUdp.targetSupportsUdp({ poolId: poolMixed }), true);
    assert.equal(gatewayUdp.targetSupportsUdp({ peerId: newGw, poolId: poolOld }), false, 'the pool wins');
    assert.deepEqual(gatewayUdp.capabilitiesOf('kein json'), []);
  });
});

describe('routes API: UDP through a gateway that can', () => {
  it('UDP on a capable gateway and on a pool with a capable member: 201', async () => {
    const a = await post('/routes', l4('udp', viaGateway(newGw)));
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.route.l4_protocol, 'udp');
    const b = await post('/routes', l4('udp', viaPool(poolMixed)));
    assert.equal(b.status, 201, JSON.stringify(b.body));
    await routes.remove(a.body.route.id);
    await routes.remove(b.body.route.id);
  });

  it('a gateway without it: 400 with "update the gateway (from version …)"; a pool without one: the pool hint', async () => {
    const a = await post('/routes', l4('udp', viaGateway(oldGw)));
    assert.equal(a.status, 400);
    assert.equal(a.body.code, 'UDP_VIA_GATEWAY');
    assert.ok(a.body.fields && a.body.fields.l4_protocol);
    assert.ok(a.body.error.includes(gatewayUdp.MIN_GATEWAY_UDP), a.body.error);
    assert.ok(!/^udp_via/.test(a.body.error), 'translated: ' + a.body.error);
    const b = await post('/routes', l4('udp', viaPool(poolOld)));
    assert.equal(b.status, 400);
    assert.equal(b.body.code, 'UDP_VIA_GATEWAY');
    assert.ok(b.body.error.includes(gatewayUdp.MIN_GATEWAY_UDP), b.body.error);
    assert.notEqual(a.body.error, b.body.error, 'own text for the pool');
  });

  it('German texts name the update and the version', async () => {
    const res = await agent.post('/api/v1/routes').set('X-CSRF-Token', csrf).set('Accept-Language', 'de').send(l4('udp', viaGateway(oldGw)));
    assert.equal(res.status, 400);
    // the test app may answer in its default language; both texts carry the version
    assert.ok(res.body.error.includes(gatewayUdp.MIN_GATEWAY_UDP), res.body.error);
    const de = require('../src/i18n/de.json');
    assert.match(de['error.routes.udp_via_gateway'], /aktualisieren \(ab Version \{\{version\}\}\)/);
    assert.match(de['error.routes.udp_via_pool'], /\{\{version\}\}/);
  });

  it('PUT: moving a working UDP entry to a gateway that cannot → 400; to one that can → 200', async () => {
    const r = await routes.create(l4('udp', viaGateway(newGw)));
    let res = await put('/routes/' + r.id, { target_peer_id: oldGw });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(db.prepare('SELECT target_peer_id FROM routes WHERE id = ?').get(r.id).target_peer_id, newGw);
    res = await put('/routes/' + r.id, { target_pool_id: poolMixed });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await routes.remove(r.id);
  });
});

describe('config pull: udp_routes only for a gateway that can', () => {
  it('capable gateway: UDP in udp_routes, not in l4_routes; the hash covers it', async () => {
    const udp = await routes.create(l4('udp', viaGateway(newGw)));
    const tcp = await routes.create({ ...l4('tcp', viaGateway(newGw)), target_lan_port: 22 });
    const cfg = gateways.getGatewayConfig(newGw);
    assert.deepEqual(cfg.l4_routes.map((r) => r.id), [tcp.id]);
    assert.deepEqual(cfg.udp_routes, [{ id: udp.id, listen_port: Number(udp.l4_listen_port), target_lan_host: '192.168.7.10', target_lan_port: 53 }]);
    const h1 = gateways.computeConfigHash(newGw);
    const { features, udp_routes: _u, ...rest } = cfg;
    assert.notEqual(h1, gateways.hashOfConfig({ ...rest, features }), 'udp_routes are part of the hash');
    db.prepare('UPDATE routes SET target_lan_port = 5353 WHERE id = ?').run(udp.id);
    assert.notEqual(gateways.computeConfigHash(newGw), h1, 'a changed UDP entry changes the hash');
    await routes.remove(udp.id);
    await routes.remove(tcp.id);
  });

  it('hash formula = gateway side: sha256(h + "\\nudp_routes\\n" + stableJson(udp_routes))', () => {
    const cfg = { config_hash_version: 2, peer_id: 3, routes: [], l4_routes: [], egress_routes: [], features: { a: 1 }, udp_routes: [{ id: 1, listen_port: 53, target_lan_host: 'nas.lan', target_lan_port: 53 }] };
    const lib = require('@callmetechie/gatecontrol-config-hash').computeConfigHash;
    const { features, udp_routes: udpRoutes, ...rest } = cfg;
    const withF = 'sha256:' + crypto.createHash('sha256').update(lib(rest) + '\n' + gateways.stableJson(features)).digest('hex');
    const want = 'sha256:' + crypto.createHash('sha256').update(withF + '\nudp_routes\n' + gateways.stableJson(udpRoutes)).digest('hex');
    assert.equal(gateways.hashOfConfig(cfg), want);
  });

  it('existing UDP entry behind an older gateway: no udp_routes, gateway_udp false — after the update it works without a step', async () => {
    const tcp = await routes.create(l4('tcp', viaGateway(oldGw)));
    db.prepare("UPDATE routes SET l4_protocol = 'udp' WHERE id = ?").run(tcp.id); // a row from before
    let cfg = gateways.getGatewayConfig(oldGw);
    assert.equal(cfg.udp_routes, undefined, 'an older gateway gets no new field');
    assert.equal(cfg.l4_routes.some((r) => r.id === tcp.id), false, 'and no TCP listener for a UDP entry');
    const row = routes.toApiRows([routes.getById(tcp.id)])[0];
    assert.equal(row.gateway_udp, false);
    const detail = await agent.get('/api/v1/routes/' + tcp.id);
    assert.equal(detail.body.route.gateway_udp, false, 'GET /routes/:id (the editor) says so too');
    const before = gateways.computeConfigHash(oldGw);

    setCaps(oldGw, ['dns', 'udp-routes']); // its heartbeat after the update
    cfg = gateways.getGatewayConfig(oldGw);
    assert.deepEqual(cfg.udp_routes.map((r) => r.id), [tcp.id]);
    assert.notEqual(gateways.computeConfigHash(oldGw), before, 'the hash changes → the gateway pulls');
    assert.equal(routes.toApiRows([routes.getById(tcp.id)])[0].gateway_udp, true);
    setCaps(oldGw, ['dns', 'cache']);
    await routes.remove(tcp.id);
  });
});

describe('Caddy: a pool UDP entry only to capable members', () => {
  it('failover pool with an older first member: Caddy dials the capable one; TCP keeps the first', async () => {
    const udp = await routes.create(l4('udp', viaPool(poolMixed)));
    const tcp = await routes.create(l4('tcp', viaPool(poolMixed)));
    const cfg = await caddyConfig.buildCaddyConfig();
    const dialsOf = (lp, proto) => {
      const server = Object.values(cfg.apps.layer4.servers).find((s) => s.listen.includes((proto === 'udp' ? 'udp/' : 'tcp/') + ':' + lp) || s.listen.includes(':' + lp));
      return server.routes.flatMap((x) => x.handle).filter((h) => h.handler === 'proxy').flatMap((h) => h.upstreams.flatMap((u) => u.dial));
    };
    assert.deepEqual(dialsOf(udp.l4_listen_port, 'udp'), ['udp/10.8.0.82:' + udp.l4_listen_port]);
    assert.deepEqual(dialsOf(tcp.l4_listen_port, 'tcp'), ['10.8.0.81:' + tcp.l4_listen_port]);
    await routes.remove(udp.id);
    await routes.remove(tcp.id);
  });
});

describe('domain zones and hosts', () => {
  it('UDP host entry in a zone of a capable gateway: 201; zone.gateway.udp true/false', async () => {
    const res = await post(`/domains/${zoneNew}/hosts`, { subdomain: 'spiel', lan_host: '192.168.7.30', entries: [{ type: 'udp', target_port: 27015, listen_port: port++ }] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const refused = await post(`/domains/${zoneOld}/hosts`, { subdomain: 'spiel', lan_host: '192.168.7.30', entries: [{ type: 'udp', target_port: 27015, listen_port: port++ }] });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'UDP_VIA_GATEWAY');
    assert.ok(refused.body.error.includes(gatewayUdp.MIN_GATEWAY_UDP), refused.body.error);
    const page = await agent.get('/api/v1/zones');
    assert.equal(page.status, 200);
    const zNew = page.body.zones.find((z) => z.domain_id === zoneNew);
    const zOld = page.body.zones.find((z) => z.domain_id === zoneOld);
    assert.equal(zNew.gateway.udp, true);
    assert.equal(zOld.gateway.udp, false);
    // the UDP entry of the host carries gateway_udp: true (no "no effect" note)
    const host = zNew.hosts.find((h) => h.entries.some((e) => e.l4_protocol === 'udp'));
    assert.equal(host.entries.find((e) => e.l4_protocol === 'udp').gateway_udp, true);
  });

  it('moving a UDP entry from a capable gateway zone to an older gateway is refused', async () => {
    const res = await put(`/domains/${zoneNew}/gateway`, { kind: 'gateway', peer_id: oldGw });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'UDP_VIA_GATEWAY');
    const ok = await put(`/domains/${zoneNew}/gateway`, { kind: 'pool', pool_id: poolMixed });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });
});
