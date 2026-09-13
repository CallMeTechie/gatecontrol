'use strict';
// Caddy tls.log parser (fixture lines) and the watcher: offsets, missing file,
// rotation, attempt cap → pause, success → issued.
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup, teardown } = require('./helpers/setup');

const H = 'x.example.com';
const TS = 1757764800.123; // 2025-09-13T12:00:00.123Z
const L = {
  issuerErr: (host = H, error = 'HTTP 403 urn:ietf:params:acme:error:unauthorized - Invalid response from http://x.example.com/.well-known/acme-challenge/abc: 404', ts = TS) =>
    JSON.stringify({ level: 'error', ts, logger: 'tls.obtain', msg: 'could not get certificate from issuer', identifier: host, issuer: 'acme-v02.api.letsencrypt.org-directory', error }),
  retry: (attempt, host = H, error = 'x', extra = {}) =>
    JSON.stringify({ level: 'error', ts: TS + attempt, logger: 'tls.obtain', msg: 'will retry', error, attempt, retrying_in: 60, elapsed: 5.1, max_duration: 2592000, ...extra, identifier: host }),
  obtained: (host = H) => JSON.stringify({ level: 'info', ts: TS + 100, logger: 'tls.obtain', msg: 'certificate obtained successfully', identifier: host, issuer: 'acme-v02.api.letsencrypt.org-directory' }),
  renewed: (host = H) => JSON.stringify({ level: 'info', ts: TS + 200, logger: 'tls.renew', msg: 'certificate renewed successfully', identifier: host }),
};

let tlsGuard, caddy, syncCount;
beforeEach(async () => {
  await setup();
  tlsGuard = require('../src/services/tlsGuard');
  caddy = require('../src/services/caddyConfig');
  syncCount = 0;
  caddy.syncToCaddy = async () => { syncCount++; return true; };
});
afterEach(() => { tlsGuard.stopWatcher(); teardown(); });

test('parseTlsLogLine: fixture lines', () => {
  const e = tlsGuard.parseTlsLogLine(L.issuerErr());
  assert.equal(e.kind, 'error'); assert.equal(e.host, H); assert.equal(e.attempt, null);
  assert.match(e.error, /Invalid response/); assert.equal(e.retrying_in, null);
  assert.equal(e.at, '2025-09-13T12:00:00.123Z'); assert.equal(e.logger, 'tls.obtain');

  const r = tlsGuard.parseTlsLogLine(L.retry(2, H, 'boom'));
  assert.equal(r.kind, 'error'); assert.equal(r.attempt, 2); assert.equal(r.retrying_in, 60); assert.equal(r.max_duration, 2592000);

  const s = tlsGuard.parseTlsLogLine(L.obtained());
  assert.equal(s.kind, 'success'); assert.equal(s.host, H);
  assert.equal(tlsGuard.parseTlsLogLine(L.renewed()).kind, 'success');

  // Defensive: other shapes, strings, garbage.
  assert.equal(tlsGuard.parseTlsLogLine('not json'), null);
  assert.equal(tlsGuard.parseTlsLogLine('{"msg":"will retry"}'), null, 'no identifier → ignored');
  assert.equal(tlsGuard.parseTlsLogLine(JSON.stringify({ msg: 'loading certificate', identifier: H })), null);
  const alt = tlsGuard.parseTlsLogLine(JSON.stringify({ ts: '2026-01-02T03:04:05Z', logger: 'tls.renew', msg: 'could not get certificate from issuer', identifiers: ['Y.Example.com'], err: { detail: 'x' }, retrying_in: '1m30s' }));
  assert.equal(alt.host, 'y.example.com'); assert.equal(alt.at, '2026-01-02T03:04:05.000Z');
  assert.equal(alt.error, '{"detail":"x"}'); assert.equal(alt.retrying_in, 90);
  assert.equal(tlsGuard.parseDurationSeconds('2h'), 7200);
  assert.equal(tlsGuard.parseDurationSeconds('abc'), null);
});

test('classifyError', () => {
  const c = tlsGuard.classifyError;
  assert.equal(c('429 urn:ietf:params:acme:error:rateLimited: too many failed authorizations'), 'rate_limited');
  assert.equal(c('CAA record for x.example.com prevents issuance'), 'caa');
  assert.equal(c('account does not exist / invalid contact email'), 'account');
  assert.equal(c('no valid A records found for x.example.com'), 'dns');
  assert.equal(c('dial tcp 1.2.3.4:80: connection refused'), 'dns');
  assert.equal(c('Timeout during connect (likely firewall problem)'), 'dns');
  assert.equal(c('Invalid response from http://x/.well-known/acme-challenge/a: 404'), 'dns');
  assert.equal(c('something else'), 'other');
  assert.equal(c(''), 'other');
});

async function withLog(lines, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-tls-log-'));
  const file = path.join(dir, 'tls.log');
  if (lines !== null) fs.writeFileSync(file, lines.map((l) => l + '\n').join(''));
  tlsGuard.startWatcher({ file, intervalMs: 1e9, immediate: false });
  try { await fn(file); } finally { tlsGuard.stopWatcher(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('watcher: missing file is tolerated, then lines are applied incrementally', async () => {
  await withLog(null, async (file) => {
    assert.equal(await tlsGuard.pollOnce(), 0);
    fs.writeFileSync(file, L.issuerErr() + '\n');
    assert.equal(await tlsGuard.pollOnce(), 1);
    let row = tlsGuard.getRow(H);
    assert.equal(row.state, 'failed'); assert.equal(row.attempts, 1);
    assert.equal(row.last_error_code, 'dns'); assert.match(row.last_error, /Invalid response/);
    assert.equal(row.last_attempt_at, '2025-09-13T12:00:00.123Z'); assert.equal(row.next_retry_at, null);

    // partial line stays buffered until the newline arrives
    const retry = L.retry(1);
    fs.appendFileSync(file, retry.slice(0, 20));
    assert.equal(await tlsGuard.pollOnce(), 0);
    fs.appendFileSync(file, retry.slice(20) + '\n');
    assert.equal(await tlsGuard.pollOnce(), 1);
    row = tlsGuard.getRow(H);
    assert.equal(row.attempts, 1, "Caddy's attempt number is authoritative");
    assert.equal(row.next_retry_at, new Date((TS + 1) * 1000 + 60000).toISOString());
    assert.equal(await tlsGuard.pollOnce(), 0, 'nothing new');
  });
});

test('watcher: after max_attempts failures the host is paused and Caddy synced; success resets', async () => {
  const eventBus = require('../src/services/eventBus');
  const events = [];
  const listener = (evt) => events.push(evt.payload);
  eventBus.subscribe(listener, (t) => t === 'tls');
  try {
    await withLog([L.issuerErr(), L.retry(1), L.issuerErr(), L.retry(2)], async (file) => {
      assert.equal(await tlsGuard.pollOnce(), 4);
      let row = tlsGuard.getRow(H);
      assert.equal(row.state, 'failed'); assert.equal(row.attempts, 2); assert.equal(syncCount, 0);

      fs.appendFileSync(file, L.issuerErr() + '\n');
      await tlsGuard.pollOnce();
      row = tlsGuard.getRow(H);
      assert.equal(row.state, 'paused'); assert.equal(row.attempts, 3);
      assert.equal(row.paused_reason, 'attempts'); assert.ok(row.paused_at);
      assert.equal(row.last_error_code, 'dns', 'the classified Caddy error stays');
      assert.equal(syncCount, 1, 'pause pushes the skip list to Caddy');
      assert.deepEqual(tlsGuard.pausedHosts(), [H]);
      assert.ok(events.some((p) => p.host === H && p.state === 'paused' && p.paused_reason === 'attempts'));
      const act = require('../src/db/connection').getDb().prepare("SELECT message, severity FROM activity_log WHERE event_type = 'tls_paused'").all();
      assert.equal(act.length, 1); assert.equal(act[0].severity, 'warning'); assert.match(act[0].message, /3 failed/);

      // Further errors while paused only update the record, never re-sync.
      fs.appendFileSync(file, L.retry(3) + '\n');
      await tlsGuard.pollOnce();
      assert.equal(tlsGuard.getRow(H).state, 'paused'); assert.equal(syncCount, 1);

      // Success (e.g. after retry) → issued, counters cleared.
      fs.appendFileSync(file, L.obtained() + '\n');
      await tlsGuard.pollOnce();
      row = tlsGuard.getRow(H);
      assert.equal(row.state, 'issued'); assert.equal(row.attempts, 0);
      assert.equal(row.last_error, null); assert.equal(row.last_error_code, null);
      assert.equal(row.next_retry_at, null); assert.equal(row.paused_reason, null);
      assert.deepEqual(tlsGuard.pausedHosts(), []);
    });
  } finally {
    eventBus.unsubscribe(listener);
  }
});

test('watcher: max_attempts 0 never pauses', async () => {
  require('../src/services/settings').set('tls.max_attempts', '0');
  await withLog([L.issuerErr(), L.retry(5), L.retry(9)], async () => {
    await tlsGuard.pollOnce();
    const row = tlsGuard.getRow(H);
    assert.equal(row.state, 'failed'); assert.equal(row.attempts, 9); assert.equal(syncCount, 0);
  });
});

test('watcher: rotation (new inode / smaller file) restarts from the top; offset persists across restarts', async () => {
  await withLog([L.issuerErr('a.example.com')], async (file) => {
    assert.equal(await tlsGuard.pollOnce(), 1);
    // rotate: remove and recreate. The inode may be reused and the size may
    // match — a real rotated log starts with a later timestamp, which the
    // head fingerprint catches.
    fs.rmSync(file);
    fs.writeFileSync(file, L.issuerErr('b.example.com', undefined, TS + 3600) + '\n');
    assert.equal(await tlsGuard.pollOnce(), 1);
    assert.equal(tlsGuard.getRow('b.example.com').attempts, 1);
    // truncate in place
    fs.writeFileSync(file, '');
    assert.equal(await tlsGuard.pollOnce(), 0);
    fs.appendFileSync(file, L.retry(4, 'b.example.com') + '\n');
    assert.equal(await tlsGuard.pollOnce(), 1);
    assert.equal(tlsGuard.getRow('b.example.com').attempts, 4);

    // restart the watcher on the same file: the persisted offset skips old lines
    tlsGuard.stopWatcher();
    tlsGuard.startWatcher({ file, intervalMs: 1e9, immediate: false });
    assert.equal(await tlsGuard.pollOnce(), 0, 'no replay after restart');
    fs.appendFileSync(file, L.obtained('b.example.com') + '\n');
    assert.equal(await tlsGuard.pollOnce(), 1);
    assert.equal(tlsGuard.getRow('b.example.com').state, 'issued');
  });
});
