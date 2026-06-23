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

test('portal.css does NOT contain Pi-hole/donut styles (correctly trimmed)', async () => {
  const res = await supertest(app).get('/css/portal.css').expect(200);
  assert.ok(!res.text.includes('.donut'), 'found .donut — Pi-hole styles not fully removed');
  assert.ok(!res.text.includes('.pi-wrap'), 'found .pi-wrap — Pi-hole styles not fully removed');
  assert.ok(!res.text.includes('.c-pihole'), 'found .c-pihole — Pi-hole grid span not removed');
});
