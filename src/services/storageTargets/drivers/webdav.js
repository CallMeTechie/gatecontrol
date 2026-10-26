'use strict';

// Storage target "NAS über WebDAV" (kind 'webdav'): Nextcloud, QNAP,
// Synology WebDAV Server, any RFC 4918 server. Basic authentication (use
// https — over http the password travels readable, the UI says so), the
// folders of a key are created with MKCOL on the way, Range for reads,
// MOVE for renames, the free space from RFC 4331 quota properties.
//
// config: { url: 'https://nas:5006/drive', username, tlsCa }
// secret: { password }

const net = require('../net');
const { StorageError } = require('../errors');
const { slice } = require('../streams');

function create(cfg, secret) {
  const base = new URL(cfg.url.endsWith('/') ? cfg.url : cfg.url + '/');
  const tlsCa = cfg.tlsCa || null;
  const auth = cfg.username ? 'Basic ' + Buffer.from(`${cfg.username}:${secret.password || ''}`, 'utf8').toString('base64') : null;
  const known = new Set(); // collections created / seen in this process

  function urlOf(key, dir) {
    const p = key.split('/').map(encodeURIComponent).join('/');
    return new URL(p + (dir ? '/' : ''), base);
  }

  async function call(method, url, { headers = {}, body = null, idleMs } = {}) {
    const h = Object.assign({}, headers);
    if (auth) h.authorization = auth;
    try { return await net.request({ method, url, headers: h, body, tlsCa, idleMs }); } catch (e) { throw StorageError.from(e); }
  }

  function failure(status, what) {
    const msg = `${what}: HTTP ${status}`;
    if (status === 401) return new StorageError('auth', msg);
    if (status === 403) return new StorageError('denied', msg);
    if (status === 404 || status === 409) return new StorageError('not_found', msg);
    if (status === 412) return new StorageError('exists', msg);
    if (status === 507) return new StorageError('full', msg);
    return new StorageError('failed', msg);
  }

  /** MKCOL every folder of `key` that is not known yet. */
  async function ensureDirs(key) {
    const segs = key.split('/').slice(0, -1);
    for (let i = 1; i <= segs.length; i++) {
      const dir = segs.slice(0, i).join('/');
      if (known.has(dir)) continue;
      const res = await call('MKCOL', urlOf(dir, true));
      await net.drain(res.stream);
      // 201 created; 405 exists already; some servers answer 301 for an existing collection
      if (res.status !== 201 && res.status !== 405 && res.status !== 301) throw failure(res.status, 'create folder');
      known.add(dir);
    }
  }

  async function put(key, source) {
    await ensureDirs(key);
    const res = await call('PUT', urlOf(key), { headers: { 'content-length': String(source.length), 'content-type': 'application/octet-stream' }, body: source.open(0, source.length - 1) });
    await net.drain(res.stream);
    if (res.status !== 201 && res.status !== 204 && res.status !== 200) throw failure(res.status, 'upload');
  }

  async function get(key, range) {
    const res = await call('GET', urlOf(key), { headers: range ? { range: `bytes=${range.start}-${range.end}` } : {} });
    if (res.status !== 200 && res.status !== 206) { await net.drain(res.stream); throw failure(res.status, 'download'); }
    return range && res.status === 200 ? slice(res.stream, range.start, range.end) : res.stream;
  }

  async function head(key) {
    const res = await call('HEAD', urlOf(key));
    await net.drain(res.stream);
    if (res.status === 404) return null;
    if (res.status !== 200) throw failure(res.status, 'head');
    return { size: Number(res.headers['content-length']), mtime: Date.parse(res.headers['last-modified']) || null };
  }

  async function remove(key) {
    const res = await call('DELETE', urlOf(key));
    await net.drain(res.stream);
    if (res.status === 404) return false;
    if (res.status !== 204 && res.status !== 200) throw failure(res.status, 'delete');
    return true;
  }

  async function move(from, to) {
    await ensureDirs(to);
    const res = await call('MOVE', urlOf(from), { headers: { destination: urlOf(to).href, overwrite: 'F' } });
    await net.drain(res.stream);
    if (res.status !== 201 && res.status !== 204) throw failure(res.status, 'move');
  }

  const PROPS = Buffer.from('<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>');
  const tag = (name) => new RegExp(`<(?:[A-Za-z0-9]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${name}>`);
  const RESPONSE_RE = /<(?:[A-Za-z0-9]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?response>/g;
  const COLLECTION_RE = /<(?:[A-Za-z0-9]+:)?collection\b/;
  const HREF_RE = tag('href');
  const LEN_RE = tag('getcontentlength');
  const MOD_RE = tag('getlastmodified');
  const MAX_LIST = 1000000;

  /**
   * Every file below `prefix` → [{ key, size, mtime }] (PROPFIND Depth 1 per
   * folder — many servers refuse Depth infinity); [] when the folder is missing.
   */
  async function list(prefix) {
    const out = [];
    const basePath = decodeURIComponent(base.pathname);
    const queue = [String(prefix || '').replace(/^\/+|\/+$/g, '')];
    while (queue.length) {
      const dir = queue.shift();
      const res = await call('PROPFIND', dir ? urlOf(dir, true) : base, { headers: { depth: '1', 'content-type': 'application/xml' }, body: PROPS });
      const xml = (await net.readBody(res.stream, 64 * 1024 * 1024)).toString('utf8');
      if (res.status === 404) continue;
      if (res.status !== 207) throw failure(res.status, 'list');
      for (const m of xml.matchAll(RESPONSE_RE)) {
        const block = m[1];
        const href = HREF_RE.exec(block);
        if (!href) continue;
        let p;
        try { p = decodeURIComponent(new URL(href[1].trim().replace(/&amp;/g, '&'), base).pathname); } catch { continue; }
        if (!p.startsWith(basePath)) continue;
        const rel = p.slice(basePath.length).replace(/\/+$/, '');
        if (!rel || rel === dir) continue;
        if (COLLECTION_RE.test(block)) { queue.push(rel); continue; }
        const len = LEN_RE.exec(block);
        const mod = MOD_RE.exec(block);
        out.push({ key: rel, size: len ? Number(len[1].trim()) : 0, mtime: mod ? Date.parse(mod[1].trim()) || null : null });
        if (out.length > MAX_LIST) throw new StorageError('protocol', 'too many files');
      }
    }
    return out;
  }

  async function space() {
    const body = Buffer.from('<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:quota-available-bytes/><d:quota-used-bytes/></d:prop></d:propfind>');
    try {
      const res = await call('PROPFIND', base, { headers: { depth: '0', 'content-type': 'application/xml' }, body });
      const xml = (await net.readBody(res.stream, 256 * 1024)).toString('utf8');
      if (res.status !== 207) return { free: null, total: null };
      const num = (tag) => { const m = new RegExp(`<(?:[A-Za-z0-9]+:)?${tag}[^>]*>\\s*(-?\\d+)\\s*<`).exec(xml); return m ? Number(m[1]) : null; };
      const free = num('quota-available-bytes');
      const used = num('quota-used-bytes');
      return { free: free != null && free >= 0 ? free : null, total: free != null && free >= 0 && used != null ? free + used : null };
    } catch { return { free: null, total: null }; }
  }

  /** The base folder exists (else created level by level — levels above it the server may refuse, that is fine). */
  async function prepare() {
    const probe = async (u) => { const r = await call('PROPFIND', u, { headers: { depth: '0' } }); await net.drain(r.stream); return r.status; };
    let st = await probe(base);
    if (st === 404) {
      const segs = base.pathname.split('/').filter(Boolean);
      for (let i = 1; i <= segs.length; i++) {
        const u = new URL('/' + segs.slice(0, i).join('/') + '/', base);
        const r = await call('MKCOL', u);
        await net.drain(r.stream);
      }
      st = await probe(base);
    }
    if (st !== 207) throw failure(st, 'folder');
  }

  return { kind: 'webdav', ranges: true, files: true, put, get, head, remove, move, list, space, prepare };
}

module.exports = { create };
