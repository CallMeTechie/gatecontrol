'use strict';

// Child process of tests/plugins_db_wal.test.js, started with LD_PRELOAD=slowfsync.so (every sync waits
// FAKE_FSYNC_MS). Prints one JSON line.
//
//   node run.js plugin N  N single-row UPDATEs and N kv.set through the plugin storage (WAL since 1.255.0)
//   node run.js delete    the same UPDATEs with the pragmas of before 1.255.0 (journal_mode = DELETE)
//   node run.js probe     the disk write probe (services/diskHealth.js) until it has MIN_SAMPLES
//   node run.js quiet N   N times: a write, a quiet time (the log is checkpointed), the next write and reads meanwhile
//                         — what the first write after the checkpoint costs, and a read that arrives during it
//   node run.js many N    N plugins written in the same moment: when each one's log was checkpointed
//   node run.js kill      rows written one after the other, each printed once stored — until the test kills the process
//
// quiet / many / kill: with GC_PLUGIN_CHECKPOINT=worker the host's checkpoint thread serves the files
// (services/plugins/checkpointService.js), else each storage thread checkpoints itself (GC_PLUGIN_CHECKPOINT=inline).

require('../../helpers/test-env');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const WRITES = Number(process.argv[3]) || 10;

function median(list) {
  const s = [...list].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function plugin() {
  const storage = require('../../../src/services/plugins/storage');
  const db = storage.forPlugin('slow-disk');
  await db.call('exec', { sql: 'CREATE TABLE resources (id INTEGER PRIMARY KEY, state_json TEXT)' });
  await db.call('exec', { sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 20) INSERT INTO resources SELECT x, '{}' FROM c" });
  const ms = [];
  for (let i = 0; i < WRITES; i++) {
    const t0 = performance.now();
    await db.call('query', { sql: 'UPDATE resources SET state_json = ? WHERE id = ?', params: [JSON.stringify({ on: i }), 1 + (i % 20)], mode: 'run' });
    await db.call('kv.set', { key: 'last', value: i });
    ms.push((performance.now() - t0) / 2);
  }
  const still = await db.call('query', { sql: 'SELECT 1 AS one', mode: 'get' });
  await storage.closeAll();
  const dir = path.join(require('../../../src/services/plugins/constants').dbDir('slow-disk'));
  return { medianMs: median(ms), maxMs: Math.max(...ms), open: !!still.row, files: fs.readdirSync(dir).sort() };
}

function rollbackJournal() {
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-slow-delete-'));
  const db = new Database(path.join(dir, 'plugin.db'));
  db.pragma('journal_mode = DELETE');
  db.exec('CREATE TABLE resources (id INTEGER PRIMARY KEY, state_json TEXT)');
  db.exec("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 20) INSERT INTO resources SELECT x, '{}' FROM c");
  const up = db.prepare('UPDATE resources SET state_json = ? WHERE id = ?');
  const ms = [];
  for (let i = 0; i < WRITES; i++) {
    const t0 = performance.now();
    up.run(JSON.stringify({ on: i }), 1 + (i % 20));
    ms.push(performance.now() - t0);
  }
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return { medianMs: median(ms), maxMs: Math.max(...ms) };
}

const QUIET_MS = 150;
// how long past its usual time a checkpoint's report is waited for (a machine whose real disk is busy)
const REPORT_WAIT_MS = 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Until `done()` or REPORT_WAIT_MS passed. */
async function reported(done) {
  for (const end = performance.now() + REPORT_WAIT_MS; !done() && performance.now() < end;) await sleep(20);
}

/** The storage with a short quiet time; → the checkpoints the host's thread reported: [{ id, from, to }]. */
function checkpointed() {
  const storage = require('../../../src/services/plugins/storage');
  const service = require('../../../src/services/plugins/checkpointService');
  storage._setCheckpointIdleMsForTest(QUIET_MS);
  service._setOptionsForTest({ everyMs: 25, maxAgeMs: QUIET_MS });
  const seen = [];
  service.handlers.onCheckpoint = (m) => { if (m.log > 0) seen.push({ id: m.id, from: m.at, to: m.at + m.ms, complete: m.complete }); };
  return { storage, service, seen };
}

async function quiet() {
  const { storage, service, seen } = checkpointed();
  const db = storage.forPlugin('quiet');
  await db.call('exec', { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)' });
  await db.call('query', { sql: "INSERT INTO t VALUES (1, 'a')", mode: 'run' });
  const sync = Number(process.env.FAKE_FSYNC_MS) || 0;
  const first = [];
  const reads = [];
  for (let i = 0; i < WRITES; i++) {
    // reads all through the quiet time and the checkpoint in it (two syncs, and the new start of the log)
    const until = performance.now() + QUIET_MS + sync * 6 + 200;
    // QUIET_READS=one: a single read, right after the quiet time ended (a storage thread that checkpoints itself
    // does so only once no call came for QUIET_MS)
    if (process.env.QUIET_READS === 'one') await sleep(QUIET_MS + 15);
    // With the host's thread the reads go on until the checkpoint of this quiet time was reported (on a disk that
    // is busy for real it can end after `until`), and one more: sent after the report, so answered after the
    // storage thread started the log anew (storage.js asks it to before the report is handed on, on the port of
    // the calls). The write below is then "the first write after a checkpoint", whatever the disk took.
    const want = service.running() ? seen.length + 1 : 0;
    for (;;) {
      const last = performance.now() >= until && (seen.length >= want || performance.now() >= until + REPORT_WAIT_MS);
      if (last && !want) break;
      const from = Date.now();
      const t0 = performance.now();
      await db.call('query', { sql: 'SELECT v FROM t WHERE id = 1', mode: 'get' });
      reads.push({ from, to: Date.now(), ms: performance.now() - t0 });
      if (last) break;
      await sleep(process.env.QUIET_READS === 'one' ? Math.max(1, until - performance.now()) : 7);
    }
    const t0 = performance.now();
    await db.call('query', { sql: 'UPDATE t SET v = ? WHERE id = 1', params: ['v' + i], mode: 'run' });
    first.push(performance.now() - t0);
  }
  const row = await db.call('query', { sql: 'SELECT v FROM t WHERE id = 1', mode: 'get' });
  const served = service.running();
  await storage.closeAll();
  const dir = path.join(require('../../../src/services/plugins/constants').dbDir('quiet'));
  // Reads against the checkpoints of the host's thread, on the one clock both have (Date.now, whole ms) — an order,
  // not a duration: the syncs of this child are slow by the shim AND by the real disk of the machine, a limit in
  // milliseconds would measure that disk. The reads come one after the other, so:
  //   during  per checkpoint, the reads that began and were answered while it ran — a read that waits for the
  //           checkpoint is answered after its end, never during it;
  //   held    the reads that began in the first half of a checkpoint and were not answered before its end.
  const during = seen.map((c) => reads.filter((r) => r.from >= c.from && r.to < c.to).length);
  const held = seen.reduce((n, c) => n + reads.filter((r) => r.from >= c.from && r.from < c.from + (c.to - c.from) / 2 && r.to >= c.to).length, 0);
  return {
    firstWriteMaxMs: Math.max(...first), readMaxMs: Math.max(...reads.map((r) => r.ms)), reads: reads.length,
    checkpoints: seen.length, checkpointMinMs: seen.length ? Math.min(...seen.map((c) => c.to - c.from)) : null, readsDuring: during, readsHeld: held,
    served, value: row.row.v, files: fs.readdirSync(dir).sort(),
  };
}

async function many() {
  const { storage, seen } = checkpointed();
  const dbs = [];
  for (let i = 0; i < WRITES; i++) {
    const db = storage.forPlugin('many-' + i);
    await db.call('exec', { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)' });
    dbs.push(db);
  }
  const sync = Number(process.env.FAKE_FSYNC_MS) || 0;
  // the usual time of the checkpoints, and past it until each database's was reported (a disk busy for real)
  const all = () => dbs.every((db, i) => seen.some((c) => c.id === 'many-' + i));
  await sleep(QUIET_MS + WRITES * sync * 4 + 300);
  await reported(all);
  seen.length = 0;
  await Promise.all(dbs.map((db) => db.call('query', { sql: "INSERT OR REPLACE INTO t VALUES (1, 'x')", mode: 'run' })));
  await sleep(QUIET_MS + WRITES * sync * 4 + 300);
  await reported(all);
  const t0 = Math.min(...seen.map((c) => c.from));
  const list = seen.map((c) => ({ id: c.id, from: c.from - t0, to: c.to - t0 }));
  await storage.closeAll();
  return { checkpoints: list };
}

async function kill() {
  const { storage } = checkpointed();
  const db = storage.forPlugin('kill');
  await db.call('exec', { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)' });
  process.stdout.write(`dir ${require('../../../src/services/plugins/constants').dbDir('kill')}\n`);
  for (let i = 1; ; i++) {
    await db.call('query', { sql: 'INSERT INTO t VALUES (?, ?)', params: [i, 'x'.repeat(500)], mode: 'run' });
    if (i % 10 === 0) await db.call('kv.set', { key: 'last', value: i });
    process.stdout.write(`stored ${i}\n`);
    if (i % 25 === 0) await sleep(QUIET_MS + 30); // quiet times: checkpoints and new starts of the log in between
  }
}

async function probe() {
  const diskHealth = require('../../../src/services/diskHealth');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-slow-probe-'));
  diskHealth.start({ dir, everyMs: 20, firstMs: 0, force: true });
  for (let i = 0; i < 500 && (!diskHealth.status() || diskHealth.status().samples < diskHealth.MIN_SAMPLES); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const out = { status: diskHealth.status(), hint: diskHealth.hint(), lastMs: diskHealth.lastMs() };
  await diskHealth.stop();
  out.probeFileLeft = fs.existsSync(path.join(dir, diskHealth.PROBE_FILE));
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

(async () => {
  const what = process.argv[2];
  const modes = { plugin, delete: rollbackJournal, probe, quiet, many, kill };
  const out = await modes[Object.prototype.hasOwnProperty.call(modes, what) ? what : 'probe']();
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
})().catch((e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(1); });
