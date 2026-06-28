'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');
const license = require('../src/services/license');

before(async () => {
  await setup();
  license._overrideForTest({ api_tokens: true });
});
after(() => teardown());

async function makeToken(name, scopes) {
  const agent = getAgent();
  const csrf = getCsrf();
  const res = await agent
    .post('/api/v1/tokens')
    .set('x-csrf-token', csrf)
    .send({ name, scopes })
    .expect(201);
  return res.body.token;
}

test('permissions response includes portalUrl https string when portal enabled (default on)', async () => {
  const app = getAgent().app;
  const token = await makeToken('pao-test-1', ['client']);
  const res = await supertest(app)
    .get('/api/v1/client/permissions')
    .set('X-API-Key', token)
    .expect(200);
  assert.ok(res.body.ok);
  assert.equal(typeof res.body.portalUrl, 'string', 'portalUrl should be a string when portal enabled');
  assert.match(res.body.portalUrl, /^https:\/\/.+/, 'portalUrl should start with https://');
});

test('permissions response includes autoOpenPortal true when portal enabled and autoappear defaults on', async () => {
  const app = getAgent().app;
  const token = await makeToken('pao-test-2', ['client']);
  const res = await supertest(app)
    .get('/api/v1/client/permissions')
    .set('X-API-Key', token)
    .expect(200);
  assert.equal(res.body.autoOpenPortal, true, 'autoOpenPortal should be true with defaults');
});

test('autoOpenPortal is false when portal.autoappear toggled off; portalUrl still set', async () => {
  const settings = require('../src/services/settings');
  settings.set('portal.autoappear', '0');
  try {
    const app = getAgent().app;
    const token = await makeToken('pao-test-3', ['client']);
    const res = await supertest(app)
      .get('/api/v1/client/permissions')
      .set('X-API-Key', token)
      .expect(200);
    assert.equal(res.body.autoOpenPortal, false, 'autoOpenPortal should be false when autoappear=0');
    assert.equal(typeof res.body.portalUrl, 'string', 'portalUrl should still be set when portal enabled');
  } finally {
    settings.set('portal.autoappear', '1');
  }
});
