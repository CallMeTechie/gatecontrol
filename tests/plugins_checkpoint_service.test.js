'use strict';

// Checkpoints of the plugin databases in one thread of the host
// (services/plugins/checkpointService.js + checkpointWorker.js) and the gate
// "one checkpoint at a time" it shares with the host database
// (db/checkpointGate.js).
//
// Protokoll vom 12./13. 11. (Cloud-Platte: 38 ms je Sync, 26 je Sekunde):
// winzige Schreibvorgänge der Plugins dauerten regelmäßig 0,3–10 s. Die
// Nachstellung mit gebremsten Syncs (tests/plugins_db_wal.test.js) zeigt die
// Zeiten; hier das Verhalten ohne gebremste Platte:
//   * ein geändertes Plugin wird nach maxAgeMs gesichert, ein ruhiges nie;
//   * nie zwei Checkpoints gleichzeitig (Tor, auch gegenüber der Host-Datenbank);
//   * eine offene Transaktion des Plugins, die erst liest und dann schreibt,
//     übersteht einen Checkpoint mitten darin;
//   * das Protokoll bleibt begrenzt, wenn der Thread nicht nachkommt;
//   * Schließen hinterlässt plugin.db allein; fällt der Thread aus, sichern
//     die Speicher-Threads wieder selbst.

process.env.GC_PLUGIN_CHECKPOINT = 'worker';
require('./helpers/test-env');
const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');

const storage = require('../src/services/plugins/storage');
const service = require('../src/services/plugins/checkpointService');
const gate = require('../src/db/checkpointGate');
const { dbDir } = require('../src/services/plugins/constants');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const files = (id) => fs.readdirSync(dbDir(id)).sort();
const walSize = (id) => { try { return fs.statSync(path.join(dbDir(id), 'plugin.db-wal')).size; } catch { return 0; } };

let seen = [];
service.handlers.onCheckpoint = (m) => { seen.push(m); };
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(10); } return !!fn(); };
const served = (id) => until(() => storage.forPlugin(id).served === true);
const real = (id) => seen.filter((m) => m.id === id && m.log > 0);

/** plugin.db alone, without its log (as tests/plugins_db_wal.test.js): does it hold the row? */
function inMainFile(id, sql) {
  const buf = fs.readFileSync(path.join(dbDir(id), 'plugin.db'));
  buf[18] = 1;
  buf[19] = 1;
  let c = null;
  try { c = new Database(buf); return c.prepare(sql).get(); } catch (err) {
    if (err.code !== 'SQLITE_CORRUPT' && err.code !== 'SQLITE_NOTADB' && !/no such table/.test(err.message)) throw err;
    return null;
  } finally { if (c) c.close(); }
}

afterEach(async () => {
  await storage.closeAll();
  service._setOptionsForTest(null);
  storage._setWalCapPagesForTest(null);
  Atomics.store(new Int32Array(gate.shared()), 0, 0);
  seen = [];
});
after(() => storage.closeAll());

describe('checkpoint thread of the plugin databases', () => {
  it('a changed database is checkpointed once the change is maxAgeMs old, a quiet one never; closing leaves plugin.db alone', async () => {
    service._setOptionsForTest({ everyMs: 20, maxAgeMs: 300 });
    const db = storage.forPlugin('cs-age');
    await db.call('exec', { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)' });
    assert.ok(await served('cs-age'), 'the thread serves the file');
    await until(() => real('cs-age').length >= 1); // the log of CREATE TABLE
    await sleep(100);
    seen = [];
    await sleep(500);
    assert.deepEqual(seen, [], 'quiet: no checkpoint (the new start of the log is no change)');
    // reads, and a transaction that only reads: nothing to checkpoint either
    await db.call('query', { sql: 'SELECT COUNT(*) AS n FROM t', mode: 'get' });
    await db.call('exec', { sql: 'BEGIN' });
    await db.call('query', { sql: 'SELECT COUNT(*) AS n FROM t', mode: 'get' });
    await db.call('exec', { sql: 'COMMIT' });
    await sleep(500);
    assert.deepEqual(seen, [], 'a transaction that only read: no checkpoint');
    // one that wrote is seen at its COMMIT
    await db.call('exec', { sql: 'BEGIN' });
    await db.call('query', { sql: "INSERT INTO t VALUES (7, 'txn')", mode: 'run' });
    await db.call('exec', { sql: 'COMMIT' });
    assert.ok(await until(() => real('cs-age').some((m) => m.complete)), 'a transaction that wrote is checkpointed');
    assert.ok(await until(() => { const r = inMainFile('cs-age', 'SELECT v FROM t WHERE id = 7'); return r && r.v === 'txn'; }));
    await sleep(100);
    seen = [];

    const t0 = Date.now();
    await db.call('query', { sql: "INSERT INTO t VALUES (1, 'a')", mode: 'run' });
    // reads all the time: a storage thread that checkpoints itself would never find its quiet time
    const reads = setInterval(() => { db.call('query', { sql: 'SELECT v FROM t', mode: 'get' }).catch(() => {}); }, 20);
    try {
      assert.ok(await until(() => real('cs-age').length >= 1), 'checkpointed');
    } finally { clearInterval(reads); }
    const took = Date.now() - t0;
    assert.ok(took >= 280 && took < 3000, `after ${took} ms`);
    assert.equal(real('cs-age')[0].complete, true);
    assert.ok(await until(() => { const r = inMainFile('cs-age', 'SELECT v FROM t WHERE id = 1'); return r && r.v === 'a'; }), 'the row is in plugin.db itself');

    assert.ok(files('cs-age').includes('plugin.db-wal'));
    await storage.close('cs-age');
    assert.deepEqual(files('cs-age'), ['plugin.db'], 'the log copied back and removed (no connection of the thread left)');
    // and the folder can go (uninstall, restore): nothing holds the file open
    fs.rmSync(dbDir('cs-age'), { recursive: true, force: true });
    const again = storage.forPlugin('cs-age');
    await again.call('exec', { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)' });
    assert.equal((await again.call('query', { sql: 'SELECT COUNT(*) AS n FROM t', mode: 'get' })).row.n, 0, 'a new file');
    assert.ok(await served('cs-age'));
  });

  it('never two checkpoints at once: the thread waits for the gate, and takes one database after the other', async () => {
    service._setOptionsForTest({ everyMs: 20, maxAgeMs: 150, gateWaitMs: 60000 });
    const a = storage.forPlugin('cs-gate-a');
    const b = storage.forPlugin('cs-gate-b');
    for (const db of [a, b]) await db.call('exec', { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)' });
    assert.ok(await served('cs-gate-a') && await served('cs-gate-b'));
    await until(() => real('cs-gate-a').length && real('cs-gate-b').length);
    await sleep(100);
    seen = [];
    // someone else (the host database's checkpoint) holds the gate
    const g = new Int32Array(gate.shared());
    assert.equal(Atomics.compareExchange(g, 0, 0, gate.HOST), 0);
    await Promise.all([a, b].map((db) => db.call('query', { sql: "INSERT INTO t VALUES (1, 'x')", mode: 'run' })));
    await sleep(700);
    assert.deepEqual(seen, [], 'no checkpoint while the gate is held');
    assert.equal(inMainFile('cs-gate-a', 'SELECT v FROM t WHERE id = 1') || null, null);
    // a statement does not wait for it either
    const t0 = Date.now();
    await a.call('query', { sql: "UPDATE t SET v = 'y' WHERE id = 1", mode: 'run' });
    assert.ok(Date.now() - t0 < 500);
    gate.release(gate.shared(), gate.HOST);
    assert.ok(await until(() => real('cs-gate-a').length && real('cs-gate-b').length), 'both follow');
    const list = [...real('cs-gate-a').slice(0, 1), ...real('cs-gate-b').slice(0, 1)].sort((x, y) => x.at - y.at);
    assert.ok(list[1].at >= list[0].at + list[0].ms, `one after the other: ${JSON.stringify(list.map((m) => [m.id, m.at, m.ms]))}`);
    assert.equal(Atomics.load(g, 0), 0, 'the gate is free again');
  });

  it('the gate does not hold a checkpoint for ever: after gateWaitMs it runs', async () => {
    service._setOptionsForTest({ everyMs: 20, maxAgeMs: 100, gateWaitMs: 300 });
    const db = storage.forPlugin('cs-gate-wait');
    await db.call('exec', { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)' });
    assert.ok(await served('cs-gate-wait'));
    await until(() => real('cs-gate-wait').length);
    seen = [];
    const g = new Int32Array(gate.shared());
    Atomics.store(g, 0, gate.HOST);
    await db.call('query', { sql: "INSERT INTO t VALUES (1, 'x')", mode: 'run' });
    assert.ok(await until(() => real('cs-gate-wait').length >= 1, 4000), 'checkpointed without the gate');
    assert.equal(Atomics.load(g, 0), gate.HOST, 'and the gate of the other one is not taken away');
  });

  it('a transaction of the plugin that reads first and writes later survives a checkpoint in between', async () => {
    service._setOptionsForTest({ everyMs: 20, maxAgeMs: 100 });
    const db = storage.forPlugin('cs-txn');
    await db.call('exec', { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)' });
    await db.call('query', { sql: "INSERT INTO t VALUES (1, 'a')", mode: 'run' });
    assert.ok(await served('cs-txn'));
    for (let round = 0; round < 3; round++) {
      seen = [];
      await db.call('query', { sql: 'UPDATE t SET v = ? WHERE id = 1', params: ['r' + round], mode: 'run' });
      await db.call('exec', { sql: 'BEGIN' });
      assert.equal((await db.call('query', { sql: 'SELECT v FROM t WHERE id = 1', mode: 'get' })).row.v, 'r' + round);
      // the checkpoint of the UPDATE before, and the thread's "start the log anew" — inside the open transaction
      assert.ok(await until(() => seen.some((m) => m.id === 'cs-txn' && m.complete)), 'checkpointed during the transaction');
      await sleep(50);
      await db.call('query', { sql: 'UPDATE t SET v = ? WHERE id = 1', params: ['t' + round], mode: 'run' });
      await db.call('exec', { sql: 'COMMIT' });
      assert.equal((await db.call('query', { sql: 'SELECT v FROM t WHERE id = 1', mode: 'get' })).row.v, 't' + round);
    }
    assert.ok(await until(() => { const r = inMainFile('cs-txn', 'SELECT v FROM t WHERE id = 1'); return r && r.v === 't2'; }), 'the committed transaction reaches plugin.db');
  });

  it('the log stays bounded when the thread does not keep up: the write that reaches the limit checkpoints itself', async () => {
    const CAP = 300; // pages (the real limit: 4000)
    storage._setWalCapPagesForTest(CAP);
    service._setOptionsForTest({ everyMs: 20, maxAgeMs: 3600e3, growBytes: 1e12 }); // serves the file, never due
    const db = storage.forPlugin('cs-cap');
    await db.call('exec', { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)' });
    assert.ok(await served('cs-cap'));
    assert.ok(await until(() => real('cs-cap').length >= 1)); // the log it found when it took the file: once
    await sleep(50); // the storage thread took its limit
    seen = [];
    let max = 0;
    for (let i = 0; i < 2500; i++) {
      await db.call('query', { sql: 'INSERT OR REPLACE INTO t VALUES (?, ?)', params: [i % 400, 'x'.repeat(3000)], mode: 'run' });
      if (i % 50 === 0) max = Math.max(max, walSize('cs-cap'));
    }
    max = Math.max(max, walSize('cs-cap'));
    assert.deepEqual(seen, [], 'the thread did not checkpoint');
    assert.ok(max > 0 && max <= (CAP + 20) * 4200, `log at most ${Math.round(max / 1024)} KB (limit ${CAP} pages) after 2500 pages written`);
    assert.equal((await db.call('query', { sql: 'SELECT COUNT(*) AS n FROM t', mode: 'get' })).row.n, 400);
  });

  it('a storage thread restarted after "storage timed out": the new one is served again, its writes are checkpointed, closing leaves plugin.db alone', async () => {
    const { mock } = require('node:test');
    const logger = require('../src/utils/logger');
    mock.method(logger, 'warn', () => {});
    service._setOptionsForTest({ everyMs: 20, maxAgeMs: 150 });
    try {
      const db = storage.forPlugin('cs-timeout');
      await db.call('exec', { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)' });
      await db.call('query', { sql: "INSERT INTO t VALUES (1, 'before')", mode: 'run' });
      assert.ok(await served('cs-timeout'));
      const first = db.worker;
      const firstGone = new Promise((resolve) => { first.once('exit', resolve); });
      // ~1.5 s in the worker with a limit of 300 ms (as tests/plugins_storage_timeout.test.js)
      const sql = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c';
      const t0 = Date.now();
      await db.call('query', { sql, params: [300000], mode: 'get' }, 5000);
      const n = Math.floor(300000 * 1500 / Math.max(1, Date.now() - t0));
      await assert.rejects(db.call('query', { sql, params: [n], mode: 'get' }, 300), /storage timeout/);
      assert.equal(db.served, null);
      await db.call('query', { sql: "UPDATE t SET v = 'after' WHERE id = 1", mode: 'run' });
      assert.notEqual(db.worker, first, 'a new storage thread');
      assert.ok(await served('cs-timeout'), 'served again, with the new thread\'s write counter');
      seen = [];
      await db.call('query', { sql: "UPDATE t SET v = 'again' WHERE id = 1", mode: 'run' });
      assert.ok(await until(() => real('cs-timeout').some((m) => m.complete)), 'its write is seen and checkpointed');
      assert.ok(await until(() => { const r = inMainFile('cs-timeout', 'SELECT v FROM t WHERE id = 1'); return r && r.v === 'again'; }));
      await firstGone; // the terminated thread ends once SQLite gives control back: its connection is open until then
      await storage.close('cs-timeout');
      assert.deepEqual(files('cs-timeout'), ['plugin.db']);
    } finally { mock.restoreAll(); }
  });

  it('the thread ends: the storage threads checkpoint themselves again (quiet time), nothing is lost', async () => {
    const { mock } = require('node:test');
    const logger = require('../src/utils/logger');
    const warn = mock.method(logger, 'warn', () => {});
    storage._setCheckpointIdleMsForTest(150);
    service._setOptionsForTest({ everyMs: 20, maxAgeMs: 3600e3, growBytes: 1e12 });
    try {
      const db = storage.forPlugin('cs-lost');
      await db.call('exec', { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)' });
      assert.ok(await served('cs-lost'));
      assert.ok(await until(() => real('cs-lost').length >= 1)); // the log it found when it took the file: once
      await db.call('query', { sql: "INSERT INTO t VALUES (1, 'kept')", mode: 'run' });
      await sleep(400);
      assert.equal(inMainFile('cs-lost', 'SELECT v FROM t WHERE id = 1') || null, null, 'served: the storage thread does not checkpoint');
      // the thread dies (an error in it): as storage.js sees it
      service._crashForTest();
      assert.ok(await until(() => !service.running()));
      assert.equal(storage.forPlugin('cs-lost').served, false);
      assert.ok(warn.mock.calls.some((c) => /plugin checkpoint thread ended/.test(c.arguments[1])));
      assert.ok(await until(() => { const r = inMainFile('cs-lost', 'SELECT v FROM t WHERE id = 1'); return r && r.v === 'kept'; }), 'checkpointed by the storage thread');
      await db.call('query', { sql: "UPDATE t SET v = 'more' WHERE id = 1", mode: 'run' });
      assert.ok(await until(() => { const r = inMainFile('cs-lost', 'SELECT v FROM t WHERE id = 1'); return r && r.v === 'more'; }));
      await storage.close('cs-lost');
      assert.deepEqual(files('cs-lost'), ['plugin.db']);
    } finally {
      mock.restoreAll();
      storage._setCheckpointIdleMsForTest(null);
    }
  });
});

describe('the host database\'s checkpoint worker and the gate (db/checkpointWorker.js)', () => {
  it('waits while a plugin checkpoint holds the gate, runs when it is free, and frees it itself', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-gate-'));
    const file = path.join(dir, 'h.db');
    const main = new Database(file);
    main.pragma('journal_mode = WAL');
    main.pragma('wal_autocheckpoint = 0');
    main.exec('CREATE TABLE t (x TEXT)');
    const g = new Int32Array(gate.shared());
    const got = [];
    const w = new Worker(path.join(__dirname, '..', 'src', 'db', 'checkpointWorker.js'), { workerData: { file, everyMs: 20, maxAgeMs: 100, gate: gate.shared(), gateWaitMs: 60000 } });
    try {
      w.on('message', (m) => { if (m && m.t === 'checkpoint' && m.log > 0) got.push(m); });
      assert.ok(await until(() => got.length >= 1), 'the log of CREATE TABLE');
      await sleep(100);
      got.length = 0;
      assert.equal(Atomics.compareExchange(g, 0, 0, gate.PLUGINS), 0);
      main.prepare('INSERT INTO t VALUES (?)').run('a');
      await sleep(600);
      assert.deepEqual(got, [], 'no checkpoint of the host database while a plugin checkpoint runs');
      main.prepare('INSERT INTO t VALUES (?)').run('b'); // the main thread writes on
      gate.release(gate.shared(), gate.PLUGINS);
      assert.ok(await until(() => got.length >= 1), 'it follows');
      await sleep(50);
      assert.equal(Atomics.load(g, 0), 0);
    } finally {
      await w.terminate();
      main.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
