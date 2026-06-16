'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Database = require('better-sqlite3');
const { migrations } = require('../src/db/migrationList');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-mig-ext-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let getDb;
before(() => {
  require('../src/db/migrations').runMigrations();
  getDb = require('../src/db/connection').getDb;
});

describe('migration: route_external_exposure', () => {
  it('adds external_enabled column with NOT NULL DEFAULT 0 to routes', () => {
    const cols = getDb().prepare('PRAGMA table_info(routes)').all();
    const col = cols.find((c) => c.name === 'external_enabled');
    assert.ok(col, 'external_enabled column must exist');
    assert.equal(col.notnull, 1, 'external_enabled must be NOT NULL');
    assert.equal(col.dflt_value, '0', 'external_enabled must default to 0');
  });

  it('new routes default to external_enabled = 0', () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO routes (domain, target_ip, target_port) VALUES ('new.example.com', '10.8.0.99', 8080)"
    ).run();
    const row = db
      .prepare("SELECT external_enabled FROM routes WHERE domain = 'new.example.com'")
      .get();
    assert.equal(row.external_enabled, 0);
  });

  it('is recorded as version 51', () => {
    const row = getDb()
      .prepare('SELECT version, name FROM migration_history WHERE version = 51')
      .get();
    assert.ok(row, 'migration 51 must be recorded');
    assert.equal(row.name, 'route_external_exposure');
  });

  it('backfills pre-existing routes to external_enabled = 1', () => {
    // Simulate the one-time backfill: build a DB up to v50, insert a legacy
    // route (no external_enabled column yet), then apply v51 SQL directly
    // to prove the UPDATE sets all pre-existing rows to external_enabled = 1.
    const db = new Database(':memory:');
    for (const m of migrations) {
      if (m.version <= 50) db.exec(m.sql);
    }
    db.prepare(
      "INSERT INTO routes (domain, target_ip, target_port, route_type) VALUES ('legacy.example.com', '127.0.0.1', 80, 'http')"
    ).run();
    const m51 = migrations.find((m) => m.version === 51);
    db.exec(m51.sql);
    const legacy = db
      .prepare("SELECT external_enabled FROM routes WHERE domain = 'legacy.example.com'")
      .get();
    assert.equal(legacy.external_enabled, 1, 'existing route backfilled to external_enabled = 1');
    db.close();
  });
});
