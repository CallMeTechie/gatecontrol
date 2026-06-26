// tests/pihole_portal_owner.test.js
'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
// setup MUST be required before config/default so NODE_ENV=test is set before
// config/default.js is evaluated (it throws on missing GC_SECRET in non-test mode).
const { setup, teardown, getAgent } = require('./helpers/setup');
const config = require('../config/default');
const HOME_HOST = `home.${config.dns.domain}`;
let app, getDb, pihole, license, adminId, p1, p2, foreignPeer, foreignUser;

beforeEach(async () => {
  await setup();
  app = require('../src/app').createApp();
  getDb = require('../src/db/connection').getDb;
  pihole = require('../src/services/pihole');
  license = require('../src/services/license');
  license.hasFeature = () => true;
  adminId = getDb().prepare("SELECT id FROM users WHERE username='admin'").get().id; // getAgent() is this user
  p1 = getDb().prepare("INSERT INTO peers (name,public_key,allowed_ips,enabled,peer_type,user_id) VALUES ('m1','k1','10.8.0.5/32',1,'regular',?)").run(adminId).lastInsertRowid;
  p2 = getDb().prepare("INSERT INTO peers (name,public_key,allowed_ips,enabled,peer_type,user_id) VALUES ('m2','k2','10.8.0.6/32',1,'regular',?)").run(adminId).lastInsertRowid;
  foreignUser = getDb().prepare("INSERT INTO users (username,password_hash,role) VALUES ('bob','x','admin')").run().lastInsertRowid;
  foreignPeer = getDb().prepare("INSERT INTO peers (name,public_key,allowed_ips,enabled,peer_type,user_id) VALUES ('b1','k3','10.8.0.50/32',1,'regular',?)").run(foreignUser).lastInsertRowid;
});
afterEach(() => { teardown(); });

function cacheWith(extra){ return Object.assign({ instances:[{id:'p1',connected:true}], attribution:'per_peer', lastSyncAt:1750000000000, topClients:[], topClientsBlocked:[] }, extra); }

test('logged-in owner → aggregate over OWN devices only (+ deviceCount), no foreign device', async () => {
  pihole.getCache = () => cacheWith({
    topClients:        [{ ip:'10.8.0.5', count:500, peerId:p1, peerName:'m1' }, { ip:'10.8.0.6', count:300, peerId:p2, peerName:'m2' }, { ip:'10.8.0.50', count:999, peerId:foreignPeer, peerName:'b1' }],
    topClientsBlocked: [{ ip:'10.8.0.5', count:50,  peerId:p1, peerName:'m1' }, { ip:'10.8.0.50', count:888, peerId:foreignPeer, peerName:'b1' }],
  });
  const r = await getAgent().get('/api/v1/portal/pihole/owner').expect(200);
  assert.equal(r.body.data.allowed, 800);     // 500+300, NOT 999
  assert.equal(r.body.data.blocked, 50);       // 50, NOT 888
  assert.equal(r.body.data.total, 850);
  assert.equal(r.body.data.deviceCount, 2);    // p1 + p2
  assert.deepEqual(Object.keys(r.body.data).sort(), ['allowed','asOf','blocked','blockedPct','deviceCount','total']);
});
test('IDOR: a foreign owner_id in body/query is ignored', async () => {
  pihole.getCache = () => cacheWith({ topClients:[{ ip:'10.8.0.50', count:999, peerId:foreignPeer, peerName:'b1' }] });
  const r = await getAgent().get('/api/v1/portal/pihole/owner?user_id=' + foreignUser).send({ user_id: foreignUser }).expect(200);
  // admin owns p1/p2 which are NOT in the cache here → no_data, never the foreign 999
  assert.equal(r.body.data, null);
  assert.equal(r.body.reason, 'no_data');
});
test('owner with devices but none in lists → no_data', async () => {
  pihole.getCache = () => cacheWith({});
  const r = await getAgent().get('/api/v1/portal/pihole/owner').expect(200);
  assert.equal(r.body.data, null); assert.equal(r.body.reason, 'no_data');
});
test('not logged in, trust off → no_owner', async () => {
  pihole.getCache = () => cacheWith({});
  const r = await supertest(app).get('/api/v1/portal/pihole/owner').set('Host', HOME_HOST).expect(200);
  assert.equal(r.body.data, null); assert.equal(r.body.reason, 'no_owner');
});
test('collapsed → collapsed', async () => {
  pihole.getCache = () => cacheWith({ attribution:'collapsed' });
  const r = await getAgent().get('/api/v1/portal/pihole/owner').expect(200);
  assert.equal(r.body.data, null); assert.equal(r.body.reason, 'collapsed');
});
test('feature off → unavailable', async () => {
  license.hasFeature = () => false;
  const r = await getAgent().get('/api/v1/portal/pihole/owner').expect(200);
  assert.equal(r.body.data, null); assert.equal(r.body.reason, 'unavailable');
});
test('logged-in but user deleted (peers user_id nulled) → no_data, not no_owner', async () => {
  getDb().prepare('UPDATE peers SET user_id = NULL WHERE user_id = ?').run(adminId); // simulate TP1 cleanup
  pihole.getCache = () => cacheWith({ topClients:[{ ip:'10.8.0.5', count:5, peerId:p1, peerName:'m1' }] });
  const r = await getAgent().get('/api/v1/portal/pihole/owner').expect(200);
  assert.equal(r.body.data, null); assert.equal(r.body.reason, 'no_data');
});
