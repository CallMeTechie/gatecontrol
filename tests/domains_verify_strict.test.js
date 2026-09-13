'use strict';
// Strict domain verification (TLS guard): A, AAAA and CAA must all fit this
// server; getServerPublicIps() supplies both addresses.
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

const V4 = '198.51.100.7';
const V6 = '2001:4ba0:cafe:94::1';
const FOREIGN6 = '2001:41d0:301:1::29';

let domains, settings;
beforeEach(async () => {
  await setup();
  domains = require('../src/services/domains');
  settings = require('../src/services/settings');
  domains._setServerIpsForTest(null);
  domains._setInterfacesForTest(() => ({}));
  domains._setCaaResolverForTest(async () => { const e = new Error('ENODATA'); e.code = 'ENODATA'; throw e; });
  settings.set('server.public_ip', V4);
});
afterEach(() => { domains._setServerIpsForTest(null); teardown(); });

const resolver = (map) => async (host, family) => {
  const r = map[host] || { a: [], aaaa: [] };
  return family === 4 ? r.a : r.aaaa;
};

test('getServerPublicIps: overrides win, v6 from the interfaces, else AAAA of GC_WG_HOST', async () => {
  settings.set('server.public_ipv6', V6);
  let ips = await domains.getServerPublicIps();
  assert.deepEqual(ips, { v4: V4, v6: V6, source: { v4: 'override', v6: 'override' } });

  settings.set('server.public_ipv6', '');
  domains._setInterfacesForTest(() => ({
    lo: [{ address: '::1', family: 'IPv6', internal: true }],
    ens18: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: 'fd00::5', family: 'IPv6', internal: false },
      { address: '2001:db8:1:2::9', family: 'IPv6', internal: false },                   // documentation range: not global
      { address: '2a01:4f8:1:2:1234:5678:9abc:def0', family: 'IPv6', internal: false }, // random tail (temporary-like)
      { address: '2a01:4f8:1:2::1', family: 'IPv6', internal: false },                   // stable, preferred
      { address: '203.0.113.5', family: 'IPv4', internal: false },
    ],
  }));
  ips = await domains.getServerPublicIps();
  assert.equal(ips.v6, '2a01:4f8:1:2::1');
  assert.equal(ips.source.v6, 'interface');

  domains._setInterfacesForTest(() => ({}));
  domains._setResolverForTest(resolver({ 'test.example.com': { a: [V4], aaaa: [V6] } }));
  ips = await domains.getServerPublicIps();
  assert.equal(ips.v6, V6);
  assert.equal(ips.source.v6, 'wg_host');
  const legacy = await domains.getServerPublicIp();
  assert.deepEqual(legacy, { ip: V4, family: 4, source: 'override' });
});

test('getServerPublicIps: loopback/private answers for GC_WG_HOST are never the server address', async () => {
  settings.set('server.public_ip', '');
  // split-horizon / hosts-file answer first, the public one behind it
  domains._setResolverForTest(resolver({ 'test.example.com': { a: ['127.0.1.1', '10.8.0.1'], aaaa: ['::1', 'fd00::1'] } }));
  let ips = await domains.getServerPublicIps();
  assert.deepEqual(ips, { v4: null, v6: null, source: { v4: 'unknown', v6: 'unknown' } });
  domains._setResolverForTest(resolver({ 'test.example.com': { a: ['127.0.1.1', V4], aaaa: ['fe80::1', V6] } }));
  ips = await domains.getServerPublicIps();
  assert.equal(ips.v4, V4); assert.equal(ips.v6, V6);
});

test('getServerPublicIps: a legacy IPv6 literal in server.public_ip counts as the v6 override', async () => {
  settings.set('server.public_ip', V6);
  domains._setResolverForTest(resolver({ 'test.example.com': { a: [V4], aaaa: [] } }));
  const ips = await domains.getServerPublicIps();
  assert.equal(ips.v6, V6);
  assert.equal(ips.source.v6, 'override');
  assert.equal(ips.v4, V4);
  assert.equal(ips.source.v4, 'wg_host');
});

test('verified when A matches and no AAAA exists', async () => {
  domains._setResolverForTest(resolver({ 'home.example.com': { a: [V4], aaaa: [] } }));
  const r = await domains.verify('home.example.com');
  assert.equal(r.status, 'verified');
  assert.equal(r.error, null);
  assert.equal(r.check.code, 'ok');
  assert.deepEqual(r.check.records.a, [V4]);
});

test('reproduction: A ok, AAAA foreign, server without v6 → failed / aaaa_without_ipv6', async () => {
  domains._setResolverForTest(resolver({ 'jenny.example.com': { a: [V4], aaaa: [FOREIGN6] } }));
  const r = await domains.verify('jenny.example.com');
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'aaaa_without_ipv6');
  assert.match(r.check.detail, /2001:41d0:301:1::29/);
  assert.equal(r.resolvedIp, FOREIGN6);
  const row = await domains.add('jenny.example.com');
  assert.equal(row.status, 'failed');
  assert.equal(row.last_error, 'aaaa_without_ipv6');
  assert.equal(JSON.parse(row.check_json).code, 'aaaa_without_ipv6');
});

test('AAAA foreign while the server has a v6 → aaaa_mismatch naming the foreign address', async () => {
  settings.set('server.public_ipv6', V6);
  domains._setResolverForTest(resolver({ 'jenny.example.com': { a: [V4], aaaa: [FOREIGN6] } }));
  const r = await domains.verify('jenny.example.com');
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'aaaa_mismatch');
  assert.match(r.check.detail, new RegExp(`AAAA ${FOREIGN6} ≠ ${V6}`));
});

test('AAAA matching the server v6 (non-canonical override) → verified', async () => {
  settings.set('server.public_ipv6', '2001:4BA0:CAFE:0094:0000:0000:0000:0001');
  domains._setResolverForTest(resolver({ 'v6.example.com': { a: [V4], aaaa: [V6] } }));
  const r = await domains.verify('v6.example.com');
  assert.equal(r.status, 'verified');
});

test('any foreign A record fails, even next to a matching one', async () => {
  domains._setResolverForTest(resolver({ 'multi.example.com': { a: [V4, '203.0.113.1'], aaaa: [] } }));
  const r = await domains.verify('multi.example.com');
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'a_mismatch');
  assert.match(r.check.detail, /203\.0\.113\.1/);
});

test('no records → failed / no_records; resolver down → pending / resolver_unreachable', async () => {
  domains._setResolverForTest(resolver({}));
  let r = await domains.verify('nx.example.com');
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'no_records');
  domains._setResolverForTest(async () => { throw new Error('ESERVFAIL'); });
  r = await domains.verify('nx.example.com');
  assert.equal(r.status, 'pending');
  assert.equal(r.error, 'resolver_unreachable');
});

test('server IPv4 unknown → pending / server_ip_unknown (a v6-only override is not enough)', async () => {
  settings.set('server.public_ip', '');
  settings.set('server.public_ipv6', V6);
  domains._setResolverForTest(resolver({ 'x.example.com': { a: [V4], aaaa: [] } })); // GC_WG_HOST unresolvable
  const r = await domains.verify('x.example.com');
  assert.equal(r.status, 'pending');
  assert.equal(r.error, 'server_ip_unknown');
});

test('CAA of a parent blocks when it names another CA; letsencrypt.org passes', async () => {
  domains._setResolverForTest(resolver({ 'deep.sub.example.com': { a: [V4], aaaa: [] } }));
  const nodata = () => { const e = new Error('ENODATA'); e.code = 'ENODATA'; throw e; };
  domains._setCaaResolverForTest(async (name) => {
    if (name === 'example.com') return [{ critical: 0, issue: 'digicert.com' }, { critical: 0, iodef: 'mailto:x@example.com' }];
    return nodata();
  });
  let r = await domains.verify('deep.sub.example.com');
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'caa_blocks');
  assert.match(r.check.detail, /digicert\.com/);
  assert.equal(r.check.records.caa.length, 2);

  // The closest set wins (RFC 8659): sub.example.com allows Let's Encrypt.
  domains._setCaaResolverForTest(async (name) => {
    if (name === 'sub.example.com') return [{ critical: 0, issue: 'letsencrypt.org; validationmethods=http-01' }];
    if (name === 'example.com') return [{ critical: 0, issue: 'digicert.com' }];
    return nodata();
  });
  r = await domains.verify('deep.sub.example.com');
  assert.equal(r.status, 'verified');

  // Only iodef → no restriction.
  domains._setCaaResolverForTest(async (name) => (name === 'example.com' ? [{ critical: 0, iodef: 'mailto:x@example.com' }] : nodata()));
  r = await domains.verify('deep.sub.example.com');
  assert.equal(r.status, 'verified');
});
