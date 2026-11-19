'use strict';

// RDP route through a gateway POOL instead of a pinned gateway
// (services/rdp.js, access_mode=gateway): exactly one of gateway_peer_id or
// gateway_pool_id. A pool route can be created directly; switching peer →
// pool and pool → peer clears the former target in the RDP row AND in the
// linked L4 route (routes.update, opts.clear), so the Caddy config and the
// gateway configs (listener, WoL whitelist) only hold the new target.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

const GW_A = 81; // a single gateway, in no pool
const GW_B = 82; // pool member, priority 10 (the active one)
const GW_C = 83; // pool member, priority 20
const MAC = 'AA:BB:CC:DD:EE:81';

let agent, csrf, db, rdp, routes, gateways, caddyConfig, poolId, emptyPoolId;

function gateway(id, name) {
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (?, ?, ?, 'gateway', ?, 1)")
    .run(id, name, 'pk-rdp-pool-' + id, `10.8.0.${id}/32`);
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, last_seen_at, created_at)
    VALUES (?, 9876, 'h', 'e', 1, ?, ?)`).run(id, Date.now(), Date.now());
}

before(async () => {
  const ctx = await setup();
  agent = ctx.agent;
  csrf = ctx.csrfToken;
  require('../src/services/license')._overrideForTest({
    rdp_via_gateway: true, gateway_tcp_routing: true, gateway_peers: -1,
  });
  db = require('../src/db/connection').getDb();
  rdp = require('../src/services/rdp');
  routes = require('../src/services/routes');
  gateways = require('../src/services/gateways');
  caddyConfig = require('../src/services/caddyConfig');
  // no push to real gateways from the tests
  gateways.notifyConfigChanged = async () => {};
  const colocation = require('../src/services/gatewayColocation');
  colocation._setInterfacesForTest(() => ({ lo: [{ address: '127.0.0.1', family: 'IPv4' }] }));
  require('../src/services/gatewayHealth')._resetSnapshotCache();
  gateway(GW_A, 'rdp-pool-a');
  gateway(GW_B, 'rdp-pool-b');
  gateway(GW_C, 'rdp-pool-c');
  const pool = require('../src/services/gatewayPool');
  poolId = Number(pool.createPool({ name: 'rdp-pool', mode: 'failover', failback_cooldown_s: 60 }));
  pool.addMember(poolId, GW_B, 10);
  pool.addMember(poolId, GW_C, 20);
  emptyPoolId = Number(pool.createPool({ name: 'rdp-pool-empty', mode: 'failover', failback_cooldown_s: 60 }));
});

after(() => {
  require('../src/services/gatewayColocation')._setInterfacesForTest(null);
  return teardown();
});

let port = 4600;
function body(name, fields) {
  return {
    name, host: '192.168.1.80', port: 3389, credential_mode: 'none',
    access_mode: 'gateway', gateway_listen_port: port++,
    wol_enabled: true, wol_mac_address: MAC, ...fields,
  };
}

const rdpRow = (id) => ({ ...db.prepare('SELECT gateway_peer_id, gateway_pool_id, gateway_l4_route_id FROM rdp_routes WHERE id = ?').get(id) });
const l4Row = (id) => ({ ...db.prepare('SELECT target_kind, target_peer_id, target_pool_id, wol_enabled, wol_mac FROM routes WHERE id = ?').get(id) });
const listenerOf = (peerId, l4Id) => gateways.getGatewayConfig(peerId).l4_routes.find((x) => x.id === l4Id) || null;

// The upstreams Caddy dials for the L4 listener on this port.
async function caddyDials(listenPort) {
  const cfg = await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  const servers = (cfg.apps.layer4 && cfg.apps.layer4.servers) || {};
  const out = [];
  for (const s of Object.values(servers)) {
    if (!(s.listen || []).some((l) => String(l).endsWith(':' + listenPort))) continue;
    for (const r of s.routes) {
      for (const h of r.handle || []) {
        if (h.handler === 'proxy') for (const u of h.upstreams) out.push(...u.dial);
      }
    }
  }
  return out;
}

function assertOnlyPool(id, listenPort) {
  const row = rdpRow(id);
  assert.equal(row.gateway_pool_id, poolId);
  assert.equal(row.gateway_peer_id, null, 'the RDP row keeps no gateway peer next to the pool');
  const l4 = l4Row(row.gateway_l4_route_id);
  assert.deepEqual(l4, { target_kind: 'gateway', target_peer_id: null, target_pool_id: poolId, wol_enabled: 1, wol_mac: MAC });
  for (const peerId of [GW_B, GW_C]) {
    const entry = listenerOf(peerId, row.gateway_l4_route_id);
    assert.ok(entry, 'pool member ' + peerId + ' has the listener');
    assert.equal(entry.wol_mac, MAC, 'pool member ' + peerId + ' has the MAC in its WoL whitelist');
  }
  assert.equal(listenerOf(GW_A, row.gateway_l4_route_id), null, 'the former gateway has no listener any more');
  return caddyDials(listenPort).then((dials) => assert.deepEqual(dials, [`10.8.0.${GW_B}:${listenPort}`]));
}

function assertOnlyPeer(id, listenPort) {
  const row = rdpRow(id);
  assert.equal(row.gateway_peer_id, GW_A);
  assert.equal(row.gateway_pool_id, null, 'the RDP row keeps no pool next to the gateway peer');
  const l4 = l4Row(row.gateway_l4_route_id);
  assert.deepEqual(l4, { target_kind: 'gateway', target_peer_id: GW_A, target_pool_id: null, wol_enabled: 1, wol_mac: MAC });
  const entry = listenerOf(GW_A, row.gateway_l4_route_id);
  assert.ok(entry, 'the gateway has the listener');
  assert.equal(entry.wol_mac, MAC);
  for (const peerId of [GW_B, GW_C]) {
    assert.equal(listenerOf(peerId, row.gateway_l4_route_id), null, 'former pool member ' + peerId + ' has no listener any more');
  }
  return caddyDials(listenPort).then((dials) => assert.deepEqual(dials, [`10.8.0.${GW_A}:${listenPort}`]));
}

describe('RDP route through a gateway pool', () => {
  it('create with a pool (no peer): 201, linked L4 route on the pool, every member has listener + MAC', async () => {
    const b = body('rdp-pool-create', { gateway_pool_id: poolId });
    const res = await agent.post('/api/v1/rdp').set('X-CSRF-Token', csrf).send(b);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.route.gateway_pool_id, poolId);
    await assertOnlyPool(res.body.route.id, b.gateway_listen_port);
  });

  it('create: both peer and pool → 400; neither → 400; unknown or empty pool → 400; nothing is created', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM rdp_routes').get().n;
    const l4Before = db.prepare("SELECT COUNT(*) AS n FROM routes WHERE route_type = 'l4'").get().n;
    const cases = [
      [{ gateway_peer_id: GW_A, gateway_pool_id: poolId }, 'gateway_pool_id', /conflicting_target/],
      [{}, 'gateway_peer_id', /peer or gateway pool is required/],
      [{ gateway_peer_id: null, gateway_pool_id: null }, 'gateway_peer_id', /peer or gateway pool is required/],
      [{ gateway_pool_id: 99999 }, 'gateway_pool_id', /gateway_pool_not_found/],
      [{ gateway_pool_id: emptyPoolId }, 'gateway_pool_id', /gateway_pool_empty/],
    ];
    for (const [fields, field, re] of cases) {
      const res = await agent.post('/api/v1/rdp').set('X-CSRF-Token', csrf).send(body('rdp-pool-reject', fields));
      assert.equal(res.status, 400, JSON.stringify(fields) + ' → ' + JSON.stringify(res.body));
      assert.match(res.body.fields[field], re, JSON.stringify(fields));
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rdp_routes').get().n, before);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM routes WHERE route_type = 'l4'").get().n, l4Before);
  });

  it('update peer → pool (as the form sends it: peer null + pool): only the pool is left, everywhere', async () => {
    const b = body('rdp-peer-to-pool', { gateway_peer_id: GW_A });
    const r = await rdp.create(b);
    await assertOnlyPeer(r.id, b.gateway_listen_port);
    const res = await agent.patch(`/api/v1/rdp/${r.id}`).set('X-CSRF-Token', csrf)
      .send({ access_mode: 'gateway', gateway_peer_id: null, gateway_pool_id: poolId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertOnlyPool(r.id, b.gateway_listen_port);
  });

  it('update peer → pool with only gateway_pool_id in the patch: the L4 route follows, the peer is cleared', async () => {
    const b = body('rdp-peer-to-pool-only', { gateway_peer_id: GW_A });
    const r = await rdp.create(b);
    await rdp.update(r.id, { gateway_pool_id: poolId });
    await assertOnlyPool(r.id, b.gateway_listen_port);
  });

  it('update pool → peer: only the gateway is left, everywhere (the pool members drop the listener)', async () => {
    const b = body('rdp-pool-to-peer', { gateway_pool_id: poolId });
    const r = await rdp.create(b);
    await assertOnlyPool(r.id, b.gateway_listen_port);
    const res = await agent.patch(`/api/v1/rdp/${r.id}`).set('X-CSRF-Token', csrf)
      .send({ access_mode: 'gateway', gateway_peer_id: GW_A, gateway_pool_id: null });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertOnlyPeer(r.id, b.gateway_listen_port);
  });

  it('update pool → peer with only gateway_peer_id in the patch', async () => {
    const b = body('rdp-pool-to-peer-only', { gateway_pool_id: poolId });
    const r = await rdp.create(b);
    await rdp.update(r.id, { gateway_peer_id: GW_A });
    await assertOnlyPeer(r.id, b.gateway_listen_port);
  });

  it('update: both set → 400, both cleared on a gateway route → 400; the route stays as it was', async () => {
    const b = body('rdp-update-reject', { gateway_pool_id: poolId });
    const r = await rdp.create(b);
    for (const fields of [{ gateway_peer_id: GW_A, gateway_pool_id: poolId }, { gateway_peer_id: null, gateway_pool_id: null }]) {
      const res = await agent.patch(`/api/v1/rdp/${r.id}`).set('X-CSRF-Token', csrf).send({ access_mode: 'gateway', ...fields });
      assert.equal(res.status, 400, JSON.stringify(fields) + ' → ' + JSON.stringify(res.body));
    }
    await assertOnlyPool(r.id, b.gateway_listen_port);
  });
});

describe('a route stored with both (from before the fix)', () => {
  it('an unrelated edit is not refused and drops the stale gateway (the pool was the effective target)', async () => {
    const b = body('rdp-legacy-both', { gateway_pool_id: poolId });
    const r = await rdp.create(b);
    db.prepare('UPDATE rdp_routes SET gateway_peer_id = ? WHERE id = ?').run(GW_A, r.id);
    db.prepare('UPDATE routes SET target_peer_id = ? WHERE id = ?').run(GW_A, r.gateway_l4_route_id);
    const res = await agent.patch(`/api/v1/rdp/${r.id}`).set('X-CSRF-Token', csrf).send({ name: 'rdp-legacy-renamed' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertOnlyPool(r.id, b.gateway_listen_port);
  });
});

describe('routes.update keeps COALESCE for everyone else', () => {
  it('a null target_peer_id without opts.clear keeps the stored peer; opts.clear clears only the named field', async () => {
    const created = await routes.create({
      domain: null, route_type: 'l4', target_kind: 'gateway', target_peer_id: GW_A,
      target_lan_host: '192.168.1.90', target_lan_port: 22, l4_protocol: 'tcp',
      l4_listen_port: '4700', l4_tls_mode: 'none', target_port: 4700, enabled: true,
    });
    await routes.update(created.id, { target_peer_id: null, description: 'kept' });
    assert.equal(l4Row(created.id).target_peer_id, GW_A);
    await assert.rejects(routes.update(created.id, {}, { clear: ['domain'] }), /cannot be cleared/);
    await assert.rejects(routes.update(created.id, { target_pool_id: poolId }, { clear: ['target_pool_id'] }), /conflicting_target/);
    await routes.update(created.id, { target_pool_id: poolId }, { clear: ['target_peer_id'] });
    const row = l4Row(created.id);
    assert.equal(row.target_peer_id, null);
    assert.equal(row.target_pool_id, poolId);
    await routes.remove(created.id);
  });
});
