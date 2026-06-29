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

test('GET /smarthome returns 200 for licensed admin', async () => {
  await agent.get('/smarthome').expect(200);
});
