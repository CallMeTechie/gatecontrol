'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf;
beforeEach(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
});
afterEach(teardown);

test('GET /api/v1/gateway-pools/migration-candidates returns target_lan_host and target_lan_port', async () => {
  // Seed a gateway peer
  const db = require('../src/db/connection').getDb();
  db.prepare(`
    INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled)
    VALUES (42, 'test-gateway', 'pk42', 'gateway', '10.8.0.42/32', 1)
  `).run();

  // Seed a pinned gateway route (not in any pool)
  db.prepare(`
    INSERT INTO routes (domain, target_kind, target_peer_id, target_pool_id, target_lan_host, target_lan_port, target_ip, target_port, route_type, enabled)
    VALUES ('pinned.example.com', 'gateway', 42, NULL, '127.0.0.1', 8096, '127.0.0.1', 8080, 'http', 1)
  `).run();

  // Make authenticated request to migration-candidates endpoint
  const res = await agent.get('/api/v1/gateway-pools/migration-candidates');
  assert.equal(res.status, 200);
  assert.ok(res.body.routes, 'routes array present');
  assert.equal(res.body.routes.length, 1);

  const route = res.body.routes[0];
  assert.equal(route.domain, 'pinned.example.com');
  assert.equal(route.target_lan_host, '127.0.0.1', 'target_lan_host must be present');
  assert.equal(route.target_lan_port, 8096, 'target_lan_port must be present');
  assert.equal(route.target_ip, '127.0.0.1', 'legacy target_ip still present');
  assert.equal(route.target_port, 8080, 'legacy target_port still present');
  assert.equal(route.peer_name, 'test-gateway');
});
