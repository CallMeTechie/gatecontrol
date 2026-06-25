'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
let getDb;
beforeEach(async () => { await setup(); getDb = require('../src/db/connection').getDb; });
afterEach(teardown);
test('peers has a nullable user_id column', () => {
  const col = getDb().prepare("PRAGMA table_info(peers)").all().find(c => c.name === 'user_id');
  assert.ok(col, 'user_id column missing'); assert.equal(col.notnull, 0);
});
test('idx_peers_user_id exists', () => {
  assert.ok(getDb().prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_peers_user_id'").get());
});
