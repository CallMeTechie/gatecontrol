'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

beforeEach(async () => { await setup(); });
afterEach(teardown);

test('ip2location: empty api_key does not overwrite; clear removes it', async () => {
  const agent = getAgent(); const csrf = getCsrf();
  // Set a secret
  await agent.put('/api/v1/settings/ip2location').set('X-CSRF-Token', csrf).send({ api_key: 'SECRET123' }).expect(200);
  // Send empty api_key — should NOT overwrite
  await agent.put('/api/v1/settings/ip2location').set('X-CSRF-Token', csrf).send({ api_key: '' }).expect(200);
  let r = await agent.get('/api/v1/settings/ip2location').expect(200);
  assert.equal(r.body.data.has_api_key, true, 'secret should still be set after empty api_key PUT');
  // Send clear:true — should remove it
  await agent.put('/api/v1/settings/ip2location').set('X-CSRF-Token', csrf).send({ api_key: '', clear: true }).expect(200);
  r = await agent.get('/api/v1/settings/ip2location').expect(200);
  assert.equal(r.body.data.has_api_key, false, 'secret should be cleared after clear:true PUT');
});

test('smtp: empty password does not overwrite; clear_password removes it', async () => {
  const agent = getAgent(); const csrf = getCsrf();
  // Set a password
  await agent.put('/api/v1/smtp/settings').set('X-CSRF-Token', csrf).send({ host: 'm', port: '25', from: 'a@x', password: 'PW1' }).expect(200);
  // Send without password key — should NOT overwrite
  await agent.put('/api/v1/smtp/settings').set('X-CSRF-Token', csrf).send({ host: 'm', port: '25', from: 'a@x' }).expect(200);
  let r = await agent.get('/api/v1/smtp/settings').expect(200);
  assert.equal(r.body.data.hasPassword, true, 'password should still be set after PUT without password key');
  // Send clear_password:true — should remove it
  await agent.put('/api/v1/smtp/settings').set('X-CSRF-Token', csrf).send({ host: 'm', port: '25', from: 'a@x', clear_password: true }).expect(200);
  r = await agent.get('/api/v1/smtp/settings').expect(200);
  assert.equal(r.body.data.hasPassword, false, 'password should be cleared after clear_password:true PUT');
});
