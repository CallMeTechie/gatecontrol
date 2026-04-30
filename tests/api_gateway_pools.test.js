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

test('POST /api/v1/gateway-pools creates pool', async () => {
  const res = await agent.post('/api/v1/gateway-pools')
    .set('X-CSRF-Token', csrf)
    .send({ name: 'Heimnetz', mode: 'failover', failback_cooldown_s: 300 });
  assert.equal(res.status, 201);
  assert.ok(res.body.id);
  assert.equal(res.body.name, 'Heimnetz');
});

test('POST rejects without gateway_pools feature', async () => {
  const license = require('../src/services/license');
  license._overrideForTest({ gateway_pools: false });
  const res = await agent.post('/api/v1/gateway-pools')
    .set('X-CSRF-Token', csrf)
    .send({ name: 'X', mode: 'failover', failback_cooldown_s: 60 });
  assert.equal(res.status, 403);
});

test('POST rejects load_balancing mode without gateway_pool_load_balancing', async () => {
  const license = require('../src/services/license');
  license._overrideForTest({
    gateway_pools: true, gateway_pool_failover: true,
    gateway_pool_load_balancing: false, gateway_pools_limit: 10,
  });
  const res = await agent.post('/api/v1/gateway-pools')
    .set('X-CSRF-Token', csrf)
    .send({ name: 'L', mode: 'load_balancing', lb_policy: 'round_robin', failback_cooldown_s: 60 });
  assert.equal(res.status, 403);
});

test('POST rejects when pool count exceeds gateway_pools_limit', async () => {
  const license = require('../src/services/license');
  license._overrideForTest({ gateway_pools: true, gateway_pool_failover: true, gateway_pools_limit: 1 });
  await agent.post('/api/v1/gateway-pools').set('X-CSRF-Token', csrf)
    .send({ name: 'A', mode: 'failover', failback_cooldown_s: 60 });
  const res = await agent.post('/api/v1/gateway-pools').set('X-CSRF-Token', csrf)
    .send({ name: 'B', mode: 'failover', failback_cooldown_s: 60 });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /limit/);
});

test('GET /api/v1/gateway-pools lists all pools', async () => {
  await agent.post('/api/v1/gateway-pools').set('X-CSRF-Token', csrf)
    .send({ name: 'A', mode: 'failover', failback_cooldown_s: 60 });
  const res = await agent.get('/api/v1/gateway-pools');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
});

test('DELETE rejects when pool is referenced by routes', async () => {
  const create = await agent.post('/api/v1/gateway-pools').set('X-CSRF-Token', csrf)
    .send({ name: 'A', mode: 'failover', failback_cooldown_s: 60 });
  const poolId = create.body.id;
  const db = require('../src/db/connection').getDb();
  db.prepare(`
    INSERT INTO routes (domain, target_kind, target_pool_id, target_ip, target_port, route_type, enabled)
    VALUES ('x.test', 'gateway', ?, '0.0.0.0', 5000, 'http', 1)
  `).run(poolId);
  const res = await agent.delete(`/api/v1/gateway-pools/${poolId}`).set('X-CSRF-Token', csrf);
  assert.equal(res.status, 409);
});

test('license downgrade disables pools', async () => {
  const license = require('../src/services/license');
  await agent.post('/api/v1/gateway-pools').set('X-CSRF-Token', csrf)
    .send({ name: 'A', mode: 'failover', failback_cooldown_s: 60 });
  license._overrideForTest({ gateway_pools: false });
  await license.enforceLimits();
  const pool = require('../src/db/connection').getDb()
    .prepare("SELECT enabled FROM gateway_pools WHERE name = 'A'").get();
  assert.equal(pool.enabled, 0);
});
