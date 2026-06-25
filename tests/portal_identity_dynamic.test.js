'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let portalIdentity, settings, getDb;
beforeEach(async () => {
  await setup();
  portalIdentity = require('../src/middleware/portalIdentity');
  settings = require('../src/services/settings');
  getDb = require('../src/db/connection').getDb;
  getDb().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('alice','k1','10.8.0.5/32',1,'regular')").run();
});
afterEach(teardown);

function runMw(hostname) {
  const req = { socket: { remoteAddress: '127.0.0.1' },
    get: h => (String(h).toLowerCase() === 'x-gc-portal-peer-ip' ? '10.8.0.5' : undefined), hostname };
  portalIdentity(req, {}, () => {});
  return req;
}

test('identity established for the configured public host', () => {
  settings.set('portal.base_domain', 'domaincaster.com');
  settings.set('portal.prefix', 'home');
  assert.ok(runMw('home.domaincaster.com').portalPeerId);
});

test('identity NOT established for a stale/foreign host', () => {
  settings.set('portal.base_domain', 'domaincaster.com');
  settings.set('portal.prefix', 'home');
  assert.equal(runMw('home.gc.internal').portalPeerId, null);
});
