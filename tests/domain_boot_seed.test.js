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

test('skips non-public-TLD bases and prunes lingering pending non-public rows', async () => {
  // an internal-TLD route: its base (gc.internal) must NEVER be seeded
  getDb().prepare(`INSERT INTO routes (description, domain, target_ip, target_port, enabled, route_type)
                   VALUES ('r3','nas.gc.internal','10.0.0.4','80',1,'http')`).run();
  // a non-public base auto-seeded by an earlier boot → must be pruned
  getDb().prepare("INSERT OR IGNORE INTO domains (domain, status) VALUES ('old.lan','pending')").run();
  // a verified row must survive — cleanup only targets pending rows
  getDb().prepare("INSERT OR IGNORE INTO domains (domain, status) VALUES ('kept.internal','verified')").run();

  const res = await domainBoot.runDomainSeedAndVerify({
    verifyEach: async (d) => ({ status: 'verified', resolvedIp: '1.2.3.4', expectedIp: '1.2.3.4', error: null }),
  });

  // Set membership (exact match) — avoids CodeQL's js/incomplete-url-substring
  // false-positive that fires on Array.includes('host.tld') in tests.
  const present = new Set(getDb().prepare('SELECT domain FROM domains').all().map(r => r.domain));
  assert.equal(res.seeded, 2, 'only the 2 public bases are seeded');
  assert.ok(!present.has('gc.internal'), 'non-public base must not be seeded');
  assert.ok(!present.has('old.lan'), 'lingering pending non-public row must be pruned');
  assert.ok(present.has('kept.internal'), 'verified rows must never be pruned');
  assert.ok(present.has('domaincaster.com') && present.has('marcbackes.net'), 'public bases seeded');
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
