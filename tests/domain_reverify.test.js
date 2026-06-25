'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let getDb, domainBoot, settings, domains;
beforeEach(async () => {
  await setup();
  getDb = require('../src/db/connection').getDb;
  domainBoot = require('../src/services/domainBoot');
  settings = require('../src/services/settings');
  domains = require('../src/services/domains');
  // Seed two domain rows in pending state
  domains.seedPending('example.com');
  domains.seedPending('example.net');
});
afterEach(teardown);

test('reverifyAllAndReflag: all verified → warning=0, rows become verified', async () => {
  const result = await domainBoot.reverifyAllAndReflag({
    verifyEach: async (d) => ({ status: 'verified', resolvedIp: '1.2.3.4', expectedIp: '1.2.3.4', error: null }),
  });
  assert.equal(result.verified, 2);
  assert.equal(result.flagged, false);
  assert.equal(settings.get('domains.server_ip_warning', '0'), '0');
  const rows = getDb().prepare('SELECT status FROM domains ORDER BY domain').all();
  assert.ok(rows.every(r => r.status === 'verified'), 'all rows should be verified');
});

test('reverifyAllAndReflag: >=2 all mismatch → warning=1, rows stay pending (not failed)', async () => {
  const result = await domainBoot.reverifyAllAndReflag({
    verifyEach: async (d) => ({ status: 'failed', resolvedIp: '9.9.9.9', expectedIp: '1.2.3.4', error: 'mismatch' }),
  });
  assert.equal(result.verified, 0);
  assert.equal(result.flagged, true);
  assert.equal(settings.get('domains.server_ip_warning', '0'), '1');
  const rows = getDb().prepare('SELECT status FROM domains ORDER BY domain').all();
  assert.ok(rows.every(r => r.status === 'pending'), 'rows must not be reddened to failed');
});
