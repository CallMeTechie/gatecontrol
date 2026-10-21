'use strict';

// Plugin media (docs/plugins.md "Media"): files the users of a plugin that
// declares `media` in plugin.json upload through GateControl — pictures,
// voice messages, documents. The plugin never gets the bytes; it gets a
// media id, keeps it in its own data and decides who may see the file
// (hook mediaAccess).
//
//   * store(): a raw request body (apps: PUT /api/v1/client/plugins/<id>/media,
//     frames: GC.upload → PUT /api/v1/portal|plugins/<id>/media) is streamed
//     to disk, never held in memory: Content-Type from the plugin's `types`,
//     Content-Length ≤ `maxBytes`, the plugin's quota (admin-adjustable,
//     default `quotaDefault`);
//   * storeBuffer(): a file the host fetched for the plugin (gc.media.fetch,
//     hostApi.js) — no owner, an optional display name; same checks, same
//     writer;
//   * on disk: <data>/plugin-media/<plugin>/<id[0..2]>/<id>, encrypted with a
//     random key per file (AES-256-GCM in CHUNK-sized chunks, each with its
//     own nonce — prefix ‖ chunk index — and the chunk index plus a "last"
//     flag as additional data, so chunks can be neither reordered nor cut
//     off). That key is stored in plugin_media.key_enc, wrapped with a key
//     derived (HKDF-SHA256) from the persistent server secret (GC_SECRET, the
//     secret tiles.js signs with). Chunks make Range requests cheap (voice
//     messages): only the chunks of the range are read and decrypted;
//   * a new file is "unclaimed" (ref_count 0) until the plugin binds it with
//     gc.media.claim(id) — cleanup() removes unclaimed files after 24 h;
//   * resumable uploads (media.resumable, since 1.193.0): storePart() writes
//     one part (Content-Range) of an upload the client names (uploadId, per
//     plugin and uploader) into <plugin>/.uploads/<key>.part — sealed chunk
//     by chunk like every file, so an aborted part keeps every whole chunk;
//     uploadStatus() says where to continue. Parts left for 24 h are removed;
//   * handOver() (gc.media.handOver, since 1.193.0): a file of one plugin
//     becomes an unclaimed file of another — a hard link of the same sealed
//     file (a copy on another file system), its key wrapped for the new id;
//   * frames (no session, opaque origin) load a file through a signed
//     capability URL /plugin-media/<token> (gc.media.url), like the tile
//     relay: `<id>.<exp>.<uid>.<sig>`, sig = HMAC-SHA256 over
//     `plugin-media:<id>:<plugin>:<exp>:<uid>` with the server secret.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../../../config/default');
const { dataRoot, assertId } = require('./constants');
const logger = require('../../utils/logger');

const ID_RE = /^[0-9a-f]{32}$/;
const MAGIC = Buffer.from('GCM1', 'latin1');
const PREFIX_LEN = 8;
const HEADER_LEN = MAGIC.length + PREFIX_LEN;
const CHUNK = 64 * 1024;
const TAG_LEN = 16;
const UNCLAIMED_TTL_MS = 24 * 3600 * 1000;
const URL_PREFIX = '/plugin-media/';
const URL_TTL_DEFAULT_S = 3600;
const URL_TTL_MIN_S = 60;
const URL_TTL_MAX_S = 24 * 3600;
const URL_ROUND_S = 300;
const SIG_LEN = 22;
const TOKEN_RE = /^([0-9a-f]{32})\.(\d{1,12})\.(\d{1,12})\.([A-Za-z0-9_-]{22})$/;
const QUOTA_SETTING = 'plugins.media_quota.';
const BACKUP_SETTING = 'plugins.backup_media';

class MediaError extends Error {
  constructor(code, status, message) { super(message || code); this.code = code; this.status = status || 400; }
}

function db() { return require('../../db/connection').getDb(); }
function settings() { return require('../settings'); }

/** <data>/plugin-media — every plugin's files (outside plugin-data: never writable by a plugin process). */
function mediaRoot() { return path.join(dataRoot(), 'plugin-media'); }
function pluginDir(plugin) { return path.join(mediaRoot(), assertId(plugin)); }
function fileOf(plugin, id) {
  if (!ID_RE.test(String(id))) throw new MediaError('not_found', 404);
  return path.join(pluginDir(plugin), id.slice(0, 2), id);
}

// ─── Keys ───────────────────────────────────────

let masterCache = null;
/** The key wrapping every file key, derived from the server secret. */
function masterKey() {
  const secret = String(config.app.secret);
  if (!masterCache || masterCache.secret !== secret) {
    masterCache = { secret, key: Buffer.from(crypto.hkdfSync('sha256', secret, 'gatecontrol', 'plugin-media-v1', 32)) };
  }
  return masterCache.key;
}

function wrapKey(key, id) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  c.setAAD(Buffer.from('plugin-media-key:' + id));
  const ct = Buffer.concat([c.update(key), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function unwrapKey(enc, id) {
  const buf = Buffer.from(String(enc), 'base64');
  if (buf.length !== 12 + TAG_LEN + 32) throw new MediaError('corrupt', 500);
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), buf.subarray(0, 12));
  d.setAAD(Buffer.from('plugin-media-key:' + id));
  d.setAuthTag(buf.subarray(12, 12 + TAG_LEN));
  return Buffer.concat([d.update(buf.subarray(12 + TAG_LEN)), d.final()]);
}

function nonce(prefix, index) {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(index, PREFIX_LEN);
  return n;
}

function aad(index, last) { return Buffer.from(`${index}:${last ? 1 : 0}`); }

function sealChunk(key, prefix, index, last, plain) {
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce(prefix, index));
  c.setAAD(aad(index, last));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function openChunk(key, prefix, index, last, sealed) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce(prefix, index));
  d.setAAD(aad(index, last));
  d.setAuthTag(sealed.subarray(sealed.length - TAG_LEN));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG_LEN)), d.final()]);
}

/** Size on disk of a file with `bytes` plaintext bytes. */
function sealedSize(bytes) {
  const chunks = Math.max(1, Math.ceil(bytes / CHUNK));
  return HEADER_LEN + bytes + chunks * TAG_LEN;
}

// ─── Plugin declaration, quota ──────────────────

/** The plugin's `media` declaration (manifest.js validateMedia) or null. */
function declOf(plugin) {
  return plugin && plugin.manifest && plugin.manifest.media ? plugin.manifest.media : null;
}

/** The quota of a plugin in bytes: the administrator's value, else the declared default. */
function quotaOf(plugin) {
  const decl = declOf(plugin);
  if (!decl) return 0;
  let v = null;
  try { v = settings().get(QUOTA_SETTING + plugin.id, null); } catch { v = null; }
  const n = v == null ? NaN : Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : decl.quotaDefault;
}

/** Administrator: set the quota (bytes) or go back to the declared default (null). */
function setQuota(plugin, bytes) {
  const { MEDIA_QUOTA_MIN, MEDIA_QUOTA_MAX } = require('./manifest');
  if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < MEDIA_QUOTA_MIN || bytes > MEDIA_QUOTA_MAX)) throw new MediaError('invalid', 400);
  settings().set(QUOTA_SETTING + plugin.id, bytes === null ? '' : String(bytes));
  return quotaOf(plugin);
}

/** { bytes, count } of a plugin's stored files (claimed or not). */
function usage(pluginId) {
  const r = db().prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS count FROM plugin_media WHERE plugin = ?').get(pluginId);
  return { bytes: r.bytes, count: r.count };
}

/** "image/jpeg; charset=…" → "image/jpeg" (lower case), '' when missing. */
function baseType(ct) {
  return String(ct || '').split(';')[0].trim().toLowerCase();
}

/** Is `mime` (baseType) allowed by the declaration — listed, or in a declared family ("image/*")? */
function typeAllowed(decl, mime) {
  return !!decl && require('./manifest').typeAllowed(decl.types, mime);
}

// ─── Upload ─────────────────────────────────────

const NAME_MAX = 200;
// control characters (C0, DEL, C1) and the bidi controls that could disguise an extension
const NAME_STRIP_RE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * A file name for display / download (gc.media.fetch opts.name): the last
 * path segment only, no control characters, trimmed, ≤ NAME_MAX characters
 * (a long name keeps its extension). null when nothing is left.
 */
function cleanName(v) {
  if (v == null) return null;
  let s = String(v).split(/[\\/]/).pop().replace(NAME_STRIP_RE, '').trim();
  if (!s || s === '.' || s === '..') return null;
  const chars = Array.from(s);
  if (chars.length > NAME_MAX) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 ? Array.from(s.slice(dot)) : [];
    s = ext.length > 1 && ext.length <= 16
      ? chars.slice(0, NAME_MAX - ext.length).join('').trimEnd() + ext.join('')
      : chars.slice(0, NAME_MAX).join('').trimEnd();
  }
  return s || null;
}

/**
 * Encrypt `length` bytes from `source` (an async iterable of Buffers) into a
 * new file of the plugin and add its row (unclaimed). The one writer of
 * store() and storeBuffer(). The quota is checked again after writing
 * (parallel uploads of the same plugin may have filled it meanwhile).
 * `incomplete()` names the code when the source ended early.
 * @returns {{ mediaId, mime, bytes }}
 */
async function writeFile(plugin, { source, length, mime, owner, name, incomplete }) {
  const id = crypto.randomBytes(16).toString('hex');
  const final = fileOf(plugin.id, id);
  fs.mkdirSync(path.dirname(final), { recursive: true, mode: 0o700 });
  const tmp = path.join(pluginDir(plugin.id), `.tmp-${id}`);
  const key = crypto.randomBytes(32);
  const prefix = crypto.randomBytes(PREFIX_LEN);
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(tmp, 'wx', 0o600);
  let received = 0;
  let index = 0;
  let pending = Buffer.alloc(0);
  try {
    fs.writeSync(fd, Buffer.concat([MAGIC, prefix]));
    for await (const chunk of source) {
      received += chunk.length;
      if (received > length) throw new MediaError('length_mismatch', 400);
      hash.update(chunk);
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      // keep the last full chunk back: only the end of the stream tells it is the last
      while (pending.length > CHUNK) {
        fs.writeSync(fd, sealChunk(key, prefix, index++, false, pending.subarray(0, CHUNK)));
        pending = pending.subarray(CHUNK);
      }
    }
    if (received !== length) throw new MediaError(incomplete ? incomplete() : 'length_mismatch', 400);
    fs.writeSync(fd, sealChunk(key, prefix, index, true, pending));
    fs.fsyncSync(fd);
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* closed */ }
    fs.rmSync(tmp, { force: true });
    if (e instanceof MediaError) throw e;
    throw new MediaError('aborted', 400, e && e.message);
  }
  fs.closeSync(fd);
  if (usage(plugin.id).bytes + length > quotaOf(plugin)) {
    fs.rmSync(tmp, { force: true });
    throw new MediaError('quota_exceeded', 507);
  }
  fs.renameSync(tmp, final);
  db().prepare(`INSERT INTO plugin_media (id, plugin, owner_user_id, mime, bytes, sha256, created_at, ref_count, claimed_at, key_enc, name)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`).run(id, plugin.id, owner == null ? null : owner, mime, length, hash.digest('hex'),
    new Date().toISOString(), wrapKey(key, id), name == null ? null : name);
  return { mediaId: id, mime, bytes: length };
}

/** Content-Length of an upload (1 … 12 digits, no chunked body) or MediaError length_required. */
function contentLength(req) {
  const rawLen = req.headers['content-length'];
  if (rawLen == null || !/^\d{1,12}$/.test(String(rawLen)) || req.headers['transfer-encoding']) throw new MediaError('length_required', 411);
  const length = Number(rawLen);
  if (length < 1) throw new MediaError('length_required', 411);
  return length;
}

/**
 * Stream one upload to disk. `req` is the incoming request (a readable
 * stream with headers). Checks before a byte is read: declared media,
 * uploads allowed (`media.uploads`), Content-Type in `types`,
 * Content-Length present, 1 ≤ length ≤ maxBytes, quota. Afterwards the
 * received length must equal Content-Length.
 * @returns {Promise<{ mediaId, mime, bytes }>}
 * @throws {MediaError} no_media (404), uploads_disabled (403), unsupported_type (415),
 *   length_required (411), too_large (413), quota_exceeded (507), aborted / length_mismatch (400)
 */
async function store(plugin, ownerUserId, req) {
  const decl = declOf(plugin);
  if (!decl) throw new MediaError('no_media', 404);
  if (decl.uploads === false) throw new MediaError('uploads_disabled', 403);
  const mime = baseType(req.headers['content-type']);
  if (!typeAllowed(decl, mime)) throw new MediaError('unsupported_type', 415);
  const length = contentLength(req);
  if (length > decl.maxBytes) throw new MediaError('too_large', 413);
  if (usage(plugin.id).bytes + length > quotaOf(plugin)) throw new MediaError('quota_exceeded', 507);
  return writeFile(plugin, { source: req, length, mime, owner: ownerUserId, name: null,
    incomplete: () => (req.aborted || req.destroyed ? 'aborted' : 'length_mismatch') });
}

/**
 * Store bytes the host holds already (gc.media.fetch): no owner, `name`
 * cleaned (cleanName). Same checks as store(): declared media, type in
 * `types`, 1 ≤ bytes ≤ maxBytes, quota; same file format.
 * @returns {Promise<{ mediaId, mime, bytes, name }>}
 * @throws {MediaError} no_media, unsupported_type, empty, too_large, quota_exceeded
 */
async function storeBuffer(plugin, buf, { mime, name = null, owner = null } = {}) {
  const decl = declOf(plugin);
  if (!decl) throw new MediaError('no_media', 404);
  const type = baseType(mime);
  if (!typeAllowed(decl, type)) throw new MediaError('unsupported_type', 415);
  if (!Buffer.isBuffer(buf) || buf.length < 1) throw new MediaError('empty', 400);
  if (buf.length > decl.maxBytes) throw new MediaError('too_large', 413);
  if (usage(plugin.id).bytes + buf.length > quotaOf(plugin)) throw new MediaError('quota_exceeded', 507);
  const clean = cleanName(name);
  const out = await writeFile(plugin, { source: [buf], length: buf.length, mime: type, owner, name: clean });
  return { ...out, name: clean };
}

// ─── Resumable uploads (media.resumable, since 1.193.0) ─────
//
// PUT …/media?uploadId=<id>&offset=<n> with `Content-Range: bytes
// <n>-<end>/<total>` and Content-Length = end - n + 1. The first part (n = 0)
// opens the upload (type, total ≤ maxBytes and the quota checked once for the
// whole file); every further part must start where the upload stands
// (uploadStatus().offset, a multiple of CHUNK — 409 offset_mismatch with
// `offset` otherwise). Each whole chunk of a part is sealed and written at
// its place in the part file; what an aborted part sent after its last whole
// chunk is dropped (the client sends it again from `offset`). The key is
// wrapped for the media id chosen when the upload opened, so the finished
// part file is renamed into place as it is. One part at a time per upload
// (409 busy); the uploadId is the client's (8 … 64 of [A-Za-z0-9_-]) and
// only ever refers to that uploader's upload in that plugin.

const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const UPLOAD_TTL_MS = 24 * 3600 * 1000;
const CONTENT_RANGE_RE = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15})$/;
const busyUploads = new Set();

function uploadsDir(pluginId) { return path.join(pluginDir(pluginId), '.uploads'); }

/** Files of one upload: the sealed part file and its state (JSON). */
function uploadFiles(pluginId, owner, uploadId) {
  const key = crypto.createHash('sha256').update(`${pluginId}\0${owner == null ? '' : owner}\0${uploadId}`).digest('hex').slice(0, 32);
  const dir = uploadsDir(pluginId);
  return { key, part: path.join(dir, `${key}.part`), state: path.join(dir, `${key}.json`) };
}

function readUploadState(f) {
  try {
    const st = JSON.parse(fs.readFileSync(f.state, 'utf8'));
    return st && st.v === 1 && ID_RE.test(String(st.mediaId)) && Number.isSafeInteger(st.total) && Number.isSafeInteger(st.chunks) ? st : null;
  } catch { return null; }
}

function writeUploadState(f, st) {
  const tmp = `${f.state}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st), { mode: 0o600 });
  fs.renameSync(tmp, f.state);
}

function dropUpload(f) {
  fs.rmSync(f.part, { force: true });
  fs.rmSync(f.state, { force: true });
}

function uploadExpired(st, now = Date.now()) { return !st || !(now - st.createdAt < UPLOAD_TTL_MS); }

/** Bytes of an upload that are stored for good (whole chunks). */
function committedOf(st) { return Math.min(st.total, st.chunks * CHUNK); }

/**
 * HEAD/GET …/media/uploads/<uploadId>: where the uploader's upload stands →
 * { uploadId, offset, total, mime } or null (unknown, expired, another uploader's).
 */
function uploadStatus(plugin, ownerUserId, uploadId) {
  if (!declOf(plugin) || !UPLOAD_ID_RE.test(String(uploadId || ''))) return null;
  const f = uploadFiles(plugin.id, ownerUserId, String(uploadId));
  const st = readUploadState(f);
  if (!st || uploadExpired(st)) return null;
  return { uploadId: String(uploadId), offset: committedOf(st), total: st.total, mime: st.mime };
}

function mediaError(code, status, extra) { return Object.assign(new MediaError(code, status), extra || {}); }

/**
 * One part of a resumable upload (see above).
 * @returns {Promise<{ complete: false, uploadId, offset, total } | { complete: true, mediaId, mime, bytes }>}
 * @throws {MediaError} like store(), and not_resumable (400), invalid_upload_id (400),
 *   range_required / invalid_range (400), offset_mismatch / upload_mismatch / busy (409,
 *   with `offset` where the upload stands)
 */
async function storePart(plugin, ownerUserId, req) {
  const decl = declOf(plugin);
  if (!decl) throw new MediaError('no_media', 404);
  if (decl.uploads === false) throw new MediaError('uploads_disabled', 403);
  if (decl.resumable !== true) throw new MediaError('not_resumable', 400);
  const uploadId = String(req.query.uploadId);
  if (!UPLOAD_ID_RE.test(uploadId)) throw new MediaError('invalid_upload_id', 400);
  const mime = baseType(req.headers['content-type']);
  if (!typeAllowed(decl, mime)) throw new MediaError('unsupported_type', 415);
  const length = contentLength(req);
  const m = CONTENT_RANGE_RE.exec(String(req.headers['content-range'] || '').trim());
  if (!m) throw new MediaError('range_required', 400);
  const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (end < start || end >= total || end - start + 1 !== length) throw new MediaError('invalid_range', 400);
  if (req.query.offset != null && String(req.query.offset) !== String(start)) throw new MediaError('invalid_range', 400);
  if (total > decl.maxBytes) throw new MediaError('too_large', 413);
  const f = uploadFiles(plugin.id, ownerUserId, uploadId);
  if (busyUploads.has(f.key)) throw new MediaError('busy', 409);
  busyUploads.add(f.key);
  try {
    fs.mkdirSync(uploadsDir(plugin.id), { recursive: true, mode: 0o700 });
    let st = readUploadState(f);
    if (st && uploadExpired(st)) { dropUpload(f); st = null; }
    if (st && (st.mime !== mime || st.total !== total)) throw mediaError('upload_mismatch', 409, { offset: committedOf(st) });
    if (!st) {
      if (start !== 0) throw mediaError('offset_mismatch', 409, { offset: 0 });
      if (usage(plugin.id).bytes + total > quotaOf(plugin)) throw new MediaError('quota_exceeded', 507);
      const id = crypto.randomBytes(16).toString('hex');
      const prefix = crypto.randomBytes(PREFIX_LEN);
      st = { v: 1, mediaId: id, mime, total, chunks: 0, prefix: prefix.toString('base64'),
        keyEnc: wrapKey(crypto.randomBytes(32), id), createdAt: Date.now() };
      fs.writeFileSync(f.part, Buffer.concat([MAGIC, prefix]), { mode: 0o600 });
      writeUploadState(f, st);
    } else if (start !== committedOf(st)) {
      throw mediaError('offset_mismatch', 409, { offset: committedOf(st) });
    }
    const key = unwrapKey(st.keyEnc, st.mediaId);
    const prefix = Buffer.from(st.prefix, 'base64');
    const lastIndex = Math.ceil(total / CHUNK) - 1;
    const fd = fs.openSync(f.part, 'r+');
    let index = st.chunks;
    let pending = Buffer.alloc(0);
    let received = 0;
    let failure = null;
    try {
      for await (const chunk of req) {
        received += chunk.length;
        if (received > length) { failure = new MediaError('length_mismatch', 400); break; }
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (index <= lastIndex) {
          const plainLen = index === lastIndex ? total - index * CHUNK : CHUNK;
          if (pending.length < plainLen) break;
          const sealed = sealChunk(key, prefix, index, index === lastIndex, pending.subarray(0, plainLen));
          fs.writeSync(fd, sealed, 0, sealed.length, HEADER_LEN + index * (CHUNK + TAG_LEN));
          pending = pending.subarray(plainLen);
          index++;
        }
      }
    } catch (e) {
      failure = new MediaError('aborted', 400, e && e.message);
    }
    if (!failure && received !== length) failure = new MediaError(req.aborted || req.destroyed ? 'aborted' : 'length_mismatch', 400);
    try {
      fs.ftruncateSync(fd, index > lastIndex ? sealedSize(total) : HEADER_LEN + index * (CHUNK + TAG_LEN));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    st.chunks = index;
    writeUploadState(f, st);
    const offset = committedOf(st);
    if (failure) throw Object.assign(failure, { offset });
    if (offset < total) return { complete: false, uploadId, offset, total };
    // complete: the quota again (other uploads meanwhile), the plaintext hash, the file into place
    if (usage(plugin.id).bytes + total > quotaOf(plugin)) { dropUpload(f); throw new MediaError('quota_exceeded', 507); }
    const r = { id: st.mediaId, plugin: plugin.id, bytes: total, key_enc: st.keyEnc };
    const hash = crypto.createHash('sha256');
    for await (const part of readRange(r, 0, total - 1, f.part)) hash.update(part);
    const final = fileOf(plugin.id, st.mediaId);
    fs.mkdirSync(path.dirname(final), { recursive: true, mode: 0o700 });
    fs.renameSync(f.part, final);
    fs.rmSync(f.state, { force: true });
    db().prepare(`INSERT INTO plugin_media (id, plugin, owner_user_id, mime, bytes, sha256, created_at, ref_count, claimed_at, key_enc, name)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL)`).run(st.mediaId, plugin.id, ownerUserId == null ? null : ownerUserId, mime, total,
      hash.digest('hex'), new Date().toISOString(), st.keyEnc);
    return { complete: true, mediaId: st.mediaId, mime, bytes: total };
  } finally {
    busyUploads.delete(f.key);
  }
}

/** PUT …/media: a part of a resumable upload (?uploadId=…) or a whole file. */
function upload(plugin, ownerUserId, req) {
  return req.query && req.query.uploadId != null ? storePart(plugin, ownerUserId, req) : store(plugin, ownerUserId, req);
}

// ─── Reading ────────────────────────────────────

/** The row of a plugin's media id, or null. */
function row(pluginId, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  return db().prepare('SELECT * FROM plugin_media WHERE id = ? AND plugin = ?').get(id, pluginId) || null;
}

/** What gc.media.info answers. */
function info(r) {
  if (!r) return null;
  return { mediaId: r.id, mime: r.mime, bytes: r.bytes, sha256: r.sha256, owner: r.owner_user_id == null ? null : r.owner_user_id,
    createdAt: r.created_at, claimed: r.ref_count > 0, name: r.name == null ? null : r.name };
}

/**
 * `Range` header → { start, end } (inclusive) within `size`, null for the
 * whole file, false when it cannot be satisfied (416). One range only;
 * anything else is answered as the whole file (RFC 9110 allows ignoring it).
 */
function parseRange(header, size) {
  if (header == null || header === '') return null;
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return false;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || end < start) return false;
  return { start, end };
}

/**
 * Plaintext bytes start…end (inclusive) of a stored file, decrypted chunk
 * by chunk (only the chunks of the range are read). `file`: another sealed
 * file of the same key (a finished resumable upload before it moves).
 * @returns {AsyncGenerator<Buffer>}
 */
async function* readRange(r, start, end, file = null) {
  const key = unwrapKey(r.key_enc, r.id);
  const fh = await fs.promises.open(file || fileOf(r.plugin, r.id), 'r');
  try {
    const head = Buffer.alloc(HEADER_LEN);
    await fh.read(head, 0, HEADER_LEN, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new MediaError('corrupt', 500);
    const prefix = head.subarray(MAGIC.length);
    const lastIndex = Math.max(0, Math.ceil(r.bytes / CHUNK) - 1);
    for (let i = Math.floor(start / CHUNK); i <= Math.floor(end / CHUNK); i++) {
      const plainLen = i === lastIndex ? r.bytes - i * CHUNK : CHUNK;
      const sealed = Buffer.alloc(plainLen + TAG_LEN);
      const { bytesRead } = await fh.read(sealed, 0, sealed.length, HEADER_LEN + i * (CHUNK + TAG_LEN));
      if (bytesRead !== sealed.length) throw new MediaError('corrupt', 500);
      const plain = openChunk(key, prefix, i, i === lastIndex, sealed);
      const from = i * CHUNK;
      yield plain.subarray(Math.max(0, start - from), Math.min(plain.length, end - from + 1));
    }
  } finally { await fh.close(); }
}

const INLINE_RE = /^(?:image|audio|video)\//;

/**
 * Content-Disposition of a stored file: with a name
 * `<type>; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded>`
 * (RFC 6266 / 8187); without one, documents as a download named by their id
 * and pictures, audio and video inline without the header (null).
 */
function contentDisposition(type, name, id) {
  if (name) {
    const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
    const pct = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    return `${type}; filename="${ascii || id}"; filename*=UTF-8''${pct}`;
  }
  return type === 'attachment' ? `attachment; filename="${id}"` : null;
}

/**
 * Answer a GET for a stored file: Range (206/416), Accept-Ranges, the
 * stored type, nosniff, a sandboxing CSP; pictures, audio and video inline,
 * everything else as a download. `cache` is the Cache-Control value.
 * opts (since 1.193.0, public links): `attachment` — always a download;
 * `name` — the download name instead of the stored one.
 */
async function send(req, res, r, cache, opts = {}) {
  const range = parseRange(req.headers.range, r.bytes);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('ETag', `"${r.sha256.slice(0, 32)}"`);
  if (range === false) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Range', `bytes */${r.bytes}`);
    return res.status(416).end();
  }
  const { start, end } = range || { start: 0, end: r.bytes - 1 };
  res.setHeader('Content-Type', r.mime);
  res.setHeader('Cache-Control', cache);
  const disposition = contentDisposition(!opts.attachment && INLINE_RE.test(r.mime) ? 'inline' : 'attachment', opts.name || r.name, r.id);
  if (disposition) res.setHeader('Content-Disposition', disposition);
  res.setHeader('Content-Length', String(end - start + 1));
  if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${r.bytes}`);
  res.status(range ? 206 : 200);
  if (req.method === 'HEAD') return res.end();
  try {
    for await (const part of readRange(r, start, end)) {
      if (res.destroyed) return undefined;
      if (!res.write(part)) await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
    }
    return res.end();
  } catch (e) {
    logger.warn({ plugin: r.plugin, media: r.id, err: e.message }, 'plugin media: read failed');
    return res.destroy();
  }
}

const ACCESS_MS = 5000;

/**
 * May `user` (the viewer the plugin gets) read file `r`? The plugin's hook
 * mediaAccess({ user, mediaId, owner, mime }) decides (true only); without
 * the hook only the uploader may. An error or no answer within ACCESS_MS → no.
 */
async function mayRead(pluginId, user, r) {
  if (!user || !r) return false;
  let out;
  try {
    out = await require('./runtime').call(pluginId, 'mediaAccess', { user, mediaId: r.id, owner: r.owner_user_id == null ? null : r.owner_user_id, mime: r.mime }, module.exports._accessMs || ACCESS_MS);
  } catch { return false; }
  if (out && out.allowed === null) return r.owner_user_id != null && r.owner_user_id === user.id;
  return !!out && out.allowed === true;
}

/** Status and code of a failed store() for the routes. */
function failure(res, e) {
  if (e instanceof MediaError) return res.status(e.status).json({ ok: false, code: e.code, ...(Number.isSafeInteger(e.offset) ? { offset: e.offset } : {}) });
  logger.warn({ err: e && e.message }, 'plugin media: upload failed');
  return res.status(500).json({ ok: false, code: 'internal' });
}

// ─── Plugin API (gc.media) ──────────────────────

/** gc.media.claim: the plugin keeps the file (no clean-up after 24 h). Idempotent. */
function claim(pluginId, id) {
  const r = row(pluginId, id);
  if (!r) return null;
  if (r.ref_count < 1) db().prepare('UPDATE plugin_media SET ref_count = 1, claimed_at = ? WHERE id = ?').run(new Date().toISOString(), r.id);
  return info(row(pluginId, id));
}

/** Public links (publicLinks.js) that serve a removed file end with it. */
function revokeLinks(pluginId, mediaIds) {
  try { require('./publicLinks').revokeForMedia(pluginId, mediaIds); } catch (e) {
    logger.warn({ plugin: pluginId, err: e.message }, 'plugin media: revoking public links failed');
  }
}

/** Delete one file (row and disk). → true when it existed. */
function remove(pluginId, id) {
  const r = row(pluginId, id);
  if (!r) return false;
  db().prepare('DELETE FROM plugin_media WHERE id = ?').run(r.id);
  fs.rmSync(fileOf(r.plugin, r.id), { force: true });
  revokeLinks(pluginId, [r.id]);
  return true;
}

/** Every file of a plugin ("Alles löschen", a restore removing the plugin). */
function removeAll(pluginId) {
  db().prepare('DELETE FROM plugin_media WHERE plugin = ?').run(pluginId);
  fs.rmSync(pluginDir(pluginId), { recursive: true, force: true });
  revokeLinks(pluginId, null);
}

// ─── Hand-over between plugins (gc.media.handOver, since 1.193.0) ────

/**
 * A file of plugin `from` becomes a new, unclaimed file of plugin `to`
 * (owner `owner` or none). `to` must declare media taking the type, the
 * size (handOverMaxBytes, default maxBytes) and have room in its quota.
 * The sealed file is hard-linked (copied when that fails, e.g. another file
 * system) — the bytes are never decrypted; its key is wrapped for the new id.
 * The permission (permissions.services) is the caller's job (hostApi.js).
 * @returns {Promise<{ mediaId, mime, bytes, name }>}
 * @throws {MediaError} not_found, no_media, unsupported_type, too_large, quota_exceeded
 */
async function handOver(from, id, to, { owner = null } = {}) {
  const r = row(from.id, id);
  if (!r) throw new MediaError('not_found', 404);
  const decl = declOf(to);
  if (!decl) throw new MediaError('no_media', 404);
  if (!typeAllowed(decl, r.mime)) throw new MediaError('unsupported_type', 415);
  if (r.bytes > (decl.handOverMaxBytes || decl.maxBytes)) throw new MediaError('too_large', 413);
  if (usage(to.id).bytes + r.bytes > quotaOf(to)) throw new MediaError('quota_exceeded', 507);
  const newId = crypto.randomBytes(16).toString('hex');
  const final = fileOf(to.id, newId);
  fs.mkdirSync(path.dirname(final), { recursive: true, mode: 0o700 });
  const tmp = path.join(pluginDir(to.id), `.tmp-${newId}`);
  try {
    try { await fs.promises.link(fileOf(from.id, r.id), tmp); } catch { await fs.promises.copyFile(fileOf(from.id, r.id), tmp); }
    if (usage(to.id).bytes + r.bytes > quotaOf(to)) throw new MediaError('quota_exceeded', 507);
    fs.renameSync(tmp, final);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if (e instanceof MediaError) throw e;
    throw new MediaError('not_found', 404, e && e.message);
  }
  const key = unwrapKey(r.key_enc, r.id);
  db().prepare(`INSERT INTO plugin_media (id, plugin, owner_user_id, mime, bytes, sha256, created_at, ref_count, claimed_at, key_enc, name)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`).run(newId, to.id, owner == null ? null : owner, r.mime, r.bytes, r.sha256,
    new Date().toISOString(), wrapKey(key, newId), r.name == null ? null : r.name);
  return { mediaId: newId, mime: r.mime, bytes: r.bytes, name: r.name == null ? null : r.name };
}

// ─── Capability URLs for frames ─────────────────

function sign(id, plugin, exp, uid) {
  return crypto.createHmac('sha256', String(config.app.secret)).update(`plugin-media:${id}:${plugin}:${exp}:${uid}`).digest('base64url').slice(0, SIG_LEN);
}

/**
 * gc.media.url(id, { user, ttlS }) → '/plugin-media/<token>' for `ttlS`
 * seconds (60…86400, default 3600), rounded up to the next 5 minutes so a
 * frame rendered twice gets the same URL (browser cache). `user` (a user
 * id) is bound into the token for the record; 0 = none.
 */
function url(pluginId, id, { user = null, ttlS = null, now = Date.now() } = {}) {
  const ttl = ttlS == null ? URL_TTL_DEFAULT_S : ttlS;
  const exp = Math.ceil((Math.floor(now / 1000) + ttl) / URL_ROUND_S) * URL_ROUND_S;
  const uid = user == null ? 0 : user;
  return `${URL_PREFIX}${id}.${exp}.${uid}.${sign(id, pluginId, exp, uid)}`;
}

/** A token of /plugin-media/<token> → the row it names (still stored, same plugin) or null. */
function resolveToken(token, now = Date.now()) {
  const m = TOKEN_RE.exec(String(token || ''));
  if (!m) return null;
  const exp = Number(m[2]);
  const s = Math.floor(now / 1000);
  if (!(s < exp && exp <= s + URL_TTL_MAX_S + URL_ROUND_S)) return null;
  const r = db().prepare('SELECT * FROM plugin_media WHERE id = ?').get(m[1]);
  if (!r) return null;
  if (!crypto.timingSafeEqual(Buffer.from(m[4]), Buffer.from(sign(r.id, r.plugin, exp, Number(m[3]))))) return null;
  return { row: r, exp };
}

// ─── Clean-up ───────────────────────────────────

/**
 * Hourly (plugins/index.js): unclaimed files older than 24 h, leftovers
 * of aborted uploads (.tmp-*, older than an hour) and resumable uploads
 * not finished within 24 h go. Files of an
 * uninstalled plugin stay ("Daten behalten"; "Alles löschen" → removeAll).
 * → number of files removed.
 */
function cleanup(now = Date.now()) {
  let n = 0;
  const cutoff = new Date(now - UNCLAIMED_TTL_MS).toISOString();
  const old = db().prepare('SELECT id, plugin FROM plugin_media WHERE ref_count = 0 AND created_at <= ?').all(cutoff);
  for (const r of old) {
    db().prepare('DELETE FROM plugin_media WHERE id = ? AND ref_count = 0').run(r.id);
    try { fs.rmSync(fileOf(r.plugin, r.id), { force: true }); } catch { /* gone */ }
    revokeLinks(r.plugin, [r.id]);
    n++;
  }
  let dirs = [];
  try { dirs = fs.readdirSync(mediaRoot(), { withFileTypes: true }); } catch { dirs = []; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let ents = [];
    try { ents = fs.readdirSync(path.join(mediaRoot(), d.name)); } catch { ents = []; }
    for (const e of ents) {
      if (!e.startsWith('.tmp-')) continue;
      const f = path.join(mediaRoot(), d.name, e);
      try { if (fs.statSync(f).mtimeMs < now - 3600 * 1000) { fs.rmSync(f, { force: true }); n++; } } catch { /* gone */ }
    }
    n += cleanupUploads(path.join(mediaRoot(), d.name, '.uploads'), now);
  }
  return n;
}

/** Resumable uploads of one plugin older than UPLOAD_TTL_MS (state and part, or a part without state). */
function cleanupUploads(dir, now) {
  let n = 0;
  let ents = [];
  try { ents = fs.readdirSync(dir); } catch { return 0; }
  for (const e of ents) {
    const m = /^([0-9a-f]{32})\.(part|json)$/.exec(e);
    if (!m) continue;
    const f = { part: path.join(dir, `${m[1]}.part`), state: path.join(dir, `${m[1]}.json`) };
    if (m[2] === 'json') {
      if (uploadExpired(readUploadState(f), now)) { dropUpload(f); n++; }
    } else if (!fs.existsSync(f.state)) {
      try { if (fs.statSync(f.part).mtimeMs < now - UPLOAD_TTL_MS) { fs.rmSync(f.part, { force: true }); n++; } } catch { /* gone */ }
    }
  }
  return n;
}

// ─── Backup (docs/plugins.md "Backup") ──────────

function backupEnabled() {
  try { return settings().get(BACKUP_SETTING, '0') === '1'; } catch { return false; }
}

function setBackupEnabled(on) { settings().set(BACKUP_SETTING, on ? '1' : '0'); }

/**
 * The claimed files of a plugin for a backup, within `budget.left` bytes
 * (decremented): [{ id, owner_user_id, mime, bytes, sha256, created_at,
 * claimed_at, key, data }] — `data` the file as stored (encrypted, base64),
 * `key` its file key encrypted with GC_ENCRYPTION_KEY (utils/crypto, the
 * form every backup secret has: the off-site re-key converts it, a restore
 * on another server unwraps it). Throws code 'too_large' when the files do
 * not fit.
 */
function exportPlugin(pluginId, budget) {
  const { encrypt } = require('../../utils/crypto');
  const rows = db().prepare('SELECT * FROM plugin_media WHERE plugin = ? AND ref_count > 0 ORDER BY created_at').all(pluginId);
  const out = [];
  for (const r of rows) {
    const size = sealedSize(r.bytes);
    if (size > budget.left) throw Object.assign(new Error('too large'), { code: 'too_large' });
    const data = fs.readFileSync(fileOf(r.plugin, r.id));
    budget.left -= data.length;
    out.push({ id: r.id, owner_user_id: r.owner_user_id, mime: r.mime, bytes: r.bytes, sha256: r.sha256, created_at: r.created_at,
      claimed_at: r.claimed_at, name: r.name == null ? null : r.name, key: encrypt(unwrapKey(r.key_enc, r.id).toString('hex')), data: data.toString('base64') });
  }
  return out;
}

/** Restore the files of a backup entry (exportPlugin's list). → number restored. */
function importPlugin(pluginId, list) {
  if (!Array.isArray(list)) return 0;
  const { decrypt } = require('../../utils/crypto');
  let n = 0;
  for (const e of list) {
    try {
      if (!e || !ID_RE.test(String(e.id)) || typeof e.data !== 'string' || typeof e.key !== 'string' || typeof e.mime !== 'string'
        || !Number.isSafeInteger(e.bytes) || e.bytes < 1 || !/^[0-9a-f]{64}$/.test(String(e.sha256))) continue;
      const key = Buffer.from(decrypt(e.key), 'hex');
      if (key.length !== 32) continue;
      const data = Buffer.from(e.data, 'base64');
      if (data.length !== sealedSize(e.bytes) || !data.subarray(0, MAGIC.length).equals(MAGIC)) continue;
      const file = fileOf(pluginId, e.id);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, data, { mode: 0o600 });
      db().prepare(`INSERT OR REPLACE INTO plugin_media (id, plugin, owner_user_id, mime, bytes, sha256, created_at, ref_count, claimed_at, key_enc, name)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(e.id, pluginId, Number.isSafeInteger(e.owner_user_id) ? e.owner_user_id : null, baseType(e.mime),
        e.bytes, e.sha256, typeof e.created_at === 'string' ? e.created_at : new Date().toISOString(),
        typeof e.claimed_at === 'string' ? e.claimed_at : new Date().toISOString(), wrapKey(key, e.id), cleanName(e.name));
      n++;
    } catch (err) {
      logger.warn({ plugin: pluginId, err: err.message }, 'plugin media: restore of a file failed');
    }
  }
  return n;
}

module.exports = {
  MediaError, ID_RE, CHUNK, URL_PREFIX, URL_TTL_MIN_S, URL_TTL_MAX_S, UNCLAIMED_TTL_MS, QUOTA_SETTING, BACKUP_SETTING,
  mediaRoot, fileOf, declOf, quotaOf, setQuota, usage, baseType, typeAllowed, store, storeBuffer, storePart, upload, uploadStatus, UPLOAD_ID_RE, UPLOAD_TTL_MS,
  cleanName, contentDisposition, row, info, parseRange, readRange, send, mayRead, failure,
  claim, remove, removeAll, handOver, url, resolveToken, cleanup, backupEnabled, setBackupEnabled, exportPlugin, importPlugin, sealedSize,
  _accessMs: null,
};
