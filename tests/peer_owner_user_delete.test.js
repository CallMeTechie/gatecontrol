'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
let peers, users, getDb;
beforeEach(async () => { await setup(); peers = require('../src/services/peers'); users = require('../src/services/users'); getDb = require('../src/db/connection').getDb; });
afterEach(teardown);
// safe: setup() already seeds 1 admin, so removing this 2nd admin passes the last-admin guard.
test('removing a user clears user_id on their peers; peer survives', async () => {
  const uid = getDb().prepare("INSERT INTO users (username,password_hash,role) VALUES ('owner','x','admin')").run().lastInsertRowid;
  const p = await peers.create({ name: 'devC', userId: uid });
  users.remove(uid);
  assert.equal(getDb().prepare('SELECT user_id FROM peers WHERE id=?').get(p.id).user_id, null);
  assert.ok(getDb().prepare('SELECT 1 FROM peers WHERE id=?').get(p.id));
});
