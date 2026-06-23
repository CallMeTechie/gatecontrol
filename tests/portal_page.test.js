'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

let app, getDb;
beforeEach(async () => {
  await setup();
  getDb = require('../src/db/connection').getDb;
  app = require('../src/app').createApp();
});
afterEach(teardown);

test('GET /portal renders the page with the device name for a known peer', async () => {
  getDb().prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type)
                   VALUES ('Marc Phone','k1','10.8.0.5/32',1,'regular')`).run();
  const res = await supertest(app).get('/portal').set('X-GC-Portal-Peer-IP', '10.8.0.5').expect(200);
  assert.match(res.text, /portal\.css/);
  assert.match(res.text, /Marc Phone/);
});

test('a disabled-master portal returns 404', async () => {
  require('../src/services/settings').set('portal.enabled', '0');
  await supertest(app).get('/portal').set('X-GC-Portal-Peer-IP', '10.8.0.5').expect(404);
});

test('GET /portal without reserved header renders generic welcome (fail-safe)', async () => {
  const res = await supertest(app).get('/portal').expect(200);
  assert.match(res.text, /portal\.css/);
});
