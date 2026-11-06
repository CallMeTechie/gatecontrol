'use strict';

// Live state of the gateway pools on the gateways page (services/gatewayPoolState.js,
// GET /api/v1/gateway-pools/state): the member that serves the routes now,
// the others (standby / recovering / offline), the reserve check from the
// standby's own route_reachability, routes pinned to a member, the history of
// switches (migration 131, at most 50 per pool), "Pool auflösen"
// (POST /:id/dissolve) and the old page /gateway-pools → /gateways.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf, db, caddy;
beforeEach(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  caddy = require('../src/services/caddyConfig');
  caddy.syncToCaddy = async () => true;
  // the companion "confirms" every config push at once (gatewayPoolSync waits for its hash)
  const gws = require('../src/services/gateways');
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
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, last_seen_at, created_at, last_health, platform)
    VALUES (?, 9876, 'h', 'e', ?, ?, ?, ?, ?)`)
    .run(id, opts.alive === false ? 0 : 1, opts.lastSeen || Date.now(), Date.now(), JSON.stringify(opts.health || {}), opts.platform || null);
}
function route(id, domain, fields) {
  const f = { target_kind: 'gateway', target_pool_id: null, target_peer_id: null, ...fields };
  db.prepare(`INSERT INTO routes (id, domain, target_kind, target_pool_id, target_peer_id, target_lan_host, target_lan_port, target_ip, target_port, route_type, enabled)
    VALUES (?, ?, ?, ?, ?, '192.168.1.5', 5001, '0.0.0.0', 5001, 'http', 1)`).run(id, domain, f.target_kind, f.target_pool_id, f.target_peer_id);
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
const getState = async () => {
  const r = await agent.get('/api/v1/gateway-pools/state');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

test('state: the first alive member serves, the other stands by; threshold, licence, route counts', async () => {
  gateway(21, 'DS918', { platform: 'synology' });
  gateway(22, 'Pi Keller', { platform: 'rpi' });
  const id = await pool('Heimnetz', [21, 22]);
  route(100, 'nas.example.com', { target_pool_id: id });
  route(101, 'drucker.example.com', { target_peer_id: 21 });
  const st = await getState();
  assert.equal(st.threshold_s, 90);
  assert.equal(st.routes_total, 2);
  assert.equal(st.routes_pooled, 1);
  assert.equal(st.licensed.failover, true);
  const p = st.pools.find((x) => x.id === id);
  assert.equal(p.status, 'protected');
  assert.deepEqual(p.active_peer_ids, [21]);
  assert.deepEqual(p.members.map((m) => [m.peer_id, m.priority, m.state, m.name, m.platform]),
    [[21, 1, 'active', 'DS918', 'synology'], [22, 2, 'standby', 'Pi Keller', 'rpi']]);
  assert.deepEqual(p.routes.map((r) => r.domain), ['nas.example.com']);
  assert.deepEqual(p.pinned_routes.map((r) => [r.domain, r.peer_id, r.peer_name, r.failed_over]), [['drucker.example.com', 21, 'DS918', false]]);
  assert.equal(p.history.length, 0, 'setting the pool up is no switch');
  assert.equal(p.since.peer_id, 21);
});

test('state: reserve check from the standby\'s own route_reachability; nothing when it reports nothing', async () => {
  gateway(21, 'DS918');
  gateway(23, 'Pi', { health: { route_reachability: [{ route_id: 100, reachable: true }, { route_id: 102, reachable: false }] } });
  gateway(24, 'Old');
  const id = await pool('P', [21, 23, 24]);
  route(100, 'a.example.com', { target_pool_id: id });
  route(102, 'b.example.com', { target_pool_id: id });
  route(103, 'c.example.com', { target_pool_id: id });
  const p = (await getState()).pools[0];
  const pi = p.members.find((m) => m.peer_id === 23);
  assert.deepEqual(pi.reserve, { total: 3, checked: 2, reachable: 1, missing: [{ id: 102, domain: 'b.example.com' }] });
  assert.equal(p.members.find((m) => m.peer_id === 24).reserve, null, 'no data → no claim');
  assert.equal(p.status, 'partial', 'the next reserve misses a target: only partly protected');
  // it reaches everything again → protected
  db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = 23').run(JSON.stringify({ route_reachability: [{ route_id: 100, reachable: true }, { route_id: 102, reachable: true }] }));
  assert.equal((await getState()).pools[0].status, 'protected');
});

test('state: offline first member → on_reserve; recovering shows the failback time; none alive → down', async () => {
  gateway(21, 'DS918', { alive: false, lastSeen: Date.now() - 600000 });
  gateway(22, 'Pi');
  const id = await pool('P', [21, 22]);
  let p = (await getState()).pools.find((x) => x.id === id);
  assert.equal(p.status, 'on_reserve');
  assert.deepEqual(p.members.map((m) => m.state), ['offline', 'active']);
  const back = Date.now() - 60000;
  db.prepare('UPDATE gateway_meta SET recovered_first_hb_at = ?, went_down_at = ? WHERE peer_id = 21').run(back, back - 100000);
  p = (await getState()).pools.find((x) => x.id === id);
  assert.equal(p.members[0].state, 'recovering');
  assert.equal(p.members[0].failback_at, back + 900 * 1000);
  db.prepare('UPDATE gateway_meta SET alive = 0 WHERE peer_id = 22').run();
  p = (await getState()).pools.find((x) => x.id === id);
  assert.equal(p.status, 'down');
  assert.deepEqual(p.active_peer_ids, []);
});

test('state: single member and missing reserve', async () => {
  gateway(21, 'A');
  gateway(22, 'B', { alive: false });
  const one = await pool('One', [21]);
  const two = await pool('Two', [21, 22]);
  const st = await getState();
  assert.equal(st.pools.find((x) => x.id === one).status, 'single');
  assert.equal(st.pools.find((x) => x.id === two).status, 'no_reserve');
  assert.equal(st.routes_pooled, 0);
});

test('history: a real failover and the failback are recorded with duration; kept to 50', async () => {
  const gh = require('../src/services/gatewayHealth');
  const ps = require('../src/services/gatewayPoolState');
  gateway(21, 'DS918');
  gateway(22, 'Pi');
  const id = await pool('P', [21, 22]);
  route(100, 'nas.example.com', { target_peer_id: 21 });
  gh.evaluatePeer(21); gh.evaluatePeer(22);
  // DS918 goes down: the watchdog transition records the switch
  db.prepare('UPDATE gateway_meta SET alive = 0, went_down_at = ?, last_seen_at = ? WHERE peer_id = 21').run(Date.now() - 200000, Date.now() - 200000);
  gh._resetSnapshotCache(); gh.evaluatePeer(21); gh.evaluatePeer(22);
  await gh._onTransition(21, 'alive_to_down');
  let p = (await getState()).pools.find((x) => x.id === id);
  assert.deepEqual(p.history.map((e) => [e.kind, e.from_name, e.to_name]), [['failover', 'DS918', 'Pi']]);
  assert.equal(p.history[0].duration_ms, null, 'still on the reserve');
  assert.ok(p.last_switch_at > 0);
  // back after the cooldown
  db.prepare('UPDATE gateway_meta SET alive = 1, went_down_at = NULL, recovered_first_hb_at = NULL, last_seen_at = ? WHERE peer_id = 21').run(Date.now());
  gh._resetSnapshotCache(); gh.evaluatePeer(21); gh.evaluatePeer(22);
  await gh._onTransition(21, 'cooldown_to_alive');
  p = (await getState()).pools.find((x) => x.id === id);
  assert.deepEqual(p.history.map((e) => e.kind), ['failback', 'failover']);
  assert.ok(p.history[1].duration_ms >= 0);
  // nobody left / one back
  db.prepare('UPDATE gateway_meta SET alive = 0').run();
  assert.deepEqual(ps.recordSwitches().map((e) => e.kind), ['outage']);
  db.prepare('UPDATE gateway_meta SET alive = 1 WHERE peer_id = 22').run();
  assert.deepEqual(ps.recordSwitches().map((e) => [e.kind, e.to_peer_id]), [['restored', 22]]);
  assert.deepEqual(ps.recordSwitches(), [], 'no change, no row');
  // an administrator's reorder is a 'change'
  db.prepare('UPDATE gateway_meta SET alive = 1').run();
  const put = await agent.put(`/api/v1/gateway-pools/${id}/members`).set('X-CSRF-Token', csrf)
    .send([{ peer_id: 22, priority: 1 }, { peer_id: 21, priority: 2 }]);
  assert.equal(put.status, 200);
  // (22 already served → no row); move 21 back on top
  await agent.put(`/api/v1/gateway-pools/${id}/members`).set('X-CSRF-Token', csrf).send([{ peer_id: 21, priority: 1 }, { peer_id: 22, priority: 2 }]);
  p = (await getState()).pools.find((x) => x.id === id);
  assert.equal(p.history[0].kind, 'change');
  // at most 50 per pool
  for (let i = 0; i < 60; i++) {
    db.prepare('UPDATE gateway_meta SET alive = ? WHERE peer_id = 21').run(i % 2);
    ps.recordSwitches();
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gateway_pool_events WHERE pool_id = ?').get(id).n, ps.HISTORY_KEEP);
});

test('history: the boot reconcile writes the baseline of an existing pool', async () => {
  const gp = require('../src/services/gatewayPool');
  gateway(21, 'A');
  const id = gp.createPool({ name: 'Old', mode: 'failover', failback_cooldown_s: 60 });
  gp.addMember(id, 21, 1);
  await require('../src/services/gatewayHealth').reconcileFailoverState();
  const rows = db.prepare('SELECT kind, to_peer_id FROM gateway_pool_events WHERE pool_id = ?').all(id);
  assert.deepEqual(rows, [{ kind: 'initial', to_peer_id: 21 }]);
});

test('dissolve: routes, RDP routes and zones are pinned to the chosen gateway, the pool and its history go', async () => {
  gateway(21, 'DS918');
  gateway(22, 'Pi');
  const id = await pool('P', [21, 22]);
  route(100, 'nas.example.com', { target_pool_id: id });
  db.prepare("INSERT INTO domains (domain, status, gateway_kind, gateway_pool_id) VALUES ('example.org', 'verified', 'pool', ?)").run(id);
  // plain DELETE stays refused
  const del = await agent.delete(`/api/v1/gateway-pools/${id}`).set('X-CSRF-Token', csrf);
  assert.equal(del.status, 409);
  const noPin = await agent.post(`/api/v1/gateway-pools/${id}/dissolve`).set('X-CSRF-Token', csrf).send({});
  assert.equal(noPin.status, 400);
  assert.equal(noPin.body.error, 'pin_to_required');
  const r = await agent.post(`/api/v1/gateway-pools/${id}/dissolve`).set('X-CSRF-Token', csrf).send({ pin_to: 21 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pinned, 1);
  assert.equal(r.body.zones, 1);
  assert.deepEqual(db.prepare('SELECT target_peer_id, target_pool_id FROM routes WHERE id = 100').get(), { target_peer_id: 21, target_pool_id: null });
  assert.deepEqual(db.prepare("SELECT gateway_kind, gateway_peer_id, gateway_pool_id FROM domains WHERE domain = 'example.org'").get(),
    { gateway_kind: 'gateway', gateway_peer_id: 21, gateway_pool_id: null });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gateway_pools WHERE id = ?').get(id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gateway_pool_members WHERE pool_id = ?').get(id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gateway_pool_events WHERE pool_id = ?').get(id).n, 0);
  const missing = await agent.post('/api/v1/gateway-pools/9999/dissolve').set('X-CSRF-Token', csrf).send({});
  assert.equal(missing.status, 404);
});

test('dissolve without routes needs no gateway', async () => {
  gateway(21, 'A');
  const id = await pool('Empty', [21]);
  const r = await agent.post(`/api/v1/gateway-pools/${id}/dissolve`).set('X-CSRF-Token', csrf).send({});
  assert.equal(r.status, 200);
  assert.equal(r.body.pinned, 0);
});

test('state and dissolve need the gateway_pools licence', async () => {
  require('../src/services/license')._overrideForTest({ gateway_pools: false });
  assert.equal((await agent.get('/api/v1/gateway-pools/state')).status, 403);
  assert.equal((await agent.post('/api/v1/gateway-pools/1/dissolve').set('X-CSRF-Token', csrf).send({})).status, 403);
});

test('migration 131 creates gateway_pool_events', () => {
  const m = require('../src/db/migrationList').migrations.find((x) => x.version === 131);
  assert.equal(m.name, 'gateway_pool_events');
  assert.ok(m.detect(db));
  const cols = db.prepare('PRAGMA table_info(gateway_pool_events)').all().map((c) => c.name);
  assert.deepEqual(cols, ['id', 'pool_id', 'at', 'kind', 'from_peer_id', 'to_peer_id']);
});

test('the former page /gateway-pools leads to /gateways', async () => {
  const r = await agent.get('/gateway-pools');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/gateways');
});

test('features overview names the other gateways of the same Heimnetz', async () => {
  gateway(21, 'DS918');
  gateway(22, 'Pi');
  await pool('P', [21, 22]);
  const o = require('../src/services/gatewayFeatures').overview(21);
  assert.deepEqual(o.home, [{ id: 22, name: 'Pi' }]);
});
