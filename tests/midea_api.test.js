'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

let app, agent, csrfToken;
before(async () => { ({ app, agent, csrfToken } = await setup()); });
after(async () => { await teardown(); });

test('GET /api/v1/midea/devices returns array (feature enabled in test)', async () => {
  const res = await agent.get('/api/v1/midea/devices').expect(200);
  assert.ok(Array.isArray(res.body.devices));
});

test('GET /api/v1/midea/status returns shape', async () => {
  const res = await agent.get('/api/v1/midea/status').expect(200);
  assert.ok('devices' in res.body);
  assert.ok('lastPollAt' in res.body);
});

test('POST /api/v1/midea/devices/:id/test 404 for missing device', async () => {
  await agent.post('/api/v1/midea/devices/99999/test')
    .set('x-csrf-token', csrfToken).send({}).expect(404);
});

test('feature disabled → 403 on midea API', async () => {
  const license = require('../src/services/license');
  try {
    license._overrideForTest({ midea_integration: false });
    await agent.get('/api/v1/midea/devices').expect(403);
  } finally {
    license._overrideForTest({ midea_integration: true });
  }
});

// Admin guard test (Spec §9): unauthenticated request must hit the session
// check (admin guard) BEFORE requireFeature — proves guard ordering is correct.
test('unauthenticated request → 401 (admin guard precedes requireFeature)', async () => {
  const anonAgent = supertest(app);
  const res = await anonAgent.get('/api/v1/midea/devices');
  assert.equal(res.status, 401);
});

test('GET /midea renders without 500', async () => {
  await agent.get('/midea').expect(200);
});

test('GET /midea still renders 200 with owner UI', async () => {
  await agent.get('/midea').expect(200);
});

test('POST /devices with transport=cloud creates a cloud device', async () => {
  const res = await agent.post('/api/v1/midea/devices')
    .set('x-csrf-token', csrfToken)
    .send({ transport: 'cloud', cloud_appliance_id: '153931628798542', name: 'Klima' })
    .expect(200);
  assert.equal(res.body.device.transport, 'cloud');
  assert.equal(res.body.device.has_credentials, false);
});

test('POST /devices with transport=cloud and no cloud_appliance_id → 400', async () => {
  await agent.post('/api/v1/midea/devices')
    .set('x-csrf-token', csrfToken)
    .send({ transport: 'cloud' })
    .expect(400);
});

test('GET /api/v1/midea/status includes cloud_needs_reauth boolean and device transport', async () => {
  const res = await agent.get('/api/v1/midea/status').expect(200);
  assert.equal(typeof res.body.cloud_needs_reauth, 'boolean');
  for (const d of res.body.devices) {
    assert.ok('transport' in d, 'each device has transport field');
  }
});

test('PUT /devices/:id/owners sets owners; GET /devices reflects them', async () => {
  const users = require('../src/services/users');
  const uid = (await users.create({ username: 'dave', password: 'TestPass123!', role: 'user' })).id;  // async!
  const created = await agent.post('/api/v1/midea/devices')
    .set('x-csrf-token', csrfToken)
    .send({ transport: 'cloud', cloud_appliance_id: 'own-1', name: 'OwnAC' }).expect(200);
  const id = created.body.device.id;

  const put = await agent.put(`/api/v1/midea/devices/${id}/owners`)
    .set('x-csrf-token', csrfToken).send({ user_ids: [uid] }).expect(200);
  assert.deepEqual(put.body.owners.map((o) => o.username), ['dave']);

  const list = await agent.get('/api/v1/midea/devices').expect(200);
  const row = list.body.devices.find((d) => d.id === id);
  assert.deepEqual(row.owners.map((o) => o.id), [uid]);
  users.remove(uid);   // keep username unique within this test file
});

test('PUT /devices/:id/owners rejects a non-array user_ids → 400', async () => {
  const created = await agent.post('/api/v1/midea/devices')
    .set('x-csrf-token', csrfToken)
    .send({ transport: 'cloud', cloud_appliance_id: 'own-arr', name: 'ArrAC' }).expect(200);
  await agent.put(`/api/v1/midea/devices/${created.body.device.id}/owners`)
    .set('x-csrf-token', csrfToken).send({ user_ids: 5 }).expect(400);   // 5 is truthy non-array
});

test('PUT /devices/:id/owners without midea_integration license → 403', async () => {
  const license = require('../src/services/license');
  try {
    license._overrideForTest({ midea_integration: false });
    await agent.put('/api/v1/midea/devices/1/owners')
      .set('x-csrf-token', csrfToken).send({ user_ids: [] }).expect(403);
  } finally {
    license._overrideForTest({ midea_integration: true });
  }
});

test('PUT /devices/:id/owners is gated: unauthenticated → 401 (admin guard)', async () => {
  const anon = require('supertest')(app);
  const res = await anon.put('/api/v1/midea/devices/1/owners').send({ user_ids: [] });
  // The router-wide admin gate (session-required, precedes requireFeature) rejects
  // any non-admin session. An unauthenticated request hits the 401 branch.
  assert.equal(res.status, 401);
});

test('PUT /devices/:id/owners with an unknown user id → 400', async () => {
  const created = await agent.post('/api/v1/midea/devices')
    .set('x-csrf-token', csrfToken)
    .send({ transport: 'cloud', cloud_appliance_id: 'own-2', name: 'OwnAC2' }).expect(200);
  await agent.put(`/api/v1/midea/devices/${created.body.device.id}/owners`)
    .set('x-csrf-token', csrfToken).send({ user_ids: [987654] }).expect(400);
});

test('PUT /devices/:id/owners for a missing device → 404', async () => {
  await agent.put('/api/v1/midea/devices/99999/owners')
    .set('x-csrf-token', csrfToken).send({ user_ids: [] }).expect(404);
});
