'use strict';

// Pre-migration database snapshot (docs/feature-release-b.md §4): the
// migration runner copies the DB with VACUUM INTO before applying pending
// migrations, 0600/0700, keeps 3, aborts on failure unless
// GC_SKIP_PRE_MIGRATION_BACKUP=1; list/download API for admins.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, teardown, getAgent } = require('./helpers/setup');

let config;
let conn;
let runMigrations;
let pmb;
let dataDir;
let originalDbPath;

function useDb(name) {
  conn.closeDb();
  config.app.dbPath = path.join(dataDir, name);
  return conn.getDb();
}

/** Pretend the newest migration has not run yet: drop its schema + record. */
function rewindLatest(db) {
  const { migrations } = require('../src/db/migrationList');
  const latest = Math.max(...migrations.map((m) => m.version));
  db.prepare('DELETE FROM migration_history WHERE version = ?').run(latest);
  if (latest === 76) {
    db.exec('DROP TABLE backup_targets');
    db.exec('ALTER TABLE users DROP COLUMN last_seen_version');
  }
  return latest;
}

function maxRecorded(db) {
  return db.prepare('SELECT MAX(version) AS v FROM migration_history').get().v;
}

before(async () => {
  await setup();
  config = require('../config/default');
  conn = require('../src/db/connection');
  runMigrations = require('../src/db/migrations').runMigrations;
  pmb = require('../src/db/preMigrationBackup');
  originalDbPath = config.app.dbPath;
  dataDir = path.dirname(config.app.dbPath);
});

after(() => teardown());

describe('migration runner snapshot', () => {
  test('a fresh database gets no snapshot', () => {
    useDb('fresh.db');
    runMigrations();
    assert.equal(fs.existsSync(pmb.preMigrationDir(config.app.dbPath)), false);
  });

  test('pending migrations on an existing DB → VACUUM INTO copy, 0600 in a 0700 dir', () => {
    let db = useDb('existing.db');
    runMigrations();
    db.prepare("INSERT INTO settings (key, value) VALUES ('pmb.marker', 'before-migration')").run();
    const latest = rewindLatest(db);
    const from = maxRecorded(db);
    runMigrations();
    db = conn.getDb();
    assert.ok(db.prepare('SELECT 1 FROM migration_history WHERE version = ?').get(latest), 'migration applied afterwards');

    const dir = pmb.preMigrationDir(config.app.dbPath);
    const files = pmb.listSnapshots(config.app.dbPath);
    assert.equal(files.length, 1);
    const f = files[0];
    assert.match(f.name, new RegExp(`^gatecontrol-v${from}-v${latest}-\\d{8}-\\d{6}\\.db$`));
    assert.equal(f.from_version, from);
    assert.equal(f.to_version, latest);
    assert.ok(f.size > 0);
    assert.ok(Math.abs(Date.parse(f.created_at) - Date.now()) < 120000, 'created_at from the name (UTC)');
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, f.name)).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.partial')), [], 'no partial leftovers');

    // The copy is the state BEFORE the migration: data present, newest migration not recorded.
    const Database = require('better-sqlite3');
    const copy = new Database(path.join(dir, f.name), { readonly: true });
    try {
      assert.equal(copy.prepare("SELECT value FROM settings WHERE key = 'pmb.marker'").get().value, 'before-migration');
      assert.equal(copy.prepare('SELECT 1 FROM migration_history WHERE version = ?').get(latest), undefined);
      assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
    } finally { copy.close(); }
  });

  test('keeps the newest 3 snapshots', () => {
    const dir = pmb.preMigrationDir(config.app.dbPath);
    for (const ts of ['20200101-000000', '20200102-000000', '20200103-000000', '20200104-000000']) {
      fs.writeFileSync(path.join(dir, `gatecontrol-v1-v2-${ts}.db`), 'x', { mode: 0o600 });
    }
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'keep me');
    rewindLatest(conn.getDb());
    runMigrations();
    // today's snapshot(s) + 4 old ones → the 3 newest by the timestamp in the name
    // (a second run within the same second replaces the same-named file).
    const names = pmb.listSnapshots(config.app.dbPath).map((f) => f.name);
    assert.equal(names.length, 3);
    assert.ok(!names.includes('gatecontrol-v1-v2-20200101-000000.db'));
    assert.ok(!names.includes('gatecontrol-v1-v2-20200102-000000.db'));
    assert.ok(!names[0].includes('-v1-v2-'), 'newest is the real snapshot');
    assert.ok(fs.existsSync(path.join(dir, 'unrelated.txt')), 'foreign files untouched');
  });

  test('no pending migrations → no new snapshot', () => {
    const before = pmb.listSnapshots(config.app.dbPath).map((f) => f.name);
    runMigrations();
    assert.deepEqual(pmb.listSnapshots(config.app.dbPath).map((f) => f.name), before);
  });

  test('snapshot failure aborts BEFORE any migration runs', () => {
    const db = useDb('broken.db');
    runMigrations();
    const latest = rewindLatest(db);
    // A regular file where the snapshot directory must go → ENOTDIR/EEXIST.
    const dir = pmb.preMigrationDir(config.app.dbPath);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, 'not a directory');
    assert.throws(() => runMigrations(), (err) => {
      assert.equal(err.code, 'PRE_MIGRATION_BACKUP_FAILED');
      assert.match(err.message, /Pre-migration database backup failed/);
      assert.match(err.message, /GC_SKIP_PRE_MIGRATION_BACKUP=1/);
      return true;
    });
    assert.equal(conn.getDb().prepare('SELECT 1 FROM migration_history WHERE version = ?').get(latest), undefined,
      'nothing migrated');
  });

  test('entrypoint path (export-caddy-config) stops with the same message', () => {
    conn.closeDb(); // the child opens broken.db itself
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'bin', 'export-caddy-config.js'), path.join(dataDir, 'rt.json')], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        GC_DB_PATH: path.join(dataDir, 'broken.db'),
        GC_SECRET: 'x'.repeat(64),
        GC_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        GC_LOG_LEVEL: 'silent',
      },
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Pre-migration database backup failed/);
    assert.equal(fs.existsSync(path.join(dataDir, 'rt.json')), false);
    conn.getDb();
  });

  test('GC_SKIP_PRE_MIGRATION_BACKUP=1 migrates without a snapshot', () => {
    process.env.GC_SKIP_PRE_MIGRATION_BACKUP = '1';
    try {
      runMigrations();
    } finally {
      delete process.env.GC_SKIP_PRE_MIGRATION_BACKUP;
    }
    const { migrations } = require('../src/db/migrationList');
    const latest = Math.max(...migrations.map((m) => m.version));
    assert.ok(conn.getDb().prepare('SELECT 1 FROM migration_history WHERE version = ?').get(latest));
    fs.rmSync(pmb.preMigrationDir(config.app.dbPath), { force: true });
  });

  test('snapshotPath rejects anything but a strict snapshot name', () => {
    useDb('existing.db');
    require('../src/utils/fileModes').ensurePrivateDir(pmb.preMigrationDir(config.app.dbPath));
    fs.writeFileSync(path.join(pmb.preMigrationDir(config.app.dbPath), 'gatecontrol-v1-v2-20200103-000000.db'), 'x', { mode: 0o600 });
    for (const bad of ['../existing.db', 'gatecontrol-v1-v2-20200103-000000.db/../x', 'x.db', '.gatecontrol-v1-v2-20200103-000000.db', 'gatecontrol-v1-v2-2020-01-03.db']) {
      assert.equal(pmb.snapshotPath(config.app.dbPath, bad), null, bad);
    }
    assert.ok(pmb.snapshotPath(config.app.dbPath, 'gatecontrol-v1-v2-20200103-000000.db'));
  });
});

describe('GET /api/v1/settings/backup/pre-migration', () => {
  before(() => {
    // Back to the DB holding the login session; all DBs share one data dir,
    // hence one snapshot directory.
    conn.closeDb();
    config.app.dbPath = originalDbPath;
    conn.getDb();
  });

  test('lists snapshots with versions', async () => {
    const res = await getAgent().get('/api/v1/settings/backup/pre-migration');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.files) && res.body.files.length >= 1);
    for (const f of res.body.files) {
      assert.deepEqual(Object.keys(f).sort(), ['created_at', 'from_version', 'name', 'size', 'to_version']);
    }
  });

  test('downloads a snapshot as attachment', async () => {
    const res = await getAgent().get('/api/v1/settings/backup/pre-migration/gatecontrol-v1-v2-20200103-000000.db')
      .buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-disposition'], /attachment; filename="gatecontrol-v1-v2-20200103-000000\.db"/);
    assert.equal(res.body.toString(), 'x');
  });

  test('strict name validation: 400 for bad names, 404 for unknown', async () => {
    const bad = await getAgent().get('/api/v1/settings/backup/pre-migration/..%2Fexisting.db');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_NAME');
    const bad2 = await getAgent().get('/api/v1/settings/backup/pre-migration/gatecontrol.db');
    assert.equal(bad2.status, 400);
    const missing = await getAgent().get('/api/v1/settings/backup/pre-migration/gatecontrol-v9-v10-20990101-000000.db');
    assert.equal(missing.status, 404);
  });

  test('not reachable without a session', async () => {
    const supertest = require('supertest');
    const { createApp } = require('../src/app');
    const res = await supertest(createApp()).get('/api/v1/settings/backup/pre-migration');
    assert.ok([401, 403].includes(res.status) || res.status === 302, `status ${res.status}`);
  });
});
