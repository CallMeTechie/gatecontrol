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

describe('routes service: external_enabled persistence', () => {
  let routes, db;

  before(async () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-ext-svc-'));
    process.env.GC_DB_PATH = path.join(tmp2, 'test.db');
    process.env.GC_DATA_DIR = tmp2;
    process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
    process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
    [
      '../config/default',
      '../src/db/connection',
      '../src/db/migrations',
      '../src/services/gateways',
      '../src/services/routes',
      '../src/services/caddyConfig',
      '../src/services/license',
    ].forEach((p) => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({
      http_routes: -1,
      l4_routes: -1,
    });

    // Stub Caddy sync — no real HTTP calls in tests
    const caddy = require('../src/services/caddyConfig');
    caddy.syncToCaddy = async () => {};

    routes = require('../src/services/routes');
    db = require('../src/db/connection').getDb();
  });

  it('create without external_enabled stores 0 (default)', async () => {
    const created = await routes.create({
      domain: 'ext-default.example.com',
      target_ip: '10.8.0.10',
      target_port: 80,
    });
    const row = db.prepare('SELECT external_enabled FROM routes WHERE id = ?').get(created.id);
    assert.equal(row.external_enabled, 0, 'omitting external_enabled must default to 0');
  });

  it('create with external_enabled: true stores 1', async () => {
    const created = await routes.create({
      domain: 'ext-enabled.example.com',
      target_ip: '10.8.0.11',
      target_port: 80,
      external_enabled: true,
    });
    const row = db.prepare('SELECT external_enabled FROM routes WHERE id = ?').get(created.id);
    assert.equal(row.external_enabled, 1, 'external_enabled: true must persist as 1');
  });

  it('update toggles external_enabled; omitting the field preserves value via COALESCE', async () => {
    const created = await routes.create({
      domain: 'ext-update.example.com',
      target_ip: '10.8.0.12',
      target_port: 80,
    });

    // enable
    await routes.update(created.id, { external_enabled: true });
    const row1 = db.prepare('SELECT external_enabled FROM routes WHERE id = ?').get(created.id);
    assert.equal(row1.external_enabled, 1, 'after update with true → 1');

    // disable
    await routes.update(created.id, { external_enabled: false });
    const row2 = db.prepare('SELECT external_enabled FROM routes WHERE id = ?').get(created.id);
    assert.equal(row2.external_enabled, 0, 'after update with false → 0');

    // omit field — COALESCE preserves current value (0)
    await routes.update(created.id, { description: 'no-external-field' });
    const row3 = db.prepare('SELECT external_enabled FROM routes WHERE id = ?').get(created.id);
    assert.equal(row3.external_enabled, 0, 'update without field must leave value unchanged (COALESCE)');
  });
});
