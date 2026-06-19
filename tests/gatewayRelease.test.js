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
});
