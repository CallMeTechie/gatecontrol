'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let domains;
beforeEach(async () => {
  await setup();
  domains = require('../src/services/domains');
  domains._setResolverForTest(async (h, f) => (f === 4 ? ['198.51.100.7'] : []));
  require('../src/services/settings').set('server.public_ip', '198.51.100.7');
});
afterEach(teardown);

test('POST adds + verifies a domain; GET lists it (admin session)', async () => {
  const agent = getAgent(); const csrf = getCsrf();
  const post = await agent.post('/api/v1/settings/domains').set('X-CSRF-Token', csrf)
    .send({ domain: 'home.example.com' }).expect(200);
  assert.equal(post.body.data.status, 'verified');
  const get = await agent.get('/api/v1/settings/domains').expect(200);
  assert.ok(get.body.data.domains.some(d => d.domain === 'home.example.com'));
});

test('unauthenticated requests are rejected (GET + POST)', async () => {
  const supertest = require('supertest');
  const app = require('../src/app').createApp();
  const check = res => assert.ok([401, 403].includes(res.status), `expected 401/403, got ${res.status}`);
  await supertest(app).get('/api/v1/settings/domains').expect(check);
  await supertest(app).post('/api/v1/settings/domains').send({ domain: 'x.example.com' }).expect(check);
});

test('POST with malformed domain returns 400', async () => {
  const agent = getAgent(); const csrf = getCsrf();
  const res = await agent.post('/api/v1/settings/domains').set('X-CSRF-Token', csrf)
    .send({ domain: 'not a domain!' }).expect(400);
  assert.equal(res.body.ok, false);
});

test('PUT /domains/server-ip with invalid IP returns 400', async () => {
  const agent = getAgent(); const csrf = getCsrf();
  const res = await agent.put('/api/v1/settings/domains/server-ip').set('X-CSRF-Token', csrf)
    .send({ ip: 'not-an-ip' }).expect(400);
  assert.equal(res.body.ok, false);
});

test('PUT /domains/server-ip with empty string clears the override (200)', async () => {
  const agent = getAgent(); const csrf = getCsrf();
  const res = await agent.put('/api/v1/settings/domains/server-ip').set('X-CSRF-Token', csrf)
    .send({ ip: '' }).expect(200);
  assert.equal(res.body.ok, true);
});

test('DELETE /domains/:id removes the domain', async () => {
  const agent = getAgent(); const csrf = getCsrf();
  // First add a domain
  const post = await agent.post('/api/v1/settings/domains').set('X-CSRF-Token', csrf)
    .send({ domain: 'delete-me.example.com' }).expect(200);
  const id = post.body.data.id;
  assert.ok(id);
  // Now delete it
  const del = await agent.delete(`/api/v1/settings/domains/${id}`).set('X-CSRF-Token', csrf).expect(200);
  assert.equal(del.body.ok, true);
  // Confirm it's gone
  const get = await agent.get('/api/v1/settings/domains').expect(200);
  assert.ok(!get.body.data.domains.some(d => d.domain === 'delete-me.example.com'));
});
