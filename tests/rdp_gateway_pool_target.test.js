'use strict';

// The linked L4 route of a gateway target switches between a pinned gateway
// and a pool with routes.update(…, { clear }) — the former target goes, so the
// Caddy config and the gateway configs only hold the new one. (The cases
// through the admin API of the former Remote Desktops went with that API:
// docs/feature-remote-access.md "Remote Desktops removed".)

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

const GW_A = 81; // a single gateway, in no pool
const GW_B = 82; // pool member, priority 10 (the active one)
const GW_C = 83; // pool member, priority 20

let db, routes, gateways, poolId;

function gateway(id, name) {
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (?, ?, ?, 'gateway', ?, 1)")
    .run(id, name, 'pk-rdp-pool-' + id, `10.8.0.${id}/32`);
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, last_seen_at, created_at)
    VALUES (?, 9876, 'h', 'e', 1, ?, ?)`).run(id, Date.now(), Date.now());
}

before(async () => {
  await setup();
  require('../src/services/license')._overrideForTest({
    rdp_via_gateway: true, gateway_tcp_routing: true, gateway_peers: -1,
  });
  db = require('../src/db/connection').getDb();
  routes = require('../src/services/routes');
  gateways = require('../src/services/gateways');
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
});

after(() => {
  require('../src/services/gatewayColocation')._setInterfacesForTest(null);
  return teardown();
});

const l4Row = (id) => ({ ...db.prepare('SELECT target_kind, target_peer_id, target_pool_id, wol_enabled, wol_mac FROM routes WHERE id = ?').get(id) });

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
