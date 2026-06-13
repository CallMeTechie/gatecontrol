'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');
const license = require('../src/services/license');
let agent;
beforeEach(async () => { await setup(); agent = getAgent(); license._overrideForTest({ pihole_integration: true }); });
afterEach(teardown);

test('GET /pihole renders 200 with the page title (template compiles)', async () => {
  const res = await agent.get('/pihole');
  assert.equal(res.status, 200);
  assert.match(res.text, /Pi-hole/);
});

test('i18n files are valid JSON and contain pihole.title in both languages', () => {
  const de = require('../src/i18n/de.json');
  const en = require('../src/i18n/en.json');
  assert.ok(de['pihole.title']); assert.ok(en['pihole.title']);
  assert.ok(de['nav.pihole']); assert.ok(en['nav.pihole']);
});
