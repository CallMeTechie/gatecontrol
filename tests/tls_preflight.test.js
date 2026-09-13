'use strict';
// tlsGuard.preflight(): rule order and result shape; recordPreflight/guardHost
// state transitions in tls_status.
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

const V4 = '198.51.100.7';
const V6 = '2001:4ba0:cafe:94::1';

let domains, tlsGuard, eventBus;
const nodata = () => { const e = new Error('ENODATA'); e.code = 'ENODATA'; throw e; };
const resolver = (map) => async (host, family) => {
  const r = map[host] || { a: [], aaaa: [] };
  return family === 4 ? r.a : r.aaaa;
};

beforeEach(async () => {
  await setup();
  domains = require('../src/services/domains');
  tlsGuard = require('../src/services/tlsGuard');
  eventBus = require('../src/services/eventBus');
  domains._setServerIpsForTest({ v4: V4, v6: null });
  domains._setCaaResolverForTest(async () => nodata());
  domains._setResolverForTest(resolver({}));
});
afterEach(() => { domains._setServerIpsForTest(null); teardown(); });

test('shape and rule order', async () => {
  let r = await tlsGuard.preflight('printer.lan');
  assert.equal(r.ok, true); assert.equal(r.code, 'not_public');
  assert.deepEqual(Object.keys(r).sort(), ['checked_at', 'code', 'detail', 'ok', 'records', 'server']);

  domains._setServerIpsForTest({ v4: null, v6: V6 });
  r = await tlsGuard.preflight('a.example.com');
  assert.equal(r.code, 'server_ip_unknown'); assert.equal(r.ok, false);

  domains._setServerIpsForTest({ v4: V4, v6: null });
  domains._setResolverForTest(async () => { throw new Error('timeout'); });
  r = await tlsGuard.preflight('a.example.com');
  assert.equal(r.code, 'resolver_unreachable');

  domains._setResolverForTest(resolver({}));
  r = await tlsGuard.preflight('a.example.com');
  assert.equal(r.code, 'no_records');

  domains._setResolverForTest(resolver({ 'a.example.com': { a: ['203.0.113.9'], aaaa: ['2001:db8::9'] } }));
  r = await tlsGuard.preflight('a.example.com');
  assert.equal(r.code, 'a_mismatch', 'A is checked before AAAA');
  assert.equal(r.detail, `A 203.0.113.9 ≠ ${V4}`);
  assert.deepEqual(r.records, { a: ['203.0.113.9'], aaaa: ['2001:db8::9'], caa: [] });
  assert.deepEqual(r.server, { v4: V4, v6: null });

  domains._setResolverForTest(resolver({ 'a.example.com': { a: [V4], aaaa: ['2001:db8::9'] } }));
  r = await tlsGuard.preflight('a.example.com');
  assert.equal(r.code, 'aaaa_without_ipv6');

  domains._setServerIpsForTest({ v4: V4, v6: V6 });
  r = await tlsGuard.preflight('a.example.com');
  assert.equal(r.code, 'aaaa_mismatch');
  assert.equal(r.detail, `AAAA 2001:db8::9 ≠ ${V6}`);

  domains._setResolverForTest(resolver({ 'a.example.com': { a: [V4], aaaa: [V6] } }));
  domains._setCaaResolverForTest(async (n) => (n === 'a.example.com' ? [{ critical: 128, issue: ';' }] : nodata()));
  r = await tlsGuard.preflight('a.example.com');
  assert.equal(r.code, 'caa_blocks');
  assert.deepEqual(r.records.caa, [{ flags: 128, tag: 'issue', value: ';' }]);

  domains._setCaaResolverForTest(async (n) => (n === 'example.com' ? [{ critical: 0, issuewild: 'letsencrypt.org' }] : nodata()));
  r = await tlsGuard.preflight('A.Example.com.');
  assert.equal(r.code, 'ok'); assert.equal(r.ok, true);
  assert.match(r.checked_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('recordPreflight pauses a public host, keeps internal hosts internal, and releases a DNS-fixed host', async () => {
  const events = [];
  const listener = (evt) => events.push(evt);
  eventBus.subscribe(listener, (t) => t === 'tls');
  try {
    domains._setResolverForTest(resolver({ 'nas.example.com': { a: ['203.0.113.9'], aaaa: [] } }));
    let g = await tlsGuard.guardHost('nas.example.com');
    assert.equal(g.state, 'paused'); assert.equal(g.code, 'a_mismatch'); assert.match(g.detail, /203\.0\.113\.9/);
    let row = tlsGuard.getRow('nas.example.com');
    assert.equal(row.state, 'paused');
    assert.equal(row.paused_reason, 'preflight');
    assert.equal(row.last_error_code, 'preflight:a_mismatch');
    assert.equal(JSON.parse(row.preflight_json).code, 'a_mismatch');
    assert.ok(row.paused_at);
    assert.deepEqual(tlsGuard.pausedHosts(), ['nas.example.com']);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].payload, { host: 'nas.example.com', state: 'paused', paused_reason: 'preflight', last_error_code: 'preflight:a_mismatch' });
    const act = require('../src/db/connection').getDb().prepare("SELECT * FROM activity_log WHERE event_type = 'tls_paused'").all();
    assert.equal(act.length, 1);
    assert.equal(act[0].severity, 'warning');

    // Same verdict again: no second activity entry / event.
    await tlsGuard.guardHost('nas.example.com');
    assert.equal(require('../src/db/connection').getDb().prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'tls_paused'").get().n, 1);
    assert.equal(events.length, 1);

    // DNS fixed → the preflight pause lifts.
    domains._setResolverForTest(resolver({ 'nas.example.com': { a: [V4], aaaa: [] } }));
    g = await tlsGuard.guardHost('nas.example.com');
    assert.equal(g.state, 'pending'); assert.equal(g.code, 'ok');
    row = tlsGuard.getRow('nas.example.com');
    assert.equal(row.paused_reason, null); assert.equal(row.last_error_code, null);
    assert.deepEqual(tlsGuard.pausedHosts(), []);

    g = await tlsGuard.guardHost('printer.lan');
    assert.equal(g.state, 'internal'); assert.equal(g.code, 'not_public');
  } finally {
    eventBus.unsubscribe(listener);
  }
});

test('preflight is skipped in the test environment unless a resolver is injected or it is enabled', async () => {
  tlsGuard._setEnabledForTest(false);
  try {
    const r = await tlsGuard.preflight('anything.example.com');
    assert.equal(r.ok, true); assert.equal(r.code, 'ok');
    assert.match(r.detail, /skipped/);
  } finally {
    tlsGuard._setEnabledForTest(null);
  }
});

test('max_attempts setting: default 3, clamped to 0..10, stored as string', () => {
  const settings = require('../src/services/settings');
  assert.equal(tlsGuard.maxAttempts(), 3);
  assert.equal(tlsGuard.setMaxAttempts(0), 0);
  assert.equal(settings.get('tls.max_attempts'), '0');
  assert.equal(tlsGuard.setMaxAttempts('10'), 10);
  assert.throws(() => tlsGuard.setMaxAttempts(11), /0 and 10/);
  assert.throws(() => tlsGuard.setMaxAttempts('x'), /0 and 10/);
  assert.throws(() => tlsGuard.setMaxAttempts(-1), /0 and 10/);
  settings.set('tls.max_attempts', '99');
  assert.equal(tlsGuard.maxAttempts(), 10);
  assert.ok(settings.PUBLIC_KEYS.has('tls.max_attempts'));
});
