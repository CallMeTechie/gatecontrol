'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');
beforeEach(setup); afterEach(teardown);
test('migration v46 creates access_rules', () => {
  const cols = getDb().prepare("PRAGMA table_info(access_rules)").all().map(c => c.name);
  for (const c of ['target_type','target_id','mode','schedule','valid_from','valid_until','label','enabled'])
    assert.ok(cols.includes(c), 'missing '+c);
});
