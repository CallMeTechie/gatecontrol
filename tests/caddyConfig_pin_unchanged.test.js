'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let caddyConfig, getDb;
beforeEach(async () => {
  await setup();
  caddyConfig = require('../src/services/caddyConfig');
  getDb = require('../src/db/connection').getDb;
});
afterEach(teardown);

test('pin-route caddy block uses gateway tunnel-IP single-upstream', async () => {
  const db = getDb();
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (1, 'gw-1', 'pk1', 'gateway', '10.8.0.1/32', 1)").run();
  db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, created_at) VALUES (1, 9876, 'h', 'e', 1, strftime('%s','now')*1000)").run();
  db.prepare(`
    INSERT INTO routes (domain, target_kind, target_peer_id, target_lan_host, target_lan_port, target_ip, target_port, route_type, enabled)
    VALUES ('pin.test', 'gateway', 1, '10.0.1.5', 5000, '0.0.0.0', 5000, 'http', 1)
  `).run();
  const cfg = await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  const json = JSON.stringify(cfg);
  assert.match(json, /10\.8\.0\.1:8080/);
  assert.doesNotMatch(json, /selection_policy/);
});
