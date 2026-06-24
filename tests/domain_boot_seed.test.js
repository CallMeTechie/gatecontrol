'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let getDb, domainBoot, settings;
beforeEach(async () => {
  await setup();
  getDb = require('../src/db/connection').getDb;
  domainBoot = require('../src/services/domainBoot');
  settings = require('../src/services/settings');
  getDb().prepare(`INSERT INTO routes (description, domain, target_ip, target_port, enabled, route_type)
                   VALUES ('r1','nas.domaincaster.com','10.0.0.2','80',1,'http')`).run();
  getDb().prepare(`INSERT INTO routes (description, domain, target_ip, target_port, enabled, route_type)
                   VALUES ('r2','foo.marcbackes.net','10.0.0.3','80',1,'http')`).run();
});
afterEach(teardown);

test('seeds distinct base domains and verifies them', async () => {
  const res = await domainBoot.runDomainSeedAndVerify({
    verifyEach: async (d) => ({ status: 'verified', resolvedIp: '1.2.3.4', expectedIp: '1.2.3.4', error: null }),
  });
  assert.equal(res.seeded, 2);
  const rows = getDb().prepare('SELECT domain,status FROM domains ORDER BY domain').all();
  assert.deepEqual(rows.map(r => r.domain), ['domaincaster.com', 'marcbackes.net']);
  assert.ok(rows.every(r => r.status === 'verified'));
});

test('>=2 all-mismatch sets the server-IP warning and keeps rows pending', async () => {
  const res = await domainBoot.runDomainSeedAndVerify({
    verifyEach: async (d) => ({ status: 'failed', resolvedIp: '9.9.9.9', expectedIp: '1.2.3.4', error: 'x' }),
  });
  assert.equal(res.flagged, true);
  assert.equal(settings.get('domains.server_ip_warning', '0'), '1');
  const rows = getDb().prepare('SELECT status FROM domains').all();
  assert.ok(rows.every(r => r.status === 'pending')); // not reddened
});
