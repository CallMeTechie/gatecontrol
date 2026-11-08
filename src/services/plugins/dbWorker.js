'use strict';

// Worker thread: one plugin's SQLite file (docs/plugins.md "Speicher").
// Runs in the HOST process, but off the main thread: a runaway query of a
// plugin blocks this worker only; the host terminates it after a timeout
// (storage.js). Every plugin statement passes sqlGuard first.
//
// Calls and answers go over workerData.port. workerData.state (shared memory)
// tells the host what runs since when — the host measures a statement's time
// with it, not with the arrival of the answer (storage.js check()).

const { workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');
const { checkSql } = require('./sqlGuard');

const port = workerData.port;
const state = new Int32Array(workerData.state, 0, 2); // [open, id of the running call]
const since = new Float64Array(workerData.state, 8, 1); // when state last changed

const MAX_ROWS = 5000;
const MAX_VALUE = 1024 * 1024;
// the size of a list answer (query mode 'all'): the host's main thread copies it out of this thread and
// serialises it for the plugin in one go — 16 MB take it ~100 ms; more rows come as `truncated` (as past MAX_ROWS)
const MAX_ANSWER_BYTES = 16 * 1024 * 1024;
// the write-ahead log is copied back into plugin.db (two fsyncs) when it holds this many pages (4 KB each) …
const WAL_AUTOCHECKPOINT = 1000;
// … or after this long without a call (a passive checkpoint between two calls: the data is on the disk soon,
// no statement waits for it) — and the log file shrinks back to this size after a checkpoint
const CHECKPOINT_IDLE_MS = workerData.checkpointIdleMs || 30 * 1000;
const JOURNAL_SIZE_LIMIT = 4 * 1024 * 1024;

/** About the bytes of a row in an answer (strings by their length, numbers 8). */
function rowBytes(row) {
  let n = 16;
  for (const k in row) {
    const v = row[k];
    n += k.length + 8;
    if (typeof v === 'string') n += v.length;
    else if (v && typeof v === 'object' && typeof v.b64 === 'string') n += v.b64.length;
  }
  return n;
}

const db = new Database(workerData.file);
// WAL with synchronous = NORMAL (as the host database, db/connection.js): a COMMIT appends to plugin.db-wal and
// never waits for the disk. In the rollback journal (journal_mode = DELETE, before 1.255.0) every write — one UPDATE,
// a kv.set — paid four fsyncs (journal, database, deleting the journal); on a slow disk that is 200–300 ms per
// write (protocol of 8. 11.: ~500 slow writes an hour from every plugin, reads never slow). The disk is synced at
// a checkpoint only (every WAL_AUTOCHECKPOINT pages, at CHECKPOINT_IDLE_MS of quiet, at close). Crash-safe as
// before; a power cut can lose the transactions since the last checkpoint, never corrupt the file
// (docs/plugins.md "Speicher"). Changing the mode needs the file to itself: should another connection hold it,
// the file stays in its mode until the next start of this worker.
try { db.pragma('journal_mode = WAL'); } catch { /* busy: next open */ }
db.pragma('synchronous = NORMAL');
db.pragma(`wal_autocheckpoint = ${WAL_AUTOCHECKPOINT}`);
db.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT}`);
db.pragma('foreign_keys = ON');
db.pragma('trusted_schema = OFF');
db.pragma(`max_page_count = ${Math.max(256, Math.floor(workerData.maxBytes / db.pragma('page_size', { simple: true })))}`);
db.exec(`
  CREATE TABLE IF NOT EXISTS _gc_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS _gc_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS _gc_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
`);
since[0] = Date.now();
Atomics.store(state, 0, 1);

function inParams(p) {
  const conv = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('invalid parameter'); return v; }
    if (typeof v === 'string') { if (v.length > MAX_VALUE) throw new Error('parameter too long'); return v; }
    if (v && typeof v === 'object' && typeof v.b64 === 'string') return Buffer.from(v.b64, 'base64');
    throw new Error('invalid parameter');
  };
  if (p == null) return [];
  if (Array.isArray(p)) { if (p.length > 100) throw new Error('too many parameters'); return p.map(conv); }
  if (typeof p === 'object') {
    const out = {};
    const keys = Object.keys(p);
    if (keys.length > 100) throw new Error('too many parameters');
    for (const k of keys) { if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw new Error('invalid parameter name'); out[k] = conv(p[k]); }
    return [out];
  }
  throw new Error('invalid parameters');
}

function outRow(row) {
  if (!row || typeof row !== 'object') return row;
  const o = {};
  for (const [k, v] of Object.entries(row)) o[k] = Buffer.isBuffer(v) ? { b64: v.toString('base64') } : (typeof v === 'bigint' ? Number(v) : v);
  return o;
}

function query({ sql, params, mode }) {
  const bad = checkSql(sql);
  if (bad) throw new Error(bad);
  const stmt = db.prepare(sql);
  const args = inParams(params);
  if (mode === 'run' || !stmt.reader) {
    const r = stmt.run(...args);
    return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
  }
  if (mode === 'get') return { row: outRow(stmt.get(...args)) || null };
  const rows = [];
  let truncated = false;
  let bytes = 0;
  for (const row of stmt.iterate(...args)) {
    if (rows.length >= MAX_ROWS || (rows.length && bytes >= MAX_ANSWER_BYTES)) { truncated = true; break; }
    const r = outRow(row);
    bytes += rowBytes(r);
    rows.push(r);
  }
  return { rows, truncated };
}

function exec({ sql }) {
  const bad = checkSql(sql);
  if (bad) throw new Error(bad);
  db.exec(sql);
  return {};
}

function migrate({ list }) {
  const done = new Set(db.prepare('SELECT version FROM _gc_migrations').all().map((r) => r.version));
  const pending = (Array.isArray(list) ? list : []).filter((m) => !done.has(m.version)).sort((a, b) => a.version - b.version);
  for (const m of pending) {
    const bad = checkSql(m.sql);
    if (bad) throw new Error(`migration ${m.version}_${m.name}: ${bad}`);
  }
  const ins = db.prepare('INSERT INTO _gc_migrations (version, name) VALUES (?, ?)');
  db.transaction(() => {
    for (const m of pending) {
      try { db.exec(m.sql); } catch (e) { throw new Error(`migration ${m.version}_${m.name}: ${e.message}`); }
      ins.run(m.version, m.name);
    }
  })();
  return { applied: pending.map((m) => m.version) };
}

const WRITES = new Set(['exec', 'migrate', 'kv.set', 'kv.delete', 'settings.set']);

const ops = {
  query,
  exec,
  migrate,
  migrations: () => ({ list: db.prepare('SELECT version, name, applied_at FROM _gc_migrations ORDER BY version').all() }),
  'kv.get': ({ key }) => { const r = db.prepare('SELECT value FROM _gc_kv WHERE key = ?').get(String(key)); return { value: r ? JSON.parse(r.value) : null }; },
  'kv.set': ({ key, value }) => {
    const v = JSON.stringify(value === undefined ? null : value);
    if (v.length > MAX_VALUE) throw new Error('value too large');
    db.prepare('INSERT INTO _gc_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(String(key), v);
    return {};
  },
  'kv.delete': ({ key }) => ({ deleted: db.prepare('DELETE FROM _gc_kv WHERE key = ?').run(String(key)).changes }),
  'kv.list': ({ prefix }) => ({ keys: db.prepare("SELECT key FROM _gc_kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key LIMIT 1000")
    .all(String(prefix || '').replace(/[\\%_]/g, (c) => '\\' + c) + '%').map((r) => r.key) }),
  'settings.all': () => {
    const out = {};
    for (const r of db.prepare('SELECT key, value FROM _gc_settings').all()) { try { out[r.key] = JSON.parse(r.value); } catch { /* skip */ } }
    return { values: out };
  },
  'settings.set': ({ values }) => {
    const up = db.prepare('INSERT INTO _gc_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const del = db.prepare('DELETE FROM _gc_settings WHERE key = ?');
    db.transaction(() => {
      for (const [k, v] of Object.entries(values || {})) {
        if (v === null || v === undefined) del.run(k);
        else { const s = JSON.stringify(v); if (s.length > MAX_VALUE) throw new Error('value too large'); up.run(k, s); }
      }
    })();
    return {};
  },
  size: () => ({ bytes: db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true }) }),
};

// the time of an operation in this thread and the rows it returned (query) go with the answer: the host logs a
// slow statement (storage.js) with what it was, apart from the time the answer then waited for the main thread
const clock = () => performance.now();
const rowsOf = (v) => (v && Array.isArray(v.rows) ? v.rows.length : (v && 'row' in v ? (v.row ? 1 : 0) : null));

function mark(id) {
  since[0] = Date.now();
  Atomics.store(state, 1, id);
}

// a checkpoint once the plugin has been quiet for CHECKPOINT_IDLE_MS after a write (cheap when the log is empty)
let idleTimer = null;
let dirty = false;
function idleCheckpoint() {
  idleTimer = null;
  if (!dirty) return;
  dirty = false;
  try { db.pragma('wal_checkpoint(PASSIVE)'); } catch { /* the next one */ }
}

port.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.op === 'close') {
    // close() copies the log into plugin.db and removes plugin.db-wal: the file alone is complete again
    try { db.close(); } catch { /* ignore */ }
    try { port.postMessage({ closed: true }); } catch { /* gone */ }
    process.exit(0);
  }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const fn = Object.prototype.hasOwnProperty.call(ops, msg.op) ? ops[msg.op] : null;
  mark(Number.isSafeInteger(msg.id) && msg.id > 0 ? msg.id : 0);
  let answer;
  const t0 = clock();
  try {
    if (!fn) throw new Error('unknown operation');
    const value = fn(msg.args || {});
    answer = { id: msg.id, ok: true, value, ms: clock() - t0, rows: rowsOf(value) };
  } catch (e) {
    answer = { id: msg.id, ok: false, error: String((e && e.message) || e).slice(0, 500), ms: clock() - t0 };
  }
  // done before the answer is posted: an answer the host can take is never "running"
  mark(0);
  port.postMessage(answer);
  if (!db.inTransaction) {
    if (WRITES.has(msg.op) || (msg.op === 'query' && answer.ok && answer.value && answer.value.changes > 0)) dirty = true;
    if (dirty) idleTimer = setTimeout(idleCheckpoint, CHECKPOINT_IDLE_MS);
  } else dirty = true;
});
