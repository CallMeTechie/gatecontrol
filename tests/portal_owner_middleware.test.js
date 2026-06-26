// tests/portal_owner_middleware.test.js
'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
let portalOwner, settings, getDb;
beforeEach(async () => { await setup(); portalOwner = require('../src/middleware/portalOwner'); settings = require('../src/services/settings'); getDb = require('../src/db/connection').getDb; });
afterEach(teardown);
function seedUser(n){ return getDb().prepare("INSERT INTO users (username,password_hash,role) VALUES (?,?,'admin')").run(n,'x').lastInsertRowid; }
function seedPeer(name, uid){ return getDb().prepare("INSERT INTO peers (name,public_key,allowed_ips,enabled,peer_type,user_id) VALUES (?,?,?,1,'regular',?)").run(name,name+'k',name+'/32',uid).lastInsertRowid; }
function run(req){ let nexted=false; portalOwner(req, {}, ()=>{ nexted=true; }); assert.ok(nexted,'must call next'); return req; }

test('logged in → owner=session.userId, source session (device irrelevant)', () => {
  const u = seedUser('alice'); const other = seedUser('bob'); const dev = seedPeer('10.8.0.9', other);
  const req = run({ session:{ userId:u }, portalPeerId: dev });
  assert.equal(req.portalOwnerId, u);          // session wins over device owner 'bob'
  assert.equal(req.portalOwnerSource, 'session');
  assert.equal(req.portalLoggedIn, true);
});
test('zero-login + trust OFF → owner null', () => {
  const u = seedUser('carol'); const dev = seedPeer('10.8.0.10', u);
  const req = run({ session:{}, portalPeerId: dev });
  assert.equal(req.portalOwnerId, null);
  assert.equal(req.portalOwnerSource, null);
  assert.equal(req.portalLoggedIn, false);
});
test('zero-login + trust ON + device has owner → owner=device.user_id, source device', () => {
  settings.set('portal.trust_owner_mapping','1');
  const u = seedUser('dave'); const dev = seedPeer('10.8.0.11', u);
  const req = run({ session:{}, portalPeerId: dev });
  assert.equal(req.portalOwnerId, u);
  assert.equal(req.portalOwnerSource, 'device');
});
test('zero-login + trust ON + device has NO owner → owner null', () => {
  settings.set('portal.trust_owner_mapping','1');
  const dev = seedPeer('10.8.0.12', null);
  const req = run({ session:{}, portalPeerId: dev });
  assert.equal(req.portalOwnerId, null);
  assert.equal(req.portalOwnerSource, null);
});
test('zero-login + trust ON + unidentified device → owner null', () => {
  settings.set('portal.trust_owner_mapping','1');
  const req = run({ session:{}, portalPeerId: null });
  assert.equal(req.portalOwnerId, null);
});
