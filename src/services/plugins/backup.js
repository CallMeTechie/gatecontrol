'use strict';

// Plugins in GateControl backups (docs/plugins.md "Backup").
//
// Backup (async, part of services/backup.createBackup — no synchronous file
// or database copy on the main thread): per installed plugin
//   * the installed package files incl. its `signature` (so a fresh server
//     gets the plugin back without a new upload — and can re-check it),
//   * a consistent snapshot of its SQLite file (the SQLite backup API in
//     steps on a read-only connection, never a raw copy of a live file),
//     its files/ folder,
//   * the registry state (enabled), the third-party licence row and the
//     access targets (routes/peers by domain/name — ids change on restore),
//   * the plugin's `secret` settings once more as plain backup fields, so the
//     off-site re-key converts them like every other secret.
// Caps: MAX_PLUGIN_BYTES per backup; a plugin whose data does not fit is
// backed up without data (code, registry and settings secrets still are),
// noted in `skipped`.
//   * plugin media (plugin.json `media`, media.js) only with "Plugin-Medien
//     im Backup" on (off by default) and outside MAX_PLUGIN_BYTES, with a cap
//     of their own (MAX_MEDIA_BYTES for all plugins): the claimed files as
//     stored (encrypted) plus each file key as a backup secret; a plugin's
//     media that do not fit are left out (`skipped: ['media']`).
//   * media areas (plugin.json `media.areas`, mediaAreas.js) always: the
//     areas with their storage target and the metadata of the area files
//     (each file key as a backup secret) — never the bytes, they stay on the
//     storage target (or in the plugin media folder of this server).
//
// Restore (async, after the main restore): processes are stopped, the
// signature is verified again (a changed package is not restored; an
// unsigned one is restored but stays off while unsigned plugins are not
// allowed — the toggle itself is never taken from a backup), code and data
// are replaced, targets re-mapped, then the normal reconcile starts what may
// run. Plugins installed here but missing in a format-5 backup are removed
// completely (logged); older backups know nothing about plugins and leave
// them alone.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const pkg = require('./package');
const signature = require('./signature');
const registry = require('./registry');
const { ID_RE, LIMITS, codeDir, dataDir, dbDir, filesDir, pluginsRoot, pluginDataRoot } = require('./constants');
const logger = require('../../utils/logger');
const { Base64Value, FileBase64Value, materialize } = require('../../utils/jsonStream');
const { isSpooled } = require('../../utils/jsonSpool');

// Raw bytes of all plugins in one backup (code, databases, files). The large
// parts are never held in memory — they stay in files until the backup is
// written (FileBase64Value) and are read back in pieces on a restore
// (utils/jsonSpool) — so the cap is about the size of the backup file (base64:
// × 4/3) and the disk, not the RAM. A plugin part that does not fit is left
// out, recorded in `skipped` + `skip_reasons` and shown in the backup overview.
const MAX_PLUGIN_BYTES = 512 * 1024 * 1024;
const MAX_MEDIA_BYTES = 128 * 1024 * 1024; // plugin media (option, off by default) of all plugins in one backup
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
// snapshots of a backup run live here until the backup is written (same
// file system as the plugin data: hard links instead of copies)
const SNAP_STALE_MS = 12 * 60 * 60 * 1000;

function db() { return require('../../db/connection').getDb(); }

const tooLarge = () => Object.assign(new Error('too large for the backup'), { code: 'too_large' });
/** why a part was left out: 'too_large' (the budget) or 'read_error' (anything else) */
const reasonOf = (err) => (err && err.code === 'too_large' ? 'too_large' : 'read_error');

function snapRoot() { return path.join(pluginDataRoot(), '.backup-tmp'); }

/** A private folder for the snapshots of one backup run (old ones of a crashed run are removed). */
async function newSnapDir() {
  const root = snapRoot();
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  try {
    for (const name of await fsp.readdir(root)) {
      const p = path.join(root, name);
      try {
        const st = await fsp.lstat(p);
        if (Date.now() - st.mtimeMs > SNAP_STALE_MS) await fsp.rm(p, { recursive: true, force: true });
      } catch { /* gone meanwhile */ }
    }
  } catch { /* best effort */ }
  return fsp.mkdtemp(path.join(root, 'run-')); // 0700
}

/**
 * Regular files below `root` → Map(relative path → Base64Value). Symlinks and
 * odd names are skipped. With `snap` (a snapshot folder) each file is hard-
 * linked there and read only when the backup is written (FileBase64Value):
 * the bytes are not held in memory, and a file the plugin deletes or replaces
 * meanwhile stays as it was. Without (the code) or when linking fails, the
 * file is read now (fs.promises — a backup must not hold the main thread).
 */
async function readTree(root, budget, snap) {
  const out = new Map();
  let bytes = 0;
  const walk = async (dir, rel, depth) => {
    if (depth > LIMITS.pathDepth) return;
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      try { pkg.checkPath(r); } catch { continue; }
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs, r, depth + 1);
      else if (e.isFile()) {
        const st = await fsp.lstat(abs);
        if (!st.isFile()) continue;
        if (bytes + st.size > budget.left || out.size >= LIMITS.fileCount) throw tooLarge();
        let value = null;
        if (snap) {
          const link = path.join(snap.dir, String(snap.n++));
          try { await fsp.link(abs, link); value = new FileBase64Value(link, st.size); } catch { value = null; }
        }
        if (!value) {
          const buf = await fsp.readFile(abs);
          if (bytes + buf.length > budget.left) throw tooLarge();
          value = new Base64Value(buf);
        }
        bytes += value.length;
        out.set(r, value);
      }
    }
  };
  await walk(root, '', 0);
  budget.left -= bytes;
  return out;
}

// pages per step of the SQLite backup API (the event loop runs between steps)
const SNAPSHOT_STEP_PAGES = 256;
// a plugin that writes all the time restarts the backup API; after this many
// restarts the rest is copied in one step (what sqlite3_serialize did before)
const SNAPSHOT_MAX_RESTARTS = 3;

/**
 * A consistent snapshot of the plugin database → { value, secrets } or null.
 * The SQLite backup API copies it in steps into a file of the snapshot folder
 * (the event loop runs between steps; sqlite3_serialize did it in one
 * synchronous piece); the file is read only when the backup is written
 * (FileBase64Value). `secrets` are the secret settings of the snapshot
 * (secretSettings).
 */
async function snapshotDb(id, budget, snap) {
  const file = path.join(dbDir(id), 'plugin.db');
  try { await fsp.access(file); } catch { return null; }
  const conn = new Database(file, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    const est = conn.pragma('page_count', { simple: true }) * conn.pragma('page_size', { simple: true });
    if (est > budget.left) throw tooLarge();
    let out;
    try {
      if (!snap) throw new Error('no snapshot folder');
      const tmp = path.join(snap.dir, `db-${snap.n++}.sqlite`);
      let restarts = 0;
      let lastRemaining = Infinity;
      await conn.backup(tmp, {
        progress({ remainingPages }) {
          if (remainingPages > lastRemaining) restarts++;
          lastRemaining = remainingPages;
          return restarts >= SNAPSHOT_MAX_RESTARTS ? 0x7fffffff : SNAPSHOT_STEP_PAGES;
        },
      });
      await rollbackHeaderFile(tmp);
      const { size } = await fsp.stat(tmp);
      out = { value: new FileBase64Value(tmp, size), source: tmp };
    } catch (err) {
      // no usable snapshot folder or the like: one synchronous copy, as before
      logger.warn({ plugin: id, err: err.message }, 'backup: step-wise database snapshot failed, copying it in one piece');
      const buf = rollbackHeader(conn.serialize());
      out = { value: new Base64Value(buf), source: buf };
    }
    if (out.value.length > budget.left) throw tooLarge();
    budget.left -= out.value.length;
    return { value: out.value, secrets: secretSettings(out.source) };
  } finally {
    conn.close();
  }
}

/** rollbackHeader() for a snapshot file (bytes 18 and 19 patched in place). */
async function rollbackHeaderFile(file) {
  const fh = await fsp.open(file, 'r+');
  try {
    const head = Buffer.alloc(100);
    const { bytesRead } = await fh.read(head, 0, 100, 0);
    if (bytesRead < 100) return;
    const fixed = rollbackHeader(head);
    if (fixed !== head) await fh.write(fixed.subarray(18, 20), 0, 2, 18);
  } finally { await fh.close(); }
}

/**
 * A database file of a plugin in WAL mode (dbWorker.js, since 1.255.0) says so in its header (bytes 18 and 19 = 2);
 * SQLite refuses to open such a file from memory (new Database(buffer): "unable to open database file"). The
 * snapshot (backup API) holds every page in the file itself — no log belongs to it: the header says "rollback
 * journal" (1), as PRAGMA journal_mode = DELETE would write it. The worker switches the restored file back to WAL.
 */
function rollbackHeader(buf) {
  if (buf.length < 100 || buf[18] !== 2 || buf[19] !== 2 || !buf.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) return buf;
  const out = Buffer.from(buf);
  out[18] = 1;
  out[19] = 1;
  return out;
}

/** The secret settings (`{ enc }` values of _gc_settings) of a database snapshot (file path or serialized Buffer). */
function secretSettings(snapshot) {
  let conn;
  try { conn = Buffer.isBuffer(snapshot) ? new Database(snapshot, { readonly: true }) : new Database(snapshot, { readonly: true, fileMustExist: true }); } catch { return {}; }
  try {
    const out = {};
    for (const r of conn.prepare('SELECT key, value FROM _gc_settings').all()) {
      try { const v = JSON.parse(r.value); if (v && typeof v === 'object' && typeof v.enc === 'string') out[r.key] = v.enc; } catch { /* skip */ }
    }
    return out;
  } catch { return {}; } finally { conn.close(); }
}

// raw bytes (Base64Value), written as base64 by utils/jsonStream (piece by piece) — toJSON() gives the string
const toB64 = (m) => Object.fromEntries(m);

function exportTargets(id) {
  return db().prepare('SELECT target_id, idx, assignment FROM plugin_targets WHERE plugin_id = ? ORDER BY target_id, idx').all(id).map((r) => {
    let a = {};
    try { a = JSON.parse(r.assignment); } catch { a = {}; }
    if (a.kind === 'route') {
      const rt = db().prepare('SELECT domain, route_type, l4_listen_port FROM routes WHERE id = ?').get(a.routeId);
      a = { kind: 'route', route_domain: rt ? rt.domain : null, route_type: rt ? rt.route_type : null, l4_listen_port: rt ? rt.l4_listen_port : null };
    } else if (a.kind === 'peer') {
      const pe = db().prepare('SELECT name FROM peers WHERE id = ?').get(a.peerId);
      a = { ...a, peer_name: pe ? pe.name : null };
      delete a.peerId;
    }
    return { target_id: r.target_id, idx: r.idx, assignment: a };
  });
}

/** Human names of the parts in log lines. */
const PART_LOG = { code: 'code', database: 'database', files: 'files', media: 'media', media_areas: 'media areas' };

/**
 * Everything of the installed plugins for createBackup(), the large parts
 * (code, database, files, media) as Base64Value (raw bytes; written as
 * base64 by utils/jsonStream, toJSON() gives the string) — databases and
 * files as FileBase64Value in a snapshot folder. All file and database reads
 * are asynchronous. The list has a non-enumerable release(): it removes the
 * snapshot folder (call it once the backup is written).
 *
 * A part that is left out is in entry.skipped (['database', …]) with its
 * reason in entry.skip_reasons ({ database: 'too_large' | 'read_error' }).
 */
async function exportAllRaw() {
  let rows;
  const out = [];
  let snapDir = null;
  Object.defineProperty(out, 'release', {
    enumerable: false,
    value: async () => { if (snapDir) { const d = snapDir; snapDir = null; await fsp.rm(d, { recursive: true, force: true }).catch(() => {}); } },
  });
  try { rows = registry.list(); } catch { return out; }
  if (!rows.length) return out;
  try { snapDir = await newSnapDir(); } catch (err) {
    logger.warn({ err: err.message }, 'backup: no snapshot folder for the plugin data — read into memory');
  }
  const snap = snapDir ? { dir: snapDir, n: 0 } : null;
  const budget = { left: module.exports.MAX_PLUGIN_BYTES };
  const media = require('./media');
  const mediaBudget = media.backupEnabled() ? { left: module.exports.MAX_MEDIA_BYTES } : null;
  for (const p of rows) {
    const entry = { id: p.id, name: p.name, version: p.version, enabled: p.enabled, installed_at: p.installedAt, updated_at: p.updatedAt, skipped: [], skip_reasons: {} };
    const skip = (part, err) => {
      const reason = reasonOf(err);
      logger.warn({ plugin: p.id, name: p.name, part, reason, err: err && err.message },
        `backup: plugin ${PART_LOG[part] || part} skipped — "${p.name || p.id}" is not complete in this backup (${reason === 'too_large' ? 'too large' : 'read error'})`);
      entry.skipped.push(part);
      entry.skip_reasons[part] = reason;
    };
    try { entry.files = toB64(await readTree(codeDir(p.id, p.version), budget, null)); } catch (e) {
      entry.files = null;
      skip('code', e);
    }
    let snapDb = null;
    try { snapDb = await snapshotDb(p.id, budget, snap); } catch (e) { skip('database', e); }
    entry.db = snapDb ? snapDb.value : null;
    entry.secret_settings = snapDb ? snapDb.secrets : {};
    try { entry.data_files = toB64(await readTree(filesDir(p.id), budget, snap)); } catch (e) {
      entry.data_files = null;
      skip('files', e);
    }
    const lic = registry.getLicense(p.id);
    entry.license = lic ? { key_encrypted: lic.keyEncrypted, state: lic.state } : null;
    entry.targets = exportTargets(p.id);
    if (mediaBudget && media.declOf(p)) {
      try { entry.media = await media.exportPlugin(p.id, mediaBudget); } catch (e) { skip('media', e); }
    }
    if (media.declOf(p) && media.declOf(p).areas) {
      try { entry.media_areas = await require('./mediaAreas').exportAreas(p.id); } catch (e) { skip('media_areas', e); }
    }
    out.push(entry);
  }
  return out;
}

/**
 * The plugins of a backup (data.plugins) that are not complete in it:
 * [{ id, name, parts: [{ part, reason }] }] — name from the installed plugin
 * (or the id), reason 'too_large' | 'read_error' | 'unknown' (backups from
 * before the reasons were recorded).
 */
function incompleteOf(list) {
  if (!Array.isArray(list)) return [];
  let names = null;
  const nameOf = (id) => {
    if (!names) { names = new Map(); try { for (const p of registry.list()) names.set(p.id, p.name); } catch { /* registry unavailable */ } }
    return names.get(id) || id;
  };
  const out = [];
  for (const e of list) {
    if (!e || typeof e.id !== 'string' || !Array.isArray(e.skipped) || !e.skipped.length) continue;
    const reasons = e.skip_reasons && typeof e.skip_reasons === 'object' ? e.skip_reasons : {};
    const parts = e.skipped.filter((x) => typeof x === 'string').map((part) => ({
      part, reason: reasons[part] === 'too_large' || reasons[part] === 'read_error' ? reasons[part] : 'unknown',
    }));
    if (parts.length) out.push({ id: e.id, name: typeof e.name === 'string' && e.name ? e.name.slice(0, 100) : nameOf(e.id), parts });
  }
  return out;
}

/** exportAllRaw() with every binary part as its base64 string (the form a backup file holds). */
async function exportAll() {
  const list = await exportAllRaw();
  try { return materialize(list); } finally { await list.release(); }
}

/** Structural checks for validateBackup(). */
function validate(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ['Invalid backup: plugins must be an array'];
  const errors = [];
  list.forEach((e, i) => {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !ID_RE.test(e.id)) errors.push(`Plugin #${i + 1}: invalid id`);
    else if (e.files != null && (typeof e.files !== 'object' || Array.isArray(e.files))) errors.push(`Plugin "${e.id}": invalid files`);
    else if (e.media != null && !Array.isArray(e.media)) errors.push(`Plugin "${e.id}": invalid media`);
    else if (e.media_areas != null && (typeof e.media_areas !== 'object' || Array.isArray(e.media_areas)
      || !Array.isArray(e.media_areas.areas) || !Array.isArray(e.media_areas.files))) errors.push(`Plugin "${e.id}": invalid media areas`);
  });
  return errors;
}

// A base64 value of a backup: a string (JSON.parse) or a SpooledString (a
// large backup read with utils/jsonSpool — the bytes are still in the file).
const isB64 = (v) => typeof v === 'string' || isSpooled(v);
const decodeB64 = async (v) => (typeof v === 'string' ? Buffer.from(v, 'base64') : v.buffer());

/** {path: base64} → Map(path → Buffer) (the code: small, checked as a whole). */
async function fromB64Map(obj) {
  const m = new Map();
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return m;
  for (const [k, v] of Object.entries(obj)) {
    if (!isB64(v)) continue;
    pkg.checkPath(k);
    m.set(k, await decodeB64(v));
  }
  return m;
}

/** {path: base64} → Map(path → base64 value), paths checked, nothing decoded yet (the data files). */
function b64Entries(obj) {
  const m = new Map();
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return m;
  for (const [k, v] of Object.entries(obj)) {
    if (!isB64(v)) continue;
    pkg.checkPath(k);
    m.set(k, v);
  }
  return m;
}

/** Write the data files (b64Entries) below `dir`, one at a time — a large one decoded in pieces. */
async function extractData(entries, dir) {
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  for (const [rel, v] of entries) {
    const target = path.resolve(root, ...rel.split('/'));
    if (!target.startsWith(root + path.sep)) throw new Error('path outside the plugin folder');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    if (typeof v === 'string') await fsp.writeFile(target, Buffer.from(v, 'base64'), { flag: 'wx', mode: 0o644 });
    else await v.writeDecoded(target, { mode: 0o644 });
  }
}

/** The database snapshot of a backup, opened (in memory, or from a temp file for a spooled one) and checked — or an error. */
async function openSnapshot(b64, tmpDir) {
  let conn;
  if (typeof b64 === 'string') {
    const buf = rollbackHeader(Buffer.from(b64, 'base64'));
    if (!buf.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) throw new Error('database snapshot is not a SQLite file');
    conn = new Database(buf);
  } else {
    const file = path.join(tmpDir, 'snapshot.db');
    await b64.writeDecoded(file);
    const head = Buffer.alloc(SQLITE_MAGIC.length);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
    if (!head.equals(SQLITE_MAGIC)) throw new Error('database snapshot is not a SQLite file');
    await rollbackHeaderFile(file);
    conn = new Database(file, { readonly: true, fileMustExist: true });
  }
  try {
    conn.pragma('trusted_schema = OFF');
    const ok = conn.pragma('quick_check', { simple: true });
    if (ok !== 'ok') throw new Error('database snapshot is damaged');
    return conn;
  } catch (err) { conn.close(); throw err; }
}

function remapAssignment(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.kind === 'route') {
    const rt = a.route_type === 'l4'
      ? db().prepare("SELECT id FROM routes WHERE route_type = 'l4' AND l4_listen_port = ? AND (domain IS ? OR domain = ?)").get(a.l4_listen_port, a.route_domain, a.route_domain)
      : db().prepare('SELECT id FROM routes WHERE domain = ?').get(a.route_domain);
    return rt ? { kind: 'route', routeId: rt.id } : null;
  }
  if (a.kind === 'peer') {
    const pe = db().prepare('SELECT id FROM peers WHERE name = ?').get(a.peer_name);
    return pe ? { kind: 'peer', peerId: pe.id, port: a.port || null, scheme: a.scheme === 'https' ? 'https' : 'http' } : null;
  }
  if (a.kind === 'host' && typeof a.host === 'string') return { kind: 'host', host: a.host, port: a.port || null, scheme: a.scheme === 'https' ? 'https' : 'http' };
  return a.kind === undefined ? {} : null; // '@discovery' rows carry {}
}

/**
 * Restore the plugins of a backup. Returns { restored, skipped: [{ id, reason }] }.
 */
async function restoreAll(list, { removeOthers = false } = {}) {
  const result = { restored: 0, skipped: [], removed: [] };
  if (!Array.isArray(list)) return result;
  const plugins = require('./index');
  // A plugin-aware backup (format 5) is the complete plugin state: plugins
  // installed here but not in it are removed ("Alles löschen").
  if (removeOthers) {
    const keep = new Set(list.map((e) => (e && typeof e.id === 'string' && ID_RE.test(e.id) ? e.id : null)).filter(Boolean));
    result.removed = await plugins.removeNotIn(keep);
  }
  const runtime = require('./runtime');
  const storage = require('./storage');
  const targets = require('./targets');
  for (const e of list) {
    const id = e && typeof e.id === 'string' && ID_RE.test(e.id) ? e.id : null;
    if (!id) { result.skipped.push({ id: String(e && e.id), reason: 'invalid' }); continue; }
    let tmpDir = null;
    try {
      // Everything from the archive is untrusted: decode with the package
      // path checks, ALWAYS verify the signature, then decide.
      const files = await fromB64Map(e.files);
      const sig = signature.verify(files);
      const mres = plugins.readManifest(files);
      if (sig.status === 'invalid') { result.skipped.push({ id, reason: 'tampered' }); continue; }
      if (!mres.ok || mres.manifest.id !== id) { result.skipped.push({ id, reason: files.size ? 'manifest' : 'no_code' }); continue; }
      const m = mres.manifest;
      if (sig.status === 'trusted') m.license.server = null;
      const dataFiles = b64Entries(e.data_files);
      if (isSpooled(e.db)) tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gc-plugin-restore-')); // 0700
      const snapshot = isB64(e.db) ? await openSnapshot(e.db, tmpDir) : null;

      await runtime.ensureStopped(id);
      await storage.close(id);
      fs.rmSync(path.join(pluginsRoot(), id), { recursive: true, force: true });
      plugins.extract(files, codeDir(id, m.version));

      if (snapshot || dataFiles.size) fs.rmSync(dataDir(id), { recursive: true, force: true });
      if (snapshot) {
        // written by SQLite itself (backup API) from the validated in-memory copy
        fs.mkdirSync(dbDir(id), { recursive: true, mode: 0o700 });
        try { await snapshot.backup(path.join(dbDir(id), 'plugin.db')); } finally { snapshot.close(); }
      }
      if (dataFiles.size) await extractData(dataFiles, filesDir(id));

      registry.upsert({
        manifest: m,
        signature: sig.status === 'trusted' ? 'trusted' : (sig.status === 'untrusted' ? 'untrusted' : 'none'),
        signerKey: sig.publicKey || null,
        enabled: e.enabled !== false,
      });
      registry.removeLicense(id);
      if (e.license && (e.license.key_encrypted || e.license.state)) {
        registry.setLicense(id, { keyEncrypted: typeof e.license.key_encrypted === 'string' ? e.license.key_encrypted : null, state: e.license.state || null });
      }
      targets.removeAll(id);
      const ins = db().prepare('INSERT OR REPLACE INTO plugin_targets (plugin_id, target_id, idx, assignment) VALUES (?, ?, ?, ?)');
      for (const t of Array.isArray(e.targets) ? e.targets : []) {
        if (!t || typeof t.target_id !== 'string' || !/^(@discovery|[a-z][a-z0-9-]{0,31})$/.test(t.target_id)) continue;
        const a = remapAssignment(t.assignment);
        if (a) ins.run(id, t.target_id, Number(t.idx) || 0, JSON.stringify(a));
      }
      // secret settings travel as normal (re-keyable) backup fields
      const secrets = e.secret_settings && typeof e.secret_settings === 'object' ? e.secret_settings : {};
      const values = new Map();
      for (const [k, v] of Object.entries(secrets)) if (typeof v === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(k)) values.set(k, { enc: v });
      if (values.size && snapshot) await storage.forPlugin(id).call('settings.set', { values: Object.fromEntries(values) });
      // plugin media of the backup (only when it was made with "Plugin-Medien im Backup")
      let mediaRestored = Array.isArray(e.media) ? require('./media').importPlugin(id, e.media) : 0;
      // media areas: areas and file metadata — the bytes stayed on the storage targets
      if (e.media_areas && typeof e.media_areas === 'object') mediaRestored += require('./mediaAreas').importAreas(id, e.media_areas);
      registry.addLog(id, 'info', `restored from a backup (v${m.version}, signature: ${sig.status}${mediaRestored ? `, ${mediaRestored} media files` : ''})`);
      result.restored++;
    } catch (err) {
      logger.warn({ plugin: id, err: err.message }, 'plugin restore failed');
      result.skipped.push({ id, reason: 'failed' });
    } finally {
      if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  await plugins.reconcile();
  return result;
}

module.exports = {
  exportAll, exportAllRaw, restoreAll, validate, incompleteOf,
  // read at every backup: tests set smaller caps
  MAX_PLUGIN_BYTES, MAX_MEDIA_BYTES,
};
