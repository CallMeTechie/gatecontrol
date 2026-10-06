'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

let app;
beforeEach(async () => {
  await setup();
  app = require('../src/app').createApp();
});
afterEach(teardown);

test('GET /css/portal.css returns 200', async () => {
  await supertest(app).get('/css/portal.css').expect(200);
});

test('portal.css contains dark and light theme token blocks', async () => {
  const res = await supertest(app).get('/css/portal.css').expect(200);
  assert.ok(res.text.includes('[data-theme="dark"]'), 'missing dark theme block');
  assert.ok(res.text.includes('[data-theme="light"]'), 'missing light theme block');
});

test('portal.css styles the DNS-protection donut and the state rules', async () => {
  const res = await supertest(app).get('/css/portal.css').expect(200);
  assert.ok(res.text.includes('.pt-donut'), 'missing .pt-donut');
  assert.ok(res.text.includes('conic-gradient'), 'donut drawn with a conic gradient');
  for (const sel of ['.pt-empty', '.pt-msg', '.pt-hint', '[hidden]']) assert.ok(res.text.includes(sel), sel);
});

test('portal.js does NOT inject a <style> element (CSP-clean)', async () => {
  // The inline style injector was removed; all state CSS now lives in portal.css.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'portal.js'), 'utf8'
  );
  assert.ok(!src.includes("createElement('style')"),
    "portal.js must not inject a <style> element — it would be blocked by the page CSP");
});
