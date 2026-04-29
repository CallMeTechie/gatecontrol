'use strict';

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cadminretry-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let _caddyAdminWithRetry;

before(() => {
  // The migrations run pulls in the connection module that the
  // admin-client requires; without it, the require chain explodes
  // when caddyAdminClient pulls in services/caddyMaintenance.
  require('../src/db/migrations').runMigrations();
  ({ _caddyAdminWithRetry } = require('../src/services/caddyAdminClient'));
});

const FAST_RETRY = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 };

function timeoutErr() {
  const err = new Error('timeout');
  err.name = 'TimeoutError';
  return err;
}
function abortErr() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}
function econnrefused() {
  const err = new Error('connect ECONNREFUSED');
  err.cause = { code: 'ECONNREFUSED' };
  return err;
}
function econnreset() {
  const err = new Error('socket hang up');
  err.cause = { code: 'ECONNRESET' };
  return err;
}
function http503() {
  const err = new Error('Caddy API 503: down');
  err.status = 503;
  err.retryable = true;
  return err;
}
function http400() {
  const err = new Error('Caddy API 400: bad json');
  err.status = 400;
  err.retryable = false;
  return err;
}

describe('caddyAdminClient: _caddyAdminWithRetry', () => {
  it('passes through the result on first-try success', async () => {
    const fn = async () => 'ok';
    const out = await _caddyAdminWithRetry(fn, 'test', FAST_RETRY);
    assert.equal(out, 'ok');
  });

  it('returns null on ECONNREFUSED without retrying', async () => {
    let calls = 0;
    const fn = async () => { calls++; throw econnrefused(); };
    const out = await _caddyAdminWithRetry(fn, 'test', FAST_RETRY);
    assert.equal(out, null, 'ECONNREFUSED → null (legacy "Caddy not running" signal)');
    assert.equal(calls, 1, 'should NOT retry on ECONNREFUSED');
  });

  it('retries on TimeoutError up to maxRetries, then succeeds', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw timeoutErr();
      return 'eventually-ok';
    };
    const out = await _caddyAdminWithRetry(fn, 'test', FAST_RETRY);
    assert.equal(out, 'eventually-ok');
    assert.equal(calls, 3, '2 timeouts + 1 success');
  });

  it('retries on AbortError', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 2) throw abortErr();
      return 'ok';
    };
    const out = await _caddyAdminWithRetry(fn, 'test', FAST_RETRY);
    assert.equal(out, 'ok');
    assert.equal(calls, 2);
  });

  it('retries on ECONNRESET', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 2) throw econnreset();
      return 'ok';
    };
    const out = await _caddyAdminWithRetry(fn, 'test', FAST_RETRY);
    assert.equal(out, 'ok');
    assert.equal(calls, 2);
  });

  it('retries on retryable 5xx', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 2) throw http503();
      return 'ok';
    };
    const out = await _caddyAdminWithRetry(fn, 'test', FAST_RETRY);
    assert.equal(out, 'ok');
    assert.equal(calls, 2);
  });

  it('does NOT retry on 4xx', async () => {
    let calls = 0;
    const fn = async () => { calls++; throw http400(); };
    await assert.rejects(
      () => _caddyAdminWithRetry(fn, 'test', FAST_RETRY),
      /Caddy API 400/,
    );
    assert.equal(calls, 1, 'caller-bug 4xx must not be papered over by retries');
  });

  it('throws the last error after exhausting retries', async () => {
    let calls = 0;
    const fn = async () => { calls++; throw http503(); };
    await assert.rejects(
      () => _caddyAdminWithRetry(fn, 'test', FAST_RETRY),
      /Caddy API 503/,
    );
    assert.equal(calls, 1 + FAST_RETRY.maxRetries, 'initial + maxRetries attempts');
  });

  it('honours custom maxRetries', async () => {
    let calls = 0;
    const fn = async () => { calls++; throw timeoutErr(); };
    await assert.rejects(
      () => _caddyAdminWithRetry(fn, 'test', { ...FAST_RETRY, maxRetries: 0 }),
      /timeout/,
    );
    assert.equal(calls, 1, 'maxRetries=0 → exactly one attempt');
  });
});

describe('caddyAdminClient: backoff scaling', () => {
  it('uses exponential delay capped at maxDelayMs', async () => {
    const fn = async () => 'never';
    // Just confirm the helper does not crash on edge values.
    await _caddyAdminWithRetry(fn, 'test', { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 });
  });

  it('flat-line delays when baseDelayMs > maxDelayMs', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw timeoutErr();
      return 'ok';
    };
    const start = Date.now();
    await _caddyAdminWithRetry(fn, 'test', { maxRetries: 2, baseDelayMs: 5000, maxDelayMs: 1 });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 100, 'maxDelayMs=1 must clamp the backoff to ~1ms — elapsed ' + elapsed + 'ms');
  });
});
