'use strict';

// The gateway-failover slider is the only server-rendered settings value
// (`value="{{ settings.gateway_down_threshold_s or 90 }}"`). The settings
// template var was never injected into the page render, so the slider always
// showed the hardcoded default 90 regardless of the persisted value — the save
// round-trip looked broken in the UI. This verifies the render reflects the DB.
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

beforeEach(async () => { await setup(); });
afterEach(teardown);

test('settings page renders the persisted gateway_down_threshold_s on the slider', async () => {
  const agent = getAgent();
  const csrf = getCsrf();
  await agent.put('/api/v1/settings/gateway-failover')
    .set('X-CSRF-Token', csrf)
    .send({ gateway_down_threshold_s: 150 })
    .expect(200);
  const page = await agent.get('/settings').expect(200);
  // slider must reflect the saved value, not the hardcoded default 90
  assert.match(page.text, /id="gw-down-threshold"[^>]*value="150"/);
  assert.doesNotMatch(page.text, /id="gw-down-threshold"[^>]*value="90"/);
});
