'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let gateways, gatewayPool, getDb;
beforeEach(async () => {
  await setup();
  gateways = require('../src/services/gateways');
  gatewayPool = require('../src/services/gatewayPool');
  getDb = require('../src/db/connection').getDb;
});
afterEach(teardown);

function insertGatewayPeer(db, id) {
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (?, ?, ?, 'gateway', '10.8.0.' || ? || '/32', 1)").run(id, `gw-${id}`, `pk${id}`, id);
  db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, created_at) VALUES (?, 9876, 'h', 'e', 1, strftime('%s','now')*1000)").run(id);
}

test('getGatewayConfig returns pool routes for member peers', () => {
  const db = getDb();
  insertGatewayPeer(db, 10);
  insertGatewayPeer(db, 11);
  const poolId = gatewayPool.createPool({ name: 'P', mode: 'failover', failback_cooldown_s: 60 });
  gatewayPool.addMember(poolId, 10, 100);
  gatewayPool.addMember(poolId, 11, 200);
  db.prepare(`
    INSERT INTO routes (domain, target_kind, target_pool_id, target_lan_host, target_lan_port, target_ip, target_port, route_type, enabled)
    VALUES ('nas.test', 'gateway', ?, '10.0.1.50', 5000, '0.0.0.0', 5000, 'http', 1)
  `).run(poolId);

  const cfg11 = gateways.getGatewayConfig(11);
  assert.ok(cfg11.routes.find(r => r.domain === 'nas.test'),
    'pool route must appear in config for member peer 11');

  insertGatewayPeer(db, 99);
  const cfg99 = gateways.getGatewayConfig(99);
  assert.equal(cfg99.routes.find(r => r.domain === 'nas.test'), undefined);
});

test('pin-route still works (target_peer_id, no target_pool_id)', () => {
  const db = getDb();
  insertGatewayPeer(db, 10);
  db.prepare(`
    INSERT INTO routes (domain, target_kind, target_peer_id, target_lan_host, target_lan_port, target_ip, target_port, route_type, enabled)
    VALUES ('pin.test', 'gateway', 10, '10.0.1.5', 5000, '0.0.0.0', 5000, 'http', 1)
  `).run();
  const cfg = gateways.getGatewayConfig(10);
  assert.ok(cfg.routes.find(r => r.domain === 'pin.test'));
});

// Implicit-failover requires the pool sibling to also know the route — without
// this the frontend caddy correctly picks the alive sibling as upstream but
// the sibling's companion has no config for the domain and 404s.
test('pool sibling sees pin-routes of other pool members', () => {
  const db = getDb();
  insertGatewayPeer(db, 10); // home
  insertGatewayPeer(db, 11); // ds918 (sibling)
  const poolId = gatewayPool.createPool({ name: 'P', mode: 'failover', failback_cooldown_s: 60 });
  gatewayPool.addMember(poolId, 10, 1);
  gatewayPool.addMember(poolId, 11, 2);
  // Route pinned to peer 10 (home) — NOT a target_pool_id route
  db.prepare(`
    INSERT INTO routes (domain, target_kind, target_peer_id, target_lan_host, target_lan_port, target_ip, target_port, route_type, enabled)
    VALUES ('nas-of-home.test', 'gateway', 10, '192.168.1.5', 5001, '10.8.0.10', 5001, 'http', 1)
  `).run();
  // L4 sibling route as well
  db.prepare(`
    INSERT INTO routes (domain, target_kind, target_peer_id, target_lan_host, target_lan_port, target_ip, target_port, route_type, l4_listen_port, enabled)
    VALUES ('rdp-of-home.test', 'gateway', 10, '192.168.1.6', 3389, '10.8.0.10', 3389, 'l4', 13389, 1)
  `).run();

  // Peer 10 (the pinned one) sees its own routes — basic sanity
  const cfg10 = gateways.getGatewayConfig(10);
  assert.ok(cfg10.routes.find(r => r.domain === 'nas-of-home.test'));
  assert.ok(cfg10.l4_routes.find(r => r.listen_port === 13389));

  // Peer 11 (the sibling) MUST also see the routes — without this the
  // failover redirect from the frontend caddy hits a companion that
  // doesn't know the domain.
  const cfg11 = gateways.getGatewayConfig(11);
  assert.ok(cfg11.routes.find(r => r.domain === 'nas-of-home.test'),
    'sibling peer 11 must receive pin-routes of pool member peer 10');
  assert.ok(cfg11.l4_routes.find(r => r.listen_port === 13389),
    'sibling peer 11 must receive L4 pin-routes of pool member peer 10');

  // A non-member peer must NOT see those routes (no cross-pool leakage)
  insertGatewayPeer(db, 99);
  const cfg99 = gateways.getGatewayConfig(99);
  assert.equal(cfg99.routes.find(r => r.domain === 'nas-of-home.test'), undefined);
});
