'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

beforeEach(setup);
afterEach(teardown);

test('migration v45 creates route_auth_share_links + share_link_id column', () => {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(route_auth_share_links)").all().map(c => c.name);
  assert.ok(cols.includes('token_hash'));
  assert.ok(cols.includes('one_time'));
  assert.ok(cols.includes('redeemed_count'));
  assert.ok(cols.includes('revoked_at'));
  const sessCols = db.prepare("PRAGMA table_info(route_auth_sessions)").all().map(c => c.name);
  assert.ok(sessCols.includes('share_link_id'));
  // token_hash is UNIQUE
  const idx = db.prepare("PRAGMA index_list(route_auth_share_links)").all();
  assert.ok(idx.length >= 1);
});
