'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let caddyConfig, gatewayPool, gatewayHealth, getDb;
beforeEach(async () => {
  await setup();
  caddyConfig = require('../src/services/caddyConfig');
  gatewayPool = require('../src/services/gatewayPool');
  gatewayHealth = require('../src/services/gatewayHealth');
  getDb = require('../src/db/connection').getDb;
  gatewayHealth._resetSnapshotCache();
});
afterEach(teardown);

function setupTwoGwPool(mode = 'failover', lb_policy = null) {
  const db = getDb();
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (10, 'gw-10', 'pk10', 'gateway', '10.8.0.10/32', 1)").run();
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (11, 'gw-11', 'pk11', 'gateway', '10.8.0.11/32', 1)").run();
  db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, last_seen_at, alive, created_at) VALUES (10, 9876, 'h', 'e', ?, 1, strftime('%s','now')*1000)").run(Date.now());
  db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, last_seen_at, alive, created_at) VALUES (11, 9876, 'h', 'e', ?, 1, strftime('%s','now')*1000)").run(Date.now());
  const poolId = gatewayPool.createPool({ name: 'P', mode, lb_policy, failback_cooldown_s: 60 });
  gatewayPool.addMember(poolId, 10, 100);
  gatewayPool.addMember(poolId, 11, 200);
  db.prepare(`
    INSERT INTO routes (domain, target_kind, target_pool_id, target_lan_host, target_lan_port, target_ip, target_port, route_type, enabled)
    VALUES ('a.test', 'gateway', ?, '10.0.1.50', 5000, '0.0.0.0', 5000, 'http', 1)
  `).run(poolId);
  gatewayHealth.evaluatePeer(10);
  gatewayHealth.evaluatePeer(11);
  return poolId;
}

test('failover-mode picks lowest-priority alive peer', async () => {
  setupTwoGwPool('failover');
  const cfg = await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  const json = JSON.stringify(cfg);
  assert.match(json, /10\.8\.0\.10:8080/);
  assert.doesNotMatch(json, /10\.8\.0\.11:8080/);
});

test('failover-mode skips down peer, picks next priority', async () => {
  setupTwoGwPool('failover');
  // Set last_seen_at older than 90s threshold so evaluatePeer keeps alive=0
  getDb().prepare("UPDATE gateway_meta SET alive = 0, went_down_at = ?, last_seen_at = ? WHERE peer_id = 10")
    .run(Date.now() - 200_000, Date.now() - 200_000);
  gatewayHealth._resetSnapshotCache();
  gatewayHealth.evaluatePeer(10);
  gatewayHealth.evaluatePeer(11);
  const cfg = await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  const json = JSON.stringify(cfg);
  assert.doesNotMatch(json, /10\.8\.0\.10:8080/);
  assert.match(json, /10\.8\.0\.11:8080/);
});

test('lb-mode includes all alive peers + selection_policy', async () => {
  setupTwoGwPool('load_balancing', 'round_robin');
  const cfg = await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  const json = JSON.stringify(cfg);
  assert.match(json, /10\.8\.0\.10:8080/);
  assert.match(json, /10\.8\.0\.11:8080/);
  assert.match(json, /round_robin/);
});

test('pool-outage renders 503 block (HTTP), not user-maintenance', async () => {
  setupTwoGwPool('failover');
  // last_seen_at older than threshold + alive=0 + went_down_at present
  // → evaluatePeer keeps alive=0 (no first_alive transition)
  getDb().prepare("UPDATE gateway_meta SET alive = 0, went_down_at = ?, last_seen_at = ?")
    .run(Date.now() - 200_000, Date.now() - 200_000);
  gatewayHealth._resetSnapshotCache();
  gatewayHealth.evaluatePeer(10);
  gatewayHealth.evaluatePeer(11);
  const cfg = await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  const json = JSON.stringify(cfg);
  assert.match(json, /static_response/);
  assert.match(json, /503/);
});

test('pin-route on down peer is unchanged (passes through)', async () => {
  const db = getDb();
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (10, 'gw-10', 'pk10', 'gateway', '10.8.0.10/32', 1)").run();
  db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, created_at) VALUES (10, 9876, 'h', 'e', 0, strftime('%s','now')*1000)").run();
  db.prepare(`
    INSERT INTO routes (domain, target_kind, target_peer_id, target_lan_host, target_lan_port, target_ip, target_port, route_type, enabled)
    VALUES ('pin.test', 'gateway', 10, '10.0.1.5', 5000, '0.0.0.0', 5000, 'http', 1)
  `).run();
  gatewayHealth._resetSnapshotCache();
  gatewayHealth.evaluatePeer(10);
  const cfg = await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  const json = JSON.stringify(cfg);
  assert.match(json, /10\.8\.0\.10:8080/);
});

// ── Implicit pool-failover for peer-pinned routes ────────────────────────
// Routes don't need target_pool_id to fail over — being a member of a pool
// is enough. When the pinned peer goes down, caddy resolves to the pool's
// next alive member.

test('implicit failover: pin-route on down peer reroutes to alive pool sibling', async () => {
  const db = getDb();
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (10, 'home', 'pk10', 'gateway', '10.8.0.10/32', 1)").run();
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (11, 'ds918', 'pk11', 'gateway', '10.8.0.11/32', 1)").run();
  // home offline, ds918 alive
  db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, went_down_at, last_seen_at, created_at) VALUES (10, 9876, 'h', 'e', 0, ?, ?, strftime('%s','now')*1000)")
    .run(Date.now() - 200_000, Date.now() - 200_000);
  db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, last_seen_at, created_at) VALUES (11, 9876, 'h', 'e', 1, ?, strftime('%s','now')*1000)")
    .run(Date.now());
  const poolId = gatewayPool.createPool({ name: 'P', mode: 'failover', failback_cooldown_s: 60 });
  gatewayPool.addMember(poolId, 10, 1); // home priority 1 (preferred)
  gatewayPool.addMember(poolId, 11, 2); // ds918 priority 2 (fallback)
  // Route is pinned to home — no target_pool_id
  db.prepare(`
    INSERT INTO routes (domain, target_kind, target_peer_id, target_lan_host, target_lan_port, target_ip, target_port, route_type, enabled)
    VALUES ('nas.test', 'gateway', 10, '10.0.1.5', 5000, '10.0.1.5', 5000, 'http', 1)
  `).run();
  gatewayHealth._resetSnapshotCache();
  gatewayHealth.evaluatePeer(10);
  gatewayHealth.evaluatePeer(11);
  const cfg = await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  const json = JSON.stringify(cfg);
  // Pinned peer (home) is offline → expect ds918 as upstream
  assert.match(json, /10\.8\.0\.11:8080/, 'expected failover to ds918');
  assert.doesNotMatch(json, /10\.8\.0\.10:8080/, 'expected NOT to use offline home');
});

test('implicit failover: pin-route on alive peer uses the peer directly (no pool detour)', async () => {
  const db = getDb();
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (10, 'home', 'pk10', 'gateway', '10.8.0.10/32', 1)").run();
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (11, 'ds918', 'pk11', 'gateway', '10.8.0.11/32', 1)").run();
  db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, last_seen_at, created_at) VALUES (10, 9876, 'h', 'e', 1, ?, strftime('%s','now')*1000)").run(Date.now());
  db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, last_seen_at, created_at) VALUES (11, 9876, 'h', 'e', 1, ?, strftime('%s','now')*1000)").run(Date.now());
  const poolId = gatewayPool.createPool({ name: 'P', mode: 'failover', failback_cooldown_s: 60 });
  gatewayPool.addMember(poolId, 10, 1);
  gatewayPool.addMember(poolId, 11, 2);
  db.prepare(`
    INSERT INTO routes (domain, target_kind, target_peer_id, target_lan_host, target_lan_port, target_ip, target_port, route_type, enabled)
    VALUES ('nas.test', 'gateway', 11, '10.0.1.5', 5000, '10.0.1.5', 5000, 'http', 1)
  `).run();
  gatewayHealth._resetSnapshotCache();
  gatewayHealth.evaluatePeer(10);
  gatewayHealth.evaluatePeer(11);
  const cfg = await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  const json = JSON.stringify(cfg);
  // Route pinned to ds918 (alive) → expect ds918 directly, no detour through home
  assert.match(json, /10\.8\.0\.11:8080/);
  assert.doesNotMatch(json, /10\.8\.0\.10:8080/);
});

test('implicit failover: down peer not in any pool stays pinned (no orphan rerouting)', async () => {
  const db = getDb();
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (10, 'lone', 'pk10', 'gateway', '10.8.0.10/32', 1)").run();
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (11, 'unrelated', 'pk11', 'gateway', '10.8.0.11/32', 1)").run();
  db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, went_down_at, last_seen_at, created_at) VALUES (10, 9876, 'h', 'e', 0, ?, ?, strftime('%s','now')*1000)")
    .run(Date.now() - 200_000, Date.now() - 200_000);
  db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, last_seen_at, created_at) VALUES (11, 9876, 'h', 'e', 1, ?, strftime('%s','now')*1000)")
    .run(Date.now());
  // Pool with peer 11 only — peer 10 is NOT in the pool
  const poolId = gatewayPool.createPool({ name: 'P', mode: 'failover', failback_cooldown_s: 60 });
  gatewayPool.addMember(poolId, 11, 1);
  db.prepare(`
    INSERT INTO routes (domain, target_kind, target_peer_id, target_lan_host, target_lan_port, target_ip, target_port, route_type, enabled)
    VALUES ('lone.test', 'gateway', 10, '10.0.1.5', 5000, '10.0.1.5', 5000, 'http', 1)
  `).run();
  gatewayHealth._resetSnapshotCache();
  gatewayHealth.evaluatePeer(10);
  gatewayHealth.evaluatePeer(11);
  const cfg = await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  const json = JSON.stringify(cfg);
  // Pinned peer offline, NOT in pool → stays on offline peer (no cross-pool rerouting)
  assert.match(json, /10\.8\.0\.10:8080/);
  assert.doesNotMatch(json, /10\.8\.0\.11:8080/);
});
