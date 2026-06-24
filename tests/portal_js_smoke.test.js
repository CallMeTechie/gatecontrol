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

test('portal.js is served and references the portal endpoints', async () => {
  const res = await supertest(app).get('/js/portal.js').expect(200);
  assert.match(res.text, /\/api\/v1\/portal\//);
});
