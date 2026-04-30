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
