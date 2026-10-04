'use strict';

// The gateway-failover slider used to be the one server-rendered settings
// value and once always showed the default 90. The settings page reads every
// value from the APIs now (no DB read in the page handler): GET returns what
// PUT stored, and an out-of-range value is a 400 with a field message.
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

beforeEach(async () => { await setup(); });
afterEach(teardown);

test('GET /settings/gateway-failover returns the persisted gateway_down_threshold_s', async () => {
  const agent = getAgent();
  const csrf = getCsrf();
  await agent.put('/api/v1/settings/gateway-failover')
    .set('X-CSRF-Token', csrf)
    .send({ gateway_down_threshold_s: 150 })
    .expect(200);
  const res = await agent.get('/api/v1/settings/gateway-failover').expect(200);
  assert.equal(res.body.data.gateway_down_threshold_s, 150);
  const bad = await agent.put('/api/v1/settings/gateway-failover').set('X-CSRF-Token', csrf).send({ gateway_down_threshold_s: 5 }).expect(400);
  assert.ok(bad.body.fields.gateway_down_threshold_s);
  const page = await agent.get('/settings').expect(200);
  assert.match(page.text, /id="st-gw-down" data-st-field="gw-down" min="30" max="600" step="10"/);
});
