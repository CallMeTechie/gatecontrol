'use strict';

// Migration v75 `aurora_only` (docs/feature-aurora-only.md): data only —
// default_theme and every stored users.theme become 'aurora'; the users.theme
// column stays.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let db;
before(async () => {
  await setup();
  db = require('../src/db/connection').getDb();
});
after(teardown);

const v75 = () => require('../src/db/migrationList').migrations.find((m) => m.version === 75);

test('v75 is registered as aurora_only, applied, and pure SQL', () => {
  const m = v75();
  assert.ok(m, 'migration 75 exists');
  assert.equal(m.name, 'aurora_only');
  assert.equal(typeof m.sql, 'string');
  assert.doesNotMatch(m.sql, /\bDROP\b|\bALTER\b/i, 'no schema change');
  const row = db.prepare('SELECT name FROM migration_history WHERE version = 75').get();
  assert.equal(row && row.name, 'aurora_only');
  assert.ok(db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'theme'), 'users.theme column kept');
});

test('v75 normalises default_theme and every stored personal theme to aurora', () => {
  db.prepare("INSERT INTO settings (key, value) VALUES ('default_theme', 'pro') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  const ins = db.prepare("INSERT INTO users (username, password_hash, role, theme) VALUES (?, 'x', 'user', ?)");
  ins.run('t_default', 'default');
  ins.run('t_pro', 'pro');
  ins.run('t_aurora', 'aurora');
  ins.run('t_null', null);

  db.exec(v75().sql);

  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'default_theme'").get().value, 'aurora');
  const themes = Object.fromEntries(db.prepare("SELECT username, theme FROM users WHERE username LIKE 't\\_%' ESCAPE '\\'").all().map((r) => [r.username, r.theme]));
  assert.deepEqual(themes, { t_default: 'aurora', t_pro: 'aurora', t_aurora: 'aurora', t_null: null });
});

test('v75 is idempotent and does not create a default_theme row', () => {
  db.prepare("DELETE FROM settings WHERE key = 'default_theme'").run();
  db.exec(v75().sql);
  db.exec(v75().sql);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM settings WHERE key = 'default_theme'").get().c, 0);
});
