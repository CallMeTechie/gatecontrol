'use strict';

// Plugins in GateControl backups (docs/plugins.md "Backup").
//
// Backup (sync, part of services/backup.createBackup): per installed plugin
//   * the installed package files incl. its `signature` (so a fresh server
//     gets the plugin back without a new upload — and can re-check it),
//   * a consistent snapshot of its SQLite file (sqlite3_serialize on a
//     read-only connection: a read transaction, never a raw copy of a live
//     file), its files/ folder,
//   * the registry state (enabled), the third-party licence row and the
//     access targets (routes/peers by domain/name — ids change on restore),
//   * the plugin's `secret` settings once more as plain backup fields, so the
//     off-site re-key converts them like every other secret.
// Caps: MAX_PLUGIN_BYTES per backup; a plugin whose data does not fit is
// backed up without data (code, registry and settings secrets still are),
// noted in `skipped`.
//
// Restore (async, after the main restore): processes are stopped, the
// signature is verified again (a changed package is not restored; an
// unsigned one is restored but stays off while unsigned plugins are not
// allowed — the toggle itself is never taken from a backup), code and data
// are replaced, targets re-mapped, then the normal reconcile starts what may
// run. Plugins installed here but missing in the backup are left alone.

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const pkg = require('./package');
const signature = require('./signature');
const registry = require('./registry');
const { ID_RE, LIMITS, codeDir, dataDir, dbDir, filesDir, pluginsRoot } = require('./constants');
const logger = require('../../utils/logger');

const MAX_PLUGIN_BYTES = 48 * 1024 * 1024; // raw bytes of all plugins in one backup
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

function db() { return require('../../db/connection').getDb(); }

/** Regular files below `root` → Map(relative path → Buffer). Symlinks and odd names are skipped. */
function readTree(root, budget) {
  const out = new Map();
  let bytes = 0;
  const walk = (dir, rel, depth) => {
    if (depth > LIMITS.pathDepth) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      try { pkg.checkPath(r); } catch { continue; }
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, r, depth + 1);
      else if (e.isFile()) {
        const buf = fs.readFileSync(abs);
        bytes += buf.length;
        if (bytes > budget.left || out.size >= LIMITS.fileCount) throw Object.assign(new Error('too large'), { code: 'too_large' });
        out.set(r, buf);
      }
    }
  };
  walk(root, '', 0);
  budget.left -= bytes;
  return out;
}

function snapshotDb(id, budget) {
  const file = path.join(dbDir(id), 'plugin.db');
  if (!fs.existsSync(file)) return null;
  const conn = new Database(file, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    const buf = conn.serialize();
    if (buf.length > budget.left) throw Object.assign(new Error('too large'), { code: 'too_large' });
    budget.left -= buf.length;
    return buf;
  } finally { conn.close(); }
}

function secretSettings(dbBuf) {
  if (!dbBuf) return {};
  const conn = new Database(dbBuf, { readonly: true });
  try {
    const out = {};
    for (const r of conn.prepare('SELECT key, value FROM _gc_settings').all()) {
      try { const v = JSON.parse(r.value); if (v && typeof v === 'object' && typeof v.enc === 'string') out[r.key] = v.enc; } catch { /* skip */ }
    }
    return out;
  } catch { return {}; } finally { conn.close(); }
}

const toB64 = (m) => Object.fromEntries([...m].map(([k, v]) => [k, v.toString('base64')]));

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

/** Everything of the installed plugins for createBackup(). */
function exportAll() {
  let rows;
  try { rows = registry.list(); } catch { return []; }
  const budget = { left: MAX_PLUGIN_BYTES };
  const out = [];
  for (const p of rows) {
    const entry = { id: p.id, version: p.version, enabled: p.enabled, installed_at: p.installedAt, updated_at: p.updatedAt, skipped: [] };
    try { entry.files = toB64(readTree(codeDir(p.id, p.version), budget)); } catch (e) {
      logger.warn({ plugin: p.id, err: e.message }, 'backup: plugin code skipped');
      entry.files = null;
      entry.skipped.push('code');
    }
    let dbBuf = null;
    try { dbBuf = snapshotDb(p.id, budget); } catch (e) {
      logger.warn({ plugin: p.id, err: e.message }, 'backup: plugin database skipped');
      entry.skipped.push('database');
    }
    entry.db = dbBuf ? dbBuf.toString('base64') : null;
    entry.secret_settings = secretSettings(dbBuf);
    try { entry.data_files = toB64(readTree(filesDir(p.id), budget)); } catch (e) {
      logger.warn({ plugin: p.id, err: e.message }, 'backup: plugin files skipped');
      entry.data_files = null;
      entry.skipped.push('files');
    }
    const lic = registry.getLicense(p.id);
    entry.license = lic ? { key_encrypted: lic.keyEncrypted, state: lic.state } : null;
    entry.targets = exportTargets(p.id);
    out.push(entry);
  }
  return out;
}

/** Structural checks for validateBackup(). */
function validate(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ['Invalid backup: plugins must be an array'];
  const errors = [];
  list.forEach((e, i) => {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !ID_RE.test(e.id)) errors.push(`Plugin #${i + 1}: invalid id`);
    else if (e.files != null && (typeof e.files !== 'object' || Array.isArray(e.files))) errors.push(`Plugin "${e.id}": invalid files`);
  });
  return errors;
}

function fromB64Map(obj) {
  const m = new Map();
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return m;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'string') continue;
    pkg.checkPath(k);
    m.set(k, Buffer.from(v, 'base64'));
  }
  return m;
}

function writeTree(root, files) {
  const base = path.resolve(root);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  for (const [rel, buf] of files) {
    const target = path.resolve(base, ...rel.split('/'));
    if (!target.startsWith(base + path.sep)) throw new Error('path outside the folder');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf, { flag: 'wx', mode: 0o644 });
  }
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
async function restoreAll(list) {
  const result = { restored: 0, skipped: [] };
  if (!Array.isArray(list) || !list.length) return result;
  const plugins = require('./index');
  const runtime = require('./runtime');
  const storage = require('./storage');
  const targets = require('./targets');
  for (const e of list) {
    const id = e && typeof e.id === 'string' && ID_RE.test(e.id) ? e.id : null;
    if (!id) { result.skipped.push({ id: String(e && e.id), reason: 'invalid' }); continue; }
    try {
      if (!e.files) { result.skipped.push({ id, reason: 'no_code' }); continue; }
      const files = fromB64Map(e.files);
      const sig = signature.verify(files);
      if (sig.status === 'invalid') { result.skipped.push({ id, reason: 'tampered' }); continue; }
      const mres = plugins.readManifest(files);
      if (!mres.ok || mres.manifest.id !== id) { result.skipped.push({ id, reason: 'manifest' }); continue; }
      const m = mres.manifest;
      if (sig.status === 'trusted') m.license.server = null;

      await runtime.ensureStopped(id);
      await storage.close(id);
      fs.rmSync(path.join(pluginsRoot(), id), { recursive: true, force: true });
      plugins.extract(files, codeDir(id, m.version));

      if (e.db || e.data_files) fs.rmSync(dataDir(id), { recursive: true, force: true });
      if (typeof e.db === 'string') {
        const buf = Buffer.from(e.db, 'base64');
        if (!buf.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) throw new Error('database snapshot is not a SQLite file');
        fs.mkdirSync(dbDir(id), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(dbDir(id), 'plugin.db'), buf, { mode: 0o600 });
      }
      if (e.data_files) writeTree(filesDir(id), fromB64Map(e.data_files));

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
      if (values.size && typeof e.db === 'string') await storage.forPlugin(id).call('settings.set', { values: Object.fromEntries(values) });
      registry.addLog(id, 'info', `restored from a backup (v${m.version}, signature: ${sig.status})`);
      result.restored++;
    } catch (err) {
      logger.warn({ plugin: id, err: err.message }, 'plugin restore failed');
      result.skipped.push({ id, reason: 'failed' });
    }
  }
  await plugins.reconcile();
  return result;
}

module.exports = { exportAll, restoreAll, validate, MAX_PLUGIN_BYTES };
