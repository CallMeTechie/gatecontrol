'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');
let piholeConfig, license;
beforeEach(async () => { await setup(); piholeConfig = require('../src/services/piholeConfig'); license = require('../src/services/license'); license._overrideForTest({ pihole_integration: true }); });
afterEach(teardown);

test('DEFAULT.top_clients_count is 1000 (load reflects it when unset)', () => {
  assert.equal(piholeConfig.load().top_clients_count, 1000);
});
test('PUT persists top_clients_count, rejects out-of-range values', async () => {
  const agent = getAgent(); const csrf = getCsrf();
  await agent.put('/api/v1/settings/pihole').set('X-CSRF-Token', csrf).send({ enabled:true, sync_interval_sec:30, top_clients_count: 250, instances: [] }).expect(200);
  assert.equal(piholeConfig.load().top_clients_count, 250);
  // Out of range (1–5000) is a 400 with a field message, nothing is stored.
  for (const bad of [-5, 0, 99999]) {
    const r = await agent.put('/api/v1/settings/pihole').set('X-CSRF-Token', csrf).send({ enabled:true, top_clients_count: bad, instances: [] }).expect(400);
    assert.ok(r.body.fields && r.body.fields.top_clients_count, String(bad));
    assert.equal(piholeConfig.load().top_clients_count, 250);
  }
});
