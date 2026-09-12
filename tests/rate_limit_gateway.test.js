'use strict';
// Regression: gateways and the admin's browser behind the same NAT used to
// share one per-IP apiLimiter bucket. Dashboard use spent the gateways'
// (session-less, 10x lower) budget → heartbeats 429 → gateway declared
// offline → 502 on all its routes. The gateway API now has its own limiter,
// keyed per gateway and mounted after requireGateway.
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');
const config = require('../config/default');
const gateways = require('../src/services/gateways');

let app, agent;
test.before(async () => {
  const c = await setup(); app = c.app; agent = c.agent;
  require('../src/services/license')._overrideForTest({ gateway_peers: -1 });
});
test.after(() => teardown());

// Session-less, like the real gateway companion; same source IP as `agent`.
function gwCheck(apiToken) {
  return supertest(app)
    .get('/api/v1/gateway/config/check?hash=sha256:stale')
    .set('Authorization', `Bearer ${apiToken}`);
}

test('dashboard traffic from the same IP does not starve gateway heartbeats', async () => {
  const gw = await gateways.createGateway({ name: 'gw-nat' });
  config.auth.rateLimitApi = 2; // session limit 20, session-less limit 2
  try {
    let dashboard429 = false;
    for (let i = 0; i < 30 && !dashboard429; i++) {
      const r = await agent.get('/api/v1/tags');
      if (r.status === 429) dashboard429 = true;
    }
    assert.equal(dashboard429, true, 'precondition: dashboard bucket must be exhausted');

    for (let i = 0; i < 5; i++) {
      const r = await gwCheck(gw.apiToken);
      assert.equal(r.status, 200, `gateway request ${i} should be 200, got ${r.status}`);
    }
  } finally {
    config.auth.rateLimitApi = 100000;
  }
});

test('gateway budget is per gateway, not shared across gateways on one IP', async () => {
  const a = await gateways.createGateway({ name: 'gw-a' });
  const b = await gateways.createGateway({ name: 'gw-b' });
  config.auth.rateLimitGateway = 3;
  try {
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await gwCheck(a.apiToken)).status);
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);

    const r = await gwCheck(b.apiToken);
    assert.equal(r.status, 200, 'gateway B must keep its own budget');
    assert.equal(r.headers['ratelimit-limit'], '3');
  } finally {
    config.auth.rateLimitGateway = 100000;
  }
});

test('unauthenticated gateway requests are rejected before the limiter', async () => {
  config.auth.rateLimitGateway = 1;
  try {
    for (let i = 0; i < 3; i++) {
      await supertest(app).get('/api/v1/gateway/config/check').expect(401);
    }
  } finally {
    config.auth.rateLimitGateway = 100000;
  }
});
