'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-mig-bundle-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let getDb;
before(() => {
  require('../src/db/migrations').runMigrations();
  getDb = require('../src/db/connection').getDb;
});

describe('migration: service_bundles', () => {
  it('creates the service_bundles table with expected columns', () => {
    const cols = getDb().prepare('PRAGMA table_info(service_bundles)').all();
    const names = cols.map((c) => c.name);
    for (const c of ['id', 'name', 'domain', 'description', 'created_at', 'updated_at']) {
      assert.ok(names.includes(c), 'missing column ' + c);
    }
    const domain = cols.find((c) => c.name === 'domain');
    assert.equal(domain.notnull, 0, 'domain must be nullable');
  });

  it('adds a nullable bundle_id column to routes', () => {
    const cols = getDb().prepare('PRAGMA table_info(routes)').all();
    const bundleId = cols.find((c) => c.name === 'bundle_id');
    assert.ok(bundleId, 'bundle_id column must exist');
    assert.equal(bundleId.notnull, 0, 'bundle_id must be nullable');
    assert.equal(bundleId.dflt_value, null, 'bundle_id must default to NULL');
  });

  it('creates the bundle index on routes', () => {
    const idx = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_routes_bundle'")
      .get();
    assert.ok(idx, 'idx_routes_bundle must exist');
  });

  it('narrows the unique domain index to http routes (L4 may share a domain)', () => {
    const idx = getDb()
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_routes_domain_unique'")
      .get();
    assert.ok(idx, 'idx_routes_domain_unique must exist');
    assert.match(idx.sql, /route_type = 'http'/, 'uniqueness must be scoped to http routes');
  });

  it('leaves routes unbundled by default', () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO routes (domain, target_ip, target_port) VALUES ('mig-test.example.com', '10.8.0.99', 8080)"
    ).run();
    const row = db
      .prepare("SELECT bundle_id FROM routes WHERE domain = 'mig-test.example.com'")
      .get();
    assert.equal(row.bundle_id, null);
  });

  it('is recorded as version 50 (gap at 49 is intentional)', () => {
    const row = getDb()
      .prepare('SELECT version, name FROM migration_history WHERE version = 50')
      .get();
    assert.ok(row, 'migration 50 must be recorded');
    assert.equal(row.name, 'service_bundles');
  });
});
