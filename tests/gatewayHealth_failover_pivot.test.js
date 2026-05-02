'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let gatewayHealth, gatewayPool, getDb, caddyConfig;
beforeEach(async () => {
  await setup();
  // Stub syncToCaddy so transitions don't try to talk to a real Caddy admin
  caddyConfig = require('../src/services/caddyConfig');
  caddyConfig.syncToCaddy = async () => {};
  gatewayHealth = require('../src/services/gatewayHealth');
  gatewayPool = require('../src/services/gatewayPool');
  getDb = require('../src/db/connection').getDb;
  gatewayHealth._resetSnapshotCache();
});
afterEach(teardown);

function insertPeer(db, id, name, ip) {
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (?, ?, ?, 'gateway', ?, 1)")
    .run(id, name, 'pk' + id, ip + '/32');
  db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, last_seen_at, created_at) VALUES (?, 9876, 'h', 'e', 1, ?, strftime('%s','now')*1000)")
    .run(id, Date.now());
}

function setupPoolWithRoute() {
  const db = getDb();
  insertPeer(db, 10, 'home', '10.8.0.10');
  insertPeer(db, 11, 'ds918', '10.8.0.11');
  const poolId = gatewayPool.createPool({ name: 'P', mode: 'failover', failback_cooldown_s: 60 });
  gatewayPool.addMember(poolId, 10, 1); // home (preferred)
  gatewayPool.addMember(poolId, 11, 2); // ds918 (fallback)
  // Route originally pinned to home
  db.prepare(`
    INSERT INTO routes (id, domain, target_kind, target_peer_id, target_lan_host, target_lan_port, target_ip, target_port, route_type, enabled)
    VALUES (100, 'nas.test', 'gateway', 10, '192.168.1.5', 5001, '10.8.0.10', 5001, 'http', 1)
  `).run();
  // Prime snapshot
  gatewayHealth.evaluatePeer(10);
  gatewayHealth.evaluatePeer(11);
  return { db, poolId };
}

test('alive_to_down pivots routes from offline peer to alive sibling', async () => {
  const { db } = setupPoolWithRoute();

  // Mark home offline in gateway_meta and replay the transition
  db.prepare("UPDATE gateway_meta SET alive=0, went_down_at=?, last_seen_at=? WHERE peer_id=10")
    .run(Date.now() - 200_000, Date.now() - 200_000);
  gatewayHealth._resetSnapshotCache();
  gatewayHealth.evaluatePeer(10);
  gatewayHealth.evaluatePeer(11);
  // Drive the actual state-change handler
  await gatewayHealth._onTransition(10, 'alive_to_down');

  const r = db.prepare('SELECT target_peer_id, original_peer_id FROM routes WHERE id = 100').get();
  assert.equal(r.target_peer_id, 11, 'route should now target ds918');
  assert.equal(r.original_peer_id, 10, 'original_peer_id should record the home peer');
});

test('cooldown_to_alive restores routes back to original peer', async () => {
  const { db } = setupPoolWithRoute();

  // Manually put the route in the failed-over state
  db.prepare('UPDATE routes SET target_peer_id = 11, original_peer_id = 10 WHERE id = 100').run();

  await gatewayHealth._onTransition(10, 'cooldown_to_alive');

  const r = db.prepare('SELECT target_peer_id, original_peer_id FROM routes WHERE id = 100').get();
  assert.equal(r.target_peer_id, 10, 'route should be restored to home');
  assert.equal(r.original_peer_id, null, 'original_peer_id should be cleared');
});

test('alive_to_down is no-op when no alive sibling exists', async () => {
  const { db } = setupPoolWithRoute();

  // Both members offline
  db.prepare("UPDATE gateway_meta SET alive=0, went_down_at=?, last_seen_at=? WHERE peer_id IN (10, 11)")
    .run(Date.now() - 200_000, Date.now() - 200_000);
  gatewayHealth._resetSnapshotCache();
  gatewayHealth.evaluatePeer(10);
  gatewayHealth.evaluatePeer(11);

  await gatewayHealth._onTransition(10, 'alive_to_down');

  const r = db.prepare('SELECT target_peer_id, original_peer_id FROM routes WHERE id = 100').get();
  assert.equal(r.target_peer_id, 10, 'route stays pinned to offline home (no alive sibling to pivot to)');
  assert.equal(r.original_peer_id, null);
});

test('alive_to_down does not double-pivot a route already in failover', async () => {
  const { db } = setupPoolWithRoute();

  // First failover: home → ds918
  db.prepare('UPDATE routes SET target_peer_id = 11, original_peer_id = 10 WHERE id = 100').run();
  // Mark ds918 offline too — now both are down
  db.prepare("UPDATE gateway_meta SET alive=0, went_down_at=?, last_seen_at=? WHERE peer_id=11")
    .run(Date.now() - 200_000, Date.now() - 200_000);
  gatewayHealth._resetSnapshotCache();
  gatewayHealth.evaluatePeer(10);
  gatewayHealth.evaluatePeer(11);

  await gatewayHealth._onTransition(11, 'alive_to_down');

  const r = db.prepare('SELECT target_peer_id, original_peer_id FROM routes WHERE id = 100').get();
  // No alive sibling for ds918 → no pivot. original_peer_id stays 10 (home), so
  // when home recovers the route returns to home, not to a transient sibling.
  assert.equal(r.target_peer_id, 11);
  assert.equal(r.original_peer_id, 10);
});

test('routes targeting a peer NOT in any pool are not pivoted', async () => {
  const db = getDb();
  insertPeer(db, 20, 'lone', '10.8.0.20');
  insertPeer(db, 21, 'unrelated', '10.8.0.21');
  const poolId = gatewayPool.createPool({ name: 'P', mode: 'failover', failback_cooldown_s: 60 });
  gatewayPool.addMember(poolId, 21, 1);
  db.prepare(`
    INSERT INTO routes (id, domain, target_kind, target_peer_id, target_lan_host, target_lan_port, target_ip, target_port, route_type, enabled)
    VALUES (200, 'lone.test', 'gateway', 20, '192.168.1.99', 80, '10.8.0.20', 80, 'http', 1)
  `).run();
  db.prepare("UPDATE gateway_meta SET alive=0, went_down_at=?, last_seen_at=? WHERE peer_id=20")
    .run(Date.now() - 200_000, Date.now() - 200_000);
  gatewayHealth._resetSnapshotCache();
  gatewayHealth.evaluatePeer(20);
  gatewayHealth.evaluatePeer(21);

  await gatewayHealth._onTransition(20, 'alive_to_down');

  const r = db.prepare('SELECT target_peer_id, original_peer_id FROM routes WHERE id = 200').get();
  assert.equal(r.target_peer_id, 20, 'lone peer routes are not pivoted across unrelated pools');
  assert.equal(r.original_peer_id, null);
});

test('cooldown_to_alive on a peer with nothing parked is a clean no-op', async () => {
  const { db } = setupPoolWithRoute();

  // Recovery transition for home, but no failover ever happened
  await gatewayHealth._onTransition(10, 'cooldown_to_alive');

  const r = db.prepare('SELECT target_peer_id, original_peer_id FROM routes WHERE id = 100').get();
  assert.equal(r.target_peer_id, 10);
  assert.equal(r.original_peer_id, null);
});
