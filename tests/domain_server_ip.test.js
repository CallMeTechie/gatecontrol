'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let domains, settings;
beforeEach(async () => {
  await setup();
  domains = require('../src/services/domains');
  settings = require('../src/services/settings');
});
afterEach(teardown);

test('manual override wins', async () => {
  settings.set('server.public_ip', '203.0.113.9');
  const r = await domains.getServerPublicIp();
  assert.equal(r.ip, '203.0.113.9');
  assert.equal(r.source, 'override');
});

test('derives from GC_WG_HOST via the injected resolver (no third-party call)', async () => {
  // GC_WG_HOST defaults to test.example.com in the harness; stub the resolver.
  domains._setResolverForTest(async (host, family) => (family === 4 ? ['198.51.100.7'] : []));
  const r = await domains.getServerPublicIp();
  assert.equal(r.ip, '198.51.100.7');
  assert.equal(r.family, 4);
});

test('unresolvable/localhost host -> unknown, never 127.0.0.1', async () => {
  domains._setResolverForTest(async () => []); // nothing resolves
  const r = await domains.getServerPublicIp();
  assert.equal(r.ip, null);
});

test('loopback IP-literal in GC_WG_HOST -> unknown, never returns 127.0.0.1', async () => {
  // Force GC_WG_HOST to a loopback literal; isLoopbackHost must skip it (not return it).
  process.env.GC_WG_HOST = '127.0.0.1';
  delete require.cache[require.resolve('../config/default')];
  delete require.cache[require.resolve('../src/services/domains')];
  const d2 = require('../src/services/domains');
  d2._setResolverForTest(async () => { throw new Error('resolver must not be called'); });
  // GC_BASE_URL host is localhost in the harness → also skipped → unknown.
  const r = await d2.getServerPublicIp();
  assert.equal(r.ip, null);
});
