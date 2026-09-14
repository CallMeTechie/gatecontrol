'use strict';

// Migration v76 `ops_center` (docs/feature-release-b.md §6/§7):
// backup_targets and users.last_seen_version.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let db;
before(async () => { await setup(); db = require('../src/db/connection').getDb(); });
after(teardown);

test('v76 is recorded as ops_center', () => {
  const row = db.prepare('SELECT name FROM migration_history WHERE version = 76').get();
  assert.equal(row && row.name, 'ops_center');
});

test('backup_targets columns, defaults and the type CHECK', () => {
  const cols = Object.fromEntries(db.prepare('PRAGMA table_info(backup_targets)').all().map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(cols), ['id', 'name', 'type', 'config_enc', 'enabled', 'keep', 'last_run_at', 'last_status', 'last_error', 'created_at']);
  for (const n of ['name', 'type', 'config_enc', 'enabled', 'keep', 'created_at']) assert.equal(cols[n].notnull, 1, n);
  assert.equal(String(cols.enabled.dflt_value), '1');
  assert.equal(String(cols.keep.dflt_value), '14');
  const ins = db.prepare("INSERT INTO backup_targets (name, type, config_enc, created_at) VALUES ('t', ?, 'x', '2026-09-14T00:00:00Z')");
  for (const t of ['sftp', 'smb', 's3', 'webdav']) ins.run(t);
  assert.throws(() => ins.run('ftp'), /CHECK constraint failed/);
  const r = db.prepare("SELECT enabled, keep FROM backup_targets WHERE type = 'sftp'").get();
  assert.deepEqual(r, { enabled: 1, keep: 14 });
});

test('users.last_seen_version is a nullable TEXT', () => {
  const col = db.prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'last_seen_version');
  assert.ok(col);
  assert.equal(col.type.toUpperCase(), 'TEXT');
  assert.equal(col.notnull, 0);
  assert.equal(db.prepare("SELECT last_seen_version FROM users WHERE username = 'admin'").get().last_seen_version, null);
});
