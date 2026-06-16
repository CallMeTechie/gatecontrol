'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || 'a'.repeat(64);
process.env.GC_SECRET = process.env.GC_SECRET || 'b'.repeat(64);

const Database = require('better-sqlite3');
const { migrations } = require('../src/db/migrationList');

function applyUpTo(db, version) {
  for (const m of migrations) {
    if (m.version <= version) db.exec(m.sql);
  }
}

test('migration 51 backfills existing routes to external (1), new rows default to internal (0)', () => {
  const db = new Database(':memory:');
  applyUpTo(db, 50);
  db.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type) VALUES ('legacy.example.com','127.0.0.1',80,'http')").run();
  const m51 = migrations.find(m => m.version === 51);
  assert.ok(m51, 'migration 51 exists');
  db.exec(m51.sql);

  const legacy = db.prepare("SELECT external_enabled FROM routes WHERE domain='legacy.example.com'").get();
  assert.strictEqual(legacy.external_enabled, 1, 'existing route backfilled to external=1');

  db.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type) VALUES ('new.example.com','127.0.0.1',80,'http')").run();
  const fresh = db.prepare("SELECT external_enabled FROM routes WHERE domain='new.example.com'").get();
  assert.strictEqual(fresh.external_enabled, 0, 'new route defaults to internal-only');
  db.close();
});
