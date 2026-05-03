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

test('lb-mode adds passive health checks when pool has 2+ alive members', async () => {
  setupTwoGwPool('load_balancing', 'round_robin');
  const cfg = await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  // health_checks.passive should be present on the reverse_proxy handler
  // for the lb route — drives caddy-side circuit-breaking.
  const json = JSON.stringify(cfg);
  assert.match(json, /"passive"/);
  assert.match(json, /"max_fails":3/);
  assert.match(json, /"fail_duration":"30s"/);
});

test('lb-mode L4 route renders multiple upstreams + selection_policy', async () => {
  const db = getDb();
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (20, 'gw-20', 'pk20', 'gateway', '10.8.0.20/32', 1)").run();
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (21, 'gw-21', 'pk21', 'gateway', '10.8.0.21/32', 1)").run();
  db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, last_seen_at, alive, created_at) VALUES (20, 9876, 'h', 'e', ?, 1, strftime('%s','now')*1000)").run(Date.now());
  db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, last_seen_at, alive, created_at) VALUES (21, 9876, 'h', 'e', ?, 1, strftime('%s','now')*1000)").run(Date.now());
  const poolId = gatewayPool.createPool({ name: 'L4P', mode: 'load_balancing', lb_policy: 'round_robin', failback_cooldown_s: 60 });
  gatewayPool.addMember(poolId, 20, 100);
  gatewayPool.addMember(poolId, 21, 200);
  // L4 route bound to the pool
  db.prepare(`
    INSERT INTO routes (domain, target_kind, target_pool_id, target_lan_host, target_lan_port, target_ip, target_port, route_type, l4_listen_port, l4_protocol, l4_tls_mode, enabled)
    VALUES ('l4.test', 'gateway', ?, '10.0.1.50', 3389, '0.0.0.0', 3389, 'l4', 13389, 'tcp', 'none', 1)
  `).run(poolId);
  gatewayHealth._resetSnapshotCache();
  gatewayHealth.evaluatePeer(20);
  gatewayHealth.evaluatePeer(21);
  const cfg = await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  const json = JSON.stringify(cfg);
  // Both upstreams present
  assert.match(json, /10\.8\.0\.20:13389/);
  assert.match(json, /10\.8\.0\.21:13389/);
  // L4 selection policy
  assert.match(json, /"round_robin"/);
});

test('http server config includes trusted_proxies for ip_hash to work behind LB', async () => {
  setupTwoGwPool('load_balancing', 'ip_hash');
  const cfg = await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  const srv0 = cfg.apps?.http?.servers?.srv0;
  assert.ok(srv0, 'srv0 must exist');
  assert.equal(srv0.trusted_proxies?.source, 'static');
  assert.ok(Array.isArray(srv0.trusted_proxies?.ranges));
  assert.deepEqual(srv0.client_ip_headers, ['X-Forwarded-For']);
});

