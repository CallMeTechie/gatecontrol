'use strict';

// Child process of tests/plugins_db_wal.test.js, started with LD_PRELOAD=slowfsync.so (every sync waits
// FAKE_FSYNC_MS). Prints one JSON line.
//
//   node run.js plugin N  N single-row UPDATEs and N kv.set through the plugin storage (WAL since 1.255.0)
//   node run.js delete    the same UPDATEs with the pragmas of before 1.255.0 (journal_mode = DELETE)
//   node run.js probe     the disk write probe (services/diskHealth.js) until it has MIN_SAMPLES

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
  const out = what === 'plugin' ? await plugin() : (what === 'delete' ? rollbackJournal() : await probe());
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
})().catch((e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(1); });
