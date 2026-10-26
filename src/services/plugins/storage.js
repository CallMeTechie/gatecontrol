'use strict';

// Host side of a plugin's storage: one SQLite file per plugin at
// <data>/plugin-data/<id>/db/plugin.db, served by a worker thread
// (dbWorker.js). Chosen over "tables prefixed plg_<id>_ in the main DB":
//   * no SQL parsing is needed to keep a plugin away from GateControl's own
//     tables — the main database is simply not open in that connection
//     (ATTACH & co. are refused by sqlGuard);
//   * "Alles löschen" is deleting one folder, "Daten behalten" is leaving it;
//   * the file has a size cap (max_page_count) and a runaway query only
//     blocks the worker, which is terminated after TIMEOUTS.db.
// The plugin process cannot write this folder (its --allow-fs-write is the
// sibling files/ folder), so it cannot swap the database file under the host.

const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { dbDir, LIMITS, TIMEOUTS } = require('./constants');

const IDLE_MS = 5 * 60 * 1000;
const instances = new Map();

/** The largest size of a plugin's database: plugin.json storage.maxMB (since 1.206.0), else LIMITS.dbMaxBytes. */
function maxBytesOf(id) {
  try {
    const p = require('./registry').get(id);
    const v = p && p.manifest && p.manifest.storage && p.manifest.storage.maxBytes;
    return Number.isSafeInteger(v) && v > 0 ? v : LIMITS.dbMaxBytes;
  } catch { return LIMITS.dbMaxBytes; }
}

class PluginDb {
  constructor(id) {
    this.id = id;
    this.maxBytes = null; // set by setLimit (install / update), else maxBytesOf(id)
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.idle = null;
  }

  ensure() {
    if (this.worker) return this.worker;
    const dir = dbDir(this.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const w = new Worker(path.join(__dirname, 'dbWorker.js'), {
      workerData: { file: path.join(dir, 'plugin.db'), maxBytes: this.maxBytes || maxBytesOf(this.id) },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
      env: {},
    });
    w.unref();
    w.on('message', (m) => {
      const p = m && this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
    });
    const fail = (err) => {
      if (this.worker !== w) return;
      this.worker = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
    };
    w.on('error', (e) => fail(e instanceof Error ? e : new Error(String(e))));
    w.on('exit', () => fail(new Error('storage closed')));
    this.worker = w;
    return w;
  }

  call(op, args, timeoutMs = TIMEOUTS.db) {
    const w = this.ensure();
    const id = ++this.seq;
    this.touch();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('storage timeout'));
        // a statement that runs this long blocks every later one: start over
        if (this.worker === w) { this.worker = null; w.terminate().catch(() => {}); }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      w.postMessage({ id, op, args });
    });
  }

  touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (!this.pending.size) this.close(); }, IDLE_MS);
    this.idle.unref();
  }

  async close() {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const w = this.worker;
    this.worker = null;
    if (!w) return;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('storage closed')); }
    this.pending.clear();
    await w.terminate().catch(() => {});
  }
}

function forPlugin(id) {
  let db = instances.get(id);
  if (!db) { db = new PluginDb(id); instances.set(id, db); }
  return db;
}

async function close(id) {
  const db = instances.get(id);
  instances.delete(id);
  if (db) await db.close();
}

/**
 * The size limit of a plugin's database (install / update with plugin.json
 * storage.maxMB): an open connection with another limit closes, the next
 * call opens it with the new one (SQLite never shrinks below what is used).
 */
async function setLimit(id, maxBytes) {
  const db = forPlugin(id);
  if (db.maxBytes === maxBytes) return;
  db.maxBytes = maxBytes;
  await db.close();
}

async function closeAll() {
  await Promise.all([...instances.keys()].map(close));
}

/** Bytes used by a plugin's data folder (database + files). */
function usage(dir) {
  let total = 0;
  const walk = (d, depth) => {
    if (depth > 20) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) { try { total += fs.statSync(p).size; } catch { /* gone */ } }
    }
  };
  walk(dir, 0);
  return total;
}

module.exports = { forPlugin, close, closeAll, usage, setLimit, maxBytesOf };
