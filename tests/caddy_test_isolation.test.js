'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// NODE_ENV=test is required (npm test sets it). Tests verify the
// production-safety guard: in test env, caddyApi/_caddyApi.patch MUST
// NOT open any HTTP connection to the Caddy admin API. Rationale: the
// deployed container uses network_mode: host, so 127.0.0.1:2019 from
// the test process actually hits production Caddy and would overwrite
// its live config with test-seeded routes (test.example.com, localhost).

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

test('NODE_ENV is test — sanity', () => {
  assert.equal(process.env.NODE_ENV, 'test', 'these tests are meaningful only under NODE_ENV=test');
});

test('caddyApi() does NOT call global.fetch in test env', async () => {
  const { caddyApi } = require('../src/services/caddyConfig');

  let fetchCallCount = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetchCallCount++;
    throw new Error('INTEGRATION LEAK: caddyApi called fetch() in test env');
  };

  try {
    await caddyApi('/config/');
    await caddyApi('/load', { method: 'POST', body: JSON.stringify({ apps: {} }) });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(fetchCallCount, 0, 'caddyApi must not issue any HTTP request in test env');
});

test('_caddyApi.patch() does NOT call http.request in test env', async () => {
  const { _caddyApi } = require('../src/services/caddyConfig');

  const http = require('node:http');
  let requestCallCount = 0;
  const originalRequest = http.request;
  http.request = (...args) => {
    requestCallCount++;
    throw new Error('INTEGRATION LEAK: _caddyApi.patch called http.request() in test env');
  };

  try {
    await _caddyApi.patch('/id/gc_route_1/handle', { handler: 'static_response' });
    await _caddyApi.patch('/id/gc_route_2/handle', 'revert');
  } finally {
    http.request = originalRequest;
  }

  assert.equal(requestCallCount, 0, '_caddyApi.patch must not issue any HTTP request in test env');
});

test('syncToCaddy() does NOT call global.fetch in test env (end-to-end)', async () => {
  const { syncToCaddy } = require('../src/services/caddyConfig');

  let fetchCallCount = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetchCallCount++;
    throw new Error('INTEGRATION LEAK: syncToCaddy reached fetch() in test env');
  };

  try {
    try { await syncToCaddy(); } catch (_) { /* non-DB errors ignored — we only care about fetch */ }
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(fetchCallCount, 0, 'syncToCaddy must be a no-op w.r.t. real Caddy in test env');
});
