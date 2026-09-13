'use strict';

/**
 * PEM files Caddy reads from disk (docs/feature-security-options.md §B/§F).
 *
 * Caddy takes CA bundles as file paths, never inline:
 *   - backend certificate verification: transport.tls.root_ca_pem_files
 *       → <dataDir>/backend-ca/<route_id>.pem   (routes.backend_tls_ca_pem)
 *   - client certificates (mTLS): client_authentication.trusted_ca_certs_pem_files
 *       → <dataDir>/mtls/<route_id>.pem         (routes.mtls_ca_pem)
 *
 * The database is the source of truth. sync() is called at Caddy sync time,
 * before the config is pushed: every PEM column becomes its file (written
 * atomically via tmp + rename, only when the content changed), files without
 * a matching row — deleted routes, cleared fields — are removed. Nothing
 * here throws into the sync: a failure is logged and reported in the result,
 * and buildCaddyConfig only references a file when the column is set.
 *
 * The module is import-free apart from fs/path so tests can point it at a
 * temp directory via the `dataDir` option.
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('../../config/default');
const logger = require('../utils/logger');

const BACKEND_CA_DIR = 'backend-ca';
const MTLS_DIR = 'mtls';
const FILE_RE = /^(\d+)\.pem$/;

function dataDir(override) {
  return override || (config.caddy && config.caddy.dataDir) || '/data/caddy';
}

/** Absolute path of the backend-CA file of a route. */
function backendCaPath(routeId, opts = {}) {
  return path.posix.join(dataDir(opts.dataDir), BACKEND_CA_DIR, `${Number(routeId)}.pem`);
}

/** Absolute path of the mTLS trusted-CA file of a route. */
function mtlsCaPath(routeId, opts = {}) {
  return path.posix.join(dataDir(opts.dataDir), MTLS_DIR, `${Number(routeId)}.pem`);
}

/**
 * True when a PEM directory still holds files. Lets the config build run a
 * sync after the last PEM was cleared, so orphaned files are removed.
 */
function hasPemFiles(opts = {}) {
  const base = dataDir(opts.dataDir);
  for (const d of [BACKEND_CA_DIR, MTLS_DIR]) {
    try { if (fs.readdirSync(path.join(base, d)).some((f) => FILE_RE.test(f))) return true; } catch { /* missing dir */ }
  }
  return false;
}

function writeAtomic(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

// Bring one directory in line with `wanted` (Map<routeId, pem text>).
function syncDir(dir, wanted, result) {
  let existing = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    existing = fs.readdirSync(dir);
  } catch (err) {
    result.errors.push(`${dir}: ${err.message}`);
    return;
  }
  const keep = new Set();
  for (const [routeId, pem] of wanted) {
    const file = path.join(dir, `${routeId}.pem`);
    keep.add(`${routeId}.pem`);
    try {
      let current = null;
      try { current = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
      if (current === pem) { result.unchanged++; continue; }
      writeAtomic(file, pem);
      result.written.push(file);
    } catch (err) {
      result.errors.push(`${file}: ${err.message}`);
    }
  }
  for (const name of existing) {
    if (keep.has(name)) continue;
    // Only our own <id>.pem files (and stale tmp files) are ever removed.
    if (!FILE_RE.test(name) && !/^\d+\.pem\.tmp$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      fs.unlinkSync(file);
      result.removed.push(file);
    } catch (err) {
      result.errors.push(`${file}: ${err.message}`);
    }
  }
}

/**
 * Write every PEM column of `rows` ([{ id, backend_tls_ca_pem, mtls_ca_pem }])
 * to disk and remove orphans. Without `rows` the routes table is read (all
 * rows, enabled or not — a disabled route keeps its files so re-enabling
 * needs no write). Returns { written: [], removed: [], unchanged, errors: [] }.
 */
function sync({ rows, dataDir: dirOverride } = {}) {
  const result = { written: [], removed: [], unchanged: 0, errors: [] };
  let list = rows;
  if (!Array.isArray(list)) {
    try {
      list = require('../db/connection').getDb()
        .prepare('SELECT id, backend_tls_ca_pem, mtls_ca_pem FROM routes WHERE backend_tls_ca_pem IS NOT NULL OR mtls_ca_pem IS NOT NULL')
        .all();
    } catch (err) {
      result.errors.push('routes: ' + err.message);
      list = [];
    }
  }
  const backend = new Map();
  const mtls = new Map();
  for (const r of list) {
    if (!r || !Number.isInteger(Number(r.id))) continue;
    if (r.backend_tls_ca_pem && String(r.backend_tls_ca_pem).trim()) backend.set(Number(r.id), String(r.backend_tls_ca_pem));
    if (r.mtls_ca_pem && String(r.mtls_ca_pem).trim()) mtls.set(Number(r.id), String(r.mtls_ca_pem));
  }
  const base = dataDir(dirOverride);
  syncDir(path.join(base, BACKEND_CA_DIR), backend, result);
  syncDir(path.join(base, MTLS_DIR), mtls, result);
  if (result.errors.length) logger.warn({ errors: result.errors }, 'Caddy PEM files: some files could not be synced');
  else if (result.written.length || result.removed.length) logger.info({ written: result.written.length, removed: result.removed.length }, 'Caddy PEM files synced');
  return result;
}

module.exports = {
  hasPemFiles,
  BACKEND_CA_DIR,
  MTLS_DIR,
  backendCaPath,
  mtlsCaPath,
  sync,
};
