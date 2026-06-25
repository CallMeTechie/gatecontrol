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
  settings.set('server.public_ip', '198.51.100.7'); // known-good server IP
});
afterEach(teardown);

test('verified when a resolved A matches the server IP', async () => {
  domains._setResolverForTest(async (h, f) => (f === 4 ? ['198.51.100.7'] : []));
  const r = await domains.verify('home.example.com');
  assert.equal(r.status, 'verified');
  assert.equal(r.resolvedIp, '198.51.100.7');
});

test('failed when resolves elsewhere (server IP known-good)', async () => {
  domains._setResolverForTest(async (h, f) => (f === 4 ? ['203.0.113.1'] : []));
  const r = await domains.verify('elsewhere.example.com');
  assert.equal(r.status, 'failed');
  assert.match(r.error, /198\.51\.100\.7/); // expected IP in the message
});

test('verified for IPv6 server IP regardless of canonical form', async () => {
  // Override is non-canonical (uppercase + '::' compression); the resolver returns
  // the fully-expanded canonical AAAA. A plain string compare would miss this.
  settings.set('server.public_ip', '2001:DB8::1');
  domains._setResolverForTest(async (h, f) => (f === 6 ? ['2001:db8:0:0:0:0:0:1'] : []));
  const r = await domains.verify('v6.example.com');
  assert.equal(r.status, 'verified');
});

test('pending (not failed) when server IP unknown', async () => {
  settings.set('server.public_ip', '');               // clear the override → must derive
  // CRITICAL: the stub answers ALL hosts incl. GC_WG_HOST (test.example.com). To make
  // the server IP truly unknown, GC_WG_HOST must resolve to [] (else getServerPublicIp
  // would derive an IP and the test would not exercise the unknown path).
  domains._setResolverForTest(async (h, f) =>
    (h === 'test.example.com' ? [] : (f === 4 ? ['203.0.113.1'] : [])));
  const r = await domains.verify('x.example.com');
  assert.equal(r.status, 'pending');
});

test('pending (not failed) when all public resolvers unreachable', async () => {
  domains._setResolverForTest(async () => { const e = new Error('ESERVFAIL'); throw e; });
  const r = await domains.verify('x.example.com');
  assert.equal(r.status, 'pending');
  assert.match(r.error, /resolver|erreichbar/i);
});
