'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf, getDb;
beforeEach(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
  getDb = require('../src/db/connection').getDb;
});
afterEach(teardown);

test('pin-route create with target_peer_id behaves identically post-feature', async () => {
  const db = getDb();
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips) VALUES (1, 'gw-1', 'pk1', 'gateway', '10.8.0.1/32')").run();
  const res = await agent.post('/api/v1/routes')
    .set('X-CSRF-Token', csrf)
    .send({
      domain: 'a.test', target_kind: 'gateway', target_peer_id: 1,
      target_lan_host: '10.0.1.5', target_lan_port: 5000,
      target_ip: '0.0.0.0', target_port: 5000, route_type: 'http',
    });
  assert.equal(res.status, 201);
  assert.equal(res.body.route.target_peer_id, 1);
  assert.equal(res.body.route.target_pool_id, null);
});

test('cannot set both target_peer_id AND target_pool_id', async () => {
  const db = getDb();
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips) VALUES (1, 'gw-1', 'pk1', 'gateway', '10.8.0.1/32')").run();
  const gp = require('../src/services/gatewayPool');
  const poolId = gp.createPool({ name: 'P', mode: 'failover', failback_cooldown_s: 60 });
  gp.addMember(poolId, 1, 100);
  const res = await agent.post('/api/v1/routes')
    .set('X-CSRF-Token', csrf)
    .send({
      domain: 'a.test', target_kind: 'gateway', target_peer_id: 1, target_pool_id: poolId,
      target_lan_host: '10.0.1.5', target_lan_port: 5000,
      target_ip: '0.0.0.0', target_port: 5000, route_type: 'http',
    });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /conflicting_target/);
});
