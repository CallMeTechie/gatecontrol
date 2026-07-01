// tests/smarthome_portal_api.test.js
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let app, agent, csrfToken;
before(async () => {
  ({ app, agent, csrfToken } = await setup());
  require('../src/services/license')._overrideForTest({ smarthome: true });
});
after(async () => { await teardown(); });

// NOTE: the default test agent is an authenticated admin session → portalLoggedIn true,
// portalOwnerId = admin user id. Assign ownership to that same admin id.
test('GET /portal/smarthome returns only owned controllable resources (redacted)', async () => {
  const dev = require('../src/services/smarthome/smarthomeDevices');
  const owners = require('../src/services/smarthome/smarthomeOwners');
  const adminId = getDb().prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get().id;
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'K', enabled: true });
  const owned = dev.upsertResource({ gateway_id: gw.id, deconz_id: '1', deconz_type: 'lights', kind: 'light', name: 'Mine', capabilities: { on: true }, state: { on: false } });
  dev.upsertResource({ gateway_id: gw.id, deconz_id: '2', deconz_type: 'lights', kind: 'light', name: 'NotMine', capabilities: { on: true } });
  owners.setOwners(owned, [adminId]);
  const res = await agent.get('/api/v1/portal/smarthome').expect(200);
  assert.ok(res.body.data && Array.isArray(res.body.data.devices));
  const names = res.body.data.devices.map((d) => d.name);
  assert.ok(names.includes('Mine'));
  assert.ok(!names.includes('NotMine'));
  const d = res.body.data.devices.find((x) => x.name === 'Mine');
  assert.equal(d.gateway_id, undefined);   // redacted
  assert.equal(d.deconz_id, undefined);    // redacted
  assert.ok('state' in d);
});

test('POST /portal/smarthome/:id/state on a non-owned resource → 403', async () => {
  const dev = require('../src/services/smarthome/smarthomeDevices');
  const gw = dev.createGateway({ name: 'GW2', route_id: null, apiKey: 'K', enabled: true });
  const other = dev.upsertResource({ gateway_id: gw.id, deconz_id: '7', deconz_type: 'lights', kind: 'light', name: 'Other', capabilities: { on: true } });
  await agent.post(`/api/v1/portal/smarthome/${other}/state`).set('x-csrf-token', csrfToken).send({ patch: { on: true } }).expect(403);
});

test('POST /portal/smarthome/:id/state without login → login_required', async () => {
  const supertest = require('supertest');
  const anon = supertest(app);
  const dev = require('../src/services/smarthome/smarthomeDevices');
  const gw = dev.createGateway({ name: 'GWA', route_id: null, apiKey: 'K', enabled: true });
  const rid = dev.upsertResource({ gateway_id: gw.id, deconz_id: '3', deconz_type: 'lights', kind: 'light', name: 'L', capabilities: {} });
  const r = await anon.post(`/api/v1/portal/smarthome/${rid}/state`).send({ patch: { on: true } }).expect(200);
  assert.equal(r.body.reason, 'login_required');
});

test('GET /portal/smarthome returns owned sensors in sensors[] (redacted); non-owned sensor excluded', async () => {
  const dev = require('../src/services/smarthome/smarthomeDevices');
  const owners = require('../src/services/smarthome/smarthomeOwners');
  const adminId = getDb().prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get().id;
  const gw = dev.createGateway({ name: 'GWsens', route_id: null, apiKey: 'K', enabled: true });
  const mine = dev.upsertResource({ gateway_id: gw.id, deconz_id: '10', deconz_type: 'sensors', kind: 'sensor', name: 'MyTemp', capabilities: {}, state: { type: 'temperature', value: 21.5 } });
  dev.upsertResource({ gateway_id: gw.id, deconz_id: '11', deconz_type: 'sensors', kind: 'sensor', name: 'NotMine', capabilities: {}, state: { type: 'temperature', value: 9 } });
  owners.setOwners(mine, [adminId]);
  const res = await agent.get('/api/v1/portal/smarthome').expect(200);
  assert.ok(res.body.data && Array.isArray(res.body.data.sensors));
  const names = res.body.data.sensors.map((s) => s.name);
  assert.ok(names.includes('MyTemp'));
  assert.ok(!names.includes('NotMine'));
  const s = res.body.data.sensors.find((x) => x.name === 'MyTemp');
  assert.equal(s.state.type, 'temperature');
  assert.equal(s.state.value, 21.5);
  assert.equal(s.gateway_id, undefined);   // redigiert
  assert.equal(s.deconz_id, undefined);    // redigiert
});

test('GET /portal/smarthome: owner with ONLY a sensor gets sensors[] filled, not no_data', async () => {
  const dev = require('../src/services/smarthome/smarthomeDevices');
  const owners = require('../src/services/smarthome/smarthomeOwners');
  const adminId = getDb().prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get().id;
  const gw = dev.createGateway({ name: 'GWonly', route_id: null, apiKey: 'K', enabled: true });
  const s1 = dev.upsertResource({ gateway_id: gw.id, deconz_id: '12', deconz_type: 'sensors', kind: 'sensor', name: 'Solo', capabilities: {}, state: { type: 'lightlevel', value: 42 } });
  owners.setOwners(s1, [adminId]);
  const res = await agent.get('/api/v1/portal/smarthome').expect(200);
  assert.ok(res.body.data, 'data must not be null for a sensor-only owner');
  assert.ok(res.body.data.sensors.some((x) => x.name === 'Solo'));
});

test('POST /portal/smarthome/:id/state on an owned SENSOR is rejected 400', async () => {
  const dev = require('../src/services/smarthome/smarthomeDevices');
  const owners = require('../src/services/smarthome/smarthomeOwners');
  const adminId = getDb().prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get().id;
  const gw = dev.createGateway({ name: 'GWctl', route_id: null, apiKey: 'K', enabled: true });
  const sensor = dev.upsertResource({ gateway_id: gw.id, deconz_id: '13', deconz_type: 'sensors', kind: 'sensor', name: 'Ctl', capabilities: {}, state: { type: 'temperature', value: 20 } });
  owners.setOwners(sensor, [adminId]);
  await agent.post(`/api/v1/portal/smarthome/${sensor}/state`).set('x-csrf-token', csrfToken).send({ patch: { on: true } }).expect(400);
});
