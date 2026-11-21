'use strict';
process.env.NODE_ENV = 'test';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

function fresh() { delete require.cache[require.resolve('../src/services/gatewayRelease')]; return require('../src/services/gatewayRelease'); }

describe('gatewayRelease', () => {
  let svc;
  let tmpDir;
  let origCachePath;

  beforeEach(() => {
    origCachePath = process.env.GC_GATEWAY_LATEST_CACHE;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-release-test-'));
    // Always isolate the persist file per-test — prevents cross-run pollution at the default path
    process.env.GC_GATEWAY_LATEST_CACHE = path.join(tmpDir, 'gateway-latest-version.json');
    svc = fresh();
  });

  afterEach(() => {
    if (origCachePath === undefined) delete process.env.GC_GATEWAY_LATEST_CACHE;
    else process.env.GC_GATEWAY_LATEST_CACHE = origCachePath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null on a cold cache without blocking or firing a real request', () => {
    const t0 = Date.now();
    assert.equal(svc.getLatestVersion(), null);
    assert.ok(Date.now() - t0 < 100);
  });
  it('normalises a tag (strips leading v)', () => {
    assert.equal(svc._normalizeTag('v1.9.3'), '1.9.3');
    assert.equal(svc._normalizeTag('1.9.3'), '1.9.3');
    assert.equal(svc._normalizeTag(null), null);
  });
  it('serves a set cache value', () => { svc._setCache('1.9.3'); assert.equal(svc.getLatestVersion(), '1.9.3'); });

  // --- persistence tests (RED first) ---

  it('loads persisted version from file on module init (cold-start returns non-null without fetch)', () => {
    const cacheFile = path.join(tmpDir, 'gateway-latest-version.json');
    fs.writeFileSync(cacheFile, JSON.stringify({ version: '1.16.9' }));
    process.env.GC_GATEWAY_LATEST_CACHE = cacheFile;
    const freshSvc = fresh();
    // Must return persisted value immediately without any network fetch (NODE_ENV=test)
    assert.equal(freshSvc.getLatestVersion(), '1.16.9');
  });

  it('persists version to file on _setCache', () => {
    const cacheFile = path.join(tmpDir, 'gateway-latest-version.json');
    process.env.GC_GATEWAY_LATEST_CACHE = cacheFile;
    const freshSvc = fresh();
    freshSvc._setCache('1.2.3');
    const stored = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.equal(stored.version, '1.2.3');
  });

  it('handles missing persist file gracefully — _loadPersisted returns null, getLatestVersion returns null', () => {
    const cacheFile = path.join(tmpDir, 'does-not-exist.json');
    process.env.GC_GATEWAY_LATEST_CACHE = cacheFile;
    // Must not throw
    const freshSvc = fresh();
    assert.equal(freshSvc._loadPersisted(), null);
    assert.equal(freshSvc.getLatestVersion(), null);
  });

  // --- warm-start retry tests (RED first) ---

  it('init retries the fetch when the warm-start fetch did not succeed', async () => {
    const origDelay = process.env.GC_GATEWAY_LATEST_RETRY_MS;
    process.env.GC_GATEWAY_LATEST_RETRY_MS = '15';
    try {
      const s = fresh();
      s.init();
      // First fetch fires synchronously; under NODE_ENV=test it never succeeds
      // (cache.fetchedAt stays 0) so a retry must be scheduled.
      assert.equal(s._fetchCallCount(), 1);
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(s._fetchCallCount() >= 2, `expected at least one retry, got ${s._fetchCallCount()}`);
    } finally {
      if (origDelay === undefined) delete process.env.GC_GATEWAY_LATEST_RETRY_MS;
      else process.env.GC_GATEWAY_LATEST_RETRY_MS = origDelay;
    }
  });

  it('init does NOT retry once the cache has a fresh successful fetch', async () => {
    const origDelay = process.env.GC_GATEWAY_LATEST_RETRY_MS;
    process.env.GC_GATEWAY_LATEST_RETRY_MS = '15';
    try {
      const s = fresh();
      s.init();
      // Simulate the warm-start fetch having succeeded.
      s._setCache('1.16.9');
      const after = s._fetchCallCount();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(s._fetchCallCount(), after, 'no further fetch once cache is warm');
    } finally {
      if (origDelay === undefined) delete process.env.GC_GATEWAY_LATEST_RETRY_MS;
      else process.env.GC_GATEWAY_LATEST_RETRY_MS = origDelay;
    }
  });
  // --- "Neu prüfen": a forced check, at most once a minute for the whole server ---

  it('checkNow asks GitHub whatever the age of the copy, but only once a minute; pending until the answer', async () => {
    const s = fresh();
    let calls = 0;
    let answer;
    s._setTransport(() => { calls++; return new Promise((r) => { answer = r; }); });
    try {
      s._setCache('1.30.0'); // a fresh copy: the regular check would not ask
      const first = s.checkNow();
      assert.equal(calls, 1, 'forced: asked although the copy is fresh');
      assert.equal(first.pending, true);
      assert.equal(s.isChecking(), true);
      // more clicks inside the minute (any gateway, any user): no further request
      assert.equal(s.checkNow().pending, true);
      answer({ status: 200, body: JSON.stringify({ tag_name: 'v1.31.0' }) });
      await new Promise((r) => setImmediate(r));
      assert.equal(s.isChecking(), false);
      assert.equal(s.getLatestVersion(), '1.31.0');
      assert.deepEqual(s.checkNow(), { pending: false });
      assert.equal(calls, 1, 'throttled: one request per minute');
      // a minute later it asks again
      s._resetForce();
      s.checkNow();
      assert.equal(calls, 2);
    } finally { s._setTransport(null); s._resetBackoff(); }
    assert.equal(s.FORCE_MIN_MS, 60 * 1000);
  });

  it('checkNow keeps the back-off after a failed fetch and never fires a real request in tests', async () => {
    const s = fresh();
    let calls = 0;
    s._setTransport(async () => { calls++; return { status: 503, body: '' }; });
    try {
      s.checkNow();
      await new Promise((r) => setImmediate(r));
      assert.equal(calls, 1);
      assert.equal(s.getStatus().failed, true);
      s._resetForce();
      assert.equal(s.checkNow().pending, false, 'inside the back-off: nothing is asked');
      assert.equal(calls, 1);
    } finally { s._setTransport(null); s._resetBackoff(); }
    // without a transport (test mode): no request, nothing pending
    const t = fresh();
    assert.deepEqual(t.checkNow(), { pending: false });
  });
});
