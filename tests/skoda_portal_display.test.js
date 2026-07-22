'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const supertest = require('supertest');
const { setup, teardown, getAgent } = require('./helpers/setup');
const config = require('../config/default');
const license = require('../src/services/license');
const geocode = require('../src/services/skoda/skodaGeocode');

const HOME_HOST = `home.${config.dns.domain}`;
let app; let accounts; let owners; let getDb; let adminId; let foreignId;

const STATE = { locked: true, soc: 74, rangeKm: 310, position: { lat: 50.9413, lon: 6.9583 },
  detail: {}, charging: {}, climate: {}, health: { warnings: [] }, maintenance: {} };

// Full reset per test (mirrors tests/midea_portal_display.test.js) — fresh DB +
// app + login, so a test that flips a widget flag or licence never bleeds over.
beforeEach(async () => {
  await setup();
  app = require('../src/app').createApp();
  accounts = require('../src/services/skoda/skodaAccounts');
  owners = require('../src/services/skoda/skodaOwners');
  ({ getDb } = require('../src/db/connection'));
  license.hasFeature = () => true;
  geocode._resetForTest();
  geocode.reverseGeocode = async () => 'Teststraße 1, Köln'; // no real geocoding in tests
  adminId = getDb().prepare("SELECT id FROM users WHERE role='admin'").get().id;
  foreignId = getDb().prepare("INSERT INTO users (username, password_hash, role) VALUES ('frau','x','user')").run().lastInsertRowid;
});
afterEach(async () => { await teardown(); });

function seed(vin, name, ownerId, image) {
  const acc = accounts.createAccount({ email: `${vin}@x.y`, password: 'pw' });
  getDb().prepare("INSERT INTO skoda_vehicles (account_id, vin, name, model, state_json, fetched_at, image, image_url) VALUES (?,?,?,?,?,datetime('now'),?,?)")
    .run(acc.id, vin, name, name, JSON.stringify(STATE), image || null, image ? 'u' : null);
  const id = getDb().prepare('SELECT id FROM skoda_vehicles WHERE vin=?').get(vin).id;
  owners.setOwners(id, [ownerId]);
  return id;
}

test('GET /portal/skoda returns only the logged-in owner\'s vehicles, redacted', async () => {
  const agent = await getAgent(); // logged-in admin
  const mine = seed('TMBMINE', 'Elroq', adminId);
  seed('TMBFOREIGN', 'Enyaq', foreignId);
  const res = await agent.get('/api/v1/portal/skoda').set('Host', HOME_HOST);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.vehicles.length, 1);
  assert.equal(res.body.data.vehicles[0].name, 'Elroq');
  assert.equal(res.body.data.vehicles[0].id, mine);
  assert.equal(res.body.data.loggedIn, true);
  const body = JSON.stringify(res.body);
  assert.ok(!body.includes('TMBMINE') && !body.includes('TMBFOREIGN')); // vin redacted
  assert.ok(!body.includes('@x.y')); // no account email
});

test('IDOR: user_id in query/body is ignored (foreign vehicle never returned)', async () => {
  const agent = await getAgent();
  seed('TMBMINE', 'Elroq', adminId);
  seed('TMBFOREIGN', 'Enyaq', foreignId);
  const res = await agent.get(`/api/v1/portal/skoda?user_id=${foreignId}`).set('Host', HOME_HOST).send({ user_id: foreignId });
  assert.equal(res.body.data.vehicles.length, 1);
  assert.equal(res.body.data.vehicles[0].name, 'Elroq');
});

test('no_data when the logged-in user owns no vehicles', async () => {
  const agent = await getAgent();
  seed('TMBFOREIGN', 'Enyaq', foreignId);
  const res = await agent.get('/api/v1/portal/skoda').set('Host', HOME_HOST);
  assert.equal(res.body.data, null);
  assert.equal(res.body.reason, 'no_data');
});

test('unavailable when the licence lacks skoda_integration', async () => {
  const agent = await getAgent();
  seed('TMBMINE', 'Elroq', adminId);
  license.hasFeature = () => false;
  const res = await agent.get('/api/v1/portal/skoda').set('Host', HOME_HOST);
  assert.equal(res.body.data, null);
  assert.equal(res.body.reason, 'unavailable');
});

test('no_owner for an unauthenticated portal request', async () => {
  seed('TMBMINE', 'Elroq', adminId);
  const res = await supertest(app).get('/api/v1/portal/skoda').set('Host', HOME_HOST);
  assert.equal(res.status, 200);
  assert.equal(res.body.data, null);
  assert.equal(res.body.reason, 'no_owner');
});

test('image route is owner-gated: owner gets png, non-owner gets 403', async () => {
  const agent = await getAgent();
  const mine = seed('TMBMINE', 'Elroq', adminId, Buffer.from('89504e47', 'hex'));
  const foreign = seed('TMBFOREIGN', 'Enyaq', foreignId, Buffer.from('89504e47', 'hex'));
  const okRes = await agent.get(`/api/v1/portal/skoda/vehicles/${mine}/image`).set('Host', HOME_HOST);
  assert.equal(okRes.status, 200);
  assert.match(okRes.headers['content-type'], /image\/png/);
  const forbidden = await agent.get(`/api/v1/portal/skoda/vehicles/${foreign}/image`).set('Host', HOME_HOST);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error, 'SKODA_NOT_OWNER');
});
