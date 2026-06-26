'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
let peers, getDb;
beforeEach(async () => { await setup(); peers = require('../src/services/peers'); getDb = require('../src/db/connection').getDb; });
afterEach(teardown);
function seedUser(n){ return getDb().prepare("INSERT INTO users (username,password_hash,role) VALUES (?,?,'admin')").run(n,'x').lastInsertRowid; }
function seedPeer(name, uid){ return getDb().prepare("INSERT INTO peers (name,public_key,allowed_ips,enabled,peer_type,user_id) VALUES (?,?,?,1,'regular',?)").run(name,name+'k',name+'/32',uid).lastInsertRowid; }

test('peersOfOwner returns only the owner\'s peer ids', () => {
  const u1 = seedUser('o1'), u2 = seedUser('o2');
  const a = seedPeer('10.8.0.1', u1); const b = seedPeer('10.8.0.2', u1); seedPeer('10.8.0.3', u2);
  const ids = peers.peersOfOwner(u1).sort((x,y)=>x-y);
  assert.deepEqual(ids, [a,b].sort((x,y)=>x-y));
});
test('peersOfOwner returns [] for an owner with no peers and for null', () => {
  const u = seedUser('lonely');
  assert.deepEqual(peers.peersOfOwner(u), []);
  assert.deepEqual(peers.peersOfOwner(null), []);
});
