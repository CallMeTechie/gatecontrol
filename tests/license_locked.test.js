'use strict';

// Licence feedback (docs/feature-release-b.md §11): GET /api/v1/license
// carries locked: { <feature>: 'plan' | 'not_in_token' | 'unlicensed' } for
// every locked boolean feature.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');

let agent, license;

before(async () => {
  await setup();
  agent = getAgent();
  license = require('../src/services/license');
});

after(() => { license._applyLicenseForTest(null); teardown(); });

test('unlicensed community mode: every locked boolean feature is "unlicensed", limits never appear', async () => {
  license._applyLicenseForTest(null);
  const r = await agent.get('/api/v1/license');
  assert.equal(r.status, 200);
  assert.equal(r.body.unlicensed, true);
  const locked = r.body.locked;
  assert.equal(locked.waf, 'unlicensed');
  assert.equal(locked.route_auth, 'unlicensed');
  assert.ok(!('traffic_history' in locked), 'true features are not locked');
  assert.ok(!('http_routes' in locked) && !('vpn_peers' in locked), 'limits are not features');
  assert.ok(Object.values(locked).every((v) => v === 'unlicensed'));
});

test('token applied: false in the token → plan, missing in the token → not_in_token', async () => {
  const features = { ...license.COMMUNITY_FALLBACK, route_auth: true, waf: false };
  delete features.gateway_scan_egress;   // a key the licence server does not deliver yet
  license._applyLicenseForTest({ plan: 'pro', features });
  const r = await agent.get('/api/v1/license');
  assert.equal(r.status, 200);
  assert.equal(r.body.plan, 'pro');
  const locked = r.body.locked;
  assert.equal(locked.waf, 'plan');
  assert.equal(locked.gateway_scan_egress, 'not_in_token');
  assert.ok(!('route_auth' in locked));
  assert.ok(!Object.values(locked).includes('unlicensed'));
});

test('lockedFeatures() is sorted and only carries the three reasons', () => {
  const locked = license.lockedFeatures();
  const keys = Object.keys(locked);
  assert.deepEqual(keys, [...keys].sort());
  for (const v of Object.values(locked)) assert.ok(['plan', 'not_in_token', 'unlicensed'].includes(v));
});
