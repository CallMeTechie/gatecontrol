'use strict';

// Plugin data in backups (docs/plugins.md "Backup"): up to MAX_PLUGIN_BYTES
// (512 MB raw) per backup, never held in memory — written from a snapshot
// folder, read back in pieces (utils/jsonSpool) — and a plugin part that does
// not fit (or cannot be read) is visible: skipped + reason in the backup,
// `plugins_incomplete` in the file, the backup list, the off-site target
// list, the restore test, the dashboard problems, the log and the
// "Backup-Probleme" notifications. The caps are scaled down here.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-plugin-cap-bk-'));
process.env.GC_BACKUP_DIR = backupDir;
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { helloPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

const API = '/api/v1/plugins';
const BK = '/api/v1/settings/backup';
const PASS = 'plugin cap passphrase 42';
const KDF = { N: 1024, r: 8, p: 1 };
const MB = 1024 * 1024;

let app, agent, csrf, runtime, plugins, backup, autobackup, constants, pluginBackup, jsonSpool, gcbk, db;
let server, davBase;
const davFiles = new Map();
const bigHashes = new Map();

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const post = (url, body) => agent.post(url).set('X-CSRF-Token', csrf).send(body || {});

function startDav() {
  const cols = new Set(['/', '/dav/', '/dav/gc/']);
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (req.method === 'PROPFIND') {
        if (!cols.has(p)) { res.writeHead(404); res.end(); return; }
        const items = [`<d:response><d:href>${p}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`];
        if (req.headers.depth === '1') {
          for (const [fp, b] of davFiles) if (fp.startsWith(p) && !fp.slice(p.length).includes('/')) items.push(`<d:response><d:href>${encodeURI(fp)}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${b.length}</d:getcontentlength></d:prop></d:propstat></d:response>`);
        }
        res.writeHead(207); res.end(`<d:multistatus xmlns:d="DAV:">${items.join('')}</d:multistatus>`); return;
      }
      if (req.method === 'MKCOL') { cols.add(p); res.writeHead(201); res.end(); return; }
      if (req.method === 'PUT') { davFiles.set(p, Buffer.concat(chunks)); res.writeHead(201); res.end(); return; }
      if (req.method === 'DELETE') { davFiles.delete(p); res.writeHead(204); res.end(); return; }
      if (req.method === 'GET') { const b = davFiles.get(p); if (!b) { res.writeHead(404); res.end(); return; } res.writeHead(200); res.end(b); return; }
      res.writeHead(405); res.end();
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => { davBase = `http://127.0.0.1:${server.address().port}`; r(); }));
}

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}

/** Run fn with the plugin cap set to `bytes`. */
async function withCap(bytes, fn) {
  const prev = pluginBackup.MAX_PLUGIN_BYTES;
  pluginBackup.MAX_PLUGIN_BYTES = bytes;
  try { return await fn(); } finally { pluginBackup.MAX_PLUGIN_BYTES = prev; }
}
const pause = () => new Promise((r) => setTimeout(r, 1100)); // distinct timestamps in the file names
/** fn() until it holds (cleanup after the answer has been sent) */
async function eventually(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    try { return fn(); } catch (err) { if (Date.now() > end) throw err; }
    await new Promise((r) => setTimeout(r, 25));
  }
}
const incoming = () => fs.readdirSync(path.join(backupDir, '.incoming'));
const snapLeft = () => { try { return fs.readdirSync(path.join(constants.pluginDataRoot(), '.backup-tmp')); } catch { return []; } };

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  backup = require('../src/services/backup');
  autobackup = require('../src/services/autobackup');
  constants = require('../src/services/plugins/constants');
  pluginBackup = require('../src/services/plugins/backup');
  jsonSpool = require('../src/utils/jsonSpool');
  gcbk = require('../src/services/offsite/gcbk');
  db = require('../src/db/connection').getDb();
  require('../src/services/peers').rewriteWgConfig = async () => {};
  require('../src/services/routes').syncToCaddy = async () => {};
  await startDav();

  await install(helloPackage());
  assert.equal(await runtime.waitRunning('hello'), true);
  await post(`${API}/hello/api/kv`, { key: 'k', value: 42 }).expect(200);
  const dir = path.join(constants.filesDir('hello'), 'big');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 3; i++) {
    const buf = crypto.randomBytes(2 * MB + i);
    fs.writeFileSync(path.join(dir, `f${i}.bin`), buf);
    bigHashes.set(`big/f${i}.bin`, sha(buf));
  }
});
after(async () => {
  server.close();
  await plugins.stop();
  teardown();
  fs.rmSync(backupDir, { recursive: true, force: true });
});

describe('utils/jsonSpool', () => {
  const tmp = () => path.join(backupDir, `spool-${crypto.randomBytes(4).toString('hex')}.json`);
  it('parses like JSON.parse: long strings stay in the file, any read size, escapes, unicode', async () => {
    for (let n = 0; n < 60; n++) {
      const v = { a: [], b: {} };
      for (let i = 0; i < 12; i++) {
        const r = (i * 7 + n) % 5;
        v.a.push(r === 0 ? crypto.randomBytes(50 + n * 3).toString('base64')
          : r === 1 ? 'x"\\'.repeat(20 + n) + 'äöü 😀\n\u0000/'
            : r === 2 ? n * i : r === 3 ? null : { k: ['\\"', true] });
        v.b['k' + i + '"\\'] = v.a[i];
      }
      const f = tmp();
      fs.writeFileSync(f, JSON.stringify(v, null, n % 2 ? 2 : 0));
      const { value, spooled } = await jsonSpool.parseFile(f, { spoolMin: 16 + n, readChunk: 1 + (n % 37) });
      assert.ok(spooled > 0);
      assert.deepEqual(jsonSpool.resolve(value), v, `round ${n}`);
      fs.rmSync(f);
    }
  });
  it('a spooled base64 string decodes in pieces (Buffer, file) and writes through as raw JSON', async () => {
    const raw = crypto.randomBytes(9 * MB + 2);
    const f = tmp();
    fs.writeFileSync(f, JSON.stringify({ x: raw.toString('base64'), y: 'short' }, null, 2));
    const { value } = await jsonSpool.parseFile(f);
    assert.equal(jsonSpool.isSpooled(value.x), true);
    assert.equal(value.y, 'short');
    assert.ok((await value.x.buffer()).equals(raw));
    assert.ok(value.x.bufferSync().equals(raw));
    const out = f + '.bin';
    await value.x.writeDecoded(out);
    assert.equal(sha(fs.readFileSync(out)), sha(raw));
    const parts = [];
    await require('../src/utils/jsonStream').writeJson((s) => { parts.push(s); }, value, { indent: 2 });
    assert.equal(parts.join(''), fs.readFileSync(f, 'utf8'), 'byte-identical when written again');
    fs.rmSync(f); fs.rmSync(out);
  });
});

describe('the cap', () => {
  it('is 512 MB of raw plugin data per backup (media: 128 MB of its own)', () => {
    assert.equal(pluginBackup.MAX_PLUGIN_BYTES, 512 * MB);
    assert.equal(pluginBackup.MAX_MEDIA_BYTES, 128 * MB);
  });

  it('everything fits: nothing skipped, plugins_incomplete [] before data, snapshots removed', async () => {
    const b = await backup.collectBackup();
    try {
      assert.deepEqual(Object.keys(b), ['version', 'created_at', 'plugins_incomplete', 'data']);
      assert.deepEqual(b.plugins_incomplete, []);
      const p = b.data.plugins.find((x) => x.id === 'hello');
      assert.deepEqual([p.skipped, p.skip_reasons, p.name], [[], {}, 'Hallo Welt']);
      assert.ok(snapLeft().length >= 1, 'database + files wait in the snapshot folder');
    } finally { await b.release(); }
    assert.deepEqual(snapLeft(), [], 'snapshot folder removed after release()');
  });

  it('a part that does not fit is left out: skipped + reason too_large, the rest is in the backup', async () => {
    const warns = [];
    const logger = require('../src/utils/logger');
    const orig = logger.warn;
    logger.warn = function (obj, msg) { warns.push([obj, msg]); return orig.apply(this, arguments); };
    let b;
    try { b = await withCap(1 * MB, () => backup.createBackup()); } finally { logger.warn = orig; }
    const p = b.data.plugins.find((x) => x.id === 'hello');
    assert.deepEqual(p.skipped, ['files']);
    assert.deepEqual(p.skip_reasons, { files: 'too_large' });
    assert.equal(p.data_files, null);
    assert.equal(Buffer.from(p.db, 'base64').subarray(0, 15).toString('latin1'), 'SQLite format 3', 'the database still fits');
    assert.deepEqual(b.plugins_incomplete, [{ id: 'hello', name: 'Hallo Welt', parts: [{ part: 'files', reason: 'too_large' }] }]);
    assert.deepEqual(backup.getBackupSummary(b).plugins_incomplete, b.plugins_incomplete);
    const w = warns.find(([o]) => o && o.plugin === 'hello' && o.part === 'files');
    assert.ok(w, 'log line');
    assert.match(w[1], /Hallo Welt/);
    assert.equal(w[0].reason, 'too_large');
  });

  it('a database that cannot be read: skipped with reason read_error', async () => {
    await runtime.ensureStopped('hello');
    await require('../src/services/plugins/storage').close('hello');
    const file = path.join(constants.dbDir('hello'), 'plugin.db');
    const keep = file + '.keep';
    fs.renameSync(file, keep);
    for (const s of ['-wal', '-shm']) if (fs.existsSync(file + s)) fs.renameSync(file + s, keep + s);
    fs.writeFileSync(file, Buffer.alloc(8192, 7));
    try {
      const b = await backup.createBackup();
      const p = b.data.plugins.find((x) => x.id === 'hello');
      assert.deepEqual(p.skip_reasons, { database: 'read_error' });
      assert.deepEqual(b.plugins_incomplete[0].parts, [{ part: 'database', reason: 'read_error' }]);
    } finally {
      fs.rmSync(file, { force: true });
      fs.renameSync(keep, file);
      for (const s of ['-wal', '-shm']) if (fs.existsSync(keep + s)) fs.renameSync(keep + s, file + s);
      await plugins.reconcile();
    }
    assert.equal(await runtime.waitRunning('hello'), true);
    assert.equal((await agent.get(`${API}/hello/api/kv?key=k`).expect(200)).body.value, 42);
  });

  it('an old backup without reasons: reason unknown', () => {
    assert.deepEqual(pluginBackup.incompleteOf([{ id: 'hello', skipped: ['database'] }, { id: 'x-y', skipped: [] }]),
      [{ id: 'hello', name: 'Hallo Welt', parts: [{ part: 'database', reason: 'unknown' }] }]);
  });
});

describe('visible in the overview', () => {
  let completeFile;
  let incompleteFile;
  let targetId;

  it('a complete backup: the list says so (incomplete [])', async () => {
    const r = await post('/api/v1/settings/autobackup/run').expect(200);
    assert.deepEqual(r.body.incomplete, []);
    completeFile = r.body.filename;
    const p = await require('../src/services/dashboardProblems').list({ access: null });
    assert.equal(p.problems.some((x) => x.kind === 'backup_incomplete'), false);
  });

  it('an incomplete one: run answer, list, log entry, activity → notification row "Backup-Probleme"', async () => {
    await pause();
    const r = await withCap(1 * MB, () => post('/api/v1/settings/autobackup/run').expect(200));
    incompleteFile = r.body.filename;
    assert.deepEqual(r.body.incomplete, [{ id: 'hello', name: 'Hallo Welt', parts: [{ part: 'files', reason: 'too_large' }] }]);
    const list = (await agent.get('/api/v1/settings/autobackup/list').expect(200)).body.files;
    assert.deepEqual(list.map((f) => [f.filename, f.incomplete.length]), [[incompleteFile, 1], [completeFile, 0]]);
    assert.equal(await backup.readIncomplete(path.join(backupDir, incompleteFile)).then((x) => x[0].name), 'Hallo Welt');
    const act = db.prepare("SELECT message, severity, details FROM activity_log WHERE event_type = 'autobackup_incomplete' ORDER BY id DESC").get();
    assert.ok(act, 'activity entry');
    assert.equal(act.severity, 'warning');
    assert.match(act.message, /Hallo Welt \(files: too large for the backup\)/);
    const n = require('../src/services/notifications');
    assert.ok(n.EVENTS.find((e) => e.id === 'backup_problem').types.includes('autobackup_incomplete'));
    const prev = n.emailTypes();
    try {
      n.setEmailTypes(['autobackup_failed']); // a list stored before the new type existed
      assert.equal(n.wantsEmail('autobackup_incomplete'), true);
      n.setEmailTypes([]);
      assert.equal(n.wantsEmail('autobackup_incomplete'), false);
    } finally { n.setEmailTypes(prev); }
  });

  it('dashboard: a "Probleme" entry while the newest backup is incomplete', async () => {
    const p = await require('../src/services/dashboardProblems').list({ access: null });
    const row = p.problems.find((x) => x.kind === 'backup_incomplete');
    assert.ok(row, JSON.stringify(p.problems));
    assert.equal(row.severity, 'warning');
    assert.equal(row.href, '/settings/backup');
    assert.deepEqual(row.backup, { file: incompleteFile, plugins: [{ id: 'hello', name: 'Hallo Welt', parts: [{ part: 'files', reason: 'too_large' }] }] });
  });

  it('off-site: the target list and the restore test show the incomplete archive', async () => {
    await agent.put(`${BK}/offsite`).set('X-CSRF-Token', csrf).send({ passphrase: PASS }).expect(200);
    const res = await post(`${BK}/targets`, { name: 'NAS', type: 'webdav', keep: 3, config: { url: `${davBase}/dav/gc/` } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    targetId = res.body.target.id;
    const run = await post(`${BK}/targets/${targetId}/run`).expect(200);
    assert.deepEqual(run.body.plugins_incomplete.map((p) => p.id), ['hello']);
    const t = (await agent.get(`${BK}/targets`).expect(200)).body.targets.find((x) => x.id === targetId);
    assert.equal(t.last_status, 'ok');
    assert.equal(t.last_incomplete.file, incompleteFile.replace(/\.json$/, '.gcbk'));
    assert.deepEqual(t.last_incomplete.plugins[0].parts, [{ part: 'files', reason: 'too_large' }]);
    const v = await post(`${BK}/targets/${targetId}/verify`).expect(200);
    assert.ok(v.body.warnings.includes('plugins_incomplete'), JSON.stringify(v.body));
    assert.equal(v.body.plugins_incomplete[0].name, 'Hallo Welt');
    assert.deepEqual(incoming(), [], 'temp files of the restore test removed');
  });

  it('a complete backup again: the problem is gone, the target line too', async () => {
    await pause();
    const r = await post('/api/v1/settings/autobackup/run').expect(200);
    assert.deepEqual(r.body.incomplete, []);
    const p = await require('../src/services/dashboardProblems').list({ access: null });
    assert.equal(p.problems.some((x) => x.kind === 'backup_incomplete'), false);
    await post(`${BK}/targets/${targetId}/run`).expect(200);
    const t = (await agent.get(`${BK}/targets`).expect(200)).body.targets.find((x) => x.id === targetId);
    assert.equal(t.last_incomplete, null);
  });

  it('the download says so in a header', async () => {
    const res = await withCap(1 * MB, () => agent.get('/api/v1/settings/backup').buffer(true)
      .parse((rs, cb) => { const c = []; rs.on('data', (d) => c.push(d)); rs.on('end', () => cb(null, Buffer.concat(c))); }));
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-gc-backup-incomplete'], '1');
    await eventually(() => assert.deepEqual(snapLeft(), [], 'snapshots of the download removed'));
  });

  it('the page texts (ops-ui): one plain line + what to do', () => {
    const O = require('../public/js/ops-ui.js');
    const list = [{ id: 'mail', name: 'Mail', parts: [{ part: 'database', reason: 'too_large' }] }];
    assert.equal(O.incompleteLine(list), '⚠ Not complete: Mail (database too large for the backup)');
    assert.equal(O.incompleteLine([]), '');
    assert.equal(O.incompleteHelp(list).length, 1);
    const de = require('../src/i18n/de.json');
    const t = (k, fb, params) => O.fmt(de[k] != null ? de[k] : fb, params);
    assert.equal(O.incompleteLine(list, t), '⚠ Nicht vollständig: Mail (Datenbank zu groß für das Backup)');
    assert.match(O.incompleteHelp([{ id: 'x', parts: [{ part: 'files', reason: 'read_error' }] }], t)[0], /konnte beim Sichern nicht gelesen werden/);
  });
});

describe('a large backup is restored within the limits (scaled down)', () => {
  let file;

  it('the file holds the plugin data; parsed in pieces, the large parts stay in the file', async () => {
    const files = await autobackup.listBackupFilesWithInfo();
    file = path.join(backupDir, files[0].filename);
    assert.deepEqual(files[0].incomplete, []);
    const data = await backup.readBackupFile(file);
    const p = data.data.plugins.find((x) => x.id === 'hello');
    assert.equal(jsonSpool.isSpooled(p.data_files['big/f0.bin']), true);
    assert.equal(typeof data.data.settings[0].key, 'string');
    assert.deepEqual(backup.validateBackup(data), []);
  });

  it('POST /restore with the JSON file: the plugin data comes back, the upload is removed', async () => {
    fs.rmSync(path.join(constants.filesDir('hello'), 'big'), { recursive: true, force: true });
    const res = await agent.post('/api/v1/settings/restore').set('X-CSRF-Token', csrf).attach('backup', file);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.restored.plugins, 1, JSON.stringify(res.body.restored.plugins_skipped));
    for (const [rel, h] of bigHashes) assert.equal(sha(fs.readFileSync(path.join(constants.filesDir('hello'), rel))), h, rel);
    await eventually(() => assert.deepEqual(incoming(), []));
    // a restore replaces the users table: sign in again
    agent = require('supertest').agent(app);
    const page = await agent.get('/login').expect(200);
    const c = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
    await agent.post('/login').type('form').send({ username: 'admin', password: 'TestPass123!', _csrf: c }).expect(302);
    csrf = (await agent.get('/dashboard').expect(200)).text.match(/csrfToken:\s*'([^']+)'/)[1];
    assert.equal(await runtime.waitRunning('hello'), true);
    assert.equal((await agent.get(`${API}/hello/api/kv?key=k`).expect(200)).body.value, 42, 'the database came back');
  });

  it('the .gcbk of it: preview and restore through the upload (decrypted to disk, read in pieces)', async () => {
    const arch = path.join(backupDir, 'upload-test.gcbk');
    fs.writeFileSync(arch, await gcbk.encryptBackupFile(file, { passphrase: PASS, kdf: KDF }));
    // without a passphrase field: the configured off-site passphrase
    let res = await agent.post('/api/v1/settings/restore/preview').set('X-CSRF-Token', csrf).attach('backup', arch);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    res = await agent.post('/api/v1/settings/restore/preview').set('X-CSRF-Token', csrf).field('passphrase', 'wrong passphrase!!').attach('backup', arch);
    assert.equal(res.body.code, 'DECRYPT_FAILED');
    res = await agent.post('/api/v1/settings/restore/preview').set('X-CSRF-Token', csrf).field('passphrase', PASS).attach('backup', arch);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.encrypted, true);
    assert.equal(res.body.summary.plugins, 1);
    assert.deepEqual(res.body.summary.plugins_incomplete, []);
    fs.rmSync(path.join(constants.filesDir('hello'), 'big'), { recursive: true, force: true });
    res = await agent.post('/api/v1/settings/restore').set('X-CSRF-Token', csrf).field('passphrase', PASS).attach('backup', arch);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.restored.plugins, 1);
    for (const [rel, h] of bigHashes) assert.equal(sha(fs.readFileSync(path.join(constants.filesDir('hello'), rel))), h, rel);
    await eventually(() => assert.deepEqual(incoming(), []));
    fs.rmSync(arch);
  });
});

describe('off-site archive of a large payload (streaming)', () => {
  let file;
  before(() => { file = path.join(backupDir, autobackup.listBackupFiles()[0].filename); });

  it('encryptBackupFile → decryptBackupFileTo: the payload in pieces on disk, the backup unchanged', async () => {
    const buf = await gcbk.encryptBackupFile(file, { passphrase: PASS, encryptionKey: 'ab'.repeat(32), gcVersion: '9.9.9', kdf: KDF });
    const arch = path.join(backupDir, 'stream.gcbk');
    fs.writeFileSync(arch, buf);
    const out = path.join(backupDir, 'stream.plain.json');
    const { header, bytes } = await gcbk.decryptBackupFileTo(arch, PASS, out);
    assert.equal(header.include_key, true);
    assert.equal(bytes, fs.statSync(out).size);
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    const payload = gcbk.checkPayload((await jsonSpool.parseFile(out)).value);
    assert.equal(payload.encryption_key, 'ab'.repeat(32));
    assert.deepEqual(jsonSpool.resolve(payload.backup), JSON.parse(fs.readFileSync(file, 'utf8')));
    // the same as the in-memory decryptBackup
    assert.deepEqual((await gcbk.decryptBackup(buf, PASS)).payload.backup, JSON.parse(fs.readFileSync(file, 'utf8')));
    fs.rmSync(out);

    await assert.rejects(gcbk.decryptBackupFileTo(arch, 'wrong passphrase!!', out), { code: 'DECRYPT_FAILED' });
    assert.equal(fs.existsSync(out), false, 'nothing of a failed decryption is left');
    await assert.rejects(gcbk.decryptBackupFileTo(arch, PASS, out, { maxBytes: 1 * MB }), { code: 'TOO_LARGE' });
    assert.equal(fs.existsSync(out), false);
    const cut = path.join(backupDir, 'cut.gcbk');
    fs.writeFileSync(cut, buf.subarray(0, buf.length - 1000));
    await assert.rejects(gcbk.decryptBackupFileTo(cut, PASS, out), { code: 'DECRYPT_FAILED' });
    const flipped = Buffer.from(buf);
    flipped[flipped.length - 20] ^= 1;
    fs.writeFileSync(cut, flipped);
    await assert.rejects(gcbk.decryptBackupFileTo(cut, PASS, out), { code: 'DECRYPT_FAILED' });
    assert.equal(fs.existsSync(out), false);
    fs.rmSync(cut);

    // the stand-alone CLI writes the same backup JSON (indented) without one big string
    const cliOut = path.join(backupDir, 'cli.json');
    execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'bin', 'offsite-decrypt.js'), arch, '-o', cliOut],
      { env: { ...process.env, GC_OFFSITE_PASSPHRASE: PASS }, stdio: ['ignore', 'ignore', 'pipe'] });
    assert.equal(fs.readFileSync(cliOut, 'utf8'), JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')), null, 2) + '\n');
    assert.equal(fs.statSync(cliOut).mode & 0o777, 0o600);
    fs.rmSync(cliOut);
    fs.rmSync(arch);
  });
});

describe('upload files', () => {
  it('only names made by the server, only inside the incoming folder', () => {
    const up = require('../src/services/backupUpload');
    const name = up.newName('upload');
    assert.match(name, /^[0-9a-f]{24}\.upload$/);
    assert.equal(up.incomingPath(name), path.join(path.resolve(backupDir, '.incoming'), name));
    for (const bad of ['../x.upload', '/etc/passwd', 'abc.upload', name + '/..', '', null]) assert.throws(() => up.incomingPath(bad), /invalid upload name/, String(bad));
    // a path is reduced to its name
    assert.equal(up.incomingPath('/tmp/' + name), up.incomingPath(name));
  });
  it('a symlink in a plugin\'s files is never followed into the backup', async () => {
    const link = path.join(constants.filesDir('hello'), 'evil-link');
    fs.symlinkSync('/etc/hostname', link);
    try {
      const b = await backup.createBackup();
      const p = b.data.plugins.find((x) => x.id === 'hello');
      assert.equal('evil-link' in p.data_files, false);
    } finally { fs.rmSync(link, { force: true }); }
  });
});

describe('disk space', () => {
  it('a backup is not started when the disk cannot hold it (NO_SPACE)', async () => {
    await assert.rejects(backup.checkFreeSpace(backupDir, Number.MAX_SAFE_INTEGER / 4), (err) => err.code === 'NO_SPACE' && err.need > err.free);
    await backup.checkFreeSpace(backupDir, 1024);
  });
  it('the estimate covers the file (base64 × 4/3 + tables)', async () => {
    const b = await backup.collectBackup();
    try {
      const est = backup.estimateSize(b);
      const size = fs.statSync(path.join(backupDir, autobackup.listBackupFiles()[0].filename)).size;
      assert.ok(est >= size, `estimate ${est} < file ${size}`);
      assert.ok(est < size * 1.5 + 4 * MB, `estimate ${est} far above file ${size}`);
    } finally { await b.release(); }
  });
});
