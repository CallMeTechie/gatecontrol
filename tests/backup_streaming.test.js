'use strict';

// Backups are collected and written piece by piece (utils/jsonStream,
// services/backup.writeBackupFile): with several MB of plugin data the
// event loop keeps running (timers tick), and the file is exactly what
// JSON.stringify(backup, null, 2) gave before — validateBackup, restore,
// the download and the off-site archive accept it unchanged.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { helloPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const { Base64Value, writeJson, materialize } = require('../src/utils/jsonStream');

const API = '/api/v1/plugins';
const BIG_FILES = 5;
const BIG_FILE_BYTES = 6 * 1024 * 1024; // 30 MB raw plugin files → ~40 MB base64
// generous: CI runners are slow and shared; the old synchronous path blocked
// for the whole backup (seconds on a NAS), the new one in pieces of ~1–20 ms
const MAX_TICK_GAP_MS = 750;

let app, agent, csrf, backup, autobackup, constants, runtime, plugins;
const bigHashes = new Map();

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}

/** Run `fn` while a 5 ms interval ticks; → { result, ticks, maxGap } (ms). */
async function whileTicking(fn) {
  let last = performance.now();
  let maxGap = 0;
  let ticks = 0;
  const t = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
  }, 5);
  try {
    const result = await fn();
    maxGap = Math.max(maxGap, performance.now() - last);
    return { result, ticks, maxGap: Math.round(maxGap) };
  } finally { clearInterval(t); }
}

const strip = (b) => {
  const c = JSON.parse(JSON.stringify(b));
  delete c.created_at;
  c.data.settings = c.data.settings.filter((x) => x.key !== 'autobackup_last_run'); // written by the run itself
  for (const p of c.data.plugins || []) delete p.db; // two snapshots: same content, header bytes may differ
  return c;
};

describe('utils/jsonStream', () => {
  const collect = async (v, indent) => {
    const parts = [];
    await writeJson((s) => { parts.push(s); }, v, { indent });
    return parts.join('');
  };
  const sample = () => ({
    a: 1, b: 'zwei "quoted"   äöü 😀', c: null, d: undefined, e: () => 1, f: [1, undefined, () => 2, { x: [] }, {}],
    g: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), h: { nested: { deep: [true, false, -0, NaN, Infinity, 1e21] } },
    bin: new Base64Value(crypto.randomBytes(500 * 1024 + 7)),
    big: Array.from({ length: 3000 }, (_, i) => ({ i, s: 'x'.repeat(i % 50), o: { files: i % 7 ? null : { a: new Base64Value(Buffer.from([i & 255, 1, 2])) } } })),
    empty: { only: undefined },
  });

  for (const indent of [0, 2]) {
    it(`is byte-identical to JSON.stringify(…, null, ${indent})`, async () => {
      const v = sample();
      assert.equal(await collect(v, indent), JSON.stringify(v, null, indent));
      assert.equal(await collect([], indent), '[]');
      assert.equal(await collect('s', indent), '"s"');
    });
  }

  it('materialize turns every Base64Value into its string', () => {
    const v = sample();
    const text = JSON.stringify(v);
    const m = materialize(v);
    assert.equal(typeof m.bin, 'string');
    assert.equal(JSON.stringify(m), text);
  });

  it('a large base64 value is written in pieces with the event loop running', async () => {
    const v = { blob: new Base64Value(crypto.randomBytes(24 * 1024 * 1024)) };
    let chunks = 0;
    const { ticks, maxGap } = await whileTicking(() => writeJson(() => { chunks++; }, v));
    assert.ok(chunks > 50, `chunks: ${chunks}`);
    assert.ok(ticks >= 3, `ticks: ${ticks}`);
    assert.ok(maxGap < MAX_TICK_GAP_MS, `max gap ${maxGap} ms`);
  });
});

describe('backup with several MB of plugin data', () => {
  before(async () => {
    ({ app, agent } = await setup());
    csrf = getCsrf();
    runtime = require('../src/services/plugins/runtime');
    plugins = require('../src/services/plugins');
    backup = require('../src/services/backup');
    autobackup = require('../src/services/autobackup');
    constants = require('../src/services/plugins/constants');
    require('../src/services/peers').rewriteWgConfig = async () => {};
    require('../src/services/routes').syncToCaddy = async () => {};
  });
  after(async () => { await plugins.stop(); teardown(); });

  let file;
  let parsed;

  it('prepares a plugin with large data files', async () => {
    await install(helloPackage());
    assert.equal(await runtime.waitRunning('hello'), true);
    const r = await agent.post(`${API}/hello/api/kv`).set('X-CSRF-Token', csrf).send({ key: 'k', value: 42 });
    assert.equal(r.status, 200);
    const dir = path.join(constants.filesDir('hello'), 'big');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < BIG_FILES; i++) {
      const buf = crypto.randomBytes(BIG_FILE_BYTES);
      fs.writeFileSync(path.join(dir, `f${i}.bin`), buf);
      bigHashes.set(`big/f${i}.bin`, crypto.createHash('sha256').update(buf).digest('hex'));
    }
  });

  it('the automatic backup keeps the event loop running (timers tick)', async (t) => {
    // the former way, for comparison: build the whole object, then one JSON.stringify
    const obj = await backup.createBackup();
    const t0 = performance.now();
    const oldText = JSON.stringify(obj, null, 2);
    const oldStringifyMs = Math.round(performance.now() - t0);

    const { result: filename, ticks, maxGap } = await whileTicking(() => autobackup.runBackup({ offsite: false }));
    file = path.join(autobackup.BACKUP_DIR, filename);
    const size = fs.statSync(file).size;
    t.diagnostic(`backup ${Math.round(size / 1048576)} MB: max timer gap ${maxGap} ms over ${ticks} ticks (one JSON.stringify of it alone: ${oldStringifyMs} ms)`);
    assert.ok(size > BIG_FILES * BIG_FILE_BYTES, `size ${size}`);
    assert.ok(Math.abs(size - Buffer.byteLength(oldText)) < 64 * 1024, 'same size as the former file (± created_at/snapshot)');
    assert.ok(ticks >= 5, `ticks: ${ticks}`);
    assert.ok(maxGap < MAX_TICK_GAP_MS, `max timer gap ${maxGap} ms`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(autobackup.BACKUP_DIR).filter((n) => n.endsWith('.tmp')), [], 'no tmp file left');
  });

  it('the file is the former format (JSON.stringify(…, null, 2)) and has the same content', async () => {
    const text = fs.readFileSync(file, 'utf8');
    parsed = JSON.parse(text);
    assert.equal(text, JSON.stringify(parsed, null, 2), 'byte-identical to the indented JSON of its content');
    assert.deepEqual(backup.validateBackup(parsed), []);
    const fresh = await backup.createBackup();
    assert.deepEqual(strip(parsed), strip(fresh));
    const p = parsed.data.plugins.find((x) => x.id === 'hello');
    assert.deepEqual(p.skipped, []);
    assert.equal(Buffer.from(p.db, 'base64').subarray(0, 15).toString('latin1'), 'SQLite format 3');
    for (const [rel, sha] of bigHashes) {
      assert.equal(crypto.createHash('sha256').update(Buffer.from(p.data_files[rel], 'base64')).digest('hex'), sha, rel);
    }
  });

  it('the download is streamed, compact like res.json, and complete', async () => {
    const { result: res, maxGap } = await whileTicking(() => agent.get('/api/v1/settings/backup').buffer(true)
      .parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); }));
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^application\/json; charset=utf-8$/);
    assert.match(res.headers['content-disposition'], /^attachment; filename="gatecontrol-backup-\d{4}-\d{2}-\d{2}\.json"$/);
    const text = res.body.toString('utf8');
    const body = JSON.parse(text);
    assert.equal(text, JSON.stringify(body), 'compact JSON');
    assert.deepEqual(backup.validateBackup(body), []);
    assert.deepEqual(strip(body), strip(parsed));
    assert.ok(maxGap < MAX_TICK_GAP_MS, `max timer gap ${maxGap} ms`);
  });

  it('the off-site archive streamed from the file decrypts to the same backup', async () => {
    const gcbk = require('../src/services/offsite/gcbk');
    const kdf = { N: 1024, r: 8, p: 1 };
    const passphrase = 'correct horse battery';
    const key = 'ab'.repeat(32);
    const { result: buf, maxGap } = await whileTicking(() => gcbk.encryptBackupFile(file, { passphrase, encryptionKey: key, gcVersion: '9.9.9', kdf }));
    assert.ok(maxGap < MAX_TICK_GAP_MS, `max timer gap ${maxGap} ms`);
    const { header, payload } = await gcbk.decryptBackup(buf, passphrase);
    assert.deepEqual(Object.keys(payload), ['format', 'version', 'created_at', 'gc_version', 'backup', 'encryption_key']);
    assert.equal(payload.format, gcbk.FORMAT);
    assert.equal(payload.gc_version, '9.9.9');
    assert.equal(payload.encryption_key, key);
    assert.equal(header.include_key, true);
    assert.equal(header.created_at, payload.created_at);
    assert.deepEqual(payload.backup, parsed);
    // without include_key: no key field
    const noKey = await gcbk.decryptBackup(await gcbk.encryptBackupFile(file, { passphrase, kdf }), passphrase);
    assert.equal('encryption_key' in noKey.payload, false);
    assert.equal(noKey.header.include_key, false);
    // a file that is not a JSON object is refused before anything is encrypted
    const bad = path.join(path.dirname(file), 'not-json.json');
    fs.writeFileSync(bad, '{"version": 5, "data": {');
    await assert.rejects(gcbk.encryptBackupFile(bad, { passphrase, kdf }), { code: 'CORRUPT' });
    fs.rmSync(bad);
  });

  it('without a usable temp folder the plugin database is still in the backup (one-piece copy)', async () => {
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = path.join(path.dirname(file), 'missing', 'tmp');
    try {
      const p = (await backup.createBackup()).data.plugins.find((x) => x.id === 'hello');
      assert.deepEqual(p.skipped, []);
      assert.equal(Buffer.from(p.db, 'base64').subarray(0, 15).toString('latin1'), 'SQLite format 3');
    } finally {
      if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
    }
  });

  it('restore accepts the file: the plugin and its large files come back', async () => {
    fs.rmSync(path.join(constants.filesDir('hello'), 'big'), { recursive: true, force: true });
    const res = await backup.restoreBackup(JSON.parse(fs.readFileSync(file, 'utf8')));
    assert.equal(res.plugins, 1, JSON.stringify(res.plugins_skipped));
    assert.deepEqual(res.plugins_skipped, []);
    for (const [rel, sha] of bigHashes) {
      const buf = fs.readFileSync(path.join(constants.filesDir('hello'), rel));
      assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), sha, rel);
    }
    assert.equal(await runtime.waitRunning('hello'), true);
  });
});
