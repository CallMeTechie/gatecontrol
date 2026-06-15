'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');
const license = require('../src/services/license');

before(async () => {
  await setup();
  // Flat features object (matches _overrideForTest signature). api_tokens needed to mint tokens.
  license._overrideForTest({ pihole_integration: true, remote_desktop: true, api_tokens: true });
});
after(() => teardown());

async function makeToken(scopes) {
  const agent = getAgent();
  const csrf = getCsrf();
  const res = await agent
    .post('/api/v1/tokens')
    .set('x-csrf-token', csrf)
    .send({ name: `perm-${scopes.join('-')}`, scopes })
    .expect(201);
  return res.body.token;
}

test('permissions.pihole reflects the pihole read scope (real route)', async () => {
  const app = getAgent().app;
  const withRead = await makeToken(['client', 'pihole']);
  const without = await makeToken(['client']);

  const r1 = await supertest(app).get('/api/v1/client/permissions').set('X-API-Key', withRead).expect(200);
  assert.equal(r1.body.permissions.pihole, true);
  assert.equal(r1.body.permissions.piholeControl, false);

  const r2 = await supertest(app).get('/api/v1/client/permissions').set('X-API-Key', without).expect(200);
  assert.equal(r2.body.permissions.pihole, false);
  assert.equal(r2.body.permissions.piholeControl, false);
});

test('permissions.piholeControl requires pihole:control (single source via checkScope)', async () => {
  const app = getAgent().app;
  const ctrl = await makeToken(['client', 'pihole', 'pihole:control']);
  const r = await supertest(app).get('/api/v1/client/permissions').set('X-API-Key', ctrl).expect(200);
  assert.equal(r.body.permissions.pihole, true);
  assert.equal(r.body.permissions.piholeControl, true);
});

test('token without pihole scope is denied on pihole reads (enforcement already exists)', async () => {
  const app = getAgent().app;
  const without = await makeToken(['client']);
  const res = await supertest(app).get('/api/v1/pihole/summary').set('X-API-Key', without);
  assert.equal(res.status, 403);
});
