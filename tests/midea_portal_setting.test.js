'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let portalConfig, settings;
beforeEach(async () => {
  await setup();
  portalConfig = require('../src/services/portalConfig');
  settings = require('../src/services/settings');
});
afterEach(() => teardown());

test('widgets.midea defaults to true', () => {
  assert.equal(portalConfig().widgets.midea, true);
});
test('widgets.midea reflects the setting', () => {
  settings.set('portal.widget.midea', '0');
  assert.equal(portalConfig().widgets.midea, false);
});
test('settings API persists widgets.midea', async () => {
  const agent = getAgent(); const csrf = getCsrf();
  await agent.put('/api/v1/settings/portal').set('X-CSRF-Token', csrf).send({ widgets: { midea: false } }).expect(200);
  assert.equal(settings.get('portal.widget.midea', '1'), '0');
});
