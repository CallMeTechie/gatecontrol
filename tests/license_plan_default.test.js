'use strict';

// Licence defaults for new features (docs/feature-next-package.md §S2.3):
// a BOOLEAN feature the token does not carry at all counts as enabled on every
// PAID plan (everything but `community`); community keeps COMMUNITY_FALLBACK.
// Numeric limits are never derived. GET /api/v1/license reports per feature
// source: 'token' | 'plan_default' | 'community'.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');

let agent;
let license;

/** A token payload without the given keys (a licence server that lags behind). */
function tokenWithout(keys, overrides = {}) {
  const features = { ...license.COMMUNITY_FALLBACK, ...overrides };
  for (const k of keys) delete features[k];
  return features;
}

before(async () => { await setup(); agent = getAgent(); license = require('../src/services/license'); });
after(() => { license._applyLicenseForTest(null); teardown(); });

test('planDefaults: booleans missing from the token, paid plans only, never limits', () => {
  const token = tokenWithout(['waf', 'gateway_scan_egress']);
  const derived = license.planDefaults('pro', token);
  assert.deepEqual(Object.keys(derived).sort(), ['gateway_scan_egress', 'waf']);
  assert.equal(derived.waf, true);
  assert.deepEqual(license.planDefaults('community', token), {}, 'community keeps the fallback');
  assert.deepEqual(license.planDefaults('', token), {});
  // A limit that is missing is never invented.
  const noLimits = license.planDefaults('pro', tokenWithout(['vpn_peers', 'http_routes', 'gateway_pools_limit']));
  for (const k of ['vpn_peers', 'http_routes', 'gateway_pools_limit']) assert.ok(!(k in noLimits), k);
});

test('paid plan: a missing boolean is on, an explicit false stays off, limits unchanged', async () => {
  license._applyLicenseForTest({ plan: 'pro', features: tokenWithout(['waf'], { route_auth: false, vpn_peers: 25, http_routes: 10 }) });
  assert.equal(license.hasFeature('waf'), true, 'missing from the token → on');
  assert.equal(license.hasFeature('route_auth'), false, 'false in the token stays off');
  assert.equal(license.getFeatureLimit('vpn_peers'), 25);
  assert.equal(license.getFeatureLimit('http_routes'), 10);

  const r = await agent.get('/api/v1/license');
  assert.equal(r.status, 200);
  assert.equal(r.body.features.waf, true);
  assert.equal(r.body.source.waf, 'plan_default');
  assert.equal(r.body.source.route_auth, 'token');
  assert.equal(r.body.source.vpn_peers, 'token');
  assert.ok(!('waf' in r.body.locked), 'a plan default is not a locked feature');
  assert.equal(r.body.locked.route_auth, 'plan');
});

test('community plan with a token: nothing is derived', async () => {
  license._applyLicenseForTest({ plan: 'community', features: tokenWithout(['waf'], { vpn_peers: 3 }) });
  assert.equal(license.hasFeature('waf'), false);
  const r = await agent.get('/api/v1/license');
  assert.equal(r.body.features.waf, false);
  assert.equal(r.body.source.waf, 'community');
  assert.equal(r.body.locked.waf, 'not_in_token');
});

test('unlicensed community mode: every source is community', async () => {
  license._applyLicenseForTest(null);
  const r = await agent.get('/api/v1/license');
  assert.equal(r.body.unlicensed, true);
  const sources = new Set(Object.values(r.body.source));
  assert.deepEqual([...sources], ['community']);
  assert.equal(r.body.features.waf, false);
});

test('source covers every known feature key and only the three values', async () => {
  license._applyLicenseForTest({ plan: 'business', features: tokenWithout(['waf', 'smarthome']) });
  const r = await agent.get('/api/v1/license');
  const src = r.body.source;
  for (const k of Object.keys(license.COMMUNITY_FALLBACK)) assert.ok(k in src, 'source for ' + k);
  for (const v of Object.values(src)) assert.ok(['token', 'plan_default', 'community'].includes(v), v);
  assert.deepEqual(Object.keys(src), [...Object.keys(src)].sort(), 'sorted');
  assert.equal(src.waf, 'plan_default');
  assert.equal(src.smarthome, 'plan_default');
});

test('the licence hint knows the source (pure helper)', () => {
  const L = require('../public/js/license-hint.js');
  assert.deepEqual(L.SOURCES, ['token', 'plan_default', 'community']);
  assert.equal(L.sourceOf({ source: { waf: 'plan_default' } }, 'waf'), 'plan_default');
  assert.equal(L.sourceOf({ source: { waf: 'token' } }, 'waf'), 'token');
  assert.equal(L.sourceOf({ source: { waf: 'made up' } }, 'waf'), null);
  assert.equal(L.sourceOf({}, 'waf'), null);
  assert.equal(L.sourceOf(null, 'waf'), null);
});
