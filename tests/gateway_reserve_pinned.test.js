'use strict';

// Reserve check for routes pinned to ONE gateway of a pool.
//
// gatewayHealth moves such a route to an alive sibling when its gateway goes
// down — but only the pinned gateway had it in its config, so the standby
// never probed its target and the pool page could not say beforehand whether
// the reserve would reach it. Now every member of an enabled pool also gets
// the routes pinned to its partners (services/gateways.js PARTNER_PINNED):
// it probes them with every heartbeat (route_reachability) and
// gatewayPoolState reports the result per member and per pinned route.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf, db, gws;
beforeEach(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  require('../src/services/caddyConfig').syncToCaddy = async () => true;
  gws = require('../src/services/gateways');
  gws.notifyConfigChanged = async (id) => {
    db.prepare('UPDATE gateway_meta SET last_config_hash = ? WHERE peer_id = ?').run(gws.computeConfigHash(id), id);
    return { ok: true };
  };
  require('../src/services/gatewayHealth')._resetSnapshotCache();
});
afterEach(teardown);

function gateway(id, name, opts = {}) {
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (?, ?, ?, 'gateway', ?, 1)")
    .run(id, name, 'pk' + id, `10.8.0.${id}/32`);
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, last_seen_at, created_at, last_health, lan_ip)
    VALUES (?, 9876, ?, 'e', ?, ?, ?, ?, ?)`)
    .run(id, 'h' + id, opts.alive === false ? 0 : 1, opts.lastSeen || Date.now(), Date.now(), JSON.stringify(opts.health || {}), opts.lanIp || null);
}
function route(id, domain, fields = {}) {
  const f = { target_pool_id: null, target_peer_id: null, original_peer_id: null, host: '192.168.1.5', port: 5001, type: 'http', listen: null, enabled: 1, ...fields };
  db.prepare(`INSERT INTO routes (id, domain, target_kind, target_pool_id, target_peer_id, original_peer_id, target_lan_host, target_lan_port,
      target_ip, target_port, route_type, l4_protocol, l4_listen_port, l4_tls_mode, enabled)
    VALUES (?, ?, 'gateway', ?, ?, ?, ?, ?, '0.0.0.0', ?, ?, ?, ?, ?, ?)`)
    .run(id, domain, f.target_pool_id, f.target_peer_id, f.original_peer_id, f.host, f.port, f.port, f.type,
      f.type === 'l4' ? 'tcp' : null, f.listen, f.type === 'l4' ? 'none' : null, f.enabled);
}
async function pool(name, members, extra = {}) {
  const r = await agent.post('/api/v1/gateway-pools').set('X-CSRF-Token', csrf)
    .send({ name, mode: 'failover', failback_cooldown_s: 900, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const put = await agent.put(`/api/v1/gateway-pools/${r.body.id}/members`).set('X-CSRF-Token', csrf)
    .send(members.map((peer_id, i) => ({ peer_id, priority: i + 1 })));
  assert.equal(put.status, 200, JSON.stringify(put.body));
  return r.body.id;
}
const poolState = async (id) => {
  const r = await agent.get('/api/v1/gateway-pools/state');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.pools.find((x) => x.id === id);
};
const ids = (list) => list.map((r) => r.id);

test('config: a pool member gets the routes pinned to its partners, nobody else does', async () => {
  gateway(21, 'DS918');
  gateway(22, 'Pi Keller');
  gateway(23, 'Ferienhaus');
  route(100, 'drucker.example.com', { target_peer_id: 21 });
  route(101, 'ssh.example.com', { target_peer_id: 21, type: 'l4', listen: '2222', host: '192.168.1.9', port: 22 });
  route(102, 'kamera.example.com', { target_peer_id: 23 });
  route(103, 'aus.example.com', { target_peer_id: 21, enabled: 0 });

  // no pool yet: only the pinned gateway has them
  assert.deepEqual(ids(gws.getGatewayConfig(22).routes), []);
  const hashBefore = gws.computeConfigHash(22);

  await pool('Heimnetz', [21, 22]);
  const b = gws.getGatewayConfig(22);
  assert.deepEqual(ids(b.routes), [100], 'the HTTP route pinned to the partner (not the switched-off one)');
  assert.deepEqual(b.routes[0], { id: 100, domain: 'drucker.example.com', target_kind: 'gateway', target_lan_host: '192.168.1.5', target_lan_port: 5001, protocol: 'http', wol_enabled: false });
  assert.deepEqual(b.l4_routes.map((r) => [r.id, r.listen_port, r.target_lan_host, r.target_lan_port]), [[101, 2222, '192.168.1.9', 22]]);
  assert.notEqual(gws.computeConfigHash(22), hashBefore, 'the gateway fetches the new config');
  // the pinned gateway itself: as before
  assert.deepEqual(ids(gws.getGatewayConfig(21).routes), [100]);
  assert.deepEqual(ids(gws.getGatewayConfig(21).l4_routes), [101]);
  // a gateway outside the pool: nothing of the pool's members, and its own route stays its own
  assert.deepEqual(ids(gws.getGatewayConfig(23).routes), [102]);
  assert.deepEqual(gws.getGatewayConfig(21).routes.some((r) => r.id === 102), false);

  assert.deepEqual(gws.reserveRoutesFor(22).map((r) => [r.id, r.peer_id, r.peer_name]), [[100, 21, 'DS918'], [101, 21, 'DS918']]);
  assert.deepEqual(gws.reserveRoutesFor(21), []);
  assert.deepEqual(gws.reserveRoutesFor(23), []);
});

test('config: a switched-off pool hands nothing to the partners', async () => {
  gateway(21, 'DS918');
  gateway(22, 'Pi Keller');
  route(100, 'drucker.example.com', { target_peer_id: 21 });
  const id = await pool('Heimnetz', [21, 22]);
  assert.deepEqual(ids(gws.getGatewayConfig(22).routes), [100]);
  db.prepare('UPDATE gateway_pools SET enabled = 0 WHERE id = ?').run(id);
  assert.deepEqual(ids(gws.getGatewayConfig(22).routes), [], 'gatewayHealth does not pivot over a switched-off pool either');
  assert.deepEqual(gws.reserveRoutesFor(22), []);
});

test('config: a loopback target is the home gateway\'s LAN address on every other gateway', async () => {
  gateway(21, 'DS918', { lanIp: '192.168.1.20' });
  gateway(22, 'Pi Keller');
  gateway(24, 'Alt');   // never reported a LAN address
  gateway(25, 'Pi Dach');
  route(100, 'ha.example.com', { target_peer_id: 21, host: '127.0.0.1', port: 8123 });
  route(101, 'ssh.example.com', { target_peer_id: 21, type: 'l4', listen: '2222', host: '127.0.0.1', port: 22 });
  route(102, 'alt.example.com', { target_peer_id: 24, host: '127.0.0.1', port: 80 });
  await pool('Heimnetz', [21, 22]);
  await pool('Dach', [24, 25]);

  // the home gateway keeps its own loopback
  assert.equal(gws.getGatewayConfig(21).routes[0].target_lan_host, '127.0.0.1');
  assert.equal(gws.getGatewayConfig(21).l4_routes[0].target_lan_host, '127.0.0.1');
  // the partner checks (and later serves) the home gateway's LAN address
  assert.equal(gws.getGatewayConfig(22).routes[0].target_lan_host, '192.168.1.20');
  assert.equal(gws.getGatewayConfig(22).l4_routes[0].target_lan_host, '192.168.1.20');
  // unknown LAN address of the home gateway: left out, never the partner's own loopback
  assert.deepEqual(ids(gws.getGatewayConfig(25).routes), []);

  // after the failover (target = the sibling, original = the home) it is the same address:
  // the reserve check told the truth about what the sibling then forwards to
  db.prepare('UPDATE routes SET target_peer_id = 22, original_peer_id = 21 WHERE id IN (100, 101)').run();
  assert.equal(gws.getGatewayConfig(22).routes[0].target_lan_host, '192.168.1.20');
  assert.equal(gws.getGatewayConfig(22).l4_routes[0].target_lan_host, '192.168.1.20');
  assert.deepEqual(ids(gws.getGatewayConfig(21).routes), [], 'the home gateway is out while it is failed over');
});

test('config: a pool route with a loopback target stays every member\'s own loopback', async () => {
  gateway(21, 'DS918', { lanIp: '192.168.1.20' });
  gateway(22, 'Pi Keller', { lanIp: '192.168.1.21' });
  const id = await pool('Heimnetz', [21, 22]);
  route(100, 'lokal.example.com', { target_pool_id: id, host: '127.0.0.1', port: 8080 });
  assert.equal(gws.getGatewayConfig(21).routes[0].target_lan_host, '127.0.0.1');
  assert.equal(gws.getGatewayConfig(22).routes[0].target_lan_host, '127.0.0.1');
});

test('pool state: the standby reports on the routes pinned to its partner; the pinned route names its reserve', async () => {
  gateway(21, 'DS918');
  gateway(22, 'Pi Keller', { health: { route_reachability: [{ route_id: 100, reachable: true }, { route_id: 101, reachable: true }] } });
  const id = await pool('Heimnetz', [21, 22]);
  route(100, 'nas.example.com', { target_pool_id: id });
  route(101, 'drucker.example.com', { target_peer_id: 21 });
  route(102, 'keller.example.com', { target_peer_id: 22 });

  let p = await poolState(id);
  const pi = p.members.find((m) => m.peer_id === 22);
  assert.deepEqual(pi.reserve, { total: 2, checked: 2, reachable: 2, missing: [] }, 'the pool route and the partner\'s pinned route — not its own');
  assert.equal(p.status, 'protected');
  const pinned = Object.fromEntries(p.pinned_routes.map((r) => [r.id, r]));
  assert.deepEqual(pinned[101].reserve, { peer_id: 22, name: 'Pi Keller', reachable: true });
  assert.equal(pinned[102].reserve, null, 'its reserve (DS918) reports nothing about it yet: no claim');

  // the standby does not reach the printer: said before the outage
  db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = 22')
    .run(JSON.stringify({ route_reachability: [{ route_id: 100, reachable: true }, { route_id: 101, reachable: false }] }));
  // … and the active one reports on the route pinned to the standby
  db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = 21')
    .run(JSON.stringify({ route_reachability: [{ route_id: 100, reachable: true }, { route_id: 101, reachable: true }, { route_id: 102, reachable: true }] }));
  p = await poolState(id);
  assert.deepEqual(p.members.find((m) => m.peer_id === 22).reserve,
    { total: 2, checked: 2, reachable: 1, missing: [{ id: 101, domain: 'drucker.example.com' }] });
  assert.equal(p.status, 'partial');
  const after = Object.fromEntries(p.pinned_routes.map((r) => [r.id, r]));
  assert.deepEqual(after[101].reserve, { peer_id: 22, name: 'Pi Keller', reachable: false });
  assert.deepEqual(after[102].reserve, { peer_id: 21, name: 'DS918', reachable: true });
});

test('pool state: no reserve claim for a route that runs on the reserve already, with nobody to take it, or in a switched-off pool', async () => {
  gateway(21, 'DS918', { alive: false, lastSeen: Date.now() - 600000 });
  gateway(22, 'Pi Keller', { health: { route_reachability: [{ route_id: 101, reachable: true }, { route_id: 102, reachable: true }] } });
  const id = await pool('Heimnetz', [21, 22]);
  route(101, 'drucker.example.com', { target_peer_id: 22, original_peer_id: 21 }); // failed over
  route(102, 'keller.example.com', { target_peer_id: 22 });                        // its reserve (21) is away
  let p = await poolState(id);
  assert.deepEqual(p.pinned_routes.map((r) => [r.id, r.failed_over, r.reserve]), [[101, true, null], [102, false, null]]);
  db.prepare('UPDATE gateway_meta SET alive = 1, last_seen_at = ?, last_health = ? WHERE peer_id = 21')
    .run(Date.now(), JSON.stringify({ route_reachability: [{ route_id: 102, reachable: true }] }));
  db.prepare('UPDATE routes SET target_peer_id = 21, original_peer_id = NULL WHERE id = 101').run();
  p = await poolState(id);
  assert.deepEqual(p.pinned_routes.find((r) => r.id === 102).reserve, { peer_id: 21, name: 'DS918', reachable: true });
  db.prepare('UPDATE gateway_pools SET enabled = 0 WHERE id = ?').run(id);
  p = await poolState(id);
  assert.deepEqual(p.pinned_routes.map((r) => r.reserve), [null, null]);
  assert.equal(p.members.find((m) => m.peer_id === 22).reserve, null);
});

test('fleet: GET /api/v1/gateways lists the routes a gateway only stands by for', async () => {
  gateway(21, 'DS918');
  gateway(22, 'Pi Keller');
  route(101, 'drucker.example.com', { target_peer_id: 21 });
  await pool('Heimnetz', [21, 22]);
  const r = await agent.get('/api/v1/gateways?peek=1');
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.gateways.map((g) => [g.peer_id, g]));
  assert.deepEqual(by[21].routes.map((x) => x.id), [101]);
  assert.deepEqual(by[21].reserve_routes, []);
  assert.deepEqual(by[22].routes, []);
  assert.deepEqual(by[22].reserve_routes.map((x) => [x.id, x.domain, x.peer_id, x.peer_name, x.target_lan_host, x.target_lan_port]),
    [[101, 'drucker.example.com', 21, 'DS918', '192.168.1.5', 5001]]);
});
