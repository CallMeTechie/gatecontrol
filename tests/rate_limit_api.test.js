'use strict';
// Verifies apiLimiter.skipFailedRequests: failed (4xx/5xx) responses must NOT
// deplete the rate-limit window (so a 429 storm can't pin the counter), while
// successful requests still count and the limiter still trips.
const crypto = require('crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_RATE_LIMIT_API = '5'; // low limit so the test is fast (set before requiring config)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');
const { apiLimiter } = require('../src/middleware/rateLimit');

function makeApp() {
  const app = express();
  app.use((req, res, next) => { req.t = (k) => k; next(); }); // i18n stub for the 429 handler
  app.use(apiLimiter);
  app.get('/ok', (req, res) => res.json({ ok: true }));
  app.get('/fail', (req, res) => res.status(401).json({ ok: false }));
  return app;
}

test('failed requests do not deplete the API rate-limit window', async () => {
  const app = makeApp();
  // Fire well past the limit (max=5) — all should stay 401, never 429.
  let saw429 = false;
  for (let i = 0; i < 12; i++) {
    const res = await supertest(app).get('/fail');
    if (res.status === 429) saw429 = true;
    assert.equal(res.status, 401, `request ${i} should be 401, got ${res.status}`);
  }
  assert.equal(saw429, false, 'failed requests must never trip the limiter');
});

test('successful requests still count and trip the limiter', async () => {
  const app = makeApp();
  // Same shared limiter; successful requests accumulate and must trip at max+1.
  let saw429 = false;
  for (let i = 0; i < 9; i++) {
    const res = await supertest(app).get('/ok');
    if (res.status === 429) saw429 = true;
  }
  assert.equal(saw429, true, 'successful requests beyond the limit must trip the limiter (429)');
});
