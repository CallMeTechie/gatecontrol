'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let getDb;
beforeEach(async () => { await setup(); getDb = require('../src/db/connection').getDb; });
afterEach(teardown);

test('domains table exists with expected columns', () => {
  const cols = getDb().prepare("PRAGMA table_info('domains')").all().map(c => c.name);
  for (const c of ['id','domain','status','resolved_ip','last_error','verified_at','last_checked_at','created_at']) {
    assert.ok(cols.includes(c), `missing column ${c}`);
  }
});
