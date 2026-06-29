'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getAgent } = require('./helpers/setup');
const config = require('../config/default');
const HOME_HOST = `home.${config.dns.domain}`;

let app, getDb, license, midea, mideaDevices, mideaOwners, adminId, foreignUser, dA, dForeign, lastSet;
beforeEach(async () => {
  await setup();
  app = require('../src/app').createApp();
  getDb = require('../src/db/connection').getDb;
  license = require('../src/services/license'); license.hasFeature = () => true;
  midea = require('../src/services/midea');
  mideaDevices = require('../src/services/midea/mideaDevices');
  mideaOwners = require('../src/services/midea/mideaOwners');
  lastSet = null;
  midea.setState = async (id, patch) => { lastSet = { id, patch }; return { indoorTemp: 21, targetTemp: patch.targetTemp || 22, power: patch.power !== undefined ? patch.power : true, mode: patch.mode || 'cool' }; };
  adminId = getDb().prepare("SELECT id FROM users WHERE username='admin'").get().id;
  foreignUser = getDb().prepare("INSERT INTO users (username,password_hash,role) VALUES ('bob','x','admin')").run().lastInsertRowid;
  dA = mideaDevices.createDevice({ name: 'Wohnzimmer', device_sn: 'sn-a' }).id;
  dForeign = mideaDevices.createDevice({ name: 'Fremd', device_sn: 'sn-f' }).id;
  mideaOwners.setOwners(dA, [adminId]);
  mideaOwners.setOwners(dForeign, [foreignUser]);
});
afterEach(() => teardown());

test('logged-in owner controls own device → setState called + state returned', async () => {
  const r = await getAgent().post(`/api/v1/portal/midea/${dA}/state`).send({ patch: { power: false, targetTemp: 19, mode: 'heat' } }).expect(200);
  assert.equal(lastSet.id, dA);
  assert.deepEqual(lastSet.patch, { power: false, targetTemp: 19, mode: 'heat' });
  assert.equal(r.body.data.state.mode, 'heat');
});
test('not logged in → login_required (trust never controls)', async () => {
  const r = await supertest(app).post(`/api/v1/portal/midea/${dA}/state`).set('Host', HOME_HOST).send({ patch: { power: true } }).expect(200);
  assert.equal(r.body.data, null); assert.equal(r.body.reason, 'login_required');
  assert.equal(lastSet, null);   // setState never called
});
test('foreign device → 403', async () => {
  await getAgent().post(`/api/v1/portal/midea/${dForeign}/state`).send({ patch: { power: true } }).expect(403);
  assert.equal(lastSet, null);
});
test('invalid mode → 400', async () => {
  await getAgent().post(`/api/v1/portal/midea/${dA}/state`).send({ patch: { mode: 'turbo' } }).expect(400);
});
test('out-of-range targetTemp → 400', async () => {
  await getAgent().post(`/api/v1/portal/midea/${dA}/state`).send({ patch: { targetTemp: 40 } }).expect(400);
});
test('empty patch → 400', async () => {
  await getAgent().post(`/api/v1/portal/midea/${dA}/state`).send({ patch: {} }).expect(400);
});
test('non-boolean power → 400', async () => {
  await getAgent().post(`/api/v1/portal/midea/${dA}/state`).send({ patch: { power: 'on' } }).expect(400);
});
test('device offline → unavailable', async () => {
  midea.setState = async () => ({ offline: true });
  const r = await getAgent().post(`/api/v1/portal/midea/${dA}/state`).send({ patch: { power: true } }).expect(200);
  assert.equal(r.body.data, null); assert.equal(r.body.reason, 'unavailable');
});
test('license off → unavailable', async () => {
  license.hasFeature = () => false;
  const r = await getAgent().post(`/api/v1/portal/midea/${dA}/state`).send({ patch: { power: true } }).expect(200);
  assert.equal(r.body.data, null); assert.equal(r.body.reason, 'unavailable');
});
test('widget off → 404', async () => {
  require('../src/services/settings').set('portal.widget.midea', '0');
  await getAgent().post(`/api/v1/portal/midea/${dA}/state`).send({ patch: { power: true } }).expect(404);
});
test('logged-in owner sets fanSpeed (valid snap value) → forwarded', async () => {
  const r = await getAgent().post(`/api/v1/portal/midea/${dA}/state`).send({ patch: { fanSpeed: 60 } }).expect(200);
  assert.deepEqual(lastSet.patch, { fanSpeed: 60 });
  assert.equal(r.body.data.state.mode, 'cool');
});
test('fanSpeed auto (102) → forwarded', async () => {
  await getAgent().post(`/api/v1/portal/midea/${dA}/state`).send({ patch: { fanSpeed: 102 } }).expect(200);
  assert.deepEqual(lastSet.patch, { fanSpeed: 102 });
});
test('turbo + eco booleans → forwarded', async () => {
  await getAgent().post(`/api/v1/portal/midea/${dA}/state`).send({ patch: { turbo: true, eco: false } }).expect(200);
  assert.deepEqual(lastSet.patch, { turbo: true, eco: false });
});
test('fanSpeed min percent (1) → forwarded', async () => {
  await getAgent().post(`/api/v1/portal/midea/${dA}/state`).send({ patch: { fanSpeed: 1 } }).expect(200);
  assert.deepEqual(lastSet.patch, { fanSpeed: 1 });
});
test('fanSpeed max percent (100) → forwarded', async () => {
  await getAgent().post(`/api/v1/portal/midea/${dA}/state`).send({ patch: { fanSpeed: 100 } }).expect(200);
  assert.deepEqual(lastSet.patch, { fanSpeed: 100 });
});
test('fanSpeed high (80) → forwarded', async () => {
  await getAgent().post(`/api/v1/portal/midea/${dA}/state`).send({ patch: { fanSpeed: 80 } }).expect(200);
  assert.deepEqual(lastSet.patch, { fanSpeed: 80 });
});
test('fanSpeed non-stop (50) → 400', async () => {
  await getAgent().post(`/api/v1/portal/midea/${dA}/state`).send({ patch: { fanSpeed: 50 } }).expect(400);
  assert.equal(lastSet, null);
});
test('fanSpeed out of set (999) → 400', async () => {
  await getAgent().post(`/api/v1/portal/midea/${dA}/state`).send({ patch: { fanSpeed: 999 } }).expect(400);
});
test('turbo non-boolean → 400', async () => {
  await getAgent().post(`/api/v1/portal/midea/${dA}/state`).send({ patch: { turbo: 'yes' } }).expect(400);
});
