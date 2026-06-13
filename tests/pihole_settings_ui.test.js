'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');
const license = require('../src/services/license');
let agent;
beforeEach(async () => { await setup(); agent = getAgent(); });
afterEach(teardown);

test('settings page shows the Pi-hole tab when licensed', async () => {
  license._overrideForTest({ pihole_integration: true });
  const res = await agent.get('/settings');
  assert.equal(res.status, 200);
  assert.match(res.text, /data-settings-tab="pihole"/);
});

test('settings page hides the Pi-hole tab when NOT licensed', async () => {
  license._overrideForTest({ pihole_integration: false });
  const res = await agent.get('/settings');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /data-settings-tab="pihole"/);
});

test('i18n: settings.tab_pihole present in de and en', () => {
  const de = require('../src/i18n/de.json'); const en = require('../src/i18n/en.json');
  assert.ok(de['settings.tab_pihole']); assert.ok(en['settings.tab_pihole']);
});
