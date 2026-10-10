'use strict';
// express-rate-limit 8: every limiter keys client addresses through
// ipKeyGenerator — IPv6 clients share one budget per /56 (rotating through
// the own prefix gives no fresh budget), and the option validation logs no
// ERR_ERL_* complaint (e.g. ERR_ERL_KEY_GEN_IPV6 for a raw req.ip key).
const crypto = require('crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

const logged = [];
const orig = { error: console.error, warn: console.warn };
console.error = (...args) => { logged.push(args.map(String).join(' ')); };
console.warn = (...args) => { logged.push(args.map(String).join(' ')); };
let limiters;
try {
  limiters = require('../src/middleware/rateLimit');
  require('../src/routes/api/me');
  require('../src/routes/api/client/supportBundle');
} finally {
  console.error = orig.error;
  console.warn = orig.warn;
}

function appFor(limiter) {
  const app = express();
  app.use((req, res, next) => {
    req.t = (k) => k;
    Object.defineProperty(req, 'ip', { value: req.get('x-test-ip'), configurable: true });
    next();
  });
  app.use(limiter);
  app.get('/', (req, res) => res.json({ ok: true }));
  return app;
}

test('limiter options pass express-rate-limit validation without warnings', () => {
  assert.deepEqual(logged.filter((l) => /ERR_ERL_/.test(l)), []);
});

test('IPv6 clients of one /56 share a budget, other prefixes and IPv4 do not', async () => {
  // routeAuthCodeLimiter: 3 requests per 5 minutes per client.
  const app = appFor(limiters.routeAuthCodeLimiter);
  const hit = (ip) => supertest(app).get('/').set('x-test-ip', ip);
  for (const ip of ['2001:db8:1:200::1', '2001:db8:1:2ab::2', '2001:db8:1:2ff:ffff::3']) {
    assert.equal((await hit(ip)).status, 200, ip);
  }
  assert.equal((await hit('2001:db8:1:2cd::99')).status, 429, 'same /56 → same budget');
  assert.equal((await hit('2001:db8:1:300::1')).status, 200, 'next /56 → own budget');
  assert.equal((await hit('198.51.100.7')).status, 200, 'IPv4 unaffected');
  for (let i = 0; i < 2; i++) await hit('198.51.100.7');
  assert.equal((await hit('::ffff:198.51.100.7')).status, 429, 'IPv4-mapped IPv6 counts as the IPv4 address');
});
