'use strict';

// Owner-only modes for sensitive files in the data volume: the SQLite DB and
// its -wal/-shm, the JSON backups (+ their dir), Caddy's runtime.json — both
// at creation time and as boot-time tightening of files older versions left
// world-readable. Files other uids must read (dnsmasq → dns/peers.hosts, host
// update.sh → .auto-update-*.json) and public material must stay untouched.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The container runs every process with the default umask 022 — emulate it
// so the tests prove the modes come from the code, not from a strict umask.
process.umask(0o022);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-filemodes-'));
const dbPath = path.join(tmp, 'data', 'gatecontrol.db');
const backupDir = path.join(tmp, 'data', 'backups');
const caddyDir = path.join(tmp, 'data', 'caddy');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

process.env.NODE_ENV = 'test';
process.env.GC_DB_PATH = dbPath;
process.env.GC_BACKUP_DIR = backupDir;
process.env.GC_CADDY_DATA_DIR = caddyDir;
process.env.GC_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.GC_LOG_LEVEL = 'silent';

const fileModes = require('../src/utils/fileModes');

const modeOf = (p) => fs.statSync(p).mode & 0o777;
const oct = (m) => '0' + m.toString(8);
function assertMode(p, expected) {
  assert.equal(oct(modeOf(p)), oct(expected), `${path.relative(tmp, p)}`);
}
function writeWithMode(p, content, mode) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  fs.chmodSync(p, mode);
}

after(() => {
  try { require('../src/db/connection').closeDb(); } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('utils/fileModes', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(tmp, 'u-')); });

  it('restrictToOwner strips group/other bits and keeps owner bits', () => {
    const f = path.join(dir, 'f');
    writeWithMode(f, 'x', 0o644);
    assert.equal(fileModes.restrictToOwner(f), true);
    assertMode(f, 0o600);
    assert.equal(fileModes.restrictToOwner(f), false, 'idempotent');

    const d = path.join(dir, 'd');
    fs.mkdirSync(d);
    fs.chmodSync(d, 0o755);
    assert.equal(fileModes.restrictToOwner(d), true);
    assertMode(d, 0o700);
  });

  it('restrictToOwner ignores missing paths and does not follow symlinks', () => {
    assert.equal(fileModes.restrictToOwner(path.join(dir, 'missing')), false);
    const target = path.join(dir, 'target');
    writeWithMode(target, 'x', 0o644);
    const link = path.join(dir, 'link');
    fs.symlinkSync(target, link);
    assert.equal(fileModes.restrictToOwner(link), false);
    assertMode(target, 0o644);
  });

  it('ensurePrivateDir creates a 0700 leaf, tightens an existing one, leaves parents alone', () => {
    const parent = path.join(dir, 'p');
    const leaf = path.join(parent, 'leaf');
    fileModes.ensurePrivateDir(leaf);
    assertMode(leaf, 0o700);
    assertMode(parent, 0o755);

    fs.chmodSync(leaf, 0o755);
    assert.equal(fileModes.ensurePrivateDir(leaf), true);
    assertMode(leaf, 0o700);
  });

  it('restrictDbFiles covers the DB, -wal/-shm/-journal and copies — nothing else', () => {
    const d = fs.mkdtempSync(path.join(tmp, 'db-'));
    const db = path.join(d, 'gatecontrol.db');
    const sensitive = ['gatecontrol.db', 'gatecontrol.db-wal', 'gatecontrol.db-shm', 'gatecontrol.db-journal',
      'gatecontrol.db.bak-20260612-103912', 'gatecontrol.db.bak-pre-1.119.0-shm'];
    const other = ['gatecontrol.dbx', 'gateway-latest-version.json', '.auto-update-config.json'];
    for (const n of [...sensitive, ...other]) writeWithMode(path.join(d, n), 'x', 0o644);

    const changed = fileModes.restrictDbFiles(db).map((p) => path.basename(p)).sort();
    assert.deepEqual(changed, [...sensitive].sort());
    for (const n of sensitive) assertMode(path.join(d, n), 0o600);
    for (const n of other) assertMode(path.join(d, n), 0o644);
  });

  it('precreatePrivateFile creates 0600 and never touches an existing file', () => {
    const f = path.join(dir, 'pre.db');
    fileModes.precreatePrivateFile(f);
    assertMode(f, 0o600);
    assert.equal(fs.statSync(f).size, 0);

    fs.writeFileSync(f, 'keep');
    fs.chmodSync(f, 0o640);
    fileModes.precreatePrivateFile(f);
    assert.equal(fs.readFileSync(f, 'utf8'), 'keep');
    assertMode(f, 0o640);
  });
});

describe('restrictSensitiveDataFiles (boot-time tightening of a legacy /data)', () => {
  it('tightens DB, copies, backups and runtime.json; leaves shared/public files alone', () => {
    const data = fs.mkdtempSync(path.join(tmp, 'legacy-'));
    fs.chmodSync(data, 0o755);
    const p = (...s) => path.join(data, ...s);

    const sensitiveFiles = [
      p('gatecontrol.db'), p('gatecontrol.db-wal'), p('gatecontrol.db-shm'),
      p('gatecontrol.db.bak-pre-1.124.1-wal'),
      p('backups', 'gatecontrol-20260911-133737.json'), p('backups', 'gatecontrol-20260913-195046.json'),
      p('caddy', 'runtime.json'),
    ];
    const untouchedFiles = [
      p('dns', 'peers.hosts'),                // dnsmasq (uid 100) re-reads it on SIGHUP
      p('.auto-update-config.json'),          // host update.sh
      p('.auto-update-state.json'),
      p('gateway-latest-version.json'),
      p('branding', '1-1774039528463.png'),   // served publicly
      p('caddy', 'mtls', '7.pem'),            // CA bundle (public)
    ];
    for (const f of [...sensitiveFiles, ...untouchedFiles]) writeWithMode(f, '{}', 0o644);
    for (const d of ['backups', 'caddy', 'dns', 'branding']) fs.chmodSync(p(d), 0o755);

    const changed = fileModes.restrictSensitiveDataFiles({
      dbPath: p('gatecontrol.db'), backupDir: p('backups'), caddyDataDir: p('caddy'),
    });

    for (const f of sensitiveFiles) assertMode(f, 0o600);
    assertMode(p('backups'), 0o700);
    for (const f of untouchedFiles) assertMode(f, 0o644);
    for (const d of ['caddy', 'dns', 'branding']) assertMode(p(d), 0o755);
    assertMode(data, 0o755);
    assert.equal(changed.length, sensitiveFiles.length + 1);

    assert.deepEqual(fileModes.restrictSensitiveDataFiles({
      dbPath: p('gatecontrol.db'), backupDir: p('backups'), caddyDataDir: p('caddy'),
    }), [], 'second run changes nothing');
  });

  it('tolerates missing paths', () => {
    const none = path.join(tmp, 'does-not-exist');
    assert.deepEqual(fileModes.restrictSensitiveDataFiles({
      dbPath: path.join(none, 'gatecontrol.db'), backupDir: path.join(none, 'backups'), caddyDataDir: none,
    }), []);
    assert.deepEqual(fileModes.restrictSensitiveDataFiles(), []);
  });
});

describe('db/connection — SQLite files are created owner-only', () => {
  it('a fresh DB and the -wal/-shm SQLite derives from it are 0600', () => {
    assert.equal(fs.existsSync(dbPath), false);
    const { getDb } = require('../src/db/connection');
    const { runMigrations } = require('../src/db/migrations');
    runMigrations();
    getDb().exec('CREATE TABLE IF NOT EXISTS _fm_probe (x INTEGER); INSERT INTO _fm_probe VALUES (1);');
    assertMode(dbPath, 0o600);
    assert.ok(fs.existsSync(dbPath + '-wal'), 'WAL file exists while the connection is open');
    assertMode(dbPath + '-wal', 0o600);
    assertMode(dbPath + '-shm', 0o600);
  });

  it('an existing world-readable DB with live -wal/-shm is tightened on open', () => {
    // Child process: getDb() is a per-process singleton.
    const legacy = path.join(fs.mkdtempSync(path.join(tmp, 'legacy-db-')), 'gatecontrol.db');
    const script = `
      const Database = require('better-sqlite3');
      const fs = require('node:fs');
      process.umask(0o022);
      const p = process.env.GC_DB_PATH;
      const old = new Database(p);                 // like an older version: 0644
      old.pragma('journal_mode = WAL');
      old.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1);');
      const before = [p, p + '-wal', p + '-shm'].map((f) => (fs.statSync(f).mode & 0o777).toString(8));
      const { getDb } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'db', 'connection.js'))});
      getDb().prepare('INSERT INTO t VALUES (2)').run();
      const after = [p, p + '-wal', p + '-shm'].map((f) => (fs.statSync(f).mode & 0o777).toString(8));
      process.stdout.write(JSON.stringify({ before, after }));
    `;
    const r = spawnSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, GC_DB_PATH: legacy },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const { before, after: afterModes } = JSON.parse(r.stdout);
    assert.deepEqual(before, ['644', '644', '644']);
    assert.deepEqual(afterModes, ['600', '600', '600']);
  });
});

describe('autobackup — backups are 0600 in a 0700 dir', () => {
  let autobackup;
  before(() => {
    autobackup = require('../src/services/autobackup');
    assert.equal(autobackup.BACKUP_DIR, backupDir);
  });

  it('runBackup creates the dir 0700 and the file 0600, no tmp leftovers', () => {
    assert.equal(fs.existsSync(backupDir), false);
    const filename = autobackup.runBackup();
    assertMode(backupDir, 0o700);
    assertMode(path.join(backupDir, filename), 0o600);
    assert.deepEqual(fs.readdirSync(backupDir), [filename]);
    const parsed = JSON.parse(fs.readFileSync(path.join(backupDir, filename), 'utf8'));
    assert.ok(parsed.version, 'backup content is complete JSON');
  });

  it('list/download path still sees the file; an old 0755 dir is tightened on use', () => {
    fs.chmodSync(backupDir, 0o755);
    const files = autobackup.listBackupFiles();
    assert.equal(files.length, 1);
    assertMode(backupDir, 0o700);
    const fp = autobackup.getBackupFilePath(files[0].filename);
    assert.equal(fp, path.join(backupDir, files[0].filename));
    fs.accessSync(fp, fs.constants.R_OK);
  });
});

describe('Caddy runtime.json is written 0600', () => {
  it('_persistRuntimeJson replaces a world-readable runtime.json with a 0600 one', () => {
    const target = path.join(caddyDir, 'runtime.json');
    writeWithMode(target, '{"old":true}', 0o644);
    const { _persistRuntimeJson } = require('../src/services/caddyAdminClient');
    assert.equal(_persistRuntimeJson({ apps: { http: {} } }), true);
    assertMode(target, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { apps: { http: {} } });
    assert.deepEqual(fs.readdirSync(caddyDir), ['runtime.json'], 'no tmp leftovers');
  });

  it('export-caddy-config.js (entrypoint) writes runtime.json 0600', () => {
    const out = path.join(fs.mkdtempSync(path.join(tmp, 'export-')), 'runtime.json');
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'bin', 'export-caddy-config.js'), out], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        GC_DB_PATH: path.join(path.dirname(out), 'export.db'),
        GC_BASE_URL: 'https://gc.example.com',
        GC_WG_HOST: 'gc.example.com',
        GC_SECRET: 'b'.repeat(64),
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assertMode(out, 0o600);
    assert.ok(JSON.parse(fs.readFileSync(out, 'utf8')).apps.http, 'valid Caddy JSON');
    assertMode(path.join(path.dirname(out), 'export.db'), 0o600);
  });
});
