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

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../plugins/package');
const { codeDir, LIMITS } = require('../plugins/constants');

const FILE = '.package.gcplugin';
const cache = new Map(); // `${id}@${version}` → { sha256, size, mtimeMs }

function fileOf(id, version) { return path.join(codeDir(id, version), FILE); }

/** Keep the uploaded package of a plugin with an edge part (install). */
function save(id, version, buf) {
  const f = fileOf(id, version);
  fs.writeFileSync(f + '.tmp', buf, { mode: 0o644 });
  fs.renameSync(f + '.tmp', f);
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

/** Path of the package file (rebuilt from the extracted files when missing); null when the version is not installed. */
function ensure(id, version) {
  const dir = codeDir(id, version);
  if (!fs.existsSync(dir)) return null;
  const f = fileOf(id, version);
  if (!fs.existsSync(f)) {
    const files = readTree(dir);
    if (!files.has('plugin.json')) return null;
    save(id, version, pkg.encode(files));
  }
  return f;
}

/** { file, sha256, size } of an installed version, or null. */
function info(id, version) {
  const f = ensure(id, version);
  if (!f) return null;
  const st = fs.statSync(f);
  const key = `${id}@${version}`;
  const c = cache.get(key);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return { file: f, sha256: c.sha256, size: c.size };
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  cache.set(key, { sha256, size: st.size, mtimeMs: st.mtimeMs });
  return { file: f, sha256, size: st.size };
}

function _clearCacheForTest() { cache.clear(); }

module.exports = { save, ensure, info, FILE, _clearCacheForTest };
