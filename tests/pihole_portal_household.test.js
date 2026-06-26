// tests/pihole_portal_household.test.js
'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
// setup MUST be required before config/default so NODE_ENV=test is set before
// config/default.js is evaluated (it throws on missing GC_SECRET in non-test mode).
const { setup, teardown, getAgent } = require('./helpers/setup');
const config = require('../config/default');
const HOME_HOST = `home.${config.dns.domain}`;
let app, getDb, pihole, license;
beforeEach(async () => {
  await setup();
  app = require('../src/app').createApp();
  getDb = require('../src/db/connection').getDb;
  pihole = require('../src/services/pihole'); license = require('../src/services/license');
  license.hasFeature = () => true;
});
afterEach(() => { teardown(); });
function cacheWith(summary){ return { instances:[{id:'p1',connected:true}], attribution:'per_peer', lastSyncAt:1750000000000, summary }; }

test('logged-in → global summary numbers', async () => {
  pihole.getCache = () => cacheWith({ queries:{ total:1000, blocked:250, percent:25 }, clients:{ active:7 } });
  const r = await getAgent().get('/api/v1/portal/pihole/household').expect(200);
  assert.equal(r.body.data.total, 1000);
  assert.equal(r.body.data.blocked, 250);
  assert.equal(r.body.data.blockedPct, 25);
  assert.equal(r.body.data.activeClients, 7);
  assert.deepEqual(Object.keys(r.body.data).sort(), ['activeClients','asOf','blocked','blockedPct','total']);
});
test('not logged in → login_required (even with trust on)', async () => {
  require('../src/services/settings').set('portal.trust_owner_mapping','1');
  pihole.getCache = () => cacheWith({ queries:{ total:1000, blocked:250 }, clients:{ active:7 } });
  const r = await supertest(app).get('/api/v1/portal/pihole/household').set('Host', HOME_HOST).expect(200);
  assert.equal(r.body.data, null); assert.equal(r.body.reason, 'login_required');
});
test('summary null (pre first sync) → unavailable', async () => {
  pihole.getCache = () => cacheWith(null);
  const r = await getAgent().get('/api/v1/portal/pihole/household').expect(200);
  assert.equal(r.body.data, null); assert.equal(r.body.reason, 'unavailable');
});
test('feature off → unavailable', async () => {
  license.hasFeature = () => false;
  const r = await getAgent().get('/api/v1/portal/pihole/household').expect(200);
  assert.equal(r.body.data, null); assert.equal(r.body.reason, 'unavailable');
});
