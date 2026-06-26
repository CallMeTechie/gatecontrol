'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');
let portalConfig, settings;
beforeEach(async () => { await setup(); portalConfig = require('../src/services/portalConfig'); settings = require('../src/services/settings'); });
afterEach(teardown);

test('trustOwnerMapping defaults to false (key unwritten)', () => {
  assert.equal(portalConfig().trustOwnerMapping, false);
});
test('PUT persists trust_owner_mapping=true and config reflects it', async () => {
  const agent = getAgent(); const csrf = getCsrf();
  await agent.put('/api/v1/settings/portal').set('X-CSRF-Token', csrf).send({ trust_owner_mapping: true }).expect(200);
  assert.equal(settings.get('portal.trust_owner_mapping'), '1');
  assert.equal(portalConfig().trustOwnerMapping, true);
});
