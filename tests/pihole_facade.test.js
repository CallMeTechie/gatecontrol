'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
let pihole;
beforeEach(async () => { await setup(); pihole = require('../src/services/pihole'); });
afterEach(teardown);

test('getCache returns a cache object with expected keys', () => {
  const c = pihole.getCache();
  for (const k of ['summary','topClients','blocking','instances','attribution']) assert.ok(k in c, `missing ${k}`);
});

test('setBlocking persists desired-state', () => {
  pihole.setBlocking(false, 300);
  const d = pihole.getDesired();
  assert.equal(d.enabled, false);
  assert.ok(d.timer_ends_at > 0);
});

test('testDns on an unreachable port returns {reachable:false} without throwing', async () => {
  const result = await pihole.testDns('127.0.0.1', 19953);
  assert.equal(result.reachable, false);
  assert.ok('blocking' in result, 'blocking key must be present');
});
