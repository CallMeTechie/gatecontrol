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

test('create persists userId, returns it, and getById reflects it', async () => {
  const uid = seedUser('o1');
  const p = await peers.create({ name: 'devA', userId: uid });
  assert.equal(p.user_id, uid, 'create() return must include user_id');
  assert.equal(getDb().prepare('SELECT user_id FROM peers WHERE id=?').get(p.id).user_id, uid);
});
test('create without userId stores null (backward compatible)', async () => {
  const p = await peers.create({ name: 'legacy' });
  assert.equal(getDb().prepare('SELECT user_id FROM peers WHERE id=?').get(p.id).user_id, null);
});
test('update sets/clears userId; undefined leaves unchanged', async () => {
  const uid = seedUser('o2');
  const p = await peers.create({ name: 'devB', userId: uid });
  await peers.update(p.id, { name: 'devB' });
  assert.equal(getDb().prepare('SELECT user_id FROM peers WHERE id=?').get(p.id).user_id, uid);
  await peers.update(p.id, { userId: null });
  assert.equal(getDb().prepare('SELECT user_id FROM peers WHERE id=?').get(p.id).user_id, null);
});
