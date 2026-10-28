'use strict';

// Storage target "Google Drive" (kind 'gdrive'): a folder in the
// administrator's Google Drive, reached with the scope drive.file —
// GateControl sees only what it created there itself (the folder chosen or
// made in the dialog, and everything below it). Drive addresses everything by
// id: the folders of a key are looked up (oldest first) or created on the way,
// one at a time per folder, and remembered. Uploads are resumable sessions in
// 64 MiB parts; Range for reads. Sealed blocks only (like S3): no readable
// files, no move.
//
// config: { account, folderId, folderPath, saveToken }
// secret: the OAuth token { access, refresh, expiresAt, scope, purpose }

const http = require('../../cloudAccounts/http');
const providers = require('../../cloudAccounts/providers');
const { StorageError } = require('../errors');
const { slice } = require('../streams');
const { sessionOf, toStorageError, idCache, serial, split } = require('./cloud');

const G = providers.GOOGLE;
const FOLDER = 'application/vnd.google-apps.folder';
const PART = 64 * 1024 * 1024; // a multiple of 256 KiB, as Drive wants
const folders = idCache();     // `${root}/${dir}` → folder id (shared by every driver of the process)
const once = serial();

function quote(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

function create(cfg, secret) {
  const api = sessionOf('google', cfg, secret);
  const root = cfg.folderId;

  async function call(opts) { try { return await api.call(opts); } catch (e) { throw toStorageError(e); } }
  async function expect(res, what, ok = [200]) {
    if (ok.includes(res.status)) return;
    throw toStorageError(await providers.apiError(res, what));
  }
  async function json(res) { try { return await http.readJson(res.stream); } catch (e) { throw toStorageError(e); } }

  /** The child `name` of folder `parent` (a folder or a file) or null. */
  async function find(parent, name, folder) {
    const q = `'${quote(parent)}' in parents and name = '${quote(name)}' and trashed = false and mimeType ${folder ? '=' : '!='} '${FOLDER}'`;
    const res = await call({ url: `${G.drive}/files?${new URLSearchParams({ q, fields: 'files(id,size,modifiedTime)', orderBy: 'createdTime', pageSize: '10',
      supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' }).toString()}` });
    await expect(res, 'lookup');
    const files = (await json(res)).files;
    return Array.isArray(files) && files[0] ? files[0] : null;
  }

  /** The id of folder `dir` below the root ('' = the root); created when `make`, else null when missing. */
  async function folderOf(dir, make) {
    if (!dir) return root;
    const segs = dir.split('/');
    let parent = root;
    for (let i = 0; i < segs.length; i++) {
      const k = `${root}/${segs.slice(0, i + 1).join('/')}`;
      const known = folders.get(k);
      if (known) { parent = known; continue; }
      const p = parent;
      const id = await once(k, async () => {
        if (folders.get(k)) return folders.get(k);
        const f = await find(p, segs[i], true);
        if (f) return f.id;
        if (!make) return null;
        const res = await call({ method: 'POST', url: `${G.drive}/files?fields=id&supportsAllDrives=true`, headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ name: segs[i], mimeType: FOLDER, parents: [p] })) });
        await expect(res, 'create folder');
        return (await json(res)).id || null;
      });
      if (!id) return null;
      folders.set(k, id);
      parent = id;
    }
    return parent;
  }

  async function fileOf(key) {
    const { dir, name } = split(key);
    const parent = await folderOf(dir, false);
    return parent ? find(parent, name, false) : null;
  }

  async function put(key, source) {
    const { dir, name } = split(key);
    const parent = await folderOf(dir, true);
    const existing = await find(parent, name, false);
    const res = await call({
      method: existing ? 'PATCH' : 'POST',
      url: existing ? `${G.upload}/files/${encodeURIComponent(existing.id)}?uploadType=resumable&supportsAllDrives=true`
        : `${G.upload}/files?uploadType=resumable&supportsAllDrives=true&fields=id`,
      headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'application/octet-stream', 'x-upload-content-length': String(source.length) },
      body: Buffer.from(JSON.stringify(existing ? {} : { name, parents: [parent] })),
    });
    await expect(res, 'upload');
    await http.drain(res.stream);
    const session = res.headers.location;
    if (typeof session !== 'string' || !session.startsWith(`${G.upload}/files`)) throw new StorageError('protocol', 'upload: no session');
    for (let start = 0; start < source.length; start += PART) {
      const end = Math.min(source.length, start + PART) - 1;
      const r = await call({ method: 'PUT', url: session, headers: { 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${source.length}` },
        body: source.open(start, end) });
      if (r.status === 308) { await http.drain(r.stream); continue; } // "resume incomplete": the next part
      if (r.status === 200 || r.status === 201) {
        await http.drain(r.stream);
        if (end + 1 !== source.length) throw new StorageError('length_mismatch', 'the upload ended early');
        return;
      }
      throw toStorageError(await providers.apiError(r, 'upload'));
    }
  }

  async function get(key, range) {
    const f = await fileOf(key);
    if (!f) throw new StorageError('not_found', 'download: not found');
    const res = await call({ url: `${G.drive}/files/${encodeURIComponent(f.id)}?alt=media&supportsAllDrives=true`, headers: range ? { range: `bytes=${range.start}-${range.end}` } : {} });
    await expect(res, 'download', [200, 206]);
    return range && res.status === 200 ? slice(res.stream, range.start, range.end) : res.stream;
  }

  async function head(key) {
    const f = await fileOf(key);
    return f ? { size: Number(f.size), mtime: Date.parse(f.modifiedTime) || null } : null;
  }

  async function remove(key) {
    const f = await fileOf(key);
    if (!f) return false;
    const res = await call({ method: 'DELETE', url: `${G.drive}/files/${encodeURIComponent(f.id)}?supportsAllDrives=true` });
    await http.drain(res.stream);
    if (res.status === 404) return false;
    if (res.status !== 204 && res.status !== 200) throw toStorageError(await providers.apiError(res, 'delete'));
    return true;
  }

  async function space() {
    try {
      const res = await call({ url: `${G.drive}/about?fields=storageQuota` });
      if (res.status !== 200) { await http.drain(res.stream); return { free: null, total: null }; }
      const q = (await json(res)).storageQuota || {};
      const limit = q.limit == null ? null : Number(q.limit);
      const used = Number(q.usage) || 0;
      return limit ? { free: Math.max(0, limit - used), total: limit } : { free: null, total: null };
    } catch { return { free: null, total: null }; }
  }

  /** The chosen folder still exists (and is a folder, not in the trash). */
  async function prepare() {
    const res = await call({ url: `${G.drive}/files/${encodeURIComponent(root)}?fields=id,mimeType,trashed&supportsAllDrives=true` });
    await expect(res, 'folder');
    const f = await json(res);
    if (f.trashed || (root !== 'root' && f.mimeType !== FOLDER)) throw new StorageError('not_found', 'the folder is gone or in the trash');
  }

  return { kind: 'gdrive', ranges: true, files: false, put, get, head, remove, space, prepare };
}

module.exports = { create, FOLDER, PART };
