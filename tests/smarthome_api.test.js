'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');

let app, agent, csrfToken;
before(async () => {
  ({ app, agent, csrfToken } = await setup());
  require('../src/services/license')._overrideForTest({ smarthome: true });
});
after(async () => { await teardown(); });

test('GET /api/v1/smarthome/gateways returns array for admin', async () => {
  const res = await agent.get('/api/v1/smarthome/gateways').expect(200);
  assert.ok(Array.isArray(res.body.gateways));
});

test('GET /api/v1/smarthome/resources returns array', async () => {
  const res = await agent.get('/api/v1/smarthome/resources').expect(200);
  assert.ok(Array.isArray(res.body.resources));
});

test('feature disabled → 403', async () => {
  const license = require('../src/services/license');
  try {
    license._overrideForTest({ smarthome: false });
    await agent.get('/api/v1/smarthome/gateways').expect(403);
  } finally {
    license._overrideForTest({ smarthome: true });
  }
});

test('state on unknown resource → 404', async () => {
  await agent.post('/api/v1/smarthome/resources/99999/state')
    .set('x-csrf-token', csrfToken).send({ on: true }).expect(404);
});

test('POST /gateways/:id/test on unknown gateway → 404', async () => {
  await agent.post('/api/v1/smarthome/gateways/99999/test')
    .set('x-csrf-token', csrfToken).send({}).expect(404);
});
