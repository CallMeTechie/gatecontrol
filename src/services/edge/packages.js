'use strict';

// The signed package a gateway downloads for an edge part
// (GET /api/v1/gateway/edge/packages/<id>/<version>): the .gcplugin exactly
// as it was installed. It is kept next to the extracted code as
// <data>/plugins/<id>/<version>/.package.gcplugin — a name no package file
// can have (no leading dot, package.js), removed with the version folder,
// skipped by plugin backups. A plugin installed before this file existed
// (or restored from a backup) gets it rebuilt once from its extracted files:
// the signature covers the files, not the container, so the gateway's check
// passes the same way.

// Every access goes through a file descriptor opened with O_NOFOLLOW on a
// path bounded to the plugin's own folder (no check-then-use on paths); the
// package is written to a fixed temporary name and renamed into place.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../plugins/package');
const { codeDir, pluginsRoot, assertId, LIMITS } = require('../plugins/constants');

const FILE = '.package.gcplugin';
const TMP = '.package.gcplugin.tmp';
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const cache = new Map(); // `${id}@${version}` → { sha256, size, mtimeMs, ino }

/** <data>/plugins/<id>/<version>/<name> — refused unless it stays inside the plugin's folder. */
function pathOf(id, version, name) {
  assertId(id);
  if (typeof version !== 'string' || !VERSION_RE.test(version) || version.includes('..')) throw new Error('invalid version');
  const base = path.resolve(pluginsRoot(), id);
  const dir = path.resolve(codeDir(id, version));
  const f = path.resolve(dir, name);
  if (path.dirname(dir) !== base || path.dirname(f) !== dir) throw new Error('package path outside the plugin folder');
  return f;
}

/**
 * Keep the package of a plugin with an edge part (install). `buf` is the
 * uploaded .gcplugin that install() has decoded, verified and extracted
 * already; it must still decode to this id and version and stay within the
 * package size limit. Written to a fixed temporary name, checked against
 * its sha256, then renamed.
 */
function save(id, version, buf) {
  if (!Buffer.isBuffer(buf) || buf.length > LIMITS.packageBytes) throw new Error('package too large');
  const files = pkg.decode(buf);
  let m = null;
  try { m = JSON.parse(files.get('plugin.json').toString('utf8')); } catch { m = null; }
  if (!m || m.id !== id || m.version !== version) throw new Error('package does not match the installed plugin');
  const want = crypto.createHash('sha256').update(buf).digest('hex');
  const tmp = pathOf(id, version, TMP);
  const f = pathOf(id, version, FILE);
  try { fs.unlinkSync(tmp); } catch { /* none left over */ }
  const fd = fs.openSync(tmp, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o644);
  try {
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);
    const back = Buffer.alloc(buf.length);
    fs.readSync(fd, back, 0, back.length, 0);
    if (crypto.createHash('sha256').update(back).digest('hex') !== want) throw new Error('package written incompletely');
  } catch (e) {
    fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, f);
  cache.delete(`${id}@${version}`);
}

function readTree(root) {
  const out = new Map();
  const walk = (dir, rel, depth) => {
    if (depth > LIMITS.pathDepth) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      try { pkg.checkPath(r); } catch { continue; } // .package.gcplugin and other non-package names
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, r, depth + 1);
      else if (e.isFile()) out.set(r, fs.readFileSync(abs));
    }
  };
  walk(root, '', 0);
  return out;
}

function openFile(f) {
  return fs.openSync(f, fs.constants.O_RDONLY | NOFOLLOW);
}

/**
 * Open the package of an installed version (rebuilt from the extracted files
 * when it is missing) → { fd, size, sha256 }; the caller closes `fd`.
 * null when the version is not installed.
 */
function open(id, version) {
  const f = pathOf(id, version, FILE);
  let fd;
  try { fd = openFile(f); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    let files;
    try { files = readTree(path.dirname(f)); } catch (e2) { if (e2.code === 'ENOENT') return null; throw e2; }
    if (!files.has('plugin.json')) return null;
    save(id, version, pkg.encode(files));
    fd = openFile(f);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > LIMITS.packageBytes) throw new Error('not a package file');
    const key = `${id}@${version}`;
    const c = cache.get(key);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size && c.ino === st.ino) return { fd, size: st.size, sha256: c.sha256 };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    const sha256 = crypto.createHash('sha256').update(buf.subarray(0, off)).digest('hex');
    cache.set(key, { sha256, size: off, mtimeMs: st.mtimeMs, ino: st.ino });
    return { fd, size: off, sha256 };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

/** { sha256, size } of an installed version, or null. */
function info(id, version) {
  const o = open(id, version);
  if (!o) return null;
  fs.closeSync(o.fd);
  return { sha256: o.sha256, size: o.size };
}

function _clearCacheForTest() { cache.clear(); }

module.exports = { save, open, info, pathOf, FILE, _clearCacheForTest };
