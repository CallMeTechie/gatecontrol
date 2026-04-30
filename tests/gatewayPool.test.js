'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let gatewayPool, getDb;
beforeEach(async () => {
  await setup();
  gatewayPool = require('../src/services/gatewayPool');
  getDb = require('../src/db/connection').getDb;
});
afterEach(teardown);

test('createPool creates pool with required fields', () => {
  const id = gatewayPool.createPool({
    name: 'Heimnetz', mode: 'failover', failback_cooldown_s: 300,
  });
  assert.ok(id > 0);
  const pool = gatewayPool.getPool(id);
  assert.equal(pool.name, 'Heimnetz');
  assert.equal(pool.mode, 'failover');
  assert.equal(pool.failback_cooldown_s, 300);
  assert.equal(pool.enabled, 1);
});

test('createPool rejects mode=load_balancing without lb_policy', () => {
  assert.throws(
    () => gatewayPool.createPool({ name: 'BadPool', mode: 'load_balancing', failback_cooldown_s: 300 }),
    /lb_policy required/,
  );
});

test('createPool rejects mode=failover with lb_policy set', () => {
  assert.throws(
    () => gatewayPool.createPool({ name: 'BadPool', mode: 'failover', lb_policy: 'round_robin', failback_cooldown_s: 300 }),
    /lb_policy must be null in failover mode/,
  );
});

test('createPool rejects duplicate name', () => {
  gatewayPool.createPool({ name: 'X', mode: 'failover', failback_cooldown_s: 60 });
  assert.throws(
    () => gatewayPool.createPool({ name: 'X', mode: 'failover', failback_cooldown_s: 60 }),
    /UNIQUE/,
  );
});

function insertGatewayPeer(db, id) {
  db.prepare("INSERT INTO peers (id, public_key, peer_type, allowed_ips) VALUES (?, ?, 'gateway', '10.8.0.' || ? || '/32')").run(id, `pk${id}`, id);
  db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at) VALUES (?, 9876, 'h', 'e', strftime('%s','now')*1000)").run(id);
}

test('addMember + listMembers ordered by priority', () => {
  const db = getDb();
  insertGatewayPeer(db, 1);
  insertGatewayPeer(db, 2);
  const poolId = gatewayPool.createPool({ name: 'P', mode: 'failover', failback_cooldown_s: 60 });
  gatewayPool.addMember(poolId, 1, 200);
  gatewayPool.addMember(poolId, 2, 100);
  const members = gatewayPool.listMembers(poolId);
  assert.equal(members.length, 2);
  assert.equal(members[0].peer_id, 2);
  assert.equal(members[1].peer_id, 1);
});

test('resolveActivePeer in failover-mode picks lowest priority alive peer', () => {
  const db = getDb();
  insertGatewayPeer(db, 1);
  insertGatewayPeer(db, 2);
  const poolId = gatewayPool.createPool({ name: 'P', mode: 'failover', failback_cooldown_s: 60 });
  gatewayPool.addMember(poolId, 1, 100);
  gatewayPool.addMember(poolId, 2, 200);
  const snapshot = { 1: { alive: true }, 2: { alive: true } };
  assert.equal(gatewayPool.resolveActivePeer(poolId, snapshot), 1);
  snapshot[1].alive = false;
  assert.equal(gatewayPool.resolveActivePeer(poolId, snapshot), 2);
  snapshot[2].alive = false;
  assert.equal(gatewayPool.resolveActivePeer(poolId, snapshot), null);
});

test('resolveActivePeer ties broken by lowest peer_id', () => {
  const db = getDb();
  insertGatewayPeer(db, 5);
  insertGatewayPeer(db, 3);
  const poolId = gatewayPool.createPool({ name: 'P', mode: 'failover', failback_cooldown_s: 60 });
  gatewayPool.addMember(poolId, 5, 100);
  gatewayPool.addMember(poolId, 3, 100);
  const snapshot = { 5: { alive: true }, 3: { alive: true } };
  assert.equal(gatewayPool.resolveActivePeer(poolId, snapshot), 3);
});

test('resolveActivePeers in lb-mode returns all alive members', () => {
  const db = getDb();
  insertGatewayPeer(db, 1);
  insertGatewayPeer(db, 2);
  const poolId = gatewayPool.createPool({
    name: 'L', mode: 'load_balancing', lb_policy: 'round_robin', failback_cooldown_s: 60,
  });
  gatewayPool.addMember(poolId, 1, 100);
  gatewayPool.addMember(poolId, 2, 100);
  const snapshot = { 1: { alive: true }, 2: { alive: false } };
  const peers = gatewayPool.resolveActivePeers(poolId, snapshot);
  assert.deepEqual(peers, [1]);
});

test('getMaxCooldownForPeer returns max across all pools peer is member of', () => {
  const db = getDb();
  insertGatewayPeer(db, 1);
  const p1 = gatewayPool.createPool({ name: 'A', mode: 'failover', failback_cooldown_s: 60 });
  const p2 = gatewayPool.createPool({ name: 'B', mode: 'failover', failback_cooldown_s: 600 });
  gatewayPool.addMember(p1, 1, 100);
  gatewayPool.addMember(p2, 1, 100);
  assert.equal(gatewayPool.getMaxCooldownForPeer(1), 600);
});
