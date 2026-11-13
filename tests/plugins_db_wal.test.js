'use strict';

// Plugin databases in WAL (since 1.255.0) and the write probe of the data disk.
//
// Protocol of 8. 11. (after 1.253.5): ~500 "slow plugin database statement"
// an hour from almost every plugin — all of them writes (a single-row UPDATE,
// COMMIT, kv.set), median ~300 ms, reads never slow. The plugin databases ran
// in the rollback journal (journal_mode = DELETE, synchronous = FULL): every
// write transaction waited for four syncs of the disk. In WAL with
// synchronous = NORMAL a commit only appends to plugin.db-wal; the disk is
// synced at a checkpoint.
//
//   * the worker opens WAL, a file of before switches on its first open;
//   * closing the storage leaves plugin.db alone (log copied back, -wal gone);
//   * a quiet plugin's log is checkpointed (idle checkpoint);
//   * a plugin backup of a WAL file restores (header patched for memory);
//   * slow disk simulated (LD_PRELOAD, every sync 50 ms): a write through the
//     plugin storage takes milliseconds, with the pragmas of before ≥ 150 ms;
//     the probe measures the delay and reports the disk as slow.

require('./helpers/test-env');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const storage = require('../src/services/plugins/storage');
const { dbDir } = require('../src/services/plugins/constants');
const diskHealth = require('../src/services/diskHealth');

after(() => storage.closeAll());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const files = (id) => fs.readdirSync(dbDir(id)).sort();
const mode = (id) => {
  const c = new Database(path.join(dbDir(id), 'plugin.db'), { readonly: true, fileMustExist: true });
  try { return c.pragma('journal_mode', { simple: true }); } finally { c.close(); }
};

describe('plugin databases in WAL', () => {
  it('a new database is in WAL; closing the storage copies the log back and removes plugin.db-wal', async () => {
    const db = storage.forPlugin('wal-new');
    await db.call('exec', { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)' });
    await db.call('query', { sql: 'INSERT INTO t (v) VALUES (?)', params: ['a'], mode: 'run' });
    await db.call('kv.set', { key: 'k', value: { n: 1 } });
    assert.ok(files('wal-new').includes('plugin.db-wal'), files('wal-new').join());
    assert.equal(mode('wal-new'), 'wal');
    await storage.close('wal-new');
    assert.deepEqual(files('wal-new'), ['plugin.db'], 'only the database file is left');
    // the file alone holds everything (a copy of the folder is complete)
    const c = new Database(path.join(dbDir('wal-new'), 'plugin.db'), { readonly: true });
    try {
      assert.equal(c.prepare('SELECT v FROM t').get().v, 'a');
      assert.equal(c.prepare("SELECT value FROM _gc_kv WHERE key = 'k'").get().value, '{"n":1}');
    } finally { c.close(); }
  });

  it('a database of before (rollback journal) switches to WAL on its next open, with its data', async () => {
    fs.mkdirSync(dbDir('wal-old'), { recursive: true });
    const old = new Database(path.join(dbDir('wal-old'), 'plugin.db'));
    old.pragma('journal_mode = DELETE');
    old.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')");
    old.close();
    assert.equal(mode('wal-old'), 'delete');
    const db = storage.forPlugin('wal-old');
    assert.equal((await db.call('query', { sql: 'SELECT v FROM t', mode: 'get' })).row.v, 'kept');
    assert.equal(mode('wal-old'), 'wal');
    await storage.close('wal-old');
  });

  it('a quiet plugin: the log is checkpointed into plugin.db after its last write', async () => {
    storage._setCheckpointIdleMsForTest(100);
    try {
      const db = storage.forPlugin('wal-idle');
      await db.call('exec', { sql: 'CREATE TABLE t (v TEXT)' });
      for (let i = 0; i < 5; i++) await db.call('query', { sql: 'INSERT INTO t VALUES (?)', params: ['x' + i], mode: 'run' });
      const file = path.join(dbDir('wal-idle'), 'plugin.db');
      // a separate connection would see the rows through the log either way: the main file must have them
      let backfilled = false;
      let size = 0;
      for (let i = 0; i < 50 && !backfilled; i++) {
        await sleep(50);
        // plugin.db alone, without its log (read once, no stat before; header: rollback journal, for memory)
        const buf = fs.readFileSync(file);
        size = buf.length;
        buf[18] = 1;
        buf[19] = 1;
        // read while the checkpoint is still copying pages in: a torn copy is no answer yet, try again
        let c = null;
        try {
          c = new Database(buf);
          backfilled = c.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 't'").get().n === 1;
        } catch (err) {
          if (err.code !== 'SQLITE_CORRUPT' && err.code !== 'SQLITE_NOTADB') throw err;
        } finally {
          if (c) c.close();
        }
      }
      assert.ok(backfilled, `table in plugin.db itself (${size} bytes)`);
    } finally {
      storage._setCheckpointIdleMsForTest(null);
      await storage.close('wal-idle');
    }
  });
});

describe('a slow disk (every sync delayed with LD_PRELOAD)', () => {
  const cc = ['cc', 'gcc'].find((c) => spawnSync(c, ['--version']).status === 0);
  const skip = process.platform !== 'linux' ? 'LD_PRELOAD: Linux only' : (!cc && 'no C compiler (cc / gcc) for the sync shim');
  let shim = null;
  let tmp = null;

  const child = (what, delayMs, n, extra = {}) => {
    if (!shim) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-slowfsync-'));
      shim = path.join(tmp, 'slowfsync.so');
      execFileSync(cc, ['-shared', '-fPIC', '-O2', '-o', shim, path.join(__dirname, 'fixtures', 'slow-fsync', 'slowfsync.c'), '-ldl']);
    }
    const report = path.join(tmp, `syncs-${what}-${delayMs}-${n || 0}`);
    const dataDir = fs.mkdtempSync(path.join(tmp, 'data-'));
    const env = { ...process.env, LD_PRELOAD: shim, FAKE_FSYNC_MS: String(delayMs), FAKE_FSYNC_REPORT: report, NODE_ENV: 'test' };
    for (const k of Object.keys(env)) if (/^GC_/.test(k)) delete env[k]; // the child's own temp data folder (test-env)
    env.TMPDIR = dataDir;
    Object.assign(env, extra);
    const r = spawnSync(process.execPath, [path.join(__dirname, 'fixtures', 'slow-fsync', 'run.js'), what, String(n || '')], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    try { out.syncs = Number(fs.readFileSync(report, 'utf8')); } catch { out.syncs = null; } // read once (no exists-check before)
    return out;
  };

  after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  it('a single-row UPDATE and a kv.set through the plugin storage do not wait for the disk; the rollback journal of before did', { skip }, (t) => {
    const wal = child('plugin', 50, 10);
    const wal4 = child('plugin', 50, 40);
    const before = child('delete', 50);
    t.diagnostic(`50 ms per sync — WAL: median ${wal.medianMs.toFixed(1)} ms per write; ${wal.syncs} syncs in all with 20 writes, ${wal4.syncs} with 80 (creating the file, closing it); rollback journal: median ${before.medianMs.toFixed(1)} ms per UPDATE, ${before.syncs} syncs for 10`);
    assert.ok(wal.medianMs < 25, `WAL write ${wal.medianMs} ms`);
    assert.ok(wal4.medianMs < 25, `WAL write ${wal4.medianMs} ms`);
    assert.ok(before.medianMs >= 150, `rollback journal write ${before.medianMs} ms (≥ 3 syncs of 50 ms)`);
    assert.ok(before.syncs >= 30, `rollback journal: ${before.syncs} syncs`);
    assert.ok(wal.syncs != null && wal.syncs === wal4.syncs, `WAL: a write adds no sync (${wal.syncs} with 20 writes, ${wal4.syncs} with 80)`);
    assert.deepEqual(wal.files, ['plugin.db'], 'closed cleanly');
  });

  // Protokoll vom 12./13. 11. (Cloud-Platte, 38 ms je Sync, 26 je Sekunde): 225 „slow plugin database statements“
  // an einem Tag, 92 % Schreibvorgänge mit einer Zeile, typisch 250–400 ms. WAL allein hat das nicht beendet: Der
  // erste Schreibvorgang nach jedem Checkpoint beginnt das Protokoll neu und wartet auf einen Sync, und der
  // Checkpoint lief im Thread der Anweisungen. Jetzt: ein Thread des Hosts für alle Plugin-Datenbanken.
  it('checkpoint thread: the first write after a checkpoint does not wait for the disk, a read during it not for the checkpoint', { skip }, (t) => {
    const SYNC = 100;
    const now = child('quiet', SYNC, 5, { GC_PLUGIN_CHECKPOINT: 'worker' });
    t.diagnostic(`${SYNC} ms per sync, checkpoint thread: first write after a checkpoint ≤ ${now.firstWriteMaxMs.toFixed(1)} ms, a read ≤ ${now.readMaxMs.toFixed(1)} ms (${now.reads} reads), ${now.checkpoints} checkpoints of ≥ ${now.checkpointMinMs} ms, reads answered during each: ${now.readsDuring.join(', ')}`);
    assert.equal(now.served, true);
    assert.ok(now.checkpoints >= 5, `a checkpoint in every quiet time (${now.checkpoints})`);
    assert.ok(now.firstWriteMaxMs < SYNC / 2, `the write after a checkpoint took ${now.firstWriteMaxMs} ms — it waited for a sync`);
    assert.ok(now.checkpointMinMs >= SYNC * 2 - 10, `a checkpoint with two syncs of ${SYNC} ms (${now.checkpointMinMs} ms)`);
    // A read never waits for the checkpoint (two syncs and the copying, in the host's thread): reads are answered
    // WHILE every checkpoint runs, and none that began in its first half is still open at its end. An order on one
    // clock, no limit in milliseconds — the longest read is the one that meets the sync of the log's new start
    // (the storage thread, between two calls), and that sync takes what the machine's real disk takes on top of
    // the 100 ms: 160 and 266 ms on two busy CI runners (13. 11.), with the limit of before (1.5 syncs) a red master.
    assert.ok(now.readsDuring.every((n) => n >= 1), `reads answered while a checkpoint ran: ${now.readsDuring.join(', ')} — a read waited for the checkpoint`);
    assert.equal(now.readsHeld, 0, 'reads that began in the first half of a checkpoint and were answered only after it');
    assert.equal(now.value, 'v4');
    assert.deepEqual(now.files, ['plugin.db'], 'closed cleanly: the log copied back and removed');
    // each storage thread on its own (as before, and as the fallback): both wait
    const before = child('quiet', SYNC, 5, { GC_PLUGIN_CHECKPOINT: 'inline', QUIET_READS: 'one' });
    t.diagnostic(`${SYNC} ms per sync, storage threads themselves: first write ≤ ${before.firstWriteMaxMs.toFixed(1)} ms, a read ≤ ${before.readMaxMs.toFixed(1)} ms`);
    assert.equal(before.served, false);
    assert.ok(before.firstWriteMaxMs >= SYNC, `without the thread the write pays the sync (${before.firstWriteMaxMs} ms)`);
    assert.ok(before.readMaxMs >= SYNC * 1.5, `without the thread a read waits for the checkpoint (${before.readMaxMs} ms)`);
    assert.equal(before.value, 'v4');
    assert.deepEqual(before.files, ['plugin.db']);
  });

  it('checkpoint thread: plugins written in the same moment are checkpointed one after the other, never two at once', { skip }, (t) => {
    const out = child('many', 40, 6, { GC_PLUGIN_CHECKPOINT: 'worker' });
    const list = out.checkpoints.sort((a, b) => a.from - b.from);
    t.diagnostic(list.map((c) => `${c.id} ${c.from}–${c.to}`).join(', '));
    assert.deepEqual(list.map((c) => c.id).sort(), ['many-0', 'many-1', 'many-2', 'many-3', 'many-4', 'many-5']);
    for (let i = 1; i < list.length; i++) {
      // the thread's own clock (ms): when it began a checkpoint and how long it took
      assert.ok(list[i].from >= list[i - 1].to - 1, `${list[i].id} began at ${list[i].from}, ${list[i - 1].id} ended at ${list[i - 1].to}`);
      assert.ok(list[i - 1].to - list[i - 1].from >= 70, 'a checkpoint with two syncs of 40 ms');
    }
  });

  it('checkpoint thread: a process killed between writes, checkpoints and new starts of the log leaves a consistent file with every stored row', { skip }, async () => {
    const { spawn } = require('node:child_process');
    if (!shim) child('plugin', 0, 1); // builds the shim
    const dataDir = fs.mkdtempSync(path.join(tmp, 'kill-'));
    const env = { ...process.env, LD_PRELOAD: shim, FAKE_FSYNC_MS: '15', NODE_ENV: 'test', GC_PLUGIN_CHECKPOINT: 'worker' };
    for (const k of Object.keys(env)) if (/^GC_/.test(k) && k !== 'GC_PLUGIN_CHECKPOINT') delete env[k];
    env.TMPDIR = dataDir;
    const p = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'slow-fsync', 'run.js'), 'kill'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const stored = () => { const all = [...text.matchAll(/^stored (\d+)$/gm)]; return all.length ? Number(all[all.length - 1][1]) : 0; };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`too slow: ${stored()} rows; ${err}`)); }, 30000);
      p.stdout.on('data', (d) => { text += d; if (stored() >= 130) { clearTimeout(timer); p.kill('SIGKILL'); } });
      p.on('exit', () => { clearTimeout(timer); resolve(); });
    });
    const n = stored();
    assert.ok(n >= 130, `${n} rows stored; ${err}`);
    const dir = /^dir (.+)$/m.exec(text)[1];
    assert.ok(fs.readdirSync(dir).includes('plugin.db-wal'), 'killed: the log is still there');
    const c = new Database(path.join(dir, 'plugin.db'));
    try {
      assert.equal(c.pragma('integrity_check', { simple: true }), 'ok');
      const got = c.prepare('SELECT COUNT(*) AS n, MAX(id) AS max FROM t').get();
      assert.ok(got.max >= n && got.n === got.max, `rows 1…${got.max} without a gap (${got.n}), ${n} were reported stored`);
      assert.ok(JSON.parse(c.prepare("SELECT value FROM _gc_kv WHERE key = 'last'").get().value) >= Math.floor(n / 10) * 10);
    } finally { c.close(); }
  });

  it('the write probe measures the delay and calls the disk slow; a fast disk is not', { skip }, (t) => {
    const slow = child('probe', 80);
    t.diagnostic(`80 ms per sync: ${JSON.stringify(slow.status)}`);
    assert.ok(slow.status.samples >= diskHealth.MIN_SAMPLES, JSON.stringify(slow));
    assert.ok(slow.status.ms >= 80, JSON.stringify(slow));
    assert.equal(slow.status.slow, true);
    assert.ok(slow.hint && slow.hint.ms >= 80);
    assert.equal(slow.probeFileLeft, false, 'the probe file is removed at stop');
    const fast = child('probe', 0);
    t.diagnostic(`no delay: ${JSON.stringify(fast.status)}`);
    assert.equal(fast.hint, null, JSON.stringify(fast));
  });
});

describe('diskHealth: a persistent state, not one bad moment', () => {
  it('slow from MIN_SAMPLES on with a trimmed mean ≥ SLOW_MS, fast again below FAST_MS; one log line each way', () => {
    const logger = require('../src/utils/logger');
    const { mock } = require('node:test');
    const warn = mock.method(logger, 'warn', () => {});
    const info = mock.method(logger, 'info', () => {});
    try {
      diskHealth._resetForTest();
      assert.equal(diskHealth.status(), null);
      // one sync of seconds among fast ones: no hint
      for (let i = 0; i < 14; i++) diskHealth.addSample(3);
      diskHealth.addSample(6700);
      assert.equal(diskHealth.hint(), null);
      // a slow disk: ~75 ms (the protocol: ~300 ms per write = four syncs)
      diskHealth._resetForTest();
      for (let i = 0; i < diskHealth.MIN_SAMPLES - 1; i++) diskHealth.addSample(75);
      assert.equal(diskHealth.hint(), null, 'not before MIN_SAMPLES');
      diskHealth.addSample(75);
      assert.deepEqual(diskHealth.hint(), { ms: 75 });
      for (let i = 0; i < 5; i++) diskHealth.addSample(40); // between FAST_MS and SLOW_MS: stays slow
      assert.ok(diskHealth.hint());
      for (let i = 0; i < diskHealth.WINDOW; i++) diskHealth.addSample(4);
      assert.equal(diskHealth.hint(), null);
      assert.equal(warn.mock.calls.filter((c) => /data disk is slow/.test(c.arguments[1])).length, 1);
      assert.equal(info.mock.calls.filter((c) => /writes fast again/.test(c.arguments[1])).length, 1);
      assert.equal(diskHealth.lastMs(), 4);
    } finally {
      mock.restoreAll();
      diskHealth._resetForTest();
    }
  });
});
