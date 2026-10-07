'use strict';

// Worker thread: one plugin's SQLite file (docs/plugins.md "Speicher").
// Runs in the HOST process, but off the main thread: a runaway query of a
// plugin blocks this worker only; the host terminates it after a timeout
// (storage.js). Every plugin statement passes sqlGuard first.

const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');
const { checkSql } = require('./sqlGuard');

const MAX_ROWS = 5000;
const MAX_VALUE = 1024 * 1024;

const db = new Database(workerData.file);
db.pragma('journal_mode = DELETE');
db.pragma('foreign_keys = ON');
db.pragma('trusted_schema = OFF');
db.pragma(`max_page_count = ${Math.max(256, Math.floor(workerData.maxBytes / db.pragma('page_size', { simple: true })))}`);
db.exec(`
  CREATE TABLE IF NOT EXISTS _gc_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS _gc_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS _gc_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
`);

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
  for (const row of stmt.iterate(...args)) {
    if (rows.length >= MAX_ROWS) { truncated = true; break; }
    rows.push(outRow(row));
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

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.op === 'close') { try { db.close(); } catch { /* ignore */ } process.exit(0); }
  const fn = Object.prototype.hasOwnProperty.call(ops, msg.op) ? ops[msg.op] : null;
  try {
    if (!fn) throw new Error('unknown operation');
    parentPort.postMessage({ id: msg.id, ok: true, value: fn(msg.args || {}) });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String((e && e.message) || e).slice(0, 500) });
  }
});
