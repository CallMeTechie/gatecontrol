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

test('GET /resources includes owners array', async () => {
  const dev = require('../src/services/smarthome/smarthomeDevices');
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'K', enabled: true });
  dev.upsertResource({ gateway_id: gw.id, deconz_id: '1', deconz_type: 'lights', kind: 'light', name: 'L', capabilities: {} });
  const res = await agent.get('/api/v1/smarthome/resources').expect(200);
  assert.ok(Array.isArray(res.body.resources));
  assert.ok(Array.isArray(res.body.resources[0].owners));
});

test('PUT /resources/:id/owners sets owners; unknown user → 400; non-assignable → 400', async () => {
  const dev = require('../src/services/smarthome/smarthomeDevices');
  const gw = dev.createGateway({ name: 'GW2', route_id: null, apiKey: 'K', enabled: true });
  const rid = dev.upsertResource({ gateway_id: gw.id, deconz_id: '9', deconz_type: 'lights', kind: 'light', name: 'L9', capabilities: {} });
  const sid = dev.upsertResource({ gateway_id: gw.id, deconz_id: '8', deconz_type: 'sensors', kind: 'switch', name: 'S8', capabilities: {} });
  const uid = Number(getDb().prepare("INSERT INTO users (username, password_hash, role) VALUES ('owner1', 'x', 'user')").run().lastInsertRowid);
  const ok = await agent.put(`/api/v1/smarthome/resources/${rid}/owners`).set('x-csrf-token', csrfToken).send({ userIds: [uid] }).expect(200);
  assert.deepEqual(ok.body.owners.map((o) => o.username), ['owner1']);
  await agent.put(`/api/v1/smarthome/resources/${rid}/owners`).set('x-csrf-token', csrfToken).send({ userIds: [99999] }).expect(400);
  await agent.put(`/api/v1/smarthome/resources/${sid}/owners`).set('x-csrf-token', csrfToken).send({ userIds: [uid] }).expect(400);
});

test('PUT /resources/:id/owners with non-array userIds → 400', async () => {
  const dev = require('../src/services/smarthome/smarthomeDevices');
  const gw = dev.createGateway({ name: 'GW3', route_id: null, apiKey: 'K', enabled: true });
  const rid = dev.upsertResource({ gateway_id: gw.id, deconz_id: '4', deconz_type: 'lights', kind: 'light', name: 'L4', capabilities: {} });
  await agent.put(`/api/v1/smarthome/resources/${rid}/owners`).set('x-csrf-token', csrfToken).send({ userIds: 'nope' }).expect(400);
});
