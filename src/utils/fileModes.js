'use strict';

// Owner-only file modes for sensitive files in the data volume.
//
// /data is a bind mount (./data on the host). Everything in it keeps the mode
// it was created with, so a file written with the default umask (022) is
// world-readable for every local account on the host. That is harmless for
// public material (branding logos, CA certificates, the gateway release info)
// but not for the SQLite database (argon2 password hashes, API-token hashes,
// sessions, encrypted secrets), its -wal/-shm side files, copies of it, the
// JSON backups (same content) or Caddy's runtime.json (route topology,
// basic-auth hashes).
//
// Process model (supervisord.conf): caddy, wg-wrapper and node run as root,
// dnsmasq drops to uid 100 (dnsmasq). Only dnsmasq needs read access to a file
// in /data it does not own — the addn-hosts file /data/dns/peers.hosts, which
// it re-reads on SIGHUP after dropping privileges. That file (and its
// directory) is deliberately NOT touched here. entrypoint.sh chowns /data to
// the gatecontrol user on every start; the owner-only modes set here survive
// that chown and stay usable by a future non-root node process.
//
// Everything is best-effort: a chmod that fails (not the owner, read-only
// mount, file vanished) must never keep the server from starting.

const fs = require('node:fs');
const path = require('node:path');

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

/**
 * Strip every group/other permission bit from a regular file or directory.
 * Owner bits are kept as they are (a 0644 file becomes 0600, a 0755 dir 0700).
 * Symlinks are never followed.
 *
 * @param {string} p
 * @returns {boolean} true when the mode was changed
 */
function restrictToOwner(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return false; }
  if (!st.isFile() && !st.isDirectory()) return false;
  const cur = st.mode & 0o7777;
  const next = cur & 0o700;
  if (cur === next) return false;
  try {
    fs.chmodSync(p, next);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make sure a directory exists and is accessible by its owner only. Missing
 * parents are created with the default mode — only the leaf is private, so
 * e.g. /data stays traversable for dnsmasq.
 * @param {string} dir
 * @returns {boolean} true when an existing directory's mode was changed
 */
function ensurePrivateDir(dir) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.mkdirSync(dir, { mode: PRIVATE_DIR_MODE });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  return restrictToOwner(dir);
}

/**
 * Restrict a directory and every regular file directly inside it (no
 * recursion) to its owner.
 *
 * @param {string} dir
 * @returns {string[]} paths whose mode was changed
 */
function restrictDirTree(dir) {
  const changed = [];
  if (restrictToOwner(dir)) changed.push(dir);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return changed; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const p = path.join(dir, e.name);
    if (restrictToOwner(p)) changed.push(p);
  }
  return changed;
}

/**
 * Restrict the SQLite database and everything derived from it: the -wal,
 * -shm and -journal side files and manual copies next to it
 * (gatecontrol.db.bak-*, gatecontrol.db.bak-pre-1.2.3-wal, ...).
 *
 * SQLite creates -wal/-shm with the database file's own mode (fchmod, umask
 * ignored), so a 0600 database yields 0600 side files — but side files that
 * already exist keep their old mode until SQLite deletes them on a clean
 * close, hence the explicit chmod.
 *
 * @param {string} dbPath
 * @returns {string[]} paths whose mode was changed
 */
function restrictDbFiles(dbPath) {
  const changed = [];
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return changed; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const n = e.name;
    if (n !== base && !n.startsWith(base + '-') && !n.startsWith(base + '.')) continue;
    const p = path.join(dir, n);
    if (restrictToOwner(p)) changed.push(p);
  }
  return changed;
}

/**
 * Create the database file with mode 0600 if it does not exist yet. SQLite
 * would otherwise create it with 0644 (minus umask). An empty file is a valid
 * empty database for SQLite.
 *
 * @param {string} dbPath
 */
function precreatePrivateFile(dbPath) {
  try {
    fs.closeSync(fs.openSync(dbPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, PRIVATE_FILE_MODE));
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

/**
 * Boot-time tightening of sensitive files that older versions wrote with the
 * default umask (world-readable on the host). New files get the right mode
 * at creation; this fixes what is already on disk. Idempotent, best-effort.
 *
 *   - the SQLite DB, -wal/-shm/-journal, copies (gatecontrol.db.bak-*)
 *   - the backup directory (0700) and every file directly in it (0600)
 *   - <caddyDataDir>/runtime.json
 *
 * Deliberately untouched: dns/peers.hosts (read by dnsmasq as uid 100 after
 * it drops privileges), .auto-update-*.json (read by the host's update.sh),
 * branding/, CA bundles (mtls/, backend-ca/), gateway-latest-version.json.
 *
 * @param {object} opts
 * @param {string} [opts.dbPath]
 * @param {string} [opts.backupDir]
 * @param {string} [opts.caddyDataDir]
 * @returns {string[]} paths whose mode was changed
 */
function restrictSensitiveDataFiles({ dbPath, backupDir, caddyDataDir } = {}) {
  const changed = [];
  if (dbPath && dbPath !== ':memory:' && !dbPath.startsWith('file:')) {
    changed.push(...restrictDbFiles(dbPath));
  }
  if (backupDir && fs.existsSync(backupDir)) {
    changed.push(...restrictDirTree(backupDir));
  }
  if (caddyDataDir) {
    const runtimeJson = path.join(caddyDataDir, 'runtime.json');
    if (restrictToOwner(runtimeJson)) changed.push(runtimeJson);
  }
  return changed;
}

module.exports = {
  PRIVATE_FILE_MODE,
  PRIVATE_DIR_MODE,
  restrictToOwner,
  ensurePrivateDir,
  restrictDirTree,
  restrictDbFiles,
  precreatePrivateFile,
  restrictSensitiveDataFiles,
};
