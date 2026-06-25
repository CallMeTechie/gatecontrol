'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
// NOTE: GC_CADDY_EMAIL is deliberately NOT set here. The portal must accept a verified
// public domain even with no ACME email configured (Let's Encrypt issuance needs none);
// these tests run with config.caddy.email === '' to prove that.
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

test('PUT accepts a verified public domain with NO GC_CADDY_EMAIL configured (ACME needs no account email)', async () => {
  assert.equal(require('../config/default').caddy.email, '', 'precondition: caddy email is unset for this test');
  getDb().prepare("INSERT INTO domains (domain, status) VALUES ('domaincaster.com','verified')").run();
  const agent = getAgent(); const csrf = getCsrf();
  await agent.put('/api/v1/settings/portal').set('X-CSRF-Token', csrf)
    .send({ base_domain: 'domaincaster.com', prefix: 'home' }).expect(200);
  const get = await agent.get('/api/v1/settings/portal').expect(200);
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

test('partial PUT preserves the other host field (no silent base_domain reset)', async () => {
  getDb().prepare("INSERT INTO domains (domain, status) VALUES ('domaincaster.com','verified')").run();
  const agent = getAgent(); const csrf = getCsrf();
  // First: set both base_domain and prefix
  await agent.put('/api/v1/settings/portal').set('X-CSRF-Token', csrf)
    .send({ base_domain: 'domaincaster.com', prefix: 'home' }).expect(200);
  // Then: update only prefix, omitting base_domain
  await agent.put('/api/v1/settings/portal').set('X-CSRF-Token', csrf)
    .send({ prefix: 'vpn' }).expect(200);
  // Verify: base_domain is still 'domaincaster.com', NOT reset to ''
  const get = await agent.get('/api/v1/settings/portal').expect(200);
  assert.equal(get.body.data.base_domain, 'domaincaster.com');
  assert.equal(get.body.data.effectiveHost, 'vpn.domaincaster.com');
});
