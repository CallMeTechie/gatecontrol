'use strict';

// Pre-migration database snapshot (docs/feature-release-b.md §4).
//
// Before the migration runner applies pending migrations to an existing
// database file, it takes a consistent copy with `VACUUM INTO` (reads the
// WAL too, no lock gymnastics) into
//   <dataDir>/backups/pre-migration/gatecontrol-v<from>-v<to>-<ts>.db
// where <dataDir> is the directory of the database file (/data in the image).
// Files are 0600, the directory 0700; the newest KEEP files survive.
//
// A failed snapshot aborts the start: the runner throws, the health check
// never goes green and update.sh rolls the image back — better than migrating
// a database nobody can go back to. Emergency exit for an admin who knows
// what they are doing: GC_SKIP_PRE_MIGRATION_BACKUP=1.
//
// Kept free of app services (settings, logger config beyond the shared
// logger): it runs from src/bin/export-caddy-config.js in the entrypoint too.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensurePrivateDir, PRIVATE_FILE_MODE } = require('../utils/fileModes');

const KEEP = 3;
const NAME_RE = /^gatecontrol-v(\d{1,6})-v(\d{1,6})-(\d{8}-\d{6})\.db$/;
const PARTIAL_RE = /^\.gatecontrol-v\d{1,6}-v\d{1,6}-\d{8}-\d{6}\.db\.[0-9a-f]{12}\.partial$/;

function isFileDb(dbPath) {
  return typeof dbPath === 'string' && dbPath !== '' && dbPath !== ':memory:' && !dbPath.startsWith('file:');
}

function preMigrationDir(dbPath) {
  return path.join(path.dirname(path.resolve(dbPath)), 'backups', 'pre-migration');
}

function utcStamp(date = new Date()) {
  const iso = date.toISOString(); // 2026-09-14T03:15:00.000Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

function stampToIso(ts) {
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}.000Z`;
}

/**
 * @param {string} name
 * @returns {null|{from_version:number,to_version:number,created_at:string}}
 */
function parseName(name) {
  const m = typeof name === 'string' ? NAME_RE.exec(name) : null;
  if (!m) return null;
  return { from_version: Number(m[1]), to_version: Number(m[2]), created_at: stampToIso(m[3]) };
}

/**
 * Snapshots in the directory, newest first.
 * @param {string} dbPath
 */
function listSnapshots(dbPath) {
  if (!isFileDb(dbPath)) return [];
  const dir = preMigrationDir(dbPath);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const meta = parseName(name);
    if (!meta) continue;
    let st;
    try { st = fs.lstatSync(path.join(dir, name)); } catch { continue; }
    if (!st.isFile()) continue;
    out.push({ name, size: st.size, ...meta });
  }
  // Timestamp in the name first, then name (same second: higher to_version last applied).
  out.sort((a, b) => (b.created_at.localeCompare(a.created_at)) || b.name.localeCompare(a.name));
  return out;
}

/**
 * Absolute path of a snapshot for download, or null (strict name check, no
 * path separators, must be a regular file in the snapshot directory).
 */
function snapshotPath(dbPath, name) {
  if (!isFileDb(dbPath) || !parseName(name)) return null;
  const dir = preMigrationDir(dbPath);
  const p = path.join(dir, name);
  if (path.dirname(p) !== dir) return null;
  try {
    const st = fs.lstatSync(p);
    return st.isFile() ? p : null;
  } catch { return null; }
}

function prune(dir, keep, logger) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  // Leftovers of an interrupted snapshot (crash mid-VACUUM).
  for (const n of names) {
    if (PARTIAL_RE.test(n)) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* best effort */ } }
  }
  const snaps = names.map((n) => ({ n, m: parseName(n) })).filter((x) => x.m)
    .sort((a, b) => b.m.created_at.localeCompare(a.m.created_at) || b.n.localeCompare(a.n));
  for (const s of snaps.slice(keep)) {
    try {
      fs.unlinkSync(path.join(dir, s.n));
      if (logger) logger.info({ file: s.n }, 'Old pre-migration backup removed');
    } catch (err) {
      if (logger) logger.warn({ file: s.n, err: err.message }, 'Could not remove old pre-migration backup');
    }
  }
}

/**
 * Take the snapshot. Throws (with an operator-facing message) on failure.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string} opts.dbPath
 * @param {number} opts.fromVersion  highest applied migration (0 = none)
 * @param {number} opts.toVersion    highest pending migration
 * @param {object} [opts.logger]
 * @param {Date}   [opts.now]
 * @returns {null|{name:string,path:string,size:number}}
 */
function snapshotBeforeMigrations(db, { dbPath, fromVersion, toVersion, logger, now } = {}) {
  if (!isFileDb(dbPath)) return null;
  if (process.env.GC_SKIP_PRE_MIGRATION_BACKUP === '1') {
    if (logger) logger.warn({ fromVersion, toVersion }, 'GC_SKIP_PRE_MIGRATION_BACKUP=1 — migrating WITHOUT a pre-migration database backup');
    return null;
  }
  const dir = preMigrationDir(dbPath);
  const name = `gatecontrol-v${Number(fromVersion) || 0}-v${Number(toVersion) || 0}-${utcStamp(now)}.db`;
  const finalPath = path.join(dir, name);
  const tmpPath = path.join(dir, `.${name}.${crypto.randomBytes(6).toString('hex')}.partial`);
  try {
    ensurePrivateDir(dir);
    // VACUUM INTO accepts an existing EMPTY file and keeps its mode → the copy
    // is owner-only from the first byte (SQLite would create it 0644).
    fs.closeSync(fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, PRIVATE_FILE_MODE));
    db.prepare('VACUUM INTO ?').run(tmpPath);
    fs.chmodSync(tmpPath, PRIVATE_FILE_MODE);
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* not created */ }
    const e = new Error(
      `Pre-migration database backup failed (${err.code || 'error'}: ${err.message}). ` +
      `Start aborted so that migrations v${fromVersion}→v${toVersion} do not run without a way back. ` +
      `Check free disk space and permissions of ${dir}. To start anyway WITHOUT a backup, set GC_SKIP_PRE_MIGRATION_BACKUP=1.`
    );
    e.code = 'PRE_MIGRATION_BACKUP_FAILED';
    e.cause = err;
    throw e;
  }
  const size = fs.statSync(finalPath).size;
  if (logger) logger.info({ file: finalPath, size, fromVersion, toVersion }, 'Pre-migration database backup written');
  prune(dir, KEEP, logger);
  return { name, path: finalPath, size };
}

module.exports = {
  KEEP,
  NAME_RE,
  preMigrationDir,
  parseName,
  listSnapshots,
  snapshotPath,
  snapshotBeforeMigrations,
  _utcStamp: utcStamp,
};
