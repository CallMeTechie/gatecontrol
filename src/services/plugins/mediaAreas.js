'use strict';

// Areas of the plugin media store (docs/plugins.md "Media areas"). A plugin
// that declares `media.areas` keeps its files in areas it names itself
// (gc.media.areas.ensure('family', { label: 'Familie' })) and binds each file
// to one when it claims it (gc.media.claim(id, { area, path })). The
// administrator decides per area where the files live: on this server (the
// plugin media folder, as always) or on a storage target (services/
// storageTargets: a folder, a NAS over SMB / WebDAV, an S3 bucket) — and, on
// a folder or a NAS, in which form:
//
//   * 'blocks': the sealed file (encrypted 64 KiB chunks) under an opaque key
//     <plugin>/<area>/<id[0..2]>/<id> — the only form on S3 and the form on
//     this server.
//   * 'files' (since 1.205.0, the default on a folder or NAS): the plain file
//     under the plugin's path, <plugin>/<area>/<path>, so people can open it
//     on the NAS and back it up with the NAS. Versions kept with
//     gc.media.version go to <plugin>/<area>/.gcdrive/versions/…, files
//     without a path to …/.gcdrive/files/…. Changes made on the target are
//     found by a scan (every 15 minutes, scanArea) and reported to the plugin
//     (journal plugin_media_changes, hook mediaChanged).
//
// How the bytes travel:
//
//   * Every file arrives here first (upload, fetch, hand-over) and is sealed
//     like all plugin media. For an area on a storage target the background
//     worker (tick) copies it there — sealed or plain, by the area's form —
//     under want_key (where the copy belongs now). Only then the remote copy
//     counts (target_id, remote_key, stored_form); the local one stays as
//     cache. A file is "in place" when its copy is on the area's target, in
//     the area's form, under its want_key (IN_PLACE below); everything else
//     is pending.
//   * The cache: local copies of files kept on a target, at most
//     cacheLimit() bytes (setting plugins.media_cache_bytes, default 5 GB),
//     the least recently used go first. Files waiting to be copied are never
//     evicted.
//   * Reading a file without a local copy: a plain file is read straight from
//     the target (the requested range); a sealed one from a target that reads
//     ranges (folder, WebDAV, S3) by its sealed chunks; from SMB a sealed file
//     comes back into the cache first.
//   * Moving an area (setTarget, also a change of its form), a file
//     (gc.media.move) or keeping a version (gc.media.version): the worker
//     renames on the target when it can, else copies and deletes the old copy
//     afterwards (plugin_media_gone keeps the deletions a target could not do
//     yet; a key that a file uses again is never deleted). Until a file is
//     moved it is read from where it was.
//   * A target that fails is retried with a growing pause (30 s … 15 min);
//     after 15 minutes the administrators get storage_target_unreachable
//     (activity log → notification settings), once, and
//     storage_target_recovered when it works again.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const logger = require('../../utils/logger');

const AREA_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FORMS = ['blocks', 'files'];
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
const SCAN_EVERY_MS = 15 * 60 * 1000;
const SCAN_BUDGET_MS = 10 * 60 * 1000;
const SCAN_MAX_IMPORTS = 1000;
// a file changed less than a minute ago may still be being written: the next scan takes it
const SCAN_SETTLE_MS = 60 * 1000;
// more files gone at once than this needs the administrator's yes (confirmRemovals)
const MASS_MIN = 50;
const MASS_SHARE = 0.2;
const CHANGES_KEEP_MS = 30 * 24 * 3600 * 1000;
const CHANGES_PAGE_MAX = 1000;
const MTIME_SLACK_MS = 2000;
const HIDDEN = '.gcdrive';
// control characters and the bidi controls that could disguise a name
const SEG_BAD_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;
// names a NAS (SMB / Windows) cannot hold — such a file is kept under .gcdrive/files
const NAS_BAD_RE = /["<>|?*:\\]|[. ]$/;

class AreaError extends Error {
  constructor(code, message, status) { super(message || code); this.code = code; this.status = status || 400; }
}

function db() { return require('../../db/connection').getDb(); }
function media() { return require('./media'); }
function targets() { return require('../storageTargets'); }
function settings() { return require('../settings'); }
function nowIso() { return new Date().toISOString(); }

// Where the files of an area (alias a) go now, and whether a file (pm) is there.
const WANT_SQL = '(CASE WHEN a.moving = 1 THEN a.moving_to ELSE a.target_id END)';
const IN_PLACE_SQL = `((${WANT_SQL} IS NULL AND pm.target_id IS NULL)
  OR (${WANT_SQL} IS NOT NULL AND pm.target_id IS ${WANT_SQL} AND pm.remote_key IS pm.want_key AND pm.stored_form IS a.form))`;
const JOIN_SQL = 'plugin_media pm JOIN plugin_media_areas a ON a.plugin = pm.plugin AND a.area = pm.area';

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
  db().prepare('DELETE FROM plugin_media_changes WHERE plugin = ? AND area = ?').run(plugin.id, area);
  return true;
}

function usageOf(pluginId, area) {
  const r = db().prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS count FROM plugin_media WHERE plugin = ? AND area = ?').get(pluginId, area);
  return { bytes: r.bytes, count: r.count };
}

/** Files of the area that are not where (or in the form, or under the key) the area wants them. */
function pendingOf(pluginId, area) {
  const r = db().prepare(`SELECT COALESCE(SUM(pm.bytes), 0) AS bytes, COUNT(*) AS count FROM ${JOIN_SQL}
    WHERE pm.plugin = ? AND pm.area = ? AND pm.ref_count > 0 AND NOT ${IN_PLACE_SQL}`).get(pluginId, area);
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

/** Can target `id` hold readable files (a folder, SMB, WebDAV — not S3, not this server)? */
function filesCapable(id) {
  if (id == null) return false;
  const t = targets().rowOf(id);
  return !!t && t.kind !== 's3';
}

/** Free bytes where an area's new files go (null when unknown). */
function freeOf(targetId) {
  if (targetId == null) {
    try { const s = fs.statfsSync(media().mediaRoot().replace(/\/plugin-media$/, '') || '/'); return s.bavail * s.bsize; } catch { return null; }
  }
  const t = targets().get(targetId);
  return t && t.check && t.check.free != null ? t.check.free : null;
}

function parseStats(v) { try { return v ? JSON.parse(v) : null; } catch { return null; } }

/**
 * gc.media.areas.info(area) / the admin page: { area, label, target, form,
 * moving, bytes, count, quota, pending: { count, bytes }, state, error,
 * encrypted, free, scan }. state: 'ok' | 'pending' (files still being
 * copied) | 'moving' | 'unreachable'. scan (form 'files'): { at, error,
 * stats } of the last look for changes made on the target.
 */
function info(pluginId, area, { admin = false } = {}) {
  const a = rowOf(pluginId, area);
  if (!a) return null;
  const u = usageOf(pluginId, area);
  const p = pendingOf(pluginId, area);
  const eff = effectiveTarget(a);
  const failing = [a.target_id, a.moving_to].filter((t) => t != null).map((t) => health.get(t)).find((h) => h && h.failingSince);
  const lastErr = p.count ? db().prepare(`SELECT push_error FROM plugin_media WHERE plugin = ? AND area = ? AND push_error IS NOT NULL
    ORDER BY created_at DESC LIMIT 1`).get(pluginId, area) : null;
  const form = eff == null ? 'blocks' : a.form;
  return {
    area: a.area, label: a.label, target: targetView(a.target_id, admin), form,
    moving: a.moving ? { to: targetView(a.moving_to, admin), done: u.count - p.count, total: u.count } : null,
    bytes: u.bytes, count: u.count, quota: effectiveQuota(a), quotaDefault: a.quota_bytes == null ? null : a.quota_bytes,
    pending: p, state: failing ? 'unreachable' : (a.moving ? 'moving' : (p.count ? 'pending' : 'ok')),
    error: failing ? failing.lastError : (lastErr ? lastErr.push_error : null),
    // on this server and in blocks every file is sealed; readable files are plain on the target
    encrypted: form === 'blocks', free: freeOf(eff),
    scan: form === 'files' ? { at: a.scanned_at || null, error: a.scan_error || null, stats: parseStats(a.scan_stats) } : null,
  };
}

function list(pluginId, opts) { return rows(pluginId).map((a) => info(pluginId, a.area, opts)); }

/**
 * Administrator: keep area `area` on target `targetId` (null = this server)
 * in form `form` ('files' | 'blocks'; on this server and S3 always
 * 'blocks'; unset: the area's form when it already is on a folder / NAS,
 * else 'files'). Files move in the background; an empty area changes at once.
 */
function setTarget(pluginId, area, targetId, { form } = {}) {
  const a = rowOf(pluginId, area);
  if (!a) throw new AreaError('not_found', 'no such area', 404);
  const tid = targetId == null ? null : Number(targetId);
  if (tid != null && !targets().rowOf(tid)) throw new AreaError('invalid', 'no such storage target');
  if (form != null && !FORMS.includes(form)) throw new AreaError('invalid', "form: 'files' or 'blocks'");
  let f;
  if (!filesCapable(tid)) {
    if (form === 'files') throw new AreaError('invalid', 'readable files need a folder or a NAS');
    f = 'blocks';
  } else {
    f = form || (filesCapable(effectiveTarget(a)) ? a.form : 'files');
  }
  if (effectiveTarget(a) === tid && a.form === f) return info(pluginId, area, { admin: true });
  const empty = !db().prepare('SELECT 1 FROM plugin_media WHERE plugin = ? AND area = ? LIMIT 1').get(pluginId, area);
  if (empty) {
    db().prepare("UPDATE plugin_media_areas SET target_id = ?, form = ?, moving = 0, moving_to = NULL, updated_at = datetime('now') WHERE plugin = ? AND area = ?")
      .run(tid, f, pluginId, area);
  } else {
    // files already where they belong count as moved at once (back to where they were, …)
    db().prepare("UPDATE plugin_media_areas SET moving = 1, moving_to = ?, form = ?, updated_at = datetime('now') WHERE plugin = ? AND area = ?").run(tid, f, pluginId, area);
  }
  syncWantKeys(pluginId, area);
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

/** Administrator: the next scan may remove more files than MASS_MIN / MASS_SHARE at once. */
function confirmRemovals(pluginId, area) {
  const a = rowOf(pluginId, area);
  if (!a) throw new AreaError('not_found', 'no such area', 404);
  db().prepare("UPDATE plugin_media_areas SET confirm_removals = 1, updated_at = datetime('now') WHERE plugin = ? AND area = ?").run(pluginId, area);
  return info(pluginId, area, { admin: true });
}

// ─── Paths, keys ────────────────────────────────

/** A plugin's path of a file ("Fotos/Urlaub/Strand 01.jpg"), normalised, or throws. */
function cleanPath(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > PATH_MAX) throw new AreaError('invalid', 'path too long');
  const segs = v.split('/').filter((s) => s !== '');
  if (!segs.length || segs.length > 64 || segs.some((s) => s === '.' || s === '..' || s.length > 255 || SEG_BAD_RE.test(s))) {
    throw new AreaError('invalid', 'invalid path');
  }
  if (segs[0] === HIDDEN) throw new AreaError('invalid', `paths below ${HIDDEN} are reserved`);
  return segs.join('/');
}

/** Can `p` be a file name on a NAS (SMB / Windows rules)? */
function nasName(p) { return p.split('/').every((s) => !NAS_BAD_RE.test(s)); }

function rootOf(plugin, area) { return `${plugin}/${area}`; }

/** "Fotos/Strand.jpg", at 2026-10-26T12:00:05Z, id ab12… → "Fotos/Strand (2026-10-26 120005 ab12cd).jpg" */
function versionName(p, at, id) {
  const slash = p.lastIndexOf('/');
  const dir = slash >= 0 ? p.slice(0, slash + 1) : '';
  const name = p.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const stamp = String(at || '').slice(0, 19).replace('T', ' ').replace(/:/g, '');
  return `${dir}${base} (${stamp} ${id.slice(0, 6)})${ext}`;
}

/**
 * Where file `r` of area `a` belongs on a target: sealed under its id
 * (form 'blocks'), or readable under its path / as a version / without a
 * path below .gcdrive (form 'files').
 */
function wantKeyOf(r, a) {
  if (!a) return null;
  const root = rootOf(r.plugin, a.area);
  if (a.form !== 'files') return `${root}/${r.id.slice(0, 2)}/${r.id}`;
  if (r.path != null && nasName(r.path)) return `${root}/${r.path}`;
  if (r.path == null && r.version_of != null && nasName(r.version_of)) return `${root}/${HIDDEN}/versions/${versionName(r.version_of, r.version_at, r.id)}`;
  return `${root}/${HIDDEN}/files/${r.id.slice(0, 2)}/${r.id}`;
}

function freshRow(id) { return db().prepare('SELECT * FROM plugin_media WHERE id = ?').get(id) || null; }

function setWant(id) {
  const r = freshRow(id);
  if (!r || r.area == null) return;
  db().prepare('UPDATE plugin_media SET want_key = ? WHERE id = ?').run(wantKeyOf(r, rowOf(r.plugin, r.area)), id);
}

/** want_key of every file of an area (its form changed). */
function syncWantKeys(pluginId, area) {
  const a = rowOf(pluginId, area);
  if (!a) return;
  const upd = db().prepare('UPDATE plugin_media SET want_key = ? WHERE id = ?');
  const list = db().prepare('SELECT id, plugin, path, version_of, version_at FROM plugin_media WHERE plugin = ? AND area = ?').all(pluginId, area);
  db().transaction(() => { for (const r of list) upd.run(wantKeyOf(r, a), r.id); })();
}

/** Another current file of the area with this path (not `exceptId`)? */
function pathTaken(pluginId, area, p, exceptId) {
  return !!db().prepare('SELECT 1 FROM plugin_media WHERE plugin = ? AND area = ? AND path = ? AND id <> ? LIMIT 1').get(pluginId, area, p, exceptId);
}

// ─── Claiming, moving, versions ─────────────────

/**
 * gc.media.claim(id, { area, path }) for the file row `r` (media.claim): the
 * area must exist; its quota counts the file; a path is unique in the area
 * (409 exists). A file claimed again keeps its area (gc.media.move moves).
 */
function claimInto(plugin, r, opts) {
  if (!declared(plugin)) throw new AreaError('no_areas', 'plugin.json declares no media.areas', 403);
  const a = rowOf(plugin.id, opts.area);
  if (!a) throw new AreaError('invalid', 'unknown area — gc.media.areas.ensure() it first');
  const p = cleanPath(opts.path);
  if (r.area != null && r.area !== a.area) throw new AreaError('invalid', 'the file is in another area — gc.media.move() it');
  if (r.version_of != null) throw new AreaError('invalid', 'the file is a version');
  if (p != null && pathTaken(plugin.id, a.area, p, r.id)) throw new AreaError('exists', 'another file has this path', 409);
  const q = effectiveQuota(a);
  if (q != null && r.area == null && usageOf(plugin.id, a.area).bytes + r.bytes > q) throw new AreaError('quota', 'the area is full', 507);
  db().prepare('UPDATE plugin_media SET area = ?, path = ? WHERE id = ?').run(a.area, p, r.id);
  setWant(r.id);
  kick();
}

/**
 * gc.media.move(id, { path, area }): a new path (unique in the area) and/or
 * another area of the plugin (its quota). On a target the worker renames the
 * readable file (or copies it to the other area's place).
 */
function move(plugin, r, opts) {
  if (!declared(plugin)) throw new AreaError('no_areas', 'plugin.json declares no media.areas', 403);
  if (r.area == null) throw new AreaError('invalid', 'the file is in no area — gc.media.claim() it into one');
  if (r.version_of != null) throw new AreaError('invalid', 'a version does not move');
  const o = opts && typeof opts === 'object' ? opts : {};
  const area = o.area == null ? r.area : String(o.area);
  const a = rowOf(plugin.id, area);
  if (!a) throw new AreaError('invalid', 'unknown area');
  const p = Object.prototype.hasOwnProperty.call(o, 'path') ? cleanPath(o.path) : r.path;
  if (p != null && pathTaken(plugin.id, area, p, r.id)) throw new AreaError('exists', 'another file has this path', 409);
  if (area !== r.area) {
    const q = effectiveQuota(a);
    if (q != null && usageOf(plugin.id, area).bytes + r.bytes > q) throw new AreaError('quota', 'the area is full', 507);
  }
  db().prepare('UPDATE plugin_media SET area = ?, path = ? WHERE id = ?').run(area, p, r.id);
  setWant(r.id);
  kick();
}

/**
 * gc.media.version(id): keep the file as a version of its path — the path
 * is free for the next file (readable form: the file moves to
 * .gcdrive/versions on the target). The version keeps its media id.
 */
function version(plugin, r) {
  if (!declared(plugin)) throw new AreaError('no_areas', 'plugin.json declares no media.areas', 403);
  if (r.area == null || r.path == null) throw new AreaError('invalid', 'only a file with an area and a path has versions');
  db().prepare('UPDATE plugin_media SET version_of = path, version_at = ?, path = NULL WHERE id = ?').run(nowIso(), r.id);
  setWant(r.id);
  kick();
}

/** gc.media.info: where the file is — 'server', 'target' or 'pending' (still being copied / moved). */
function stateOf(r) {
  if (r.area == null) return null;
  const x = db().prepare(`SELECT ${IN_PLACE_SQL} AS ok, ${WANT_SQL} AS want FROM ${JOIN_SQL} WHERE pm.id = ?`).get(r.id);
  if (!x) return null;
  if (!x.ok) return 'pending';
  return x.want == null ? 'server' : 'target';
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

function storageError(code, msg) { return new (targets().StorageError)(code, msg); }

// ─── Local copies ───────────────────────────────

const fetching = new Map(); // media id → Promise

/**
 * Make sure file `r` has a local sealed copy (download the whole object from
 * its target; a readable file is sealed here with the file's key and a fresh
 * nonce prefix, and must still be the file that was stored — else
 * StorageError changed and a scan of its area). → the fresh row. Concurrent
 * callers share one download.
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
      if (r.stored_form === 'files') {
        let sha;
        try { ({ sha } = await M._sealInto(tmp, M._unwrapKey(r.key_enc, r.id), stream, r.bytes)); } catch (e) {
          if (e && (e.code === 'length_mismatch' || e.message === 'length_mismatch')) { requestScan(r.plugin, r.area); throw storageError('changed', 'the file on the target has another size'); }
          throw e;
        } finally { if (typeof stream.destroy === 'function') stream.destroy(); }
        if (sha !== r.sha256) { requestScan(r.plugin, r.area); throw storageError('changed', 'the file on the target was changed there'); }
      } else {
        await require('node:stream/promises').pipeline(stream, fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
        const st = await fs.promises.stat(tmp);
        if (st.size !== M.sealedSize(r.bytes)) throw storageError('length_mismatch', 'the stored file has the wrong size');
      }
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
 * Plaintext bytes start…end of a file without a local copy: a readable file
 * straight from the target; a sealed one by its chunks (a target that reads
 * ranges) or through the cache.
 * @returns {AsyncGenerator<Buffer>}
 */
async function* readRemote(r, start, end) {
  const M = media();
  const d = await driverFor(r.target_id);
  if (r.stored_form === 'files') {
    const want = end - start + 1;
    const stream = await d.get(r.remote_key, { start, end });
    let got = 0;
    try {
      for await (const piece of stream) {
        const take = piece.length > want - got ? piece.subarray(0, want - got) : piece;
        got += take.length;
        if (take.length) yield take;
        if (got >= want) break;
      }
    } finally {
      if (typeof stream.destroy === 'function') stream.destroy();
    }
    if (got < want) { requestScan(r.plugin, r.area); throw storageError('changed', 'the file on the target is shorter than stored'); }
    return;
  }
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
  if (i <= last) throw storageError('length_mismatch', 'the stored file ended early');
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
    // a file lives under this key again (a readable file put back at its path): never delete it
    if (db().prepare('SELECT 1 FROM plugin_media WHERE target_id = ? AND remote_key = ? LIMIT 1').get(g.target_id, g.remote_key)) {
      db().prepare('DELETE FROM plugin_media_gone WHERE id = ?').run(g.id);
      continue;
    }
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
function sealedSource(r) {
  const M = media();
  const file = M.fileOf(r.plugin, r.id);
  return { length: M.sealedSize(r.bytes), open: (s, e) => fs.createReadStream(file, { start: s, end: e }) };
}

/** The plaintext of `r` (decrypted from its local sealed file) as a source for driver.put. */
function plainSource(r) {
  const M = media();
  const local = { ...r, local: 1 };
  return { length: r.bytes, open: (s, e) => Readable.from(M.readRange(local, s, e)) };
}

/**
 * Bring one file to where its area wants it: `want` (target, null = this
 * server), `form`, r.want_key. A rename on the same target when the form
 * stays, else a copy (old copy deleted afterwards).
 */
async function transfer(r, want, form) {
  const M = media();
  const from = r.target_id == null ? null : r.target_id;
  const fromKey = r.remote_key;
  const wantKey = r.want_key;
  if (want == null) {
    if (r.local === 0) { try { await ensureLocal(r); } catch (e) { if (e && typeof e === 'object') e.side = 'source'; throw e; } }
    const ok = db().prepare(`UPDATE plugin_media SET target_id = NULL, remote_key = NULL, stored_form = NULL, nonce_prefix = NULL, remote_size = NULL,
      remote_mtime = NULL, missing_since = NULL, local = 1, push_error = NULL WHERE id = ? AND target_id IS ? AND remote_key IS ?`).run(r.id, from, fromKey);
    if (ok.changes) gone(from, fromKey);
    return;
  }
  const d = await driverFor(want);
  if (form === 'files' && !d.files) throw storageError('failed', 'this storage target holds no readable files');
  if (from === want && fromKey && r.stored_form === form && typeof d.move === 'function') {
    // same target, same form: rename (instant, no bytes travel)
    await d.move(fromKey, wantKey);
    const ok = db().prepare(`UPDATE plugin_media SET remote_key = ?, remote_mtime = NULL, missing_since = NULL, push_error = NULL
      WHERE id = ? AND target_id IS ? AND remote_key IS ?`).run(wantKey, r.id, from, fromKey);
    if (!ok.changes) gone(want, wantKey); // deleted meanwhile
    noteSuccess(want);
    return;
  }
  let cur = r;
  if (cur.local === 0) {
    try { cur = await ensureLocal(cur); } catch (e) { if (e && typeof e === 'object') e.side = 'source'; throw e; }
  }
  if (form === 'files' && await d.head(wantKey)) {
    // somebody put a file there on the target: the next scan takes it in (as a conflict copy)
    requestScan(r.plugin, r.area);
    throw storageError('exists', 'a file of the same name is on the target');
  }
  const src = form === 'files' ? plainSource(cur) : sealedSource(cur);
  await d.put(wantKey, src);
  const h = await d.head(wantKey);
  if (!h || h.size !== src.length) throw storageError('length_mismatch', 'the copy on the target has the wrong size');
  let prefix = null;
  if (form === 'blocks') {
    const head = Buffer.alloc(M._sealed.HEADER_LEN);
    const fh = await fs.promises.open(M.fileOf(cur.plugin, cur.id), 'r');
    try { await fh.read(head, 0, head.length, 0); } finally { await fh.close(); }
    prefix = head.subarray(M._sealed.MAGIC_LEN).toString('hex');
  }
  const ok = db().prepare(`UPDATE plugin_media SET target_id = ?, remote_key = ?, stored_form = ?, nonce_prefix = ?, remote_size = ?, remote_mtime = NULL,
    missing_since = NULL, push_error = NULL, accessed_at = COALESCE(accessed_at, ?)
    WHERE id = ? AND target_id IS ? AND remote_key IS ? AND want_key IS ?`).run(want, wantKey, form, prefix, src.length, nowIso(), r.id, from, fromKey, wantKey);
  if (!ok.changes) { gone(want, wantKey); return; } // deleted, moved or changed meanwhile: the copy goes again
  if (from != null && (from !== want || fromKey !== wantKey)) gone(from, fromKey);
  noteSuccess(want);
}

async function processTransfers(deadline) {
  // not while another file still sits under the wanted key, or its deletion is pending there
  const todo = db().prepare(`SELECT pm.*, ${WANT_SQL} AS want, a.form AS want_form FROM ${JOIN_SQL}
    WHERE pm.ref_count > 0 AND NOT ${IN_PLACE_SQL}
      AND NOT EXISTS (SELECT 1 FROM plugin_media o WHERE o.id <> pm.id AND o.target_id IS ${WANT_SQL} AND o.remote_key = pm.want_key)
      AND NOT EXISTS (SELECT 1 FROM plugin_media_gone g WHERE g.target_id IS ${WANT_SQL} AND g.remote_key = pm.want_key)
    ORDER BY pm.created_at LIMIT 200`).all();
  for (const r of todo) {
    if (Date.now() > deadline) return;
    const want = r.want == null ? null : r.want;
    if (want != null && !healthy(want)) continue;
    if (r.local === 0 && r.target_id != null && !healthy(r.target_id)) continue;
    try {
      await transfer(r, want, want == null ? 'blocks' : r.want_form);
    } catch (e) {
      const which = e && e.side === 'source' ? r.target_id : want;
      db().prepare('UPDATE plugin_media SET push_error = ? WHERE id = ?').run(String((e && e.code) || 'failed'), r.id);
      if (isTargetError(e) && which != null) noteFailure(which, e);
      else logger.warn({ plugin: r.plugin, media: r.id, err: e && e.message }, 'plugin media areas: copy failed');
      // a file in the way on the target: the scan takes it in as a conflict copy, then this one goes there
      if (e && e.code === 'exists') requestScan(r.plugin, r.area);
    }
  }
}

function finishMoves() {
  const moving = db().prepare('SELECT * FROM plugin_media_areas WHERE moving = 1').all();
  for (const a of moving) {
    if (pendingOf(a.plugin, a.area).count) continue;
    db().prepare("UPDATE plugin_media_areas SET target_id = moving_to, moving = 0, moving_to = NULL, updated_at = datetime('now') WHERE plugin = ? AND area = ? AND moving = 1")
      .run(a.plugin, a.area);
    try {
      require('../activity').log('plugin_media_area_moved', `Plugin "${a.plugin}": area "${a.label}" moved`, {
        source: 'system', severity: 'info', details: { plugin: a.plugin, area: a.area, targetId: a.moving_to, form: a.form },
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
  const pending = db().prepare(`SELECT COALESCE(SUM(pm.bytes), 0) AS b FROM ${JOIN_SQL} WHERE pm.local = 1 AND NOT ${IN_PLACE_SQL}`).get().b;
  return { cached, pending, limit: cacheLimit(), default: CACHE_DEFAULT };
}

/** Drop the least recently used local copies of remote files until the cache fits. → files dropped. */
function evict() {
  const limit = cacheLimit();
  let used = cacheStats().cached;
  if (used <= limit) return 0;
  const cands = db().prepare(`SELECT pm.id, pm.plugin, pm.bytes FROM ${JOIN_SQL}
    WHERE pm.local = 1 AND pm.target_id IS NOT NULL AND ${IN_PLACE_SQL}
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

// ─── Changes made on the target (form 'files') ──

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', xml: 'application/xml',
  html: 'text/html', htm: 'text/html', rtf: 'application/rtf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', doc: 'application/msword', xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
};

function extOf(p) { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(p || '')); return m ? m[1].toLowerCase() : ''; }

/** A file found on the target: its type from the extension (application/octet-stream when unknown). */
function mimeOf(p) { return MIME_BY_EXT[extOf(p)] || 'application/octet-stream'; }

/** "Fotos/a.jpg" → "Fotos/a (Konflikt 2026-10-26 120005).jpg" */
function conflictPath(p, now = new Date()) {
  const slash = p.lastIndexOf('/');
  const dir = slash >= 0 ? p.slice(0, slash + 1) : '';
  const name = p.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stamp = now.toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '');
  return dot > 0 ? `${dir}${name.slice(0, dot)} (Konflikt ${stamp})${name.slice(dot)}` : `${dir}${name} (Konflikt ${stamp})`;
}

/**
 * Take a readable file found on the target into the area as a new media
 * file (claimed, read once for size and SHA-256 — no local copy; it is read
 * from the target). `like`: the file it replaces (owner, name, type kept).
 * → the new row, or null when it changed while being read.
 */
async function importRemote(a, d, entry, p, like) {
  const M = media();
  const id = crypto.randomBytes(16).toString('hex');
  const key = crypto.randomBytes(32);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const stream = await d.get(entry.key, null);
  try {
    for await (const c of stream) { hash.update(c); bytes += c.length; }
  } finally { if (typeof stream.destroy === 'function') stream.destroy(); }
  if (bytes !== entry.size || bytes < 1) return null;
  const mime = like && extOf(like.path || like.version_of) === extOf(p) ? like.mime : mimeOf(p);
  const r = { id, plugin: a.plugin, path: p, version_of: null };
  const now = nowIso();
  db().prepare(`INSERT INTO plugin_media (id, plugin, owner_user_id, mime, bytes, sha256, created_at, ref_count, claimed_at, key_enc, name,
    area, path, target_id, remote_key, want_key, stored_form, remote_size, remote_mtime, local)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'files', ?, ?, 0)`).run(id, a.plugin, like ? like.owner_user_id : null, mime, bytes,
    hash.digest('hex'), now, now, M._wrapKey(key, id), like ? like.name : null, a.area, p, a.target_id, entry.key, wantKeyOf(r, a), bytes,
    entry.mtime == null ? null : entry.mtime);
  return freshRow(id);
}

function journal(a, type, mediaId, previousId, p) {
  return db().prepare('INSERT INTO plugin_media_changes (plugin, area, type, media_id, previous_id, path, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(a.plugin, a.area, type, mediaId, previousId, p, nowIso()).lastInsertRowid;
}

/**
 * A file changed on the target: the new content becomes a new media file
 * at the path; the old one a version of it when its bytes are still here
 * (a local copy; the worker puts it into .gcdrive/versions), else it is gone.
 */
async function takeChanged(a, d, r, entry, out) {
  const p = r.path;
  const keep = r.local === 1 && fs.existsSync(media().fileOf(r.plugin, r.id));
  // free the path and the key first
  db().prepare(`UPDATE plugin_media SET path = NULL, version_of = ?, version_at = ?, target_id = NULL, remote_key = NULL, stored_form = NULL,
    nonce_prefix = NULL, remote_size = NULL, remote_mtime = NULL, missing_since = NULL WHERE id = ?`).run(p, nowIso(), r.id);
  let fresh;
  try { fresh = await importRemote(a, d, entry, p, r); } catch (e) {
    // put the old file back as it was
    db().prepare(`UPDATE plugin_media SET path = ?, version_of = NULL, version_at = NULL, target_id = ?, remote_key = ?, stored_form = 'files',
      remote_size = ?, remote_mtime = ? WHERE id = ?`).run(p, a.target_id, r.remote_key, r.remote_size, r.remote_mtime, r.id);
    throw e;
  }
  if (!fresh) {
    db().prepare(`UPDATE plugin_media SET path = ?, version_of = NULL, version_at = NULL, target_id = ?, remote_key = ?, stored_form = 'files',
      remote_size = ?, remote_mtime = ? WHERE id = ?`).run(p, a.target_id, r.remote_key, r.remote_size, r.remote_mtime, r.id);
    return;
  }
  if (keep) setWant(r.id);
  else media().forget(r.plugin, r.id);
  out.push({ type: 'changed', mediaId: fresh.id, previous: keep ? r.id : null, path: p, seq: journal(a, 'changed', fresh.id, keep ? r.id : null, p) });
}

const scanning = new Map(); // "plugin/area" → Promise

/** A scan of the area soon (a readable file was not what was stored). */
function requestScan(pluginId, area) {
  if (pluginId == null || area == null) return;
  db().prepare('UPDATE plugin_media_areas SET scanned_at = NULL WHERE plugin = ? AND area = ?').run(pluginId, area);
  kick();
}

/**
 * Look for changes made on the target of a readable area (form 'files'):
 *   * a file with another size or time → changed (takeChanged);
 *   * a new file → taken in as a new media file at its path (a file the
 *     area still wants to put there → the new one becomes a conflict copy);
 *   * a missing file → marked, and removed when it is still missing at the
 *     next scan — unless more than MASS_MIN and MASS_SHARE of the area's
 *     files go at once (scan error mass_missing until the administrator
 *     confirms).
 * Files changed in the last minute wait for the next scan. Every change goes
 * into the journal (gc.media.areas.changes) and the plugin's hook
 * mediaChanged({ area, seq }) is called. → { files, added, changed, removed,
 * missing } or null when the area is not scanned (other form, moving, …).
 */
function scanArea(pluginId, area) {
  const k = `${pluginId}/${area}`;
  if (scanning.has(k)) return scanning.get(k);
  const p = doScan(pluginId, area).finally(() => scanning.delete(k));
  scanning.set(k, p);
  return p;
}

async function doScan(pluginId, area) {
  const a = rowOf(pluginId, area);
  if (!a || a.form !== 'files' || a.target_id == null || a.moving) return null;
  const setScan = (error, stats) => db().prepare(`UPDATE plugin_media_areas SET scanned_at = ?, scan_error = ?, scan_stats = ?
    WHERE plugin = ? AND area = ?`).run(nowIso(), error, stats ? JSON.stringify(stats) : a.scan_stats, pluginId, area);
  let d;
  let entries;
  try {
    d = await driverFor(a.target_id);
    if (typeof d.list !== 'function') return null;
    entries = await d.list(rootOf(pluginId, area));
  } catch (e) {
    if (isTargetError(e)) noteFailure(a.target_id, e);
    setScan(String((e && e.code) || 'failed'), null);
    return null;
  }
  noteSuccess(a.target_id);
  const started = Date.now();
  const root = rootOf(pluginId, area) + '/';
  const tomb = new Set(db().prepare('SELECT remote_key FROM plugin_media_gone WHERE target_id = ?').all(a.target_id).map((g) => g.remote_key));
  const mine = db().prepare("SELECT * FROM plugin_media WHERE plugin = ? AND area = ? AND target_id = ? AND stored_form = 'files' AND remote_key IS NOT NULL")
    .all(pluginId, area, a.target_id);
  const byKey = new Map(mine.map((r) => [r.remote_key, r]));
  const wanted = new Set(db().prepare('SELECT want_key FROM plugin_media WHERE plugin = ? AND area = ? AND want_key IS NOT NULL AND NOT (target_id IS ? AND remote_key IS want_key)')
    .all(pluginId, area, a.target_id).map((r) => r.want_key));
  const seen = new Set();
  const changed = [];
  const added = [];
  for (const e of entries) {
    if (!e.key.startsWith(root)) continue;
    const r = byKey.get(e.key);
    if (r) seen.add(e.key);
    const rel = e.key.slice(root.length);
    if (rel.startsWith(HIDDEN + '/') || tomb.has(e.key)) continue;
    if (e.mtime != null && started - e.mtime < SCAN_SETTLE_MS) continue;
    if (r) {
      if (r.remote_mtime == null) {
        // first look after our own upload: adopt the target's time
        if (e.size === r.remote_size) db().prepare('UPDATE plugin_media SET remote_mtime = ? WHERE id = ?').run(e.mtime, r.id);
        else changed.push([r, e]);
      } else if (e.size !== r.remote_size || (e.mtime != null && Math.abs(e.mtime - r.remote_mtime) > MTIME_SLACK_MS)) {
        changed.push([r, e]);
      }
      continue;
    }
    added.push([e, rel]);
  }
  // missing: marked now, removed when still missing at the next scan
  const missing = mine.filter((r) => !seen.has(r.remote_key));
  const toRemove = missing.filter((r) => r.missing_since != null);
  db().transaction(() => {
    const mark = db().prepare('UPDATE plugin_media SET missing_since = ? WHERE id = ?');
    for (const r of missing) if (r.missing_since == null) mark.run(nowIso(), r.id);
    const clear = db().prepare('UPDATE plugin_media SET missing_since = NULL WHERE id = ?');
    for (const r of mine) if (r.missing_since != null && seen.has(r.remote_key)) clear.run(r.id);
  })();
  const out = [];
  let error = null;
  const massLimit = Math.max(MASS_MIN, Math.floor(mine.length * MASS_SHARE));
  if (toRemove.length > massLimit && !a.confirm_removals) {
    error = 'mass_missing';
  } else {
    for (const r of toRemove) {
      media().forget(pluginId, r.id);
      const pth = r.path != null ? r.path : r.version_of;
      out.push({ type: 'removed', mediaId: r.id, path: pth, version: r.version_of != null, seq: journal(a, 'removed', r.id, null, pth) });
    }
    if (a.confirm_removals) db().prepare('UPDATE plugin_media_areas SET confirm_removals = 0 WHERE plugin = ? AND area = ?').run(pluginId, area);
  }
  let imports = 0;
  for (const [r, e] of changed) {
    if (Date.now() - started > SCAN_BUDGET_MS || imports >= SCAN_MAX_IMPORTS) break;
    try { await takeChanged(a, d, r, e, out); imports++; } catch (err) {
      logger.warn({ plugin: pluginId, area, key: e.key, err: err.message }, 'plugin media areas: taking a changed file failed');
    }
  }
  for (const [e, rel] of added) {
    if (Date.now() - started > SCAN_BUDGET_MS || imports >= SCAN_MAX_IMPORTS) break;
    let pth;
    try { pth = cleanPath(rel); } catch { continue; }
    try {
      let entry = e;
      if (wanted.has(e.key) || pathTaken(pluginId, area, pth, '')) {
        // the area still wants to put one of its files there: keep this one as a conflict copy
        const cp = conflictPath(pth);
        if (typeof d.move !== 'function') continue;
        await d.move(e.key, root + cp);
        entry = { ...e, key: root + cp };
        pth = cp;
      }
      const fresh = await importRemote(a, d, entry, pth, null);
      if (!fresh) continue;
      imports++;
      out.push({ type: 'added', mediaId: fresh.id, previous: null, path: pth, seq: journal(a, 'added', fresh.id, null, pth) });
    } catch (err) {
      logger.warn({ plugin: pluginId, area, key: e.key, err: err.message }, 'plugin media areas: taking a new file failed');
    }
  }
  const stats = { files: entries.length, added: out.filter((c) => c.type === 'added').length, changed: out.filter((c) => c.type === 'changed').length,
    removed: out.filter((c) => c.type === 'removed').length, missing: missing.length - toRemove.length + (error ? toRemove.length : 0) };
  setScan(error, stats);
  db().prepare('DELETE FROM plugin_media_changes WHERE at < ?').run(new Date(Date.now() - CHANGES_KEEP_MS).toISOString());
  if (out.length) {
    const seq = out[out.length - 1].seq;
    require('./runtime').call(pluginId, 'mediaChanged', { area, seq, count: out.length }, 10000).catch(() => { /* not running: the journal waits */ });
    kick();
  }
  return stats;
}

/** gc.media.areas.changes(area, { since, limit }) → { changes: [{ seq, type, mediaId, previous, path, at }], next, more }. */
function changes(pluginId, area, { since = 0, limit = 500 } = {}) {
  if (!rowOf(pluginId, area)) throw new AreaError('invalid', 'unknown area');
  const s = Number.isSafeInteger(since) && since >= 0 ? since : 0;
  const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, CHANGES_PAGE_MAX) : 500;
  const list = db().prepare('SELECT * FROM plugin_media_changes WHERE plugin = ? AND area = ? AND seq > ? ORDER BY seq LIMIT ?').all(pluginId, area, s, n + 1);
  const more = list.length > n;
  const page = list.slice(0, n).map((c) => ({ seq: c.seq, type: c.type, mediaId: c.media_id, previous: c.previous_id, path: c.path, at: c.at }));
  return { changes: page, next: page.length ? page[page.length - 1].seq : s, more };
}

/** Areas due for a scan (form 'files', on a target, not moving, healthy, last scan ≥ 15 min ago). */
function scansDue(now = Date.now()) {
  const due = db().prepare("SELECT plugin, area, target_id, scanned_at FROM plugin_media_areas WHERE form = 'files' AND target_id IS NOT NULL AND moving = 0").all();
  return due.filter((a) => healthy(a.target_id, now) && (!a.scanned_at || now - Date.parse(a.scanned_at) >= SCAN_EVERY_MS));
}

let scanRun = null;
/** Start the due scans one after another in the background (never awaited by tick). */
function startScans() {
  if (scanRun) return;
  const due = scansDue();
  if (!due.length) return;
  scanRun = (async () => {
    for (const a of due) {
      try { await scanArea(a.plugin, a.area); } catch (e) { logger.warn({ plugin: a.plugin, area: a.area, err: e.message }, 'plugin media areas: scan failed'); }
    }
  })().finally(() => { scanRun = null; });
}

/** One run of the worker: deletions, copies, finished moves, the cache, due scans. */
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
      if (timer) { try { startScans(); } catch (e) { logger.warn({ err: e.message }, 'plugin media areas: scans failed'); } }
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
  db().prepare('DELETE FROM plugin_media_changes WHERE plugin = ?').run(pluginId);
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
 * stored_form, version_of, …, key }] } (key: the file key encrypted with
 * GC_ENCRYPTION_KEY, like media backups). Always part of the backup (also
 * without "Plugin-Medien im Backup"): the plugin's data names these ids.
 */
function exportAreas(pluginId) {
  const { encrypt } = require('../../utils/crypto');
  const M = media();
  const areas = rows(pluginId).map((a) => ({ area: a.area, label: a.label, target_id: a.target_id, form: a.form, moving: a.moving, moving_to: a.moving_to,
    quota_bytes: a.quota_bytes, admin_quota_bytes: a.admin_quota_bytes }));
  const files = db().prepare('SELECT * FROM plugin_media WHERE plugin = ? AND area IS NOT NULL AND ref_count > 0').all(pluginId).map((r) => ({
    id: r.id, area: r.area, path: r.path, target_id: r.target_id, remote_key: r.remote_key, stored_form: r.stored_form, nonce_prefix: r.nonce_prefix,
    version_of: r.version_of, version_at: r.version_at, remote_size: r.remote_size, remote_mtime: r.remote_mtime,
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
  const insA = db().prepare(`INSERT OR REPLACE INTO plugin_media_areas (plugin, area, label, target_id, form, moving, moving_to, quota_bytes, admin_quota_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const int = (v) => (Number.isSafeInteger(v) ? v : null);
  const optPath = (v) => { try { return cleanPath(v); } catch { return null; } };
  for (const a of Array.isArray(data.areas) ? data.areas : []) {
    if (!a || !AREA_RE.test(String(a.area))) continue;
    const tid = int(a.target_id);
    const target = tid != null && targets().rowOf(tid) ? tid : null;
    insA.run(pluginId, a.area, cleanLabel(a.label, a.area), target, target != null && a.form === 'files' && filesCapable(target) ? 'files' : 'blocks',
      a.moving ? 1 : 0, int(a.moving_to), int(a.quota_bytes), int(a.admin_quota_bytes));
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
      const form = tid == null ? null : (e.stored_form === 'files' ? 'files' : 'blocks');
      db().prepare(`INSERT OR REPLACE INTO plugin_media (id, plugin, owner_user_id, mime, bytes, sha256, created_at, ref_count, claimed_at, key_enc, name,
        area, path, target_id, remote_key, stored_form, nonce_prefix, version_of, version_at, remote_size, remote_mtime, local)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(e.id, pluginId, int(e.owner_user_id), M.baseType(e.mime), e.bytes, e.sha256, typeof e.created_at === 'string' ? e.created_at : nowIso(),
          typeof e.claimed_at === 'string' ? e.claimed_at : nowIso(), M._wrapKey(key, e.id), M.cleanName(e.name), e.area, optPath(e.path),
          tid, tid == null ? null : String(e.remote_key || ''), form,
          typeof e.nonce_prefix === 'string' && /^[0-9a-f]{16}$/.test(e.nonce_prefix) ? e.nonce_prefix : null,
          e.path == null ? optPath(e.version_of) : null, typeof e.version_at === 'string' ? e.version_at : null,
          tid == null ? null : int(e.remote_size), tid == null ? null : int(e.remote_mtime), local ? 1 : 0);
      setWant(e.id);
      n++;
    } catch (err) {
      logger.warn({ plugin: pluginId, err: err.message }, 'plugin media areas: restore of a file failed');
    }
  }
  kick();
  return n;
}

module.exports = {
  AreaError, AREA_RE, FORMS, CACHE_SETTING, CACHE_DEFAULT, CACHE_MIN, CACHE_MAX, ALERT_AFTER_MS, SCAN_SETTLE_MS, MASS_MIN,
  declared, rowOf, rows, ensure, remove, info, list, setTarget, setAdminQuota, confirmRemovals, effectiveTarget, cleanPath, claimInto, move, version, stateOf,
  wantKeyOf, versionName, conflictPath, mimeOf,
  ensureLocal, readRemote, touch, gone, kick, tick, start, stop, transfer, evict, cacheLimit, setCacheLimit, cacheStats, capacityCheck,
  scanArea, changes, requestScan, scansDue,
  removeAllOf, usageProvider, exportAreas, importAreas, healthy, noteFailure, noteSuccess,
  _setDriverForTest: (fn) => { driverOverride = fn; drivers.clear(); },
  _resetHealthForTest: () => { health.clear(); },
  _health: health,
};
