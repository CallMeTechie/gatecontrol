'use strict';

// Previews of plugin media (docs/plugins.md "Previews", plugin.json
// `media.previews`, since 1.208.0): small pictures of stored files for the
// lists of the apps, the portal and Windows — never the whole file on a phone.
//
//   * the server makes them itself from JPEG, PNG, WebP, GIF (first frame) and
//     AVIF (sharp/libvips, one picture at a time): `small` (fits 320 × 320) and
//     `large` (fits 1280 × 1280), JPEG, turned upright by the EXIF orientation,
//     transparency on white, no metadata (no GPS). Sources over SOURCE_MAX_BYTES
//     or MAX_PIXELS are skipped;
//   * pictures it cannot read (HEIC, videos, …) get their preview from the
//     uploader's device: putClient() takes a JPEG / WebP / PNG ≤ CLIENT_MAX_BYTES,
//     decodes it and encodes it again the same way (nothing of the upload is
//     kept as it came);
//   * made on first request (and in the background right after a file is
//     claimed), one queue for the whole server: requests before background
//     work, at most one picture decoded at a time (sharp.concurrency(1));
//   * on disk next to the file: <file>.ps (small), <file>.pl (large) — sealed
//     with AES-256-GCM under a key derived (HKDF) from the file's own key, so a
//     hand-over (same key) can link them; <file>.pc marks a preview from the
//     device, <file>.px a file the server could not read (never tried again).
//     They go with the file (media.js remove / forget / cleanup / removeAll).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const logger = require('../../utils/logger');

const SIZES = Object.freeze({
  small: Object.freeze({ px: 320, quality: 72, suffix: '.ps' }),
  large: Object.freeze({ px: 1280, quality: 80, suffix: '.pl' }),
});
const CLIENT_SUFFIX = '.pc';
const NONE_SUFFIX = '.px';
const SUFFIXES = Object.freeze([SIZES.small.suffix, SIZES.large.suffix, CLIENT_SUFFIX, NONE_SUFFIX]);

// what the server reads itself (stored type) and what the decoder must find in the bytes
const RENDER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const RENDER_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'heif']); // heif: AVIF (av1) only
const SOURCE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_PIXELS = 50 * 1000 * 1000;
// a preview a device sends (HEIC, video)
const CLIENT_TYPES = new Set(['image/jpeg', 'image/webp', 'image/png']);
const CLIENT_FORMATS = new Set(['jpeg', 'webp', 'png']);
const CLIENT_MAX_BYTES = 512 * 1024;
const CLIENT_MAX_PIXELS = 4096 * 4096;

const WAIT_MS = 20000; // a request waits this long for its picture, then 503 preview_pending
const QUEUE_MAX = { now: 500, background: 10000 };
const MAGIC = Buffer.from('GCP1', 'latin1');
const IV_LEN = 12;
const TAG_LEN = 16;

class PreviewError extends Error {
  constructor(code, status, message) { super(message || code); this.code = code; this.status = status || 400; }
}

function media() { return require('./media'); }

/** Does the plugin declare `media.previews`? */
function declared(plugin) {
  const d = media().declOf(plugin);
  return !!(d && d.previews === true);
}

let sharpMod;
/** sharp, loaded once (null when it cannot load on this platform — then there are only device previews' files, none new). */
function sharp() {
  if (sharpMod !== undefined) return sharpMod;
  try {
    sharpMod = require('sharp');
    sharpMod.concurrency(1);
    sharpMod.cache(false);
  } catch (e) {
    logger.warn({ err: e.message }, 'plugin media previews: sharp is not available');
    sharpMod = null;
  }
  return sharpMod;
}

// ─── Files ──────────────────────────────────────

function fileOf(pluginId, id, suffix) { return media().fileOf(pluginId, id) + suffix; }

function exists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function keyOf(r) {
  return Buffer.from(crypto.hkdfSync('sha256', media()._unwrapKey(r.key_enc, r.id), Buffer.alloc(0), 'plugin-media-preview-v1', 32));
}

function seal(key, size, plain) {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from('gc-preview:' + size));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}

function open(key, size, sealed) {
  if (sealed.length < MAGIC.length + IV_LEN + TAG_LEN || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new PreviewError('corrupt', 500);
  const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(Buffer.from('gc-preview:' + size));
  d.setAuthTag(sealed.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN));
  return Buffer.concat([d.update(sealed.subarray(MAGIC.length + IV_LEN + TAG_LEN)), d.final()]);
}

/** Write `data` to `final` through a temporary file in the plugin's folder (the hourly clean-up removes leftovers). */
function writeAtomic(pluginId, final, data) {
  fs.mkdirSync(path.dirname(final), { recursive: true, mode: 0o700 });
  const tmp = path.join(media().pluginDir(pluginId), `.tmp-p${crypto.randomBytes(8).toString('hex')}`);
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, final);
}

/** Store both sizes of file `r` (`client`: from the uploader's device). The small one last: it says "ready". */
function store(r, pics, client) {
  const key = keyOf(r);
  writeAtomic(r.plugin, fileOf(r.plugin, r.id, SIZES.large.suffix), seal(key, 'large', pics.large));
  if (client) writeAtomic(r.plugin, fileOf(r.plugin, r.id, CLIENT_SUFFIX), Buffer.alloc(0));
  else fs.rmSync(fileOf(r.plugin, r.id, CLIENT_SUFFIX), { force: true });
  writeAtomic(r.plugin, fileOf(r.plugin, r.id, SIZES.small.suffix), seal(key, 'small', pics.small));
  fs.rmSync(fileOf(r.plugin, r.id, NONE_SUFFIX), { force: true });
}

/** Remove the previews of a file (media.js, whenever a file goes). */
function drop(pluginId, id) {
  for (const s of SUFFIXES) {
    try { fs.rmSync(fileOf(pluginId, id, s), { force: true }); } catch { /* gone */ }
  }
}

/** Hard-link (else copy) the previews of `fromId` to `toId` (media.handOver: the same file key). */
async function linkTo(fromPlugin, fromId, toPlugin, toId) {
  for (const s of SUFFIXES) {
    const src = fileOf(fromPlugin, fromId, s);
    if (!exists(src)) continue;
    const dst = fileOf(toPlugin, toId, s);
    try {
      try { await fs.promises.link(src, dst); } catch { await fs.promises.copyFile(src, dst); }
    } catch { /* the preview is made again when asked for */ }
  }
}

// ─── State ──────────────────────────────────────

/** Can the server make a preview of file `r` itself (by its stored type and size)? */
function renderable(r) {
  return !!r && RENDER_TYPES.has(String(r.mime)) && r.bytes > 0 && r.bytes <= SOURCE_MAX_BYTES;
}

/**
 * The preview of file `r` of a plugin with media.previews → null (none, and
 * none possible) or { ready, source }: `ready` — made already; `source`
 * 'server' or 'client' (sent by the uploader's device). ready: false — the
 * server makes it on the first request.
 */
function state(plugin, r) {
  if (!r || !declared(plugin)) return null;
  if (exists(fileOf(r.plugin, r.id, SIZES.small.suffix))) {
    return { ready: true, source: exists(fileOf(r.plugin, r.id, CLIENT_SUFFIX)) ? 'client' : 'server' };
  }
  if (exists(fileOf(r.plugin, r.id, NONE_SUFFIX)) || !renderable(r) || !sharp()) return null;
  return { ready: false, source: 'server' };
}

// ─── Rendering ──────────────────────────────────

/**
 * Both sizes of a picture → { small, large } (JPEG). The decoder checks the
 * bytes themselves (`formats`, never SVG, PDF or anything else whatever the
 * stored type says), `maxPixels` before decoding.
 */
async function render(input, { formats, maxPixels }) {
  const s = sharp();
  if (!s) throw new PreviewError('unavailable', 503);
  const opts = { limitInputPixels: maxPixels, failOn: 'error' };
  let meta;
  try { meta = await s(input, opts).metadata(); } catch { throw new PreviewError('invalid_image', 400); }
  if (!formats.has(meta.format) || (meta.format === 'heif' && meta.compression !== 'av1')) throw new PreviewError('invalid_image', 400);
  if (!(meta.width > 0 && meta.height > 0) || meta.width * meta.height > maxPixels) throw new PreviewError('invalid_image', 400);
  try {
    const large = await s(input, opts)
      .rotate() // upright by its EXIF orientation
      .resize({ width: SIZES.large.px, height: SIZES.large.px, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: SIZES.large.quality })
      .toBuffer();
    const small = await s(large)
      .resize({ width: SIZES.small.px, height: SIZES.small.px, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: SIZES.small.quality })
      .toBuffer();
    return { small, large };
  } catch { throw new PreviewError('invalid_image', 400); }
}

// ─── The queue ──────────────────────────────────
// One job at a time for the whole server. A job: { key, run, priority,
// promise, resolve, reject, done }. A request for a picture already waiting in
// the background moves it forward.

const queues = { now: [], background: [] };
const jobs = new Map(); // key → job
let running = false;

function enqueue(key, run, priority) {
  const have = jobs.get(key);
  if (have) {
    if (priority === 'now' && have.priority !== 'now') {
      if (queues.now.length >= QUEUE_MAX.now) throw new PreviewError('busy', 503);
      have.priority = 'now';
      queues.now.push(have);
    }
    return have.promise;
  }
  if (queues[priority].length >= QUEUE_MAX[priority]) throw new PreviewError('busy', 503);
  const job = { key, run, priority, done: false };
  job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
  job.promise.catch(() => { /* a background job nobody waits for */ });
  jobs.set(key, job);
  queues[priority].push(job);
  setImmediate(pump);
  return job.promise;
}

async function pump() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = queues.now.shift() || queues.background.shift();
      if (!job) break;
      if (job.done) continue; // moved forward and already done
      job.done = true;
      try { job.resolve(await job.run()); } catch (e) { job.reject(e); } finally { jobs.delete(job.key); }
    }
  } finally { running = false; }
}

/** Wait for `promise` at most `ms` → its value, or PreviewError preview_pending (the job goes on). */
function within(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new PreviewError('preview_pending', 503)), ms);
    if (timer.unref) timer.unref();
  })]).finally(() => clearTimeout(timer));
}

/** The plaintext of a stored file (≤ SOURCE_MAX_BYTES), from this server or its storage target. */
async function readAll(r) {
  const parts = [];
  for await (const part of media().readRange(r, 0, r.bytes - 1)) parts.push(part);
  return Buffer.concat(parts);
}

/** Make the server's preview of file (plugin, id) if it is still missing → true when there is one. */
async function generate(pluginId, id) {
  let r = media().row(pluginId, id);
  if (!r) return false;
  if (exists(fileOf(pluginId, id, SIZES.small.suffix))) return true;
  if (exists(fileOf(pluginId, id, NONE_SUFFIX)) || !renderable(r)) return false;
  let input;
  try { input = await readAll(r); } catch (e) {
    // the storage target may be back later: no mark
    logger.warn({ plugin: pluginId, media: id, err: e.message }, 'plugin media previews: file not readable');
    throw new PreviewError('unavailable', 503);
  }
  let pics;
  try { pics = await render(input, { formats: RENDER_FORMATS, maxPixels: MAX_PIXELS }); } catch (e) {
    if (e.code !== 'invalid_image') throw e;
    if (media().row(pluginId, id)) writeAtomic(pluginId, fileOf(pluginId, id, NONE_SUFFIX), Buffer.alloc(0));
    return false;
  }
  r = media().row(pluginId, id);
  if (!r) return false; // deleted meanwhile
  if (!exists(fileOf(pluginId, id, SIZES.small.suffix))) store(r, pics, false);
  if (!media().row(pluginId, id)) { drop(pluginId, id); return false; }
  return true;
}

/**
 * In the background (media.claim): the server's preview of a new file of a
 * plugin with media.previews — while the file is still on this server, before
 * it may move to a storage target. Never throws.
 */
function warm(plugin, r) {
  try {
    if (!declared(plugin) || !renderable(r) || !sharp()) return;
    if (exists(fileOf(r.plugin, r.id, SIZES.small.suffix)) || exists(fileOf(r.plugin, r.id, NONE_SUFFIX))) return;
    enqueue(`${r.plugin}:${r.id}`, () => generate(r.plugin, r.id), 'background').catch((e) => {
      if (!(e instanceof PreviewError)) logger.warn({ plugin: r.plugin, media: r.id, err: e.message }, 'plugin media previews: background preview failed');
    });
  } catch { /* the queue is full: made on the first request */ }
}

// ─── Answers ────────────────────────────────────

/** ?size= → 'small' (default) or 'large'; anything else null. */
function sizeOf(q) {
  if (q == null || q === '' || q === 'small') return 'small';
  return q === 'large' ? 'large' : null;
}

function refuse(res, status, code, headers) {
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v);
  return res.status(status).json({ ok: false, code });
}

/**
 * Answer a GET / HEAD for the preview of file `r` of `plugin` (access already
 * checked): 200 image/jpeg with `cache`, 404 not_found (none, none possible),
 * 400 invalid_size, 503 preview_pending (Retry-After) / preview_unavailable.
 */
async function send(req, res, plugin, r, cache) {
  const size = sizeOf(req.query && req.query.size);
  if (!size) return refuse(res, 400, 'invalid_size');
  const st = state(plugin, r);
  if (!st) return refuse(res, 404, 'not_found');
  if (!st.ready) {
    try {
      const made = await within(enqueue(`${r.plugin}:${r.id}`, () => generate(r.plugin, r.id), 'now'), module.exports._waitMs || WAIT_MS);
      if (!made) return refuse(res, 404, 'not_found');
    } catch (e) {
      if (e instanceof PreviewError && e.code === 'preview_pending') return refuse(res, 503, 'preview_pending', { 'Retry-After': '3' });
      if (e instanceof PreviewError && e.code === 'busy') return refuse(res, 503, 'preview_pending', { 'Retry-After': '10' });
      logger.warn({ plugin: r.plugin, media: r.id, err: e.message }, 'plugin media previews: preview failed');
      return refuse(res, 503, 'preview_unavailable', { 'Retry-After': '30' });
    }
  }
  let body;
  try {
    const cur = media().row(r.plugin, r.id);
    if (!cur) return refuse(res, 404, 'not_found');
    body = open(keyOf(cur), size, await fs.promises.readFile(fileOf(r.plugin, r.id, SIZES[size].suffix)));
  } catch (e) {
    if (e && e.code === 'ENOENT') return refuse(res, 404, 'not_found');
    logger.warn({ plugin: r.plugin, media: r.id, err: e.message }, 'plugin media previews: preview not readable');
    return refuse(res, 404, 'not_found');
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Cache-Control', cache);
  res.setHeader('ETag', `"p${size[0]}-${crypto.createHash('sha256').update(body).digest('hex').slice(0, 24)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.status(200);
  return req.method === 'HEAD' ? res.end() : res.end(body);
}

/** The request body (≤ `max` bytes, exactly Content-Length) → Buffer. */
async function readBody(req, length, max) {
  if (length > max) throw new PreviewError('too_large', 413);
  const parts = [];
  let n = 0;
  for await (const chunk of req) {
    n += chunk.length;
    if (n > length) throw new PreviewError('length_mismatch', 400);
    parts.push(chunk);
  }
  if (n !== length) throw new PreviewError(req.aborted || req.destroyed ? 'aborted' : 'length_mismatch', 400);
  return Buffer.concat(parts);
}

/**
 * PUT …/media/<mediaId>/preview: the uploader's device sends the preview of
 * a file the server cannot read itself (HEIC, video, …). `user` is the
 * caller's id; only the uploader may. → { ready: true, source: 'client' }
 * @throws {PreviewError} not_found (404), preview_by_server (409),
 *   unsupported_type (415), length_required (411), too_large (413),
 *   invalid_image / length_mismatch / aborted (400), preview_pending / busy (503)
 */
async function putClient(plugin, r, userId, req) {
  if (!declared(plugin) || !r || r.owner_user_id == null || r.owner_user_id !== userId) throw new PreviewError('not_found', 404);
  if (renderable(r) && sharp() && !exists(fileOf(r.plugin, r.id, NONE_SUFFIX))) throw new PreviewError('preview_by_server', 409);
  const mime = media().baseType(req.headers['content-type']);
  if (!CLIENT_TYPES.has(mime)) throw new PreviewError('unsupported_type', 415);
  let length;
  try { length = media().contentLength(req); } catch { throw new PreviewError('length_required', 411); }
  const input = await readBody(req, length, CLIENT_MAX_BYTES);
  const job = enqueue(`${r.plugin}:${r.id}:client:${crypto.randomBytes(6).toString('hex')}`, async () => {
    const pics = await render(input, { formats: CLIENT_FORMATS, maxPixels: CLIENT_MAX_PIXELS });
    const cur = media().row(r.plugin, r.id);
    if (!cur) throw new PreviewError('not_found', 404);
    store(cur, pics, true);
    if (!media().row(r.plugin, r.id)) { drop(r.plugin, r.id); throw new PreviewError('not_found', 404); }
    return true;
  }, 'now');
  await within(job, module.exports._waitMs || WAIT_MS);
  return { ready: true, source: 'client' };
}

/** Status and code of a failed preview request (PreviewError → its status). */
function failure(res, e) {
  if (e instanceof PreviewError) {
    return refuse(res, e.status, e.code === 'busy' ? 'preview_pending' : e.code, e.status === 503 ? { 'Retry-After': '3' } : null);
  }
  logger.warn({ err: e && e.message }, 'plugin media previews: request failed');
  return refuse(res, 500, 'internal');
}

/** Tests: wait until the queue is empty. */
async function idle() {
  for (let i = 0; i < 2000 && (running || queues.now.length || queues.background.length); i++) await new Promise((r) => setTimeout(r, 5));
}

module.exports = {
  PreviewError, SIZES, RENDER_TYPES, CLIENT_TYPES, SOURCE_MAX_BYTES, MAX_PIXELS, CLIENT_MAX_BYTES, CLIENT_MAX_PIXELS, WAIT_MS,
  declared, state, renderable, render, warm, send, putClient, failure, drop, linkTo, sizeOf, idle,
  _waitMs: null,
};
