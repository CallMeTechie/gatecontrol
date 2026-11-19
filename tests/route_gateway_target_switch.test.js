'use strict';

// HTTP and TCP/UDP routes through a gateway: a pinned gateway (target_peer_id)
// OR a gateway pool (target_pool_id), never both (services/routes.js
// assertGatewayTarget). PUT /api/v1/routes/:id that switches gateway → pool
// or pool → gateway clears the former target — also when the patch names it
// as null, which the COALESCE of routes.update used to keep — so the row, the
// Caddy upstream and the configs of ALL gateways (listener, WoL whitelist)
// only hold the new target. Both / neither / unknown or empty pool → 400 with
// a field error. Migration 159 cleans rows stored with both (pool wins).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

const GW_A = 91; // a single gateway, in no pool
const GW_B = 92; // pool member, priority 10 (the active one)
const GW_C = 93; // pool member, priority 20
const MAC = 'AA:BB:CC:DD:EE:91';
const PROXY_PORT = 8080;

let agent, csrf, db, routes, gateways, caddyConfig, poolId, emptyPoolId;

function gateway(id, name) {
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (?, ?, ?, 'gateway', ?, 1)")
    .run(id, name, 'pk-route-switch-' + id, `10.8.0.${id}/32`);
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, last_seen_at, created_at)
    VALUES (?, 9876, 'h', 'e', 1, ?, ?)`).run(id, Date.now(), Date.now());
}

before(async () => {
  const ctx = await setup();
  agent = ctx.agent;
  csrf = ctx.csrfToken;
  require('../src/services/license')._overrideForTest({
    gateway_tcp_routing: true, gateway_peers: -1, gateway_pool_failover: true, gateway_wol: true,
  });
  db = require('../src/db/connection').getDb();
  routes = require('../src/services/routes');
  gateways = require('../src/services/gateways');
  caddyConfig = require('../src/services/caddyConfig');
  gateways.notifyConfigChanged = async () => {}; // no push to real gateways
  require('../src/services/gatewayColocation')._setInterfacesForTest(() => ({ lo: [{ address: '127.0.0.1', family: 'IPv4' }] }));
  require('../src/services/gatewayHealth')._resetSnapshotCache();
  gateway(GW_A, 'switch-a');
  gateway(GW_B, 'switch-b');
  gateway(GW_C, 'switch-c');
  const pool = require('../src/services/gatewayPool');
  poolId = Number(pool.createPool({ name: 'switch-pool', mode: 'failover', failback_cooldown_s: 60 }));
  pool.addMember(poolId, GW_B, 10);
  pool.addMember(poolId, GW_C, 20);
  emptyPoolId = Number(pool.createPool({ name: 'switch-pool-empty', mode: 'failover', failback_cooldown_s: 60 }));
});

after(() => {
  require('../src/services/gatewayColocation')._setInterfacesForTest(null);
  return teardown();
});

let seq = 0;
let listenPort = 4800;
async function createRoute(type, target) {
  const n = ++seq;
  const base = type === 'l4'
    ? { route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: String(listenPort++), l4_tls_mode: 'none', domain: null }
    : { route_type: 'http', domain: `switch${n}.example.com`, https_enabled: false };
  return routes.create({
    ...base, target_kind: 'gateway', target_lan_host: '192.168.1.91', target_lan_port: 22, target_port: 22,
    wol_enabled: true, wol_mac: MAC, enabled: true, ...target,
  });
}

const row = (id) => ({ ...db.prepare('SELECT target_kind, target_peer_id, target_pool_id, wol_enabled, wol_mac FROM routes WHERE id = ?').get(id) });

function entryOf(peerId, r) {
  const cfg = gateways.getGatewayConfig(peerId);
  const list = r.route_type === 'l4' ? cfg.l4_routes : cfg.routes;
  return (list || []).find((x) => x.id === r.id) || null;
}

function whitelisted(peerId) {
  const cfg = gateways.getGatewayConfig(peerId);
  return JSON.stringify(cfg).includes(MAC);
}

// The upstreams Caddy dials for this route.
async function caddyDials(r) {
  const cfg = await caddyConfig.buildCaddyConfig({ gatewayProxyPort: PROXY_PORT });
  const out = [];
  const collect = (handlers) => {
    for (const h of handlers || []) {
      if (h.handler === 'reverse_proxy' || h.handler === 'proxy') for (const u of h.upstreams || []) out.push(...[].concat(u.dial));
      if (h.routes) for (const sub of h.routes) collect(sub.handle);
    }
  };
  if (r.route_type === 'l4') {
    for (const s of Object.values((cfg.apps.layer4 && cfg.apps.layer4.servers) || {})) {
      if (!(s.listen || []).some((l) => String(l).endsWith(':' + r.l4_listen_port))) continue;
      for (const x of s.routes) collect(x.handle);
    }
  } else {
    for (const s of Object.values(cfg.apps.http.servers)) {
      for (const x of s.routes || []) {
        if (!(x.match || []).some((m) => (m.host || []).includes(r.domain))) continue;
        collect(x.handle);
      }
    }
  }
  return [...new Set(out)];
}

const dialsTo = (dials, peerId) => dials.some((d) => d.startsWith(`10.8.0.${peerId}:`));

async function assertOnlyPool(r) {
  assert.deepEqual(row(r.id), { target_kind: 'gateway', target_peer_id: null, target_pool_id: poolId, wol_enabled: 1, wol_mac: MAC });
  for (const peerId of [GW_B, GW_C]) {
    assert.ok(entryOf(peerId, r), 'pool member ' + peerId + ' has the route');
    assert.ok(whitelisted(peerId), 'pool member ' + peerId + ' has the MAC in its WoL whitelist');
  }
  assert.equal(entryOf(GW_A, r), null, 'the former gateway no longer has the route');
  assert.equal(whitelisted(GW_A), false, 'the former gateway no longer has the MAC');
  const dials = await caddyDials(r);
  assert.ok(dialsTo(dials, GW_B), 'Caddy dials the active pool member: ' + JSON.stringify(dials));
  assert.ok(!dialsTo(dials, GW_A), 'Caddy does not dial the former gateway: ' + JSON.stringify(dials));
}

async function assertOnlyPeer(r) {
  assert.deepEqual(row(r.id), { target_kind: 'gateway', target_peer_id: GW_A, target_pool_id: null, wol_enabled: 1, wol_mac: MAC });
  assert.ok(entryOf(GW_A, r), 'the gateway has the route');
  assert.ok(whitelisted(GW_A), 'the gateway has the MAC in its WoL whitelist');
  for (const peerId of [GW_B, GW_C]) {
    assert.equal(entryOf(peerId, r), null, 'former pool member ' + peerId + ' no longer has the route');
    assert.equal(whitelisted(peerId), false, 'former pool member ' + peerId + ' no longer has the MAC');
  }
  const dials = await caddyDials(r);
  assert.ok(dialsTo(dials, GW_A), 'Caddy dials the gateway: ' + JSON.stringify(dials));
  assert.ok(!dialsTo(dials, GW_B) && !dialsTo(dials, GW_C), 'Caddy does not dial the pool: ' + JSON.stringify(dials));
}

const put = (id, body) => agent.put(`/api/v1/routes/${id}`).set('X-CSRF-Token', csrf).send(body);

for (const type of ['http', 'l4']) {
  describe(`${type} route: switch between a gateway and a gateway pool`, () => {
    it('gateway → pool (peer null + pool, as a form sends it): only the pool is left everywhere', async () => {
      const r = await createRoute(type, { target_peer_id: GW_A });
      await assertOnlyPeer(r);
      const res = await put(r.id, { target_kind: 'gateway', target_peer_id: null, target_pool_id: poolId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      await assertOnlyPool(r);
      await routes.remove(r.id);
    });

    it('gateway → pool with only target_pool_id in the patch', async () => {
      const r = await createRoute(type, { target_peer_id: GW_A });
      const res = await put(r.id, { target_pool_id: poolId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      await assertOnlyPool(r);
      await routes.remove(r.id);
    });

    it('pool → gateway (pool null + peer): only the gateway is left everywhere', async () => {
      const r = await createRoute(type, { target_pool_id: poolId });
      await assertOnlyPool(r);
      const res = await put(r.id, { target_kind: 'gateway', target_peer_id: GW_A, target_pool_id: null });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      await assertOnlyPeer(r);
      await routes.remove(r.id);
    });

    it('pool → gateway with only target_peer_id in the patch', async () => {
      const r = await createRoute(type, { target_pool_id: poolId });
      const res = await put(r.id, { target_peer_id: GW_A });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      await assertOnlyPeer(r);
      await routes.remove(r.id);
    });

    it('400 with a field error: both, unknown pool, empty pool; the route stays as it was', async () => {
      const r = await createRoute(type, { target_peer_id: GW_A });
      const cases = [
        [{ target_peer_id: GW_A, target_pool_id: poolId }, 'target_pool_id', 'TARGET_CONFLICT'],
        [{ target_peer_id: null, target_pool_id: 99999 }, 'target_pool_id', 'TARGET_POOL_NOT_FOUND'],
        [{ target_peer_id: null, target_pool_id: emptyPoolId }, 'target_pool_id', 'TARGET_POOL_EMPTY'],
      ];
      for (const [fields, field, code] of cases) {
        const res = await put(r.id, { target_kind: 'gateway', ...fields });
        assert.equal(res.status, 400, JSON.stringify(fields) + ' → ' + JSON.stringify(res.body));
        assert.equal(res.body.code, code, JSON.stringify(res.body));
        assert.ok(res.body.fields && res.body.fields[field], 'field error on ' + field + ': ' + JSON.stringify(res.body));
      }
      await assertOnlyPeer(r);
      await routes.remove(r.id);
    });
  });
}

describe('gateway target on create and on a kind switch', () => {
  it('POST with both → 400 TARGET_CONFLICT; nothing is created', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM routes').get().n;
    const res = await agent.post('/api/v1/routes').set('X-CSRF-Token', csrf).send({
      route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: String(listenPort++), l4_tls_mode: 'none',
      target_kind: 'gateway', target_peer_id: GW_A, target_pool_id: poolId,
      target_lan_host: '192.168.1.91', target_lan_port: 22, target_port: 22,
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'TARGET_CONFLICT');
    assert.ok(res.body.fields.target_pool_id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM routes').get().n, before);
  });

  it('switching a peer route to target_kind=gateway without a target → 400 TARGET_REQUIRED', async () => {
    const r = await routes.create({ route_type: 'http', domain: 'switch-peer.example.com', https_enabled: false, target_ip: '10.8.0.250', target_port: 80 });
    const res = await put(r.id, { target_kind: 'gateway', target_lan_host: '192.168.1.91', target_lan_port: 80 });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'TARGET_REQUIRED');
    assert.ok(res.body.fields.target_peer_id);
    assert.equal(row(r.id).target_kind, 'peer');
    await routes.remove(r.id);
  });

  it('a null target_peer_id alone still keeps the stored gateway (COALESCE for unrelated edits)', async () => {
    const r = await createRoute('l4', { target_peer_id: GW_A });
    const res = await put(r.id, { target_peer_id: null, description: 'kept' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertOnlyPeer(r);
    await routes.remove(r.id);
  });

  it('a row stored with both (from before the fix): an unrelated edit keeps the pool and drops the gateway', async () => {
    const r = await createRoute('l4', { target_pool_id: poolId });
    db.prepare('UPDATE routes SET target_peer_id = ? WHERE id = ?').run(GW_A, r.id);
    const res = await put(r.id, { description: 'legacy row' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertOnlyPool(r);
    await routes.remove(r.id);
  });
});

describe('migration 159 (gateway_target_peer_xor_pool)', () => {
  const migration = () => require('../src/db/migrationList').migrations.find((m) => m.version === 159);

  it('is the newest migration and has a unique version', () => {
    const versions = require('../src/db/migrationList').migrations.map((m) => m.version);
    assert.ok(migration(), 'migration 159 exists');
    assert.equal(new Set(versions).size, versions.length);
    assert.equal(Math.max(...versions), 159);
  });

  it('keeps the pool and clears the gateway in routes and rdp_routes stored with both; leaves clean rows alone', async () => {
    const both = await createRoute('l4', { target_pool_id: poolId });
    const peerOnly = await createRoute('l4', { target_peer_id: GW_A });
    const poolOnly = await createRoute('http', { target_pool_id: poolId });
    db.prepare('UPDATE routes SET target_peer_id = ? WHERE id = ?').run(GW_A, both.id);
    const rdpIns = db.prepare(`INSERT INTO rdp_routes (name, host, port, access_mode, gateway_peer_id, gateway_pool_id)
      VALUES (?, '192.168.1.92', 3389, 'gateway', ?, ?)`);
    const rdpBoth = Number(rdpIns.run('mig-both', GW_A, poolId).lastInsertRowid);
    const rdpPeer = Number(rdpIns.run('mig-peer', GW_A, null).lastInsertRowid);
    const rdpPool = Number(rdpIns.run('mig-pool', null, poolId).lastInsertRowid);

    assert.equal(entryOf(GW_A, both) !== null, true, 'before: the stale gateway still gets the listener');
    db.exec(migration().sql);

    assert.deepEqual(row(both.id), { target_kind: 'gateway', target_peer_id: null, target_pool_id: poolId, wol_enabled: 1, wol_mac: MAC });
    assert.equal(entryOf(GW_A, both), null, 'after: the stale gateway has no listener any more');
    assert.equal(row(peerOnly.id).target_peer_id, GW_A, 'a gateway-only row is untouched');
    assert.equal(row(poolOnly.id).target_pool_id, poolId, 'a pool-only row is untouched');
    const rdp = (id) => ({ ...db.prepare('SELECT gateway_peer_id, gateway_pool_id FROM rdp_routes WHERE id = ?').get(id) });
    assert.deepEqual(rdp(rdpBoth), { gateway_peer_id: null, gateway_pool_id: poolId });
    assert.deepEqual(rdp(rdpPeer), { gateway_peer_id: GW_A, gateway_pool_id: null });
    assert.deepEqual(rdp(rdpPool), { gateway_peer_id: null, gateway_pool_id: poolId });

    // Idempotent.
    db.exec(migration().sql);
    assert.deepEqual(rdp(rdpBoth), { gateway_peer_id: null, gateway_pool_id: poolId });
    db.prepare('DELETE FROM rdp_routes WHERE id IN (?, ?, ?)').run(rdpBoth, rdpPeer, rdpPool);
    for (const r of [both, peerOnly, poolOnly]) await routes.remove(r.id);
  });
});
