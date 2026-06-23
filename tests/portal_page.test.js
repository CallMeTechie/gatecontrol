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
  assert.match(res.text, /<script nonce="[^"]+">/);
});

test('a disabled-master portal returns 404', async () => {
  require('../src/services/settings').set('portal.enabled', '0');
  await supertest(app).get('/portal').set('X-GC-Portal-Peer-IP', '10.8.0.5').expect(404);
});

test('GET /portal without reserved header renders generic welcome (fail-safe)', async () => {
  const res = await supertest(app).get('/portal').expect(200);
  assert.match(res.text, /portal\.css/);
});

test('no untranslated portal key leaks in EN render', async () => {
  getDb().prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type)
                   VALUES ('Test Device','k2','10.8.0.6/32',1,'regular')`).run();
  const res = await supertest(app).get('/portal?lang=en').set('X-GC-Portal-Peer-IP', '10.8.0.6').expect(200);
  // portal.css and portal.js are expected; no other portal.* key should appear as-is
  assert.doesNotMatch(res.text, /portal\.(?!css\b|js\b)[a-z_]+/i, 'untranslated portal key leaked in EN');
  // Confirm a known EN string is rendered (device widget heading)
  assert.match(res.text, /Device/, 'expected EN translation "Device" in EN render');
});

test('no untranslated portal key leaks in DE render', async () => {
  getDb().prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type)
                   VALUES ('Test Gerät','k3','10.8.0.7/32',1,'regular')`).run();
  const res = await supertest(app).get('/portal?lang=de').set('X-GC-Portal-Peer-IP', '10.8.0.7').expect(200);
  assert.doesNotMatch(res.text, /portal\.(?!css\b|js\b)[a-z_]+/i, 'untranslated portal key leaked in DE');
  // Confirm a known DE string is rendered (device widget heading)
  assert.match(res.text, /Gerät/, 'expected DE translation "Gerät" in DE render');
});
