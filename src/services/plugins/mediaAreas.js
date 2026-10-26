'use strict';

// Areas of the plugin media store (docs/plugins.md "Media areas"). A plugin
// that declares `media.areas` keeps its files in areas it names itself
// (gc.media.areas.ensure('family', { label: 'Familie' })) and binds each file
// to one when it claims it (gc.media.claim(id, { area, path })). The
// administrator decides per area where the files live: on this server (the
// plugin media folder, as always) or on a storage target (services/
// storageTargets: a folder, a NAS over SMB / WebDAV, an S3 bucket).
//
//   * Every file arrives here first (upload, fetch, hand-over) and is sealed
//     like all plugin media. For an area on a storage target the background
//     worker (tick) copies the sealed file there — the target only ever sees
//     encrypted blocks under an opaque key <plugin>/<area>/<id[0..2]>/<id>.
//     Only then the remote copy counts (target_id, remote_key); the local one
//     stays as cache.
//   * The cache: local copies of files kept on a target, at most
//     cacheLimit() bytes (setting plugins.media_cache_bytes, default 5 GB),
//     the least recently used go first. Files waiting to be copied are never
//     evicted.
//   * Reading a file without a local copy: from a target that reads ranges
//     (folder, WebDAV, S3) only the sealed chunks of the requested range are
//     fetched and decrypted; from SMB the whole file comes back into the cache
//     first.
//   * Moving an area (setTarget): its files are copied to the new place in the
//     background, the old copies deleted afterwards (plugin_media_gone keeps
//     the deletions a target could not do yet). Until a file is moved it is
//     read from where it was; new files go to the new place.
//   * A target that fails is retried with a growing pause (30 s … 15 min);
//     after 15 minutes the administrators get storage_target_unreachable
//     (activity log → notification settings), once, and
//     storage_target_recovered when it works again.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const logger = require('../../utils/logger');

const AREA_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LABEL_MAX = 80;
const MAX_AREAS = 1000;
const PATH_MAX = 1024;
const CACHE_SETTING = 'plugins.media_cache_bytes';
const GB = 1024 * 1024 * 1024;
const CACHE_DEFAULT = 5 * GB;
const CACHE_MIN = 256 * 1024 * 1024;
const CACHE_MAX = 100 * 1024 * GB;
const AREA_QUOTA_MIN = 1024 * 1024;
const AREA_QUOTA_MAX = 1024 * 1024 * GB; // 1 PB
const TICK_MS = 15 * 1000;
const TICK_BUDGET_MS = 60 * 1000;
const ALERT_AFTER_MS = 15 * 60 * 1000;
const BACKOFF_MIN_MS = 30 * 1000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;
const FREE_MARGIN = 512 * 1024 * 1024;
const ACCESS_TOUCH_MS = 60 * 1000;
// control characters and the bidi controls that could disguise a name
const SEG_BAD_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

class AreaError extends Error {
  constructor(code, message, status) { super(message || code); this.code = code; this.status = status || 400; }
}

function db() { return require('../../db/connection').getDb(); }
function media() { return require('./media'); }
function targets() { return require('../storageTargets'); }
function settings() { return require('../settings'); }
function nowIso() { return new Date().toISOString(); }

// ─── Areas ──────────────────────────────────────

function declared(plugin) {
  const d = media().declOf(plugin);
  return !!(d && d.areas);
}

function rowOf(pluginId, area) {
  return typeof area === 'string' && AREA_RE.test(area)
    ? db().prepare('SELECT * FROM plugin_media_areas WHERE plugin = ? AND area = ?').get(pluginId, area) || null : null;
}

function rows(pluginId) {
  return db().prepare('SELECT * FROM plugin_media_areas WHERE plugin = ? ORDER BY area').all(pluginId);
}

/** Where new files of an area go: the target being moved to, else its target (null = this server). */
function effectiveTarget(a) { return a.moving ? (a.moving_to == null ? null : a.moving_to) : (a.target_id == null ? null : a.target_id); }

function effectiveQuota(a) { return a.admin_quota_bytes != null ? a.admin_quota_bytes : (a.quota_bytes == null ? null : a.quota_bytes); }

function cleanLabel(v, area) {
  const s = v == null ? '' : String(v).replace(/[\u0000-\u001f]/g, '').trim();
  if (s.length > LABEL_MAX) throw new AreaError('invalid', 'label too long');
  return s || area;
}

function quotaArg(v) {
  if (v == null) return null;
  if (!Number.isSafeInteger(v) || v < AREA_QUOTA_MIN || v > AREA_QUOTA_MAX) throw new AreaError('invalid', 'quota must be 1 MB … 1 PB in bytes');
  return v;
}

/** gc.media.areas.ensure(area, { label, quota }) — create or update (label, the plugin's quota). */
function ensure(plugin, area, opts = {}) {
  if (!declared(plugin)) throw new AreaError('no_areas', 'plugin.json declares no media.areas', 403);
  if (typeof area !== 'string' || !AREA_RE.test(area)) throw new AreaError('invalid', 'area: 1 … 64 of a-z 0-9 _ - (starting with a letter or digit)');
  const o = opts && typeof opts === 'object' ? opts : {};
  const label = cleanLabel(o.label, area);
  const quota = quotaArg(o.quota);
  const existing = rowOf(plugin.id, area);
  if (!existing) {
    if (db().prepare('SELECT COUNT(*) AS n FROM plugin_media_areas WHERE plugin = ?').get(plugin.id).n >= MAX_AREAS) throw new AreaError('limit', `at most ${MAX_AREAS} areas`);
    db().prepare('INSERT INTO plugin_media_areas (plugin, area, label, quota_bytes) VALUES (?, ?, ?, ?)').run(plugin.id, area, label, quota);
  } else {
    db().prepare("UPDATE plugin_media_areas SET label = ?, quota_bytes = ?, updated_at = datetime('now') WHERE plugin = ? AND area = ?").run(label, quota, plugin.id, area);
  }
  return info(plugin.id, area);
}

/** gc.media.areas.remove(area) — only an empty area. → true when it existed. */
function remove(plugin, area) {
  const a = rowOf(plugin.id, area);
  if (!a) return false;
  if (db().prepare('SELECT 1 FROM plugin_media WHERE plugin = ? AND area = ? LIMIT 1').get(plugin.id, area)) throw new AreaError('not_empty', 'the area still has files');
  db().prepare('DELETE FROM plugin_media_areas WHERE plugin = ? AND area = ?').run(plugin.id, area);
  return true;
}

function usageOf(pluginId, area) {
  const r = db().prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS count FROM plugin_media WHERE plugin = ? AND area = ?').get(pluginId, area);
  return { bytes: r.bytes, count: r.count };
}

function pendingOf(pluginId, a) {
  const r = db().prepare(`SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS count FROM plugin_media
    WHERE plugin = ? AND area = ? AND ref_count > 0 AND NOT (target_id IS ?)`).get(pluginId, a.area, effectiveTarget(a));
  return { bytes: r.bytes, count: r.count };
}

/** A target for views: null = this server. `admin` adds the address. */
function targetView(id, admin) {
  if (id == null) return { id: null, kind: 'server', label: null };
  const t = targets().get(id);
  if (!t) return { id, kind: 'missing', label: null };
  const v = { id: t.id, kind: t.kind, label: t.label };
  if (admin) v.display = t.display;
  return v;
}

/** Free bytes where an area's new files go (null when unknown). */
function freeOf(targetId) {
  if (targetId == null) {
    try { const s = fs.statfsSync(media().mediaRoot().replace(/\/plugin-media$/, '') || '/'); return s.bavail * s.bsize; } catch { return null; }
  }
  const t = targets().get(targetId);
  return t && t.check && t.check.free != null ? t.check.free : null;
}

/**
 * gc.media.areas.info(area) / the admin page: { area, label, target, moving,
 * bytes, count, quota, pending: { count, bytes }, state, error, encrypted, free }.
 * state: 'ok' | 'pending' (files still being copied) | 'moving' | 'unreachable'.
 */
function info(pluginId, area, { admin = false } = {}) {
  const a = rowOf(pluginId, area);
  if (!a) return null;
  const u = usageOf(pluginId, area);
  const p = pendingOf(pluginId, a);
  const eff = effectiveTarget(a);
  const failing = [a.target_id, a.moving_to].filter((t) => t != null).map((t) => health.get(t)).find((h) => h && h.failingSince);
  const lastErr = p.count ? db().prepare(`SELECT push_error FROM plugin_media WHERE plugin = ? AND area = ? AND push_error IS NOT NULL
    ORDER BY created_at DESC LIMIT 1`).get(pluginId, area) : null;
  return {
    area: a.area, label: a.label, target: targetView(a.target_id, admin),
    moving: a.moving ? { to: targetView(a.moving_to, admin), done: u.count - p.count, total: u.count } : null,
    bytes: u.bytes, count: u.count, quota: effectiveQuota(a), quotaDefault: a.quota_bytes == null ? null : a.quota_bytes,
    pending: p, state: failing ? 'unreachable' : (a.moving ? 'moving' : (p.count ? 'pending' : 'ok')),
    error: failing ? failing.lastError : (lastErr ? lastErr.push_error : null),
    encrypted: true, free: freeOf(eff),
  };
}

function list(pluginId, opts) { return rows(pluginId).map((a) => info(pluginId, a.area, opts)); }

/**
 * Administrator: keep area `area` on target `targetId` (null = this server).
 * Files move in the background; an area without files changes at once.
 */
function setTarget(pluginId, area, targetId) {
  const a = rowOf(pluginId, area);
  if (!a) throw new AreaError('not_found', 'no such area', 404);
  const tid = targetId == null ? null : Number(targetId);
  if (tid != null && !targets().rowOf(tid)) throw new AreaError('invalid', 'no such storage target');
  if (effectiveTarget(a) === tid) return info(pluginId, area, { admin: true });
  const empty = !db().prepare('SELECT 1 FROM plugin_media WHERE plugin = ? AND area = ? LIMIT 1').get(pluginId, area);
  if (empty || (a.moving && (a.target_id == null ? null : a.target_id) === tid)) {
    // nothing to move, or back to where it was (files already copied over come back in the background)
    db().prepare("UPDATE plugin_media_areas SET target_id = ?, moving = 0, moving_to = NULL, updated_at = datetime('now') WHERE plugin = ? AND area = ?")
      .run(tid, pluginId, area);
  } else {
    db().prepare("UPDATE plugin_media_areas SET moving = 1, moving_to = ?, updated_at = datetime('now') WHERE plugin = ? AND area = ?").run(tid, pluginId, area);
  }
  kick();
  return info(pluginId, area, { admin: true });
}

/** Administrator: an area's quota (null = the plugin's). */
function setAdminQuota(pluginId, area, bytes) {
  const a = rowOf(pluginId, area);
  if (!a) throw new AreaError('not_found', 'no such area', 404);
  db().prepare("UPDATE plugin_media_areas SET admin_quota_bytes = ?, updated_at = datetime('now') WHERE plugin = ? AND area = ?")
    .run(bytes == null ? null : quotaArg(bytes), pluginId, area);
  return info(pluginId, area, { admin: true });
}

// ─── Claiming into an area ──────────────────────

/** A plugin's path of a file ("Fotos/Urlaub/Strand 01.jpg"), normalised, or throws. */
function cleanPath(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > PATH_MAX) throw new AreaError('invalid', 'path too long');
  const segs = v.split('/').filter((s) => s !== '');
  if (!segs.length || segs.length > 64 || segs.some((s) => s === '.' || s === '..' || s.length > 255 || SEG_BAD_RE.test(s))) {
    throw new AreaError('invalid', 'invalid path');
  }
  return segs.join('/');
}

/**
 * gc.media.claim(id, { area, path }) for the file row `r` (media.claim): the
 * area must exist; its quota counts the file. A claimed file stays in its
 * area (moving between areas comes with gc.media.move).
 */
function claimInto(plugin, r, opts) {
  if (!declared(plugin)) throw new AreaError('no_areas', 'plugin.json declares no media.areas', 403);
  const a = rowOf(plugin.id, opts.area);
  if (!a) throw new AreaError('invalid', 'unknown area — gc.media.areas.ensure() it first');
  const p = cleanPath(opts.path);
  if (r.area != null && r.area !== a.area) throw new AreaError('invalid', 'the file is in another area');
  const q = effectiveQuota(a);
  if (q != null && r.area == null && usageOf(plugin.id, a.area).bytes + r.bytes > q) throw new AreaError('quota', 'the area is full', 507);
  db().prepare('UPDATE plugin_media SET area = ?, path = ? WHERE id = ?').run(a.area, p, r.id);
  kick();
}

/** gc.media.info: where the file is — 'server', 'target' or 'pending' (still being copied). */
function stateOf(r) {
  if (r.area == null) return null;
  const a = rowOf(r.plugin, r.area);
  if (!a) return null;
  const want = effectiveTarget(a);
  if ((r.target_id == null ? null : r.target_id) !== want) return 'pending';
  return want == null ? 'server' : 'target';
}

// ─── Targets: drivers and health ────────────────

const drivers = new Map(); // target id → { stamp, driver }
let driverOverride = null;

async function driverFor(targetId) {
  if (driverOverride) return driverOverride(targetId);
  const row = targets().rowOf(targetId);
  if (!row) throw new (targets().StorageError)('not_found', 'the storage target was deleted');
  const stamp = row.updated_at + '|' + row.secret_enc;
  const hit = drivers.get(targetId);
  if (hit && hit.stamp === stamp) return hit.driver;
  const driver = await targets().driverOf(row);
  drivers.set(targetId, { stamp, driver });
  return driver;
}

const health = new Map(); // target id → { failingSince, lastError, nextTry, backoff, alerted }

function healthy(targetId, now = Date.now()) {
  const h = health.get(targetId);
  return !h || now >= h.nextTry;
}

function targetLabel(targetId) {
  const t = targets().get(targetId);
  return t ? t.label : `#${targetId}`;
}

function noteFailure(targetId, err, now = Date.now()) {
  const code = (err && err.code) || 'failed';
  const h = health.get(targetId) || { failingSince: now, backoff: 0, alerted: false };
  h.backoff = Math.min(BACKOFF_MAX_MS, h.backoff ? h.backoff * 2 : BACKOFF_MIN_MS);
  h.nextTry = now + h.backoff;
  h.lastError = code;
  health.set(targetId, h);
  if (!h.alerted && now - h.failingSince >= ALERT_AFTER_MS) {
    h.alerted = true;
    try {
      require('../activity').log('storage_target_unreachable', `Storage target "${targetLabel(targetId)}" has not been reachable for 15 minutes (${code}) — files wait on this server`, {
        source: 'system', severity: 'warning', details: { targetId, target_label: targetLabel(targetId), code },
      });
    } catch { /* best-effort */ }
  }
}

function noteSuccess(targetId) {
  const h = health.get(targetId);
  if (!h) return;
  health.delete(targetId);
  if (h.alerted) {
    try {
      require('../activity').log('storage_target_recovered', `Storage target "${targetLabel(targetId)}" works again`, {
        source: 'system', severity: 'info', details: { targetId, target_label: targetLabel(targetId) },
      });
    } catch { /* best-effort */ }
  }
}

function anyFailing() { for (const h of health.values()) if (h.failingSince) return true; return false; }

// errors of the target itself (count against its health) vs. of one file
function isTargetError(e) { return e && ['unreachable', 'auth', 'denied', 'tls', 'full', 'blocked_address'].includes(e.code); }

// ─── Local copies ───────────────────────────────

function keyOf(r) { return `${r.plugin}/${r.area}/${r.id.slice(0, 2)}/${r.id}`; }

function freshRow(id) { return db().prepare('SELECT * FROM plugin_media WHERE id = ?').get(id) || null; }

const fetching = new Map(); // media id → Promise

/**
 * Make sure file `r` has a local sealed copy (download the whole object from
 * its target). → the fresh row. Concurrent callers share one download.
 */
function ensureLocal(r) {
  if (!r || r.local !== 0) return Promise.resolve(r);
  if (fetching.has(r.id)) return fetching.get(r.id);
  const p = (async () => {
    const M = media();
    const d = await driverFor(r.target_id);
    const final = M.fileOf(r.plugin, r.id);
    await fs.promises.mkdir(path.dirname(final), { recursive: true, mode: 0o700 });
    const tmp = path.join(path.dirname(final), `.tmp-${r.id}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      const stream = await d.get(r.remote_key, null);
      await require('node:stream/promises').pipeline(stream, fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      const st = await fs.promises.stat(tmp);
      if (st.size !== M.sealedSize(r.bytes)) throw new (targets().StorageError)('length_mismatch', 'the stored file has the wrong size');
      await fs.promises.rename(tmp, final);
    } catch (e) {
      await fs.promises.rm(tmp, { force: true });
      throw e;
    }
    db().prepare('UPDATE plugin_media SET local = 1, accessed_at = ? WHERE id = ?').run(nowIso(), r.id);
    noteSuccess(r.target_id);
    return freshRow(r.id);
  })();
  fetching.set(r.id, p);
  p.then(() => fetching.delete(r.id), () => fetching.delete(r.id));
  return p;
}

const lastTouch = new Map();
/** The cache's LRU: a remote file's local copy was read (at most once a minute per file). */
function touch(r, now = Date.now()) {
  if (r.target_id == null) return;
  const t = lastTouch.get(r.id) || 0;
  if (now - t < ACCESS_TOUCH_MS) return;
  lastTouch.set(r.id, now);
  if (lastTouch.size > 10000) lastTouch.clear();
  db().prepare('UPDATE plugin_media SET accessed_at = ? WHERE id = ?').run(new Date(now).toISOString(), r.id);
}

/**
 * Plaintext bytes start…end of a file without a local copy. A target that
 * reads ranges gives exactly the sealed chunks of the range; otherwise the
 * whole file comes into the cache first.
 * @returns {AsyncGenerator<Buffer>}
 */
async function* readRemote(r, start, end) {
  const M = media();
  const d = await driverFor(r.target_id);
  if (!d.ranges || !r.nonce_prefix) {
    const local = await ensureLocal(r);
    yield* M.readRange(local, start, end);
    return;
  }
  const C = M._sealed;
  const key = M._unwrapKey(r.key_enc, r.id);
  const prefix = Buffer.from(r.nonce_prefix, 'hex');
  const lastIndex = Math.max(0, Math.ceil(r.bytes / C.CHUNK) - 1);
  const plainLen = (i) => (i === lastIndex ? r.bytes - i * C.CHUNK : C.CHUNK);
  const first = Math.floor(start / C.CHUNK);
  const last = Math.floor(end / C.CHUNK);
  const sealedStart = C.HEADER_LEN + first * (C.CHUNK + C.TAG_LEN);
  const sealedEnd = C.HEADER_LEN + last * (C.CHUNK + C.TAG_LEN) + plainLen(last) + C.TAG_LEN - 1;
  const stream = await d.get(r.remote_key, { start: sealedStart, end: sealedEnd });
  let buf = Buffer.alloc(0);
  let i = first;
  try {
    for await (const piece of stream) {
      buf = buf.length ? Buffer.concat([buf, piece]) : piece;
      while (i <= last && buf.length >= plainLen(i) + C.TAG_LEN) {
        const n = plainLen(i) + C.TAG_LEN;
        const plain = M._openChunk(key, prefix, i, i === lastIndex, buf.subarray(0, n));
        buf = buf.subarray(n);
        const from = i * C.CHUNK;
        yield plain.subarray(Math.max(0, start - from), Math.min(plain.length, end - from + 1));
        i++;
      }
      if (i > last) break;
    }
  } finally {
    if (typeof stream.destroy === 'function') stream.destroy();
  }
  if (i <= last) throw new (targets().StorageError)('length_mismatch', 'the stored file ended early');
}

// ─── Deletions on targets ───────────────────────

function gone(targetId, key) {
  if (targetId == null || !key) return;
  db().prepare('INSERT INTO plugin_media_gone (target_id, remote_key) VALUES (?, ?)').run(targetId, key);
  kick();
}

// ─── Background worker ──────────────────────────

let timer = null;
let running = null;
let again = false;

/** Run the worker soon (after a claim, a delete, a move). */
function kick() {
  if (!timer) return; // not started (tests call tick() themselves)
  if (running) { again = true; return; }
  setImmediate(() => { tick().catch((e) => logger.warn({ err: e.message }, 'plugin media areas: worker failed')); });
}

async function processGone(deadline) {
  const due = db().prepare('SELECT * FROM plugin_media_gone WHERE next_at <= ? ORDER BY id LIMIT 50').all(nowIso());
  for (const g of due) {
    if (Date.now() > deadline) return;
    if (!targets().rowOf(g.target_id)) { db().prepare('DELETE FROM plugin_media_gone WHERE id = ?').run(g.id); continue; }
    if (!healthy(g.target_id)) continue;
    try {
      const d = await driverFor(g.target_id);
      await d.remove(g.remote_key);
      db().prepare('DELETE FROM plugin_media_gone WHERE id = ?').run(g.id);
      noteSuccess(g.target_id);
    } catch (e) {
      const attempts = g.attempts + 1;
      const wait = Math.min(6 * 3600, 60 * 2 ** Math.min(attempts, 9)) * 1000;
      db().prepare('UPDATE plugin_media_gone SET attempts = ?, next_at = ? WHERE id = ?').run(attempts, new Date(Date.now() + wait).toISOString(), g.id);
      if (isTargetError(e)) noteFailure(g.target_id, e);
    }
  }
}

/** The local sealed file of `r` as a source for driver.put. */
function localSource(r) {
  const M = media();
  const file = M.fileOf(r.plugin, r.id);
  return { length: M.sealedSize(r.bytes), open: (s, e) => fs.createReadStream(file, { start: s, end: e }) };
}

/** Move one file to where its area wants it (`want`, null = this server). */
async function transfer(r, want) {
  const M = media();
  const from = r.target_id == null ? null : r.target_id;
  const fromKey = r.remote_key;
  let cur = r;
  if (cur.local === 0) {
    try { cur = await ensureLocal(cur); } catch (e) { if (e && typeof e === 'object') e.side = 'source'; throw e; }
  }
  if (want == null) {
    const ok = db().prepare('UPDATE plugin_media SET target_id = NULL, remote_key = NULL, local = 1, push_error = NULL WHERE id = ? AND target_id IS ?').run(r.id, from);
    if (ok.changes) gone(from, fromKey);
    return;
  }
  const d = await driverFor(want);
  const key = keyOf(cur);
  const src = localSource(cur);
  await d.put(key, src);
  const h = await d.head(key);
  if (!h || h.size !== src.length) throw new (targets().StorageError)('length_mismatch', 'the copy on the target has the wrong size');
  const head = Buffer.alloc(M._sealed.HEADER_LEN);
  const fh = await fs.promises.open(M.fileOf(cur.plugin, cur.id), 'r');
  try { await fh.read(head, 0, head.length, 0); } finally { await fh.close(); }
  const prefix = head.subarray(M._sealed.MAGIC_LEN).toString('hex');
  const ok = db().prepare(`UPDATE plugin_media SET target_id = ?, remote_key = ?, nonce_prefix = ?, push_error = NULL, accessed_at = COALESCE(accessed_at, ?)
    WHERE id = ? AND target_id IS ?`).run(want, key, prefix, nowIso(), r.id, from);
  if (!ok.changes) { gone(want, key); return; } // deleted or changed meanwhile: the copy goes again
  if (from != null && (from !== want || fromKey !== key)) gone(from, fromKey);
  noteSuccess(want);
}

async function processTransfers(deadline) {
  const todo = db().prepare(`SELECT pm.*, CASE WHEN a.moving = 1 THEN a.moving_to ELSE a.target_id END AS want
    FROM plugin_media pm JOIN plugin_media_areas a ON a.plugin = pm.plugin AND a.area = pm.area
    WHERE pm.ref_count > 0 AND NOT (pm.target_id IS (CASE WHEN a.moving = 1 THEN a.moving_to ELSE a.target_id END))
    ORDER BY pm.created_at LIMIT 200`).all();
  for (const r of todo) {
    if (Date.now() > deadline) return;
    const want = r.want == null ? null : r.want;
    if (want != null && !healthy(want)) continue;
    if (r.local === 0 && r.target_id != null && !healthy(r.target_id)) continue;
    try {
      await transfer(r, want);
    } catch (e) {
      const which = e && e.side === 'source' ? r.target_id : want;
      db().prepare('UPDATE plugin_media SET push_error = ? WHERE id = ?').run(String((e && e.code) || 'failed'), r.id);
      if (isTargetError(e) && which != null) noteFailure(which, e);
      else logger.warn({ plugin: r.plugin, media: r.id, err: e && e.message }, 'plugin media areas: copy failed');
    }
  }
}

function finishMoves() {
  const moving = db().prepare('SELECT * FROM plugin_media_areas WHERE moving = 1').all();
  for (const a of moving) {
    if (pendingOf(a.plugin, a).count) continue;
    db().prepare("UPDATE plugin_media_areas SET target_id = moving_to, moving = 0, moving_to = NULL, updated_at = datetime('now') WHERE plugin = ? AND area = ? AND moving = 1")
      .run(a.plugin, a.area);
    try {
      require('../activity').log('plugin_media_area_moved', `Plugin "${a.plugin}": area "${a.label}" moved`, {
        source: 'system', severity: 'info', details: { plugin: a.plugin, area: a.area, targetId: a.moving_to },
      });
    } catch { /* best-effort */ }
  }
}

// ─── Cache ──────────────────────────────────────

function cacheLimit() {
  let v = null;
  try { v = settings().get(CACHE_SETTING, null); } catch { v = null; }
  const n = v == null || v === '' ? NaN : Number(v);
  return Number.isSafeInteger(n) && n >= CACHE_MIN ? n : CACHE_DEFAULT;
}

function setCacheLimit(bytes) {
  if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < CACHE_MIN || bytes > CACHE_MAX)) throw new AreaError('invalid', 'cache limit out of range');
  settings().set(CACHE_SETTING, bytes == null ? '' : String(bytes));
  kick();
  return cacheLimit();
}

/** { cached (local copies of remote files), pending (local files still to be copied), limit } in bytes. */
function cacheStats() {
  const cached = db().prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM plugin_media WHERE local = 1 AND target_id IS NOT NULL').get().b;
  const pending = db().prepare(`SELECT COALESCE(SUM(pm.bytes), 0) AS b FROM plugin_media pm JOIN plugin_media_areas a ON a.plugin = pm.plugin AND a.area = pm.area
    WHERE pm.local = 1 AND NOT (pm.target_id IS (CASE WHEN a.moving = 1 THEN a.moving_to ELSE a.target_id END))`).get().b;
  return { cached, pending, limit: cacheLimit(), default: CACHE_DEFAULT };
}

/** Drop the least recently used local copies of remote files until the cache fits. → files dropped. */
function evict() {
  const limit = cacheLimit();
  let used = cacheStats().cached;
  if (used <= limit) return 0;
  const cands = db().prepare(`SELECT pm.id, pm.plugin, pm.bytes FROM plugin_media pm JOIN plugin_media_areas a ON a.plugin = pm.plugin AND a.area = pm.area
    WHERE pm.local = 1 AND pm.target_id IS NOT NULL AND pm.target_id IS (CASE WHEN a.moving = 1 THEN a.moving_to ELSE a.target_id END)
    ORDER BY COALESCE(pm.accessed_at, pm.created_at) ASC LIMIT 1000`).all();
  let n = 0;
  for (const c of cands) {
    if (used <= limit) break;
    if (fetching.has(c.id)) continue;
    try { fs.rmSync(media().fileOf(c.plugin, c.id), { force: true }); } catch { continue; }
    db().prepare('UPDATE plugin_media SET local = 0 WHERE id = ?').run(c.id);
    used -= c.bytes;
    n++;
  }
  return n;
}

/**
 * Before an upload of `length` bytes to a plugin with areas: room on this
 * server, and no pile-up while a target is down. Throws AreaError
 * server_full (507) / storage_unavailable (503).
 */
function capacityCheck(plugin, length) {
  if (!declared(plugin)) return;
  try {
    const s = fs.statfsSync(media().mediaRoot().replace(/\/plugin-media$/, '') || '/');
    if (s.bavail * s.bsize < length + FREE_MARGIN) throw new AreaError('server_full', 'not enough free space on this server', 507);
  } catch (e) { if (e instanceof AreaError) throw e; }
  if (anyFailing() && cacheStats().pending + length > cacheLimit()) {
    throw new AreaError('storage_unavailable', 'a storage target is not reachable and the files waiting for it fill the cache', 503);
  }
}

/** One run of the worker: deletions, copies, finished moves, the cache. */
async function tick() {
  if (running) { again = true; return running; }
  running = (async () => {
    do {
      again = false;
      const deadline = Date.now() + TICK_BUDGET_MS;
      try { await processGone(deadline); } catch (e) { logger.warn({ err: e.message }, 'plugin media areas: deletions failed'); }
      try { await processTransfers(deadline); } catch (e) { logger.warn({ err: e.message }, 'plugin media areas: copies failed'); }
      try { finishMoves(); } catch (e) { logger.warn({ err: e.message }, 'plugin media areas: finishing moves failed'); }
      try { evict(); } catch (e) { logger.warn({ err: e.message }, 'plugin media areas: cache clean-up failed'); }
    } while (again && timer);
  })();
  try { await running; } finally { running = null; }
}

function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch((e) => logger.warn({ err: e.message }, 'plugin media areas: worker failed')); }, TICK_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

// ─── Plugin removal, storage target usage ───────

/** "Alles löschen": every remote copy of the plugin goes, its areas too. */
function removeAllOf(pluginId) {
  const remote = db().prepare('SELECT target_id, remote_key FROM plugin_media WHERE plugin = ? AND target_id IS NOT NULL').all(pluginId);
  for (const r of remote) gone(r.target_id, r.remote_key);
  db().prepare('DELETE FROM plugin_media_areas WHERE plugin = ?').run(pluginId);
}

function pluginName(id) {
  try { const p = require('./registry').get(id); return p ? p.name : id; } catch { return id; }
}

/** storageTargets.usedBy: the areas kept on (or moving to) a target, and files still stored there. */
function usageProvider(targetId) {
  const out = [];
  const areas = db().prepare('SELECT plugin, area, label FROM plugin_media_areas WHERE target_id = ? OR (moving = 1 AND moving_to = ?)').all(targetId, targetId);
  for (const a of areas) out.push({ kind: 'area', plugin: a.plugin, pluginName: pluginName(a.plugin), area: a.area, label: a.label });
  const files = db().prepare('SELECT plugin, COUNT(*) AS n FROM plugin_media WHERE target_id = ? GROUP BY plugin').all(targetId);
  for (const f of files) if (!out.some((o) => o.plugin === f.plugin)) out.push({ kind: 'files', plugin: f.plugin, pluginName: pluginName(f.plugin), count: f.n });
  return out;
}

let registered = false;
function register() {
  if (registered) return;
  registered = true;
  targets().registerUsage(usageProvider);
}
register();

// ─── Backup (docs/plugins.md "Backup") ──────────

/**
 * The areas of a plugin and the metadata of its area files — never their
 * bytes: { areas: [...], files: [{ id, area, path, target_id, remote_key,
 * nonce_prefix, …, key }] } (key: the file key encrypted with
 * GC_ENCRYPTION_KEY, like media backups). Always part of the backup (also
 * without "Plugin-Medien im Backup"): the plugin's data names these ids.
 */
function exportAreas(pluginId) {
  const { encrypt } = require('../../utils/crypto');
  const M = media();
  const areas = rows(pluginId).map((a) => ({ area: a.area, label: a.label, target_id: a.target_id, moving: a.moving, moving_to: a.moving_to,
    quota_bytes: a.quota_bytes, admin_quota_bytes: a.admin_quota_bytes }));
  const files = db().prepare('SELECT * FROM plugin_media WHERE plugin = ? AND area IS NOT NULL AND ref_count > 0').all(pluginId).map((r) => ({
    id: r.id, area: r.area, path: r.path, target_id: r.target_id, remote_key: r.remote_key, nonce_prefix: r.nonce_prefix,
    owner_user_id: r.owner_user_id, mime: r.mime, bytes: r.bytes, sha256: r.sha256, created_at: r.created_at, claimed_at: r.claimed_at,
    name: r.name == null ? null : r.name, key: encrypt(M._unwrapKey(r.key_enc, r.id).toString('hex')),
  }));
  return { areas, files };
}

/**
 * Restore exportAreas() on this server: the areas, and every file whose
 * bytes are still somewhere — on its storage target, or (area on this
 * server) as the local file that survived. → number of files restored.
 */
function importAreas(pluginId, data) {
  if (!data || typeof data !== 'object') return 0;
  const { decrypt } = require('../../utils/crypto');
  const M = media();
  const insA = db().prepare(`INSERT OR REPLACE INTO plugin_media_areas (plugin, area, label, target_id, moving, moving_to, quota_bytes, admin_quota_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const int = (v) => (Number.isSafeInteger(v) ? v : null);
  for (const a of Array.isArray(data.areas) ? data.areas : []) {
    if (!a || !AREA_RE.test(String(a.area))) continue;
    const tid = int(a.target_id);
    insA.run(pluginId, a.area, cleanLabel(a.label, a.area), tid != null && targets().rowOf(tid) ? tid : null, a.moving ? 1 : 0,
      int(a.moving_to), int(a.quota_bytes), int(a.admin_quota_bytes));
  }
  let n = 0;
  for (const e of Array.isArray(data.files) ? data.files : []) {
    try {
      if (!e || !M.ID_RE.test(String(e.id)) || !AREA_RE.test(String(e.area)) || typeof e.key !== 'string' || typeof e.mime !== 'string'
        || !Number.isSafeInteger(e.bytes) || e.bytes < 1 || !/^[0-9a-f]{64}$/.test(String(e.sha256))) continue;
      const tid = int(e.target_id);
      const local = fs.existsSync(M.fileOf(pluginId, e.id));
      if (tid == null ? !local : !targets().rowOf(tid)) continue; // the bytes are gone
      const key = Buffer.from(decrypt(e.key), 'hex');
      if (key.length !== 32) continue;
      db().prepare(`INSERT OR REPLACE INTO plugin_media (id, plugin, owner_user_id, mime, bytes, sha256, created_at, ref_count, claimed_at, key_enc, name,
        area, path, target_id, remote_key, nonce_prefix, local) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(e.id, pluginId, int(e.owner_user_id), M.baseType(e.mime), e.bytes, e.sha256, typeof e.created_at === 'string' ? e.created_at : nowIso(),
          typeof e.claimed_at === 'string' ? e.claimed_at : nowIso(), M._wrapKey(key, e.id), M.cleanName(e.name), e.area,
          (() => { try { return cleanPath(e.path); } catch { return null; } })(), tid, tid == null ? null : String(e.remote_key || ''),
          typeof e.nonce_prefix === 'string' && /^[0-9a-f]{16}$/.test(e.nonce_prefix) ? e.nonce_prefix : null, local ? 1 : 0);
      n++;
    } catch (err) {
      logger.warn({ plugin: pluginId, err: err.message }, 'plugin media areas: restore of a file failed');
    }
  }
  kick();
  return n;
}

module.exports = {
  AreaError, AREA_RE, CACHE_SETTING, CACHE_DEFAULT, CACHE_MIN, CACHE_MAX, ALERT_AFTER_MS,
  declared, rowOf, rows, ensure, remove, info, list, setTarget, setAdminQuota, effectiveTarget, cleanPath, claimInto, stateOf,
  ensureLocal, readRemote, touch, gone, kick, tick, start, stop, transfer, evict, cacheLimit, setCacheLimit, cacheStats, capacityCheck,
  removeAllOf, usageProvider, exportAreas, importAreas, healthy, noteFailure, noteSuccess,
  _setDriverForTest: (fn) => { driverOverride = fn; drivers.clear(); },
  _resetHealthForTest: () => { health.clear(); },
  _health: health,
};
