// tests/smarthome_rules_api.test.js
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');

let app, agent, csrfToken, dev, rules;
before(async () => {
  ({ app, agent, csrfToken } = await setup());
  require('../src/services/license')._overrideForTest({ smarthome: true });
  dev = require('../src/services/smarthome/smarthomeDevices');
  rules = require('../src/services/smarthome/smarthomeRules');
  rules._setClientFactoryForTest(() => ({
    getRules: async () => ({ '1': {}, '2': {} }),
    createRule: async () => 'R1', updateRule: async () => {}, deleteRule: async () => {},
    createSchedule: async () => 'S1', deleteSchedule: async () => {}, createClipSensor: async () => 'C1', deleteClipSensor: async () => {},
  }));
});
after(async () => { await teardown(); });

test('POST /rules creates and GET /rules lists it', async () => {
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'K', enabled: true });
  const m = dev.upsertResource({ gateway_id: gw.id, deconz_id: '12', deconz_type: 'sensors', kind: 'sensor', name: 'M', capabilities: {} });
  const g = dev.upsertResource({ gateway_id: gw.id, deconz_id: '30', deconz_type: 'groups', kind: 'group', name: 'G', capabilities: { on: true } });
  const def = { triggers: [{ kind: 'motion', resourceId: m, event: 'detected' }], actions: [{ kind: 'group', resourceId: g, set: { on: true } }] };
  const created = await agent.post('/api/v1/smarthome/rules').set('x-csrf-token', csrfToken).send({ gateway_id: gw.id, name: 'Flur', definition: def }).expect(200);
  assert.ok(created.body.rule.id);
  const list = await agent.get(`/api/v1/smarthome/rules?gateway_id=${gw.id}`).expect(200);
  assert.equal(list.body.rules.length, 1);
  assert.equal(typeof list.body.limit_warn, 'boolean');
});

test('GET /rules/gateway-count returns totals', async () => {
  const gw = dev.createGateway({ name: 'GW2', route_id: null, apiKey: 'K', enabled: true });
  const res = await agent.get(`/api/v1/smarthome/rules/gateway-count?gateway_id=${gw.id}`).expect(200);
  assert.equal(res.body.total_rules, 2);
  assert.ok('external_rules' in res.body);
});

test('POST /rules without CSRF token → 403 (guard present on mutation)', async () => {
  const gw = dev.createGateway({ name: 'GWNX', route_id: null, apiKey: 'K', enabled: true });
  await agent.post('/api/v1/smarthome/rules').send({ gateway_id: gw.id, name: 'X', definition: {} }).expect(403);
});

test('PUT /rules/:id replaces name and definition', async () => {
  const gw = dev.createGateway({ name: 'GWP', route_id: null, apiKey: 'K', enabled: true });
  const m = dev.upsertResource({ gateway_id: gw.id, deconz_id: '12', deconz_type: 'sensors', kind: 'sensor', name: 'M', capabilities: {} });
  const g = dev.upsertResource({ gateway_id: gw.id, deconz_id: '30', deconz_type: 'groups', kind: 'group', name: 'G', capabilities: { on: true } });
  const def = { triggers: [{ kind: 'motion', resourceId: m, event: 'detected' }], actions: [{ kind: 'group', resourceId: g, set: { on: true } }] };
  const created = await agent.post('/api/v1/smarthome/rules').set('x-csrf-token', csrfToken).send({ gateway_id: gw.id, name: 'R', definition: def }).expect(200);
  const upd = await agent.put(`/api/v1/smarthome/rules/${created.body.rule.id}`).set('x-csrf-token', csrfToken).send({ name: 'R2', definition: def }).expect(200);
  assert.equal(upd.body.rule.name, 'R2');
});

test('POST /rules with invalid resource → 400', async () => {
  const gw = dev.createGateway({ name: 'GW3', route_id: null, apiKey: 'K', enabled: true });
  const def = { triggers: [{ kind: 'motion', resourceId: 99999, event: 'detected' }], actions: [{ kind: 'group', resourceId: 99999, set: { on: true } }] };
  await agent.post('/api/v1/smarthome/rules').set('x-csrf-token', csrfToken).send({ gateway_id: gw.id, name: 'bad', definition: def }).expect(400);
});

test('DELETE and enabled toggle work', async () => {
  const gw = dev.createGateway({ name: 'GW4', route_id: null, apiKey: 'K', enabled: true });
  const g = dev.upsertResource({ gateway_id: gw.id, deconz_id: '30', deconz_type: 'groups', kind: 'group', name: 'G', capabilities: { on: true } });
  const m = dev.upsertResource({ gateway_id: gw.id, deconz_id: '12', deconz_type: 'sensors', kind: 'sensor', name: 'M', capabilities: {} });
  const def = { triggers: [{ kind: 'motion', resourceId: m, event: 'detected' }], actions: [{ kind: 'group', resourceId: g, set: { on: true } }] };
  const created = await agent.post('/api/v1/smarthome/rules').set('x-csrf-token', csrfToken).send({ gateway_id: gw.id, name: 'R', definition: def }).expect(200);
  const id = created.body.rule.id;
  await agent.post(`/api/v1/smarthome/rules/${id}/enabled`).set('x-csrf-token', csrfToken).send({ enabled: false }).expect(200);
  await agent.delete(`/api/v1/smarthome/rules/${id}`).set('x-csrf-token', csrfToken).expect(200);
});
