'use strict';

// UDP behind a gateway or pool (docs/feature-domain-zones.md, "UDP hinter
// Gateway/Pool"): the gateway forwards TCP only, so the server refuses every
// way INTO that combination with 400 UDP_VIA_GATEWAY (translated text):
// POST/PUT /api/v1/routes, POST /domains/:id/hosts, POST /hosts/:id/entries,
// PUT /domains/:id/gateway and clearing a host's gateway override. A row from
// before the rule stays editable. And Caddy dials the upstream of a UDP entry
// over UDP (`udp/host:port`) — without the prefix caddy-l4 dials TCP.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, teardown } = require('./helpers/setup');

let agent, csrf, db, routes, caddyConfig, gw, gw2, peer, poolId, zoneId, peerZoneId;

const post = (p, body) => agent.post('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const put = (p, body) => agent.put('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);

function gateway(name, ip) {
  const id = Number(db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES (?, ?, ?, 1, 'gateway')")
    .run(name, crypto.randomBytes(16).toString('hex'), ip + '/32').lastInsertRowid);
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, alive, last_seen_at)
    VALUES (?, 9876, ?, 'e', ?, 1, ?)`).run(id, 'h' + id, Date.now(), Date.now());
  return id;
}

let port = 5100;
const l4 = (protocol, target) => ({
  route_type: 'l4', l4_protocol: protocol, l4_listen_port: String(port++), l4_tls_mode: 'none', ...target,
});
const viaGateway = (peerId) => ({ target_kind: 'gateway', target_peer_id: peerId, target_lan_host: '192.168.7.10', target_lan_port: 53, target_port: 53 });
const viaPeer = () => ({ target_kind: 'peer', peer_id: peer, target_ip: '10.8.0.70', target_port: 53 });

function assertRefused(res, field) {
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, 'UDP_VIA_GATEWAY', JSON.stringify(res.body));
  assert.ok(res.body.error && !/^udp_via_gateway/.test(res.body.error), 'translated text, not the code: ' + res.body.error);
  if (field) assert.ok(res.body.fields && res.body.fields[field], 'field error on ' + field + ': ' + JSON.stringify(res.body));
}

before(async () => {
  const ctx = await setup();
  agent = ctx.agent;
  csrf = ctx.csrfToken;
  require('../src/services/license')._overrideForTest({
    gateway_tcp_routing: true, gateway_peers: -1, gateway_pool_failover: true, l4_routes: -1, http_routes: -1, gateway_http_targets: -1,
  });
  db = require('../src/db/connection').getDb();
  routes = require('../src/services/routes');
  caddyConfig = require('../src/services/caddyConfig');
  require('../src/services/gateways').notifyConfigChanged = async () => {};
  require('../src/services/gatewayColocation')._setInterfacesForTest(() => ({ lo: [{ address: '127.0.0.1', family: 'IPv4' }] }));
  gw = gateway('udp-gw', '10.8.0.61');
  gw2 = gateway('udp-gw-2', '10.8.0.62');
  peer = Number(db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled) VALUES ('udp-peer', ?, '10.8.0.70/32', 1)")
    .run(crypto.randomBytes(16).toString('hex')).lastInsertRowid);
  const pool = require('../src/services/gatewayPool');
  poolId = Number(pool.createPool({ name: 'udp-pool', mode: 'failover', failback_cooldown_s: 60 }));
  pool.addMember(poolId, gw2, 10);
  zoneId = Number(db.prepare(`INSERT INTO domains (domain, status, gateway_kind, gateway_peer_id, default_external_enabled)
    VALUES ('udp-gw.example.com', 'verified', 'gateway', ?, 0)`).run(gw).lastInsertRowid);
  peerZoneId = Number(db.prepare(`INSERT INTO domains (domain, status, gateway_kind, gateway_peer_id, default_external_enabled)
    VALUES ('udp-peer.example.com', 'verified', 'peer', ?, 0)`).run(peer).lastInsertRowid);
});

after(() => {
  require('../src/services/gatewayColocation')._setInterfacesForTest(null);
  return teardown();
});

describe('Caddy dials the upstream of a UDP entry over UDP', () => {
  const { buildL4Route, buildL4Servers, upstreamDial } = require('../src/services/l4');

  it('upstreamDial: udp/ for UDP, nothing for TCP, an address with a network stays', () => {
    assert.equal(upstreamDial('10.8.0.5:53', 'udp'), 'udp/10.8.0.5:53');
    assert.equal(upstreamDial('10.8.0.5:22', 'tcp'), '10.8.0.5:22');
    assert.equal(upstreamDial('udp/10.8.0.5:53', 'udp'), 'udp/10.8.0.5:53');
    assert.equal(upstreamDial('10.8.0.5:53', undefined), '10.8.0.5:53');
  });

  it('a UDP entry on a peer: listener udp/:port, upstream udp/<peer>:<port>', () => {
    const servers = buildL4Servers([{
      id: 1, l4_protocol: 'udp', l4_listen_port: '27015', l4_tls_mode: 'none', target_ip: '10.8.0.5', target_port: 27015, external_enabled: 1,
    }], ['10.8.0.0/24']);
    assert.deepEqual(servers['l4-udp-27015'].listen, ['udp/:27015']);
    assert.deepEqual(servers['l4-udp-27015'].routes[0].handle[0].upstreams, [{ dial: ['udp/10.8.0.5:27015'] }]);
  });

  it('several pool upstreams of a UDP entry all carry udp/; TCP ones none', () => {
    const route = (proto) => ({ l4_protocol: proto, target_ip: '10.8.0.5', target_port: 53, external_enabled: 1, _poolUpstreams: ['10.8.0.5:53', '10.8.0.6:53'], _poolLbPolicy: 'round_robin' });
    assert.deepEqual(buildL4Route(route('udp'), 'none', []).handle[0].upstreams, [{ dial: ['udp/10.8.0.5:53'] }, { dial: ['udp/10.8.0.6:53'] }]);
    assert.deepEqual(buildL4Route(route('tcp'), 'none', []).handle[0].upstreams, [{ dial: ['10.8.0.5:53'] }, { dial: ['10.8.0.6:53'] }]);
  });

  it('the built config of a stored UDP peer entry dials udp/', async () => {
    const r = await routes.create(l4('udp', viaPeer()));
    const cfg = await caddyConfig.buildCaddyConfig();
    const server = Object.values(cfg.apps.layer4.servers).find((s) => s.listen.includes('udp/:' + r.l4_listen_port));
    assert.ok(server, 'UDP listener built');
    const dials = server.routes.flatMap((x) => x.handle).filter((h) => h.handler === 'proxy').flatMap((h) => h.upstreams.flatMap((u) => u.dial));
    assert.deepEqual(dials, ['udp/10.8.0.70:53']);
    await routes.remove(r.id);
  });
});

describe('routes API: no way into UDP behind a gateway or pool', () => {
  it('POST a UDP entry on a gateway or a pool → 400 (field l4_protocol); nothing is stored', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM routes').get().n;
    assertRefused(await post('/routes', l4('udp', viaGateway(gw))), 'l4_protocol');
    assertRefused(await post('/routes', l4('udp', { ...viaGateway(null), target_peer_id: undefined, target_pool_id: poolId })), 'l4_protocol');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM routes').get().n, before);
  });

  it('UDP on a peer and TCP on a gateway are fine', async () => {
    const a = await post('/routes', l4('udp', viaPeer()));
    const b = await post('/routes', l4('tcp', viaGateway(gw)));
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 201, JSON.stringify(b.body));
    await routes.remove(a.body.route.id);
    await routes.remove(b.body.route.id);
  });

  it('PUT: TCP on a gateway → UDP, and UDP on a peer → gateway: 400, the row stays', async () => {
    const tcp = await routes.create(l4('tcp', viaGateway(gw)));
    assertRefused(await put('/routes/' + tcp.id, { l4_protocol: 'udp' }), 'l4_protocol');
    assert.equal(db.prepare('SELECT l4_protocol FROM routes WHERE id = ?').get(tcp.id).l4_protocol, 'tcp');
    const udp = await routes.create(l4('udp', viaPeer()));
    assertRefused(await put('/routes/' + udp.id, { target_kind: 'gateway', target_peer_id: gw, target_lan_host: '192.168.7.10', target_lan_port: 53 }), 'l4_protocol');
    assert.equal(db.prepare('SELECT target_kind FROM routes WHERE id = ?').get(udp.id).target_kind, 'peer');
    await routes.remove(tcp.id);
    await routes.remove(udp.id);
  });

  it('a row from before the rule (UDP on a gateway) stays editable and can be fixed', async () => {
    const r = await routes.create(l4('tcp', viaGateway(gw)));
    db.prepare("UPDATE routes SET l4_protocol = 'udp' WHERE id = ?").run(r.id);
    let res = await put('/routes/' + r.id, { description: 'old udp entry', l4_protocol: 'udp', target_kind: 'gateway' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    res = await put('/routes/' + r.id, { l4_protocol: 'tcp' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(db.prepare('SELECT l4_protocol FROM routes WHERE id = ?').get(r.id).l4_protocol, 'tcp');
    await routes.remove(r.id);
  });
});

describe('domain zones: no UDP entry behind a gateway', () => {
  it('POST /domains/:id/hosts with a UDP entry in a gateway zone → 400, no host', async () => {
    const res = await post(`/domains/${zoneId}/hosts`, { subdomain: 'game', lan_host: '192.168.7.20', entries: [{ type: 'udp', target_port: 27015, listen_port: port++ }] });
    assertRefused(res);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM service_bundles WHERE subdomain = 'game'").get().n, 0);
  });

  it('POST /hosts/:id/entries type udp behind a gateway → 400; TCP works', async () => {
    const host = await post(`/domains/${zoneId}/hosts`, { subdomain: 'svc', lan_host: '192.168.7.21', entries: [{ type: 'tcp', target_port: 22, listen_port: port++ }] });
    assert.equal(host.status, 201, JSON.stringify(host.body));
    const hostId = host.body.host.id;
    assertRefused(await post(`/hosts/${hostId}/entries`, { type: 'udp', target_port: 53, listen_port: port++ }));
    const tcp = await post(`/hosts/${hostId}/entries`, { type: 'tcp', target_port: 2222, listen_port: port++ });
    assert.equal(tcp.status, 201, JSON.stringify(tcp.body));
  });

  it('a peer zone takes UDP entries; moving it behind a gateway is refused while it has them', async () => {
    const host = await post(`/domains/${peerZoneId}/hosts`, { subdomain: 'dns', entries: [{ type: 'udp', target_port: 53, listen_port: port++ }] });
    assert.equal(host.status, 201, JSON.stringify(host.body));
    const zoneRow = () => db.prepare('SELECT gateway_kind, gateway_peer_id, gateway_pool_id FROM domains WHERE id = ?').get(peerZoneId);
    const before = zoneRow();
    assertRefused(await put(`/domains/${peerZoneId}/gateway`, { kind: 'gateway', peer_id: gw }));
    assertRefused(await put(`/domains/${peerZoneId}/gateway`, { kind: 'pool', pool_id: poolId }));
    assert.deepEqual(zoneRow(), before, 'the zone keeps its target');
  });
});
