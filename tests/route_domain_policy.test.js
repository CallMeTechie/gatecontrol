'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let policy, getDb;
beforeEach(async () => {
  await setup();
  // setup.js (module-level) resets GC_BASE_URL to 'http://localhost:3000'.
  // Override AFTER setup() so managementHost() resolves to admin.example.com.
  // Purge both config and the policy module from require.cache so the
  // policy captures the fresh baseUrl when it first requires config.
  process.env.GC_BASE_URL = 'https://admin.example.com';
  delete require.cache[require.resolve('../config/default')];
  delete require.cache[require.resolve('../src/services/routeDomainPolicy')];
  policy = require('../src/services/routeDomainPolicy');
  getDb = require('../src/db/connection').getDb;
});
afterEach(teardown);

test('public TLD requires a verified base', () => {
  assert.equal(policy.checkDomainPolicy('nas.domaincaster.com', {}).error, 'public_domain_use_verified');
  getDb().prepare("INSERT INTO domains (domain, status) VALUES ('domaincaster.com','verified')").run();
  assert.equal(policy.checkDomainPolicy('nas.domaincaster.com', {}).error, null);
});

test('non-public TLD is carved out (no verify needed)', () => {
  assert.equal(policy.checkDomainPolicy('nas.gc.internal', {}).error, null);
  assert.equal(policy.checkDomainPolicy('printer.lan', {}).error, null);
});

test('unchanged domain is skipped (grandfathering)', () => {
  // public, unverified, but unchanged → no error
  assert.equal(policy.checkDomainPolicy('old.example.com', { currentDomain: 'old.example.com' }).error, null);
});

test('collision with management host is rejected (strict, public base seeded)', () => {
  getDb().prepare("INSERT INTO domains (domain, status) VALUES ('example.com','verified')").run();
  // base example.com is verified → only the collision path can fail. Management host = admin.example.com.
  assert.equal(policy.checkDomainPolicy('admin.example.com', { routeType: 'http' }).error, 'domain_collision');
  // a different verified-base host does NOT collide:
  assert.equal(policy.checkDomainPolicy('nas.example.com', { routeType: 'http' }).error, null);
  // trailing dot / casing still collides (normalized):
  assert.equal(policy.checkDomainPolicy('ADMIN.example.com.', { routeType: 'http' }).error, 'domain_collision');
});

test('collision with portal host is rejected when C is present', () => {
  getDb().prepare("INSERT INTO domains (domain, status) VALUES ('example.com','verified')").run();
  const settings = require('../src/services/settings');
  // C: portal.base_domain + prefix → effectivePortalHost() = home.example.com.
  // C/portalConfig IS present on this branch, so this must be deterministic —
  // a failure to set the keys should surface, not be swallowed.
  settings.set('portal.base_domain', 'example.com');
  settings.set('portal.prefix', 'home');
  const r = policy.checkDomainPolicy('home.example.com', { routeType: 'http' });
  assert.equal(r.error, 'domain_collision');
});
