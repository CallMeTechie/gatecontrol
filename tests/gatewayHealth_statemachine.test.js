'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let gatewayHealth, gatewayPool, getDb;
beforeEach(async () => {
  await setup();
  gatewayHealth = require('../src/services/gatewayHealth');
  gatewayPool = require('../src/services/gatewayPool');
  getDb = require('../src/db/connection').getDb;
  gatewayHealth._resetSnapshotCache();
});
afterEach(teardown);

function insertGatewayPeer(db, id, lastHbAgoMs = null, alive = 1) {
  const lastHb = lastHbAgoMs == null ? null : Date.now() - lastHbAgoMs;
  db.prepare("INSERT INTO peers (id, public_key, peer_type, allowed_ips) VALUES (?, ?, 'gateway', '10.8.0.' || ? || '/32')").run(id, `pk${id}`, id);
  db.prepare(`
    INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, last_seen_at, alive, created_at)
    VALUES (?, 9876, 'h', 'e', ?, ?, strftime('%s','now')*1000)
  `).run(id, lastHb, alive);
}

test('evaluatePeer marks down when last_seen_at older than threshold', () => {
  const db = getDb();
  insertGatewayPeer(db, 1, 95_000);
  const result = gatewayHealth.evaluatePeer(1);
  assert.equal(result.transition, 'alive_to_down');
  const gw = db.prepare('SELECT alive, went_down_at FROM gateway_meta WHERE peer_id = 1').get();
  assert.equal(gw.alive, 0);
  assert.ok(gw.went_down_at);
});

test('evaluatePeer keeps alive when last_seen_at within threshold', () => {
  const db = getDb();
  insertGatewayPeer(db, 1, 30_000);
  const result = gatewayHealth.evaluatePeer(1);
  assert.equal(result.transition, null);
  assert.equal(db.prepare('SELECT alive FROM gateway_meta WHERE peer_id = 1').get().alive, 1);
});

test('first heartbeat after down sets recovered_first_hb_at', () => {
  const db = getDb();
  insertGatewayPeer(db, 1, 1000, 0);
  db.prepare("UPDATE gateway_meta SET went_down_at = ? WHERE peer_id = 1").run(Date.now() - 200_000);
  const result = gatewayHealth.evaluatePeer(1);
  assert.equal(result.transition, 'down_to_cooldown');
  const gw = db.prepare('SELECT alive, recovered_first_hb_at FROM gateway_meta WHERE peer_id = 1').get();
  assert.equal(gw.alive, 0);
  assert.ok(gw.recovered_first_hb_at);
});

test('failback only after max_cooldown across all pools', () => {
  const db = getDb();
  insertGatewayPeer(db, 1, 1000, 0);
  const p1 = gatewayPool.createPool({ name: 'A', mode: 'failover', failback_cooldown_s: 60 });
  const p2 = gatewayPool.createPool({ name: 'B', mode: 'failover', failback_cooldown_s: 600 });
  gatewayPool.addMember(p1, 1, 100);
  gatewayPool.addMember(p2, 1, 100);
  db.prepare("UPDATE gateway_meta SET went_down_at = ?, recovered_first_hb_at = ? WHERE peer_id = 1")
    .run(Date.now() - 1_000_000, Date.now() - 120_000);
  let result = gatewayHealth.evaluatePeer(1);
  assert.equal(result.transition, null, 'must NOT failback before max cooldown');
  db.prepare("UPDATE gateway_meta SET recovered_first_hb_at = ? WHERE peer_id = 1")
    .run(Date.now() - 700_000);
  result = gatewayHealth.evaluatePeer(1);
  assert.equal(result.transition, 'cooldown_to_alive');
  const gw = db.prepare('SELECT alive, went_down_at, recovered_first_hb_at FROM gateway_meta WHERE peer_id = 1').get();
  assert.equal(gw.alive, 1);
  assert.equal(gw.went_down_at, null);
  assert.equal(gw.recovered_first_hb_at, null);
});

test('cooldown_reset preserves went_down_at when heartbeat-gap occurs', () => {
  const db = getDb();
  insertGatewayPeer(db, 1, 200_000, 0);
  const originalDown = Date.now() - 500_000;
  db.prepare("UPDATE gateway_meta SET went_down_at = ?, recovered_first_hb_at = ? WHERE peer_id = 1")
    .run(originalDown, Date.now() - 30_000);
  const result = gatewayHealth.evaluatePeer(1);
  assert.equal(result.transition, 'cooldown_reset');
  const gw = db.prepare('SELECT went_down_at, recovered_first_hb_at FROM gateway_meta WHERE peer_id = 1').get();
  assert.equal(gw.went_down_at, originalDown);
  assert.equal(gw.recovered_first_hb_at, null);
});

test('cooldown_reset interrupt-log fires exactly once per outage', () => {
  const db = getDb();
  insertGatewayPeer(db, 1, 200_000, 0);
  db.prepare("UPDATE gateway_meta SET went_down_at = ?, recovered_first_hb_at = ? WHERE peer_id = 1")
    .run(Date.now() - 500_000, Date.now() - 30_000);
  gatewayHealth.evaluatePeer(1);
  assert.equal(gatewayHealth._hasRecoveryInterruptBeenLogged(1), false);
  gatewayHealth._markRecoveryInterruptLogged(1);
  db.prepare("UPDATE gateway_meta SET recovered_first_hb_at = ? WHERE peer_id = 1")
    .run(Date.now() - 30_000);
  gatewayHealth.evaluatePeer(1);
  assert.equal(gatewayHealth._hasRecoveryInterruptBeenLogged(1), true,
    'second reset within same outage must still report flag set');
});

test('newly added peer with no heartbeat: first HB → alive without cooldown', () => {
  const db = getDb();
  db.prepare("INSERT INTO peers (id, public_key, peer_type, allowed_ips) VALUES (1, 'pk1', 'gateway', '10.8.0.1/32')").run();
  db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, last_seen_at, alive, created_at) VALUES (1, 9876, 'h', 'e', NULL, 0, strftime('%s','now')*1000)").run();
  let result = gatewayHealth.evaluatePeer(1);
  assert.equal(result.transition, null);
  db.prepare("UPDATE gateway_meta SET last_seen_at = ? WHERE peer_id = 1").run(Date.now());
  result = gatewayHealth.evaluatePeer(1);
  assert.equal(result.transition, 'first_alive');
  assert.equal(db.prepare('SELECT alive FROM gateway_meta WHERE peer_id = 1').get().alive, 1);
});
