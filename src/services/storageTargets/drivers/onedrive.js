'use strict';

// Storage target "OneDrive" (kind 'onedrive'): a folder in the
// administrator's OneDrive (personal or work/school), Microsoft Graph with
// Files.ReadWrite. Keys are paths below the chosen folder (Graph's
// `items/<folder>:/<path>:` addressing); their folders are created on the way
// (one at a time per folder) and remembered. Up to 4 MiB in one PUT, larger
// files through an upload session in 60 MiB fragments; downloads follow
// Graph's redirect to its storage host (no token there, http.js). Sealed
// blocks only (like S3): no readable files, no move.
//
// config: { account, driveId (null = the account's own drive), folderId, folderPath, saveToken }
// secret: the OAuth token { access, refresh, expiresAt, scope, purpose }

const http = require('../../cloudAccounts/http');
const providers = require('../../cloudAccounts/providers');
const { StorageError } = require('../errors');
const { slice } = require('../streams');
const { sessionOf, toStorageError, idCache, serial, split, collect } = require('./cloud');

const SMALL = 4 * 1024 * 1024;
const FRAGMENT = 60 * 1024 * 1024; // a multiple of 320 KiB, as Graph wants
const folders = idCache();
const once = serial();

function encPath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

function create(cfg, secret) {
  const api = sessionOf('microsoft', cfg, secret);
  const drive = cfg.driveId ? `${providers.GRAPH}/drives/${encodeURIComponent(cfg.driveId)}` : `${providers.GRAPH}/me/drive`;
  const root = cfg.folderId;
  const itemOf = (rel) => `${drive}/items/${encodeURIComponent(root)}:/${encPath(rel)}:`;

  async function call(opts) { try { return await api.call(opts); } catch (e) { throw toStorageError(e); } }
  async function content(opts) { try { return await http.request(Object.assign({ content: true }, opts)); } catch (e) { throw toStorageError(e); } }
  async function expect(res, what, ok = [200]) {
    if (ok.includes(res.status)) return;
    throw toStorageError(await providers.apiError(res, what));
  }
  async function json(res) { try { return await http.readJson(res.stream); } catch (e) { throw toStorageError(e); } }

  /** The id of folder `dir` below the root ('' = the root), created on the way. */
  async function folderOf(dir) {
    if (!dir) return root;
    const segs = dir.split('/');
    let parent = root;
    for (let i = 0; i < segs.length; i++) {
      const sub = segs.slice(0, i + 1).join('/');
      const k = `${drive}|${root}/${sub}`;
      const known = folders.get(k);
      if (known) { parent = known; continue; }
      const p = parent;
      const id = await once(k, async () => {
        if (folders.get(k)) return folders.get(k);
        const res = await call({ method: 'POST', url: `${drive}/items/${encodeURIComponent(p)}/children`, headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ name: segs[i], folder: {}, '@microsoft.graph.conflictBehavior': 'fail' })) });
        if (res.status === 201 || res.status === 200) return (await json(res)).id;
        if (res.status !== 409) throw toStorageError(await providers.apiError(res, 'create folder'));
        await http.drain(res.stream);
        const got = await call({ url: `${itemOf(sub)}?$select=id,folder` });
        await expect(got, 'folder');
        return (await json(got)).id;
      });
      if (!id) throw new StorageError('protocol', 'create folder: no id');
      folders.set(k, id);
      parent = id;
    }
    return parent;
  }

  async function put(key, source) {
    const { dir, name } = split(key);
    const parent = await folderOf(dir);
    const target = `${drive}/items/${encodeURIComponent(parent)}:/${encodeURIComponent(name)}:`;
    if (source.length <= SMALL) {
      const buf = await collect(source.open(0, source.length - 1), source.length);
      if (buf.length !== source.length) throw new StorageError('length_mismatch', 'fewer bytes than announced');
      const res = await call({ method: 'PUT', url: `${target}/content?@microsoft.graph.conflictBehavior=replace`, headers: { 'content-type': 'application/octet-stream' }, body: buf });
      await expect(res, 'upload', [200, 201]);
      await http.drain(res.stream);
      return;
    }
    const res = await call({ method: 'POST', url: `${target}/createUploadSession`, headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } })) });
    await expect(res, 'upload');
    const { uploadUrl } = await json(res);
    if (typeof uploadUrl !== 'string' || !http.allowed(new URL(uploadUrl), true)) throw new StorageError('protocol', 'upload: no session');
    try {
      for (let start = 0; start < source.length; start += FRAGMENT) {
        const end = Math.min(source.length, start + FRAGMENT) - 1;
        const r = await content({ method: 'PUT', url: uploadUrl, headers: { 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${source.length}` },
          body: source.open(start, end) });
        if (r.status === 202) { await http.drain(r.stream); continue; }
        if (r.status === 200 || r.status === 201) {
          await http.drain(r.stream);
          if (end + 1 !== source.length) throw new StorageError('length_mismatch', 'the upload ended early');
          return;
        }
        throw toStorageError(await providers.apiError(r, 'upload'));
      }
    } catch (e) {
      try { const c = await content({ method: 'DELETE', url: uploadUrl }); await http.drain(c.stream); } catch { /* the session expires by itself */ }
      throw e;
    }
  }

  async function get(key, range) {
    const headers = range ? { range: `bytes=${range.start}-${range.end}` } : {};
    let res = await call({ url: `${itemOf(key)}/content` });
    if (res.status === 302 || res.status === 301 || res.status === 307) {
      const loc = res.headers.location;
      await http.drain(res.stream);
      if (typeof loc !== 'string' || !loc) throw new StorageError('protocol', 'download: no address');
      res = await content({ url: loc, headers });
    } else if (res.status === 200 && range) {
      // answered directly: cut the range out of it
      return slice(res.stream, range.start, range.end);
    }
    await expect(res, 'download', [200, 206]);
    return range && res.status === 200 ? slice(res.stream, range.start, range.end) : res.stream;
  }

  async function head(key) {
    const res = await call({ url: `${itemOf(key)}?$select=id,size,lastModifiedDateTime,file` });
    if (res.status === 404) { await http.drain(res.stream); return null; }
    await expect(res, 'head');
    const f = await json(res);
    return { size: Number(f.size), mtime: Date.parse(f.lastModifiedDateTime) || null };
  }

  async function remove(key) {
    const res = await call({ method: 'DELETE', url: itemOf(key) });
    if (res.status === 404) { await http.drain(res.stream); return false; }
    if (res.status !== 204 && res.status !== 200) throw toStorageError(await providers.apiError(res, 'delete'));
    await http.drain(res.stream);
    return true;
  }

  async function space() {
    try {
      const res = await call({ url: `${drive}?$select=quota` });
      if (res.status !== 200) { await http.drain(res.stream); return { free: null, total: null }; }
      const q = (await json(res)).quota || {};
      const free = q.remaining == null ? null : Number(q.remaining);
      const total = q.total == null ? null : Number(q.total);
      return { free: Number.isFinite(free) ? free : null, total: Number.isFinite(total) && total > 0 ? total : null };
    } catch { return { free: null, total: null }; }
  }

  /** The chosen folder still exists and is a folder. */
  async function prepare() {
    const res = await call({ url: `${drive}/items/${encodeURIComponent(root)}?$select=id,folder,deleted` });
    await expect(res, 'folder');
    const f = await json(res);
    if (!f.folder) throw new StorageError('not_found', 'the folder is gone');
  }

  return { kind: 'onedrive', ranges: true, files: false, put, get, head, remove, space, prepare };
}

module.exports = { create, SMALL, FRAGMENT };
