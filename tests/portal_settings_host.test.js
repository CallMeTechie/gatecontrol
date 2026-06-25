'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let getDb;
beforeEach(async () => { await setup(); getDb = require('../src/db/connection').getDb; });
afterEach(teardown);

test('PUT accepts a verified base domain + prefix and GET reflects it', async () => {
  getDb().prepare("INSERT INTO domains (domain, status) VALUES ('domaincaster.com','verified')").run();
  const agent = getAgent(); const csrf = getCsrf();
  await agent.put('/api/v1/settings/portal').set('X-CSRF-Token', csrf)
    .send({ base_domain: 'domaincaster.com', prefix: 'home' }).expect(200);
  const get = await agent.get('/api/v1/settings/portal').expect(200);
  assert.equal(get.body.data.base_domain, 'domaincaster.com');
  assert.equal(get.body.data.effectiveHost, 'home.domaincaster.com');
  assert.equal(get.body.data.isPublic, true);
});

test('PUT rejects an unverified base domain (400)', async () => {
  const agent = getAgent(); const csrf = getCsrf();
  await agent.put('/api/v1/settings/portal').set('X-CSRF-Token', csrf)
    .send({ base_domain: 'unverified.com', prefix: 'home' }).expect(400);
});

test('widget toggles still work (no regression)', async () => {
  const agent = getAgent(); const csrf = getCsrf();
  await agent.put('/api/v1/settings/portal').set('X-CSRF-Token', csrf).send({ enabled: false }).expect(200);
  const get = await agent.get('/api/v1/settings/portal').expect(200);
  assert.equal(get.body.data.enabled, false);
});
