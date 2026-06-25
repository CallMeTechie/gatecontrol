// tests/pihole_portal_device.test.js
'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
// setup MUST be required before config/default so that GC_DB_PATH is set to the
// temp dir BEFORE config caches its dbPath value (config is a singleton).
const { setup, teardown } = require('./helpers/setup');
const config = require('../config/default');

const HOME_HOST = `home.${config.dns.domain}`;
let app, getDb, pihole, license, peerId;

beforeEach(async () => {
  await setup();
  app = require('../src/app').createApp();
  getDb = require('../src/db/connection').getDb;
  pihole = require('../src/services/pihole');
  license = require('../src/services/license');
  // a peer reachable by the portal-identity header (allowed_ips /32 must match)
  peerId = getDb().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('Dev','k','10.8.0.9/32',1,'regular')").run().lastInsertRowid;
  license.hasFeature = () => true; // Pro feature on for the success paths
});
afterEach(() => { teardown(); });

function ident(req) {
  // loopback source is supertest's own connection; supply header + home Host
  return req.set('X-GC-Portal-Peer-IP', '10.8.0.9').set('Host', HOME_HOST);
}

test('identified device with data → aggregated numbers only (no raw lists)', async () => {
  pihole.getCache = () => ({
    instances: [{ id:'p1', connected:true }], attribution: 'per_peer', lastSyncAt: 1750000000000,
    topClients:        [{ ip:'10.8.0.9', count:1019, peerId, peerName:'Dev' }],
    topClientsBlocked: [{ ip:'10.8.0.9', count:228,  peerId, peerName:'Dev' }],
  });
  const r = await ident(supertest(app).get('/api/v1/portal/pihole')).expect(200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(Object.keys(r.body.data).sort(), ['allowed','asOf','blocked','blockedPct','total']);
  assert.equal(r.body.data.total, 1247);
  assert.equal(r.body.data.blocked, 228);
  assert.equal(r.body.data.allowed, 1019);
  assert.equal(r.body.data.blockedPct, 18);
});

test('device in NEITHER list → reason no_data (not faked zeros)', async () => {
  pihole.getCache = () => ({ instances:[{id:'p1',connected:true}], attribution:'per_peer', lastSyncAt:1, topClients:[], topClientsBlocked:[] });
  const r = await ident(supertest(app).get('/api/v1/portal/pihole')).expect(200);
  assert.equal(r.body.data, null);
  assert.equal(r.body.reason, 'no_data');
});

test('device IN a list with genuine count:0 → data total:0 (NOT no_data)', async () => {
  pihole.getCache = () => ({ instances:[{id:'p1',connected:true}], attribution:'per_peer', lastSyncAt:1,
    topClients: [{ ip:'10.8.0.9', count:0, peerId, peerName:'Dev' }], topClientsBlocked: [] });
  const r = await ident(supertest(app).get('/api/v1/portal/pihole')).expect(200);
  assert.notEqual(r.body.data, null, 'in-list device must not be no_data');
  assert.equal(r.body.data.total, 0);
  assert.equal(r.body.data.blocked, 0);
  assert.equal(r.body.data.blockedPct, 0);
});

test('device in topClientsBlocked ONLY → allowed:0, blocked:N, pct:100', async () => {
  pihole.getCache = () => ({ instances:[{id:'p1',connected:true}], attribution:'per_peer', lastSyncAt:1,
    topClients: [], topClientsBlocked: [{ ip:'10.8.0.9', count:7, peerId, peerName:'Dev' }] });
  const r = await ident(supertest(app).get('/api/v1/portal/pihole')).expect(200);
  assert.equal(r.body.data.allowed, 0);
  assert.equal(r.body.data.blocked, 7);
  assert.equal(r.body.data.total, 7);
  assert.equal(r.body.data.blockedPct, 100);
});

test('device in topClients ONLY → blocked:0', async () => {
  pihole.getCache = () => ({ instances:[{id:'p1',connected:true}], attribution:'per_peer', lastSyncAt:1,
    topClients: [{ ip:'10.8.0.9', count:5, peerId, peerName:'Dev' }], topClientsBlocked: [] });
  const r = await ident(supertest(app).get('/api/v1/portal/pihole')).expect(200);
  assert.equal(r.body.data.blocked, 0);
  assert.equal(r.body.data.total, 5);
  assert.equal(r.body.data.blockedPct, 0);
});

test('collapsed attribution → reason collapsed', async () => {
  pihole.getCache = () => ({ instances:[{id:'p1',connected:true}], attribution:'collapsed', lastSyncAt:1, topClients:[], topClientsBlocked:[] });
  const r = await ident(supertest(app).get('/api/v1/portal/pihole')).expect(200);
  assert.equal(r.body.data, null);
  assert.equal(r.body.reason, 'collapsed');
});

test('feature off → reason unavailable', async () => {
  license.hasFeature = () => false;
  const r = await ident(supertest(app).get('/api/v1/portal/pihole')).expect(200);
  assert.equal(r.body.data, null);
  assert.equal(r.body.reason, 'unavailable');
});

test('not configured (no instances) → reason unavailable', async () => {
  pihole.getCache = () => ({ instances: [], attribution:'collapsed', lastSyncAt:null, topClients:[], topClientsBlocked:[] });
  const r = await ident(supertest(app).get('/api/v1/portal/pihole')).expect(200);
  assert.equal(r.body.data, null);
  assert.equal(r.body.reason, 'unavailable');
});

test('unidentified (no header) → reason unidentified', async () => {
  pihole.getCache = () => ({ instances:[{id:'p1',connected:true}], attribution:'per_peer', lastSyncAt:1, topClients:[], topClientsBlocked:[] });
  const r = await supertest(app).get('/api/v1/portal/pihole').set('Host', HOME_HOST).expect(200);
  assert.equal(r.body.data, null);
  assert.equal(r.body.reason, 'unidentified');
});

test('widget toggled off → 404', async () => {
  require('../src/services/settings').set('portal.widget.pihole', '0');
  const r = await ident(supertest(app).get('/api/v1/portal/pihole'));
  assert.equal(r.status, 404);
});
