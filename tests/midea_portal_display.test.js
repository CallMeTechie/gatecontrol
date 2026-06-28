'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getAgent } = require('./helpers/setup');
const config = require('../config/default');
const HOME_HOST = `home.${config.dns.domain}`;

let app, getDb, license, midea, mideaDevices, mideaOwners, adminId, foreignUser, dA, dB, dForeign;
beforeEach(async () => {
  await setup();
  app = require('../src/app').createApp();
  getDb = require('../src/db/connection').getDb;
  license = require('../src/services/license');
  license.hasFeature = () => true;
  midea = require('../src/services/midea');
  mideaDevices = require('../src/services/midea/mideaDevices');
  mideaOwners = require('../src/services/midea/mideaOwners');
  midea.getState = async (id) => ({ indoorTemp: 21, targetTemp: 22, power: true, mode: 'cool', _id: id });
  adminId = getDb().prepare("SELECT id FROM users WHERE username='admin'").get().id; // getAgent() = this user
  foreignUser = getDb().prepare("INSERT INTO users (username,password_hash,role) VALUES ('bob','x','admin')").run().lastInsertRowid;
  dA = mideaDevices.createDevice({ name: 'Wohnzimmer', device_sn: 'sn-a' }).id;
  dB = mideaDevices.createDevice({ name: 'Schlafzimmer', device_sn: 'sn-b' }).id;
  dForeign = mideaDevices.createDevice({ name: 'Fremd', device_sn: 'sn-f' }).id;
  mideaOwners.setOwners(dA, [adminId]);
  mideaOwners.setOwners(dB, [adminId]);
  mideaOwners.setOwners(dForeign, [foreignUser]);
});
afterEach(() => teardown());

test('logged-in owner sees only own devices + state + loggedIn flag', async () => {
  const r = await getAgent().get('/api/v1/portal/midea').expect(200);
  const names = r.body.data.devices.map((d) => d.name).sort();
  assert.deepEqual(names, ['Schlafzimmer', 'Wohnzimmer']);   // NOT 'Fremd'
  assert.equal(r.body.data.loggedIn, true);
  assert.equal(r.body.data.devices[0].state.indoorTemp, 21);
  assert.ok(!('cloud_appliance_id' in r.body.data.devices[0]));  // redacted
});
test('IDOR: foreign user_id in body/query is ignored', async () => {
  const r = await getAgent().get('/api/v1/portal/midea?user_id=' + foreignUser).send({ user_id: foreignUser }).expect(200);
  const names = r.body.data.devices.map((d) => d.name);
  assert.ok(!names.includes('Fremd'));
});
test('license off → unavailable', async () => {
  license.hasFeature = () => false;
  const r = await getAgent().get('/api/v1/portal/midea').expect(200);
  assert.equal(r.body.data, null); assert.equal(r.body.reason, 'unavailable');
});
test('widget off → 404', async () => {
  require('../src/services/settings').set('portal.widget.midea', '0');
  await getAgent().get('/api/v1/portal/midea').expect(404);
});
test('owner with no devices → no_data', async () => {
  mideaOwners.setOwners(dA, []); mideaOwners.setOwners(dB, []);
  const r = await getAgent().get('/api/v1/portal/midea').expect(200);
  assert.equal(r.body.data, null); assert.equal(r.body.reason, 'no_data');
});
test('not logged in, trust off → no_owner', async () => {
  const r = await supertest(app).get('/api/v1/portal/midea').set('Host', HOME_HOST).expect(200);
  assert.equal(r.body.data, null); assert.equal(r.body.reason, 'no_owner');
});
test('GET /:id/state for own device returns state', async () => {
  const r = await getAgent().get(`/api/v1/portal/midea/${dA}/state`).expect(200);
  assert.equal(r.body.data.state.power, true);
});
test('GET /:id/state offline passes through (not data:null)', async () => {
  midea.getState = async () => ({ offline: true });
  const r = await getAgent().get(`/api/v1/portal/midea/${dA}/state`).expect(200);
  assert.equal(r.body.data.state.offline, true);
});
test('GET /:id/state for foreign device → 403', async () => {
  await getAgent().get(`/api/v1/portal/midea/${dForeign}/state`).expect(403);
});
test('GET /:id/state widget off → 404', async () => {
  require('../src/services/settings').set('portal.widget.midea', '0');
  await getAgent().get(`/api/v1/portal/midea/${dA}/state`).expect(404);
});
test('GET /:id/state license off → unavailable', async () => {
  license.hasFeature = () => false;
  const r = await getAgent().get(`/api/v1/portal/midea/${dA}/state`).expect(200);
  assert.equal(r.body.data, null); assert.equal(r.body.reason, 'unavailable');
});
test('GET /:id/state unauthenticated (no trust) → 403', async () => {
  const r = await supertest(app).get(`/api/v1/portal/midea/${dA}/state`).set('Host', HOME_HOST).expect(403);
  assert.equal(r.body.error, 'MIDEA_NOT_OWNER');
});
