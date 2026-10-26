'use strict';

// Storage target "Ordner auf dem Server" (kind 'local'): a folder of this
// server — another disk or a mounted volume. Keys are relative paths below
// it; a key that would leave the folder is refused. `files`: readable files
// (media areas in the form 'files') can live here; `list` finds what changed.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { StorageError } = require('../errors');

function create(cfg) {
  const root = cfg.path;
  const full = (key) => {
    const p = path.join(root, ...String(key).split('/'));
    if (!p.startsWith(root + path.sep)) throw new StorageError('failed', 'invalid key');
    return p;
  };

  async function put(key, source) {
    const dest = full(key);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const tmp = path.join(path.dirname(dest), `.gc-upload-${crypto.randomBytes(6).toString('hex')}`);
    try {
      await pipeline(source.open(0, source.length - 1), fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      const st = await fs.promises.stat(tmp);
      if (st.size !== source.length) throw new StorageError('length_mismatch', 'the written file has the wrong size');
      await fs.promises.rename(tmp, dest);
    } catch (e) {
      await fs.promises.rm(tmp, { force: true });
      throw StorageError.from(e);
    }
  }

  async function get(key, range) {
    const f = full(key);
    try { await fs.promises.access(f); } catch { throw new StorageError('not_found', 'no such object'); }
    return fs.createReadStream(f, range ? { start: range.start, end: range.end } : {});
  }

  async function head(key) {
    try {
      const st = await fs.promises.stat(full(key));
      return st.isFile() ? { size: st.size, mtime: st.mtimeMs } : null;
    } catch { return null; }
  }

  async function remove(key) {
    try { await fs.promises.unlink(full(key)); return true; } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw StorageError.from(e);
    }
  }

  /** Rename; never over an existing object (`exists`). */
  async function move(from, to) {
    const dest = full(to);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    // (not link + unlink: FAT/exFAT disks have no hard links)
    if (await fs.promises.lstat(dest).then(() => true, () => false)) throw new StorageError('exists', 'the destination exists');
    try { await fs.promises.rename(full(from), dest); } catch (e) { throw StorageError.from(e); }
  }

  /** Every file below `prefix` (recursive) → [{ key, size, mtime }]; [] when the folder is missing. */
  async function list(prefix) {
    const out = [];
    const walk = async (dir, rel) => {
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return;
        throw StorageError.from(e);
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), r);
        else if (e.isFile() && !e.name.startsWith('.gc-upload-')) {
          try { const st = await fs.promises.stat(path.join(dir, e.name)); out.push({ key: r, size: st.size, mtime: Math.floor(st.mtimeMs) }); } catch { /* gone meanwhile */ }
        }
      }
    };
    const base = String(prefix || '').replace(/^\/+|\/+$/g, '');
    await walk(base ? full(base) : root, base);
    return out;
  }

  async function space() {
    try {
      const s = await fs.promises.statfs(root);
      return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
    } catch { return { free: null, total: null }; }
  }

  async function prepare() {
    let st;
    try { st = await fs.promises.stat(root); } catch { throw new StorageError('not_found', 'the folder does not exist'); }
    if (!st.isDirectory()) throw new StorageError('not_found', 'not a folder');
  }

  return { kind: 'local', ranges: true, files: true, put, get, head, remove, move, list, space, prepare };
}

module.exports = { create };
