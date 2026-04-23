'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const crypto = require('node:crypto');

const { hasColumn, tableExists, computeChecksum } = require('../src/db/migrationHelpers');

test('tableExists: true for existing table, false otherwise', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);');
  assert.equal(tableExists(db, 'users'), true);
  assert.equal(tableExists(db, 'nonexistent'), false);
});

test('hasColumn: true for existing column, false otherwise', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE routes (id INTEGER PRIMARY KEY, domain TEXT, enabled INTEGER);');
  assert.equal(hasColumn(db, 'routes', 'domain'), true);
  assert.equal(hasColumn(db, 'routes', 'enabled'), true);
  assert.equal(hasColumn(db, 'routes', 'missing_column'), false);
});

test('computeChecksum: deterministic SHA-256 of trimmed SQL', () => {
  const sql = '  CREATE TABLE foo (id INTEGER);  \n';
  const expected = crypto.createHash('sha256').update(sql.trim()).digest('hex');
  assert.equal(computeChecksum(sql), expected);
  assert.equal(computeChecksum(sql), computeChecksum('CREATE TABLE foo (id INTEGER);'));
  assert.notEqual(computeChecksum('A'), computeChecksum('B'));
});

test('migrationList exports the migrations array with expected shape', () => {
  const { migrations } = require('../src/db/migrationList');
  assert.ok(Array.isArray(migrations));
  assert.ok(migrations.length >= 39, 'at least 39 migrations expected');
  for (const m of migrations) {
    assert.equal(typeof m.version, 'number');
    assert.equal(typeof m.name, 'string');
    assert.equal(typeof m.sql, 'string');
  }
});

test('migrationLegacy exports bootstrap + detect functions', () => {
  const legacy = require('../src/db/migrationLegacy');
  assert.equal(typeof legacy.bootstrapMigrationHistory, 'function');
  assert.equal(typeof legacy.detectAppliedLegacyMigrations, 'function');
});

test('bootstrapMigrationHistory creates migration_history table idempotently', () => {
  const { bootstrapMigrationHistory } = require('../src/db/migrationLegacy');
  const db = new Database(':memory:');
  bootstrapMigrationHistory(db);
  assert.equal(tableExists(db, 'migration_history'), true);
  bootstrapMigrationHistory(db);
  assert.equal(tableExists(db, 'migration_history'), true);
  assert.equal(hasColumn(db, 'migration_history', 'version'), true);
  assert.equal(hasColumn(db, 'migration_history', 'name'), true);
  assert.equal(hasColumn(db, 'migration_history', 'applied_at'), true);
  assert.equal(hasColumn(db, 'migration_history', 'checksum'), true);
});
