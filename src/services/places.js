'use strict';

// "Meine Orte" (docs/feature-user-profile.md "Meine Orte"): a person's places in the user profile — kept once, offered
// by every plugin and app. Plugins keep only the reference 'profile:<id>' (gc.places), never a copy: a moved point or
// a new radius counts everywhere at once.
//
//   place        name (1–60, unique per person without regard to case), icon, lat / lon (always set, valid, never
//                0/0), radiusM (50–2000, default 150), address (optional, ≤ 200), visibility (self / family / all —
//                the levels of the profile's fields: "Familie" is a GateControl group of the kind family both belong
//                to), source (manual / notizen / familie / messenger) and sourceRef (gc.places.importFor). At most
//                MAX_PLACES per person.
//   usedBy       "Genutzt von": plugins report what they keep at a place (gc.places.reportUsage → user_place_usage,
//                plugin + kind + count). A place in use is only deleted with force.
//   events       after every change: the hook placesChanged { userId, ids, deleted } to running plugins with
//                permissions.places, and the control event `places` { ids, deleted } to the owner's apps (push
//                stream). Never a name or a coordinate in either.
//   log          the activity log names the place's id, never its name, address or coordinates.
//
// The server never learns where a person is: the apps check arriving and leaving themselves. A search near a position
// goes through services/placeSearch.js, which rounds that position first.

const { getDb } = require('../db/connection');
const activity = require('./activity');
const logger = require('../utils/logger');

const ICONS = Object.freeze(['home', 'work', 'school', 'gym', 'shop', 'family', 'pin']);
const VISIBILITY = Object.freeze(['self', 'family', 'all']);
const SOURCES = Object.freeze(['manual', 'notizen', 'familie', 'messenger']);
const MAX_PLACES = 100;
const NAME_MAX = 60;
const ADDRESS_MAX = 200;
const RADIUS_MIN = 50;
const RADIUS_MAX = 2000;
const RADIUS_DEFAULT = 150;
const SOURCE_REF_MAX = 120;
const IMPORT_MAX = 100;
const KIND_RE = /^[a-z][a-z0-9_.-]{0,39}$/;
const USAGE_MAX = 1000000;
const REF_RE = /^profile:([1-9][0-9]{0,15})$/;

class PlaceError extends Error {
  constructor(code, message, field) { super(message || code); this.code = code; if (field) this.field = field; }
}
// the texts of the endpoints (routes/api/profileApi.js): myprofile.places.err.<code> / invalid_<field>
PlaceError.prototype.i18nPrefix = 'myprofile.places.err.';
const invalid = (field, message) => new PlaceError('ERR_INVALID', message || `${field}: invalid`, field);

// ─── Values ──────────────────────────────────────────────────────

function text(v, max, field, { required = false } = {}) {
  if (v === null || v === undefined || v === '') { if (required) throw invalid(field); return null; }
  if (typeof v !== 'string') throw invalid(field);
  const s = v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) { if (required) throw invalid(field); return null; }
  if (Array.from(s).length > max) throw invalid(field, `${field}: at most ${max} characters`);
  return s;
}

/** A coordinate: a finite number (or its decimal string) within ±limit, rounded to 6 decimals (≈ 0.1 m). */
function coord(v, limit, field) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.length <= 24 && /^-?[0-9.]+$/.test(v.trim()) ? Number(v.trim()) : NaN);
  if (!Number.isFinite(n) || Math.abs(n) > limit) throw invalid(field);
  return Math.round(n * 1e6) / 1e6;
}

function radius(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d{1,5}\s*$/.test(v) ? Number(v) : NaN);
  if (!Number.isFinite(n)) throw invalid('radiusM');
  const r = Math.round(n);
  if (r < RADIUS_MIN || r > RADIUS_MAX) throw invalid('radiusM', `radiusM: ${RADIUS_MIN}–${RADIUS_MAX}`);
  return r;
}

/**
 * The fields of a place from a request: every key optional with `partial`, else name and lat / lon required. Unknown
 * keys are refused. → { name?, name_lc?, icon?, lat?, lon?, radius_m?, address?, visibility? }
 */
function fields(input, { partial }) {
  const p = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!p) throw invalid('body');
  const known = new Set(['name', 'icon', 'lat', 'lon', 'radiusM', 'address', 'visibility']);
  for (const k of Object.keys(p)) if (!known.has(k)) throw invalid(k, `${k}: unknown field`);
  const out = {};
  if (!partial || p.name !== undefined) {
    out.name = text(p.name, NAME_MAX, 'name', { required: true });
    out.name_lc = out.name.toLowerCase();
  }
  if (p.icon !== undefined) {
    if (!ICONS.includes(p.icon)) throw invalid('icon');
    out.icon = p.icon;
  } else if (!partial) out.icon = 'pin';
  if (!partial || p.lat !== undefined || p.lon !== undefined) {
    // a point is always the pair — never one half of it
    if (p.lat === undefined || p.lon === undefined || p.lat === null || p.lon === null) throw invalid(p.lat == null ? 'lat' : 'lon', 'a place needs its point on the map (lat and lon)');
    out.lat = coord(p.lat, 90, 'lat');
    out.lon = coord(p.lon, 180, 'lon');
    if (out.lat === 0 && out.lon === 0) throw invalid('lat', 'lat/lon 0/0 is no place');
  }
  if (p.radiusM !== undefined) out.radius_m = radius(p.radiusM);
  else if (!partial) out.radius_m = RADIUS_DEFAULT;
  if (p.address !== undefined) out.address = text(p.address, ADDRESS_MAX, 'address');
  if (p.visibility !== undefined) {
    if (!VISIBILITY.includes(p.visibility)) throw invalid('visibility');
    out.visibility = p.visibility;
  } else if (!partial) out.visibility = 'self';
  return out;
}

// ─── Rows ────────────────────────────────────────────────────────

const COLS = 'id, user_id, name, name_lc, icon, lat, lon, radius_m, address, visibility, source, source_ref, created_at, updated_at, last_used_at';

function positive(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^[1-9][0-9]{0,15}$/.test(v) ? Number(v) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function userOf(userId) {
  const id = positive(userId);
  if (!id) return null;
  return getDb().prepare('SELECT id, username, display_name, enabled FROM users WHERE id = ?').get(id) || null;
}
function needUser(userId) {
  const u = userOf(userId);
  if (!u) throw new PlaceError('ERR_NOT_FOUND', 'unknown user');
  return u;
}

function rowsOf(userId) {
  return getDb().prepare(`SELECT ${COLS} FROM user_places WHERE user_id = ? ORDER BY name_lc, id`).all(userId);
}
function rowById(id) {
  const n = positive(id);
  return n ? getDb().prepare(`SELECT ${COLS} FROM user_places WHERE id = ?`).get(n) || null : null;
}
/** The person's own place, or ERR_NOT_FOUND (also for somebody else's — never "exists, not yours"). */
function ownRow(userId, placeId) {
  const r = rowById(placeId);
  if (!r || r.user_id !== Number(userId)) throw new PlaceError('ERR_NOT_FOUND', 'unknown place');
  return r;
}

/** "Genutzt von" of these places → Map(placeId → [{ plugin, pluginName, kind, count }]) — only plugins still installed. */
function usageOf(ids, lang) {
  const out = new Map();
  if (!ids.length) return out;
  let installed = null;
  try {
    installed = new Map(require('./plugins/registry').list().map((p) => {
      const n = p.manifest && p.manifest.name;
      return [p.id, n && typeof n === 'object' ? (n[lang] || n.de || n.en || p.id) : (typeof n === 'string' ? n : p.id)];
    }));
  } catch { installed = null; }
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rows = getDb().prepare(`SELECT place_id, plugin, kind, count FROM user_place_usage WHERE count > 0 AND place_id IN (${part.map(() => '?').join(',')})
      ORDER BY plugin, kind`).all(...part);
    for (const r of rows) {
      if (installed && !installed.has(r.plugin)) continue;
      if (!out.has(r.place_id)) out.set(r.place_id, []);
      out.get(r.place_id).push({ plugin: r.plugin, pluginName: installed ? installed.get(r.plugin) : r.plugin, kind: r.kind, count: r.count });
    }
  }
  return out;
}

/** The answer form of a place (docs/feature-user-profile.md "Meine Orte"). `usedBy` only where given. */
function view(r, usedBy, extra) {
  return {
    id: r.id,
    ref: `profile:${r.id}`,
    name: r.name,
    icon: r.icon,
    lat: r.lat,
    lon: r.lon,
    radiusM: r.radius_m,
    address: r.address || null,
    visibility: r.visibility,
    source: r.source,
    ...(usedBy ? { usedBy } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastUsedAt: r.last_used_at || null,
    ...(extra || {}),
  };
}

function hasFamily(userId) {
  try { return require('./groups').groupsOfUser(userId).some((g) => g.kind === 'family'); } catch { return false; }
}

// ─── Events and log ──────────────────────────────────────────────

/**
 * After a change: the hook placesChanged { userId, ids, deleted } to running plugins with permissions.places, and the
 * control event `places` { ids, deleted } to the owner's open app streams. Never a value.
 */
function emitChanged(userId, ids, { deleted = false, exceptToken = null } = {}) {
  const list = [...new Set((ids || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
  if (!list.length) return;
  const payload = { userId: Number(userId), ids: list, deleted: !!deleted };
  try { require('./notify/control').placesChanged({ userId: payload.userId, ids: list, deleted: payload.deleted, exceptToken }); } catch (err) {
    logger.debug({ err: err.message }, 'places: control event not sent');
  }
  setImmediate(() => {
    let rows;
    try { rows = require('./plugins/registry').list(); } catch { return; }
    for (const p of rows) {
      const perms = p.manifest && p.manifest.permissions;
      if (!p.enabled || !perms || perms.places !== true) continue;
      try {
        const rt = require('./plugins/runtime');
        if (rt.info(p.id).state !== 'running') continue;
        rt.call(p.id, 'placesChanged', payload, 10000).catch(() => {});
      } catch { /* the plugin reads them at its next request */ }
    }
  });
}

const LOG_TEXT = {
  place_added: 'Ort angelegt',
  place_changed: 'Ort geändert',
  place_removed: 'Ort gelöscht',
  places_imported: 'Orte übernommen',
};
function log(type, userId, ctx, extra) {
  try {
    activity.log(type, LOG_TEXT[type] || type, {
      source: ctx && ctx.source ? ctx.source : 'user', ipAddress: ctx && ctx.ip ? ctx.ip : null, severity: 'info',
      details: { userId, ...(ctx && ctx.actorId && ctx.actorId !== userId ? { by: ctx.actorId } : {}), ...(extra || {}) },
    });
  } catch (err) { logger.debug({ err: err.message }, 'places: activity not written'); }
}

function uniqueViolation(err) { return err && /UNIQUE constraint failed: user_places\.user_id, user_places\.name_lc/.test(String(err.message)); }

// ─── The person's own places ─────────────────────────────────────

/**
 * listOwn(userId, { lang }) → { places, family, limits, options } — the person's own places with "Genutzt von".
 */
function listOwn(userId, { lang = 'de' } = {}) {
  const u = needUser(userId);
  const rows = rowsOf(u.id);
  const usage = usageOf(rows.map((r) => r.id), lang);
  return {
    places: rows.map((r) => view(r, usage.get(r.id) || [])),
    family: hasFamily(u.id),
    limits: { places: MAX_PLACES, name: NAME_MAX, address: ADDRESS_MAX, radius: { min: RADIUS_MIN, max: RADIUS_MAX, default: RADIUS_DEFAULT } },
    options: { icons: [...ICONS], visibility: [...VISIBILITY] },
  };
}

/** getOwn(userId, placeId, { lang }) → place with usedBy (ERR_NOT_FOUND for somebody else's). */
function getOwn(userId, placeId, { lang = 'de' } = {}) {
  const r = ownRow(userId, placeId);
  return view(r, usageOf([r.id], lang).get(r.id) || []);
}

/**
 * create(userId, input, ctx) → place. input: { name, lat, lon, icon?, radiusM?, address?, visibility? }.
 * ctx: { ip, source: 'user' | 'api' | 'plugin', actorId, exceptToken, placeSource?, sourceRef? }.
 * @throws {PlaceError} ERR_INVALID (field) | ERR_LIMIT | ERR_DUPLICATE (field name) | ERR_NOT_FOUND
 */
function create(userId, input, ctx = {}) {
  const u = needUser(userId);
  const f = fields(input, { partial: false });
  const db = getDb();
  const source = SOURCES.includes(ctx.placeSource) ? ctx.placeSource : 'manual';
  const sourceRef = typeof ctx.sourceRef === 'string' && ctx.sourceRef ? ctx.sourceRef : null;
  let id;
  const tx = db.transaction(() => {
    if (db.prepare('SELECT COUNT(*) AS n FROM user_places WHERE user_id = ?').get(u.id).n >= MAX_PLACES) throw new PlaceError('ERR_LIMIT', `at most ${MAX_PLACES} places`);
    if (db.prepare('SELECT 1 FROM user_places WHERE user_id = ? AND name_lc = ?').get(u.id, f.name_lc)) throw new PlaceError('ERR_DUPLICATE', 'a place of this name exists', 'name');
    id = Number(db.prepare(`INSERT INTO user_places (user_id, name, name_lc, icon, lat, lon, radius_m, address, visibility, source, source_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(u.id, f.name, f.name_lc, f.icon, f.lat, f.lon, f.radius_m, f.address, f.visibility, source, sourceRef).lastInsertRowid);
  });
  try { tx(); } catch (err) {
    if (uniqueViolation(err)) throw new PlaceError('ERR_DUPLICATE', 'a place of this name exists', 'name');
    throw err;
  }
  log('place_added', u.id, ctx, { placeId: id });
  emitChanged(u.id, [id], { exceptToken: ctx.exceptToken });
  return getOwn(u.id, id, ctx);
}

/** update(userId, placeId, patch, ctx) → place. The same fields as create, each optional (lat and lon only together). */
function update(userId, placeId, patch, ctx = {}) {
  const u = needUser(userId);
  const r = ownRow(u.id, placeId);
  const f = fields(patch, { partial: true });
  const cols = Object.keys(f);
  if (cols.length) {
    const db = getDb();
    if (f.name_lc !== undefined && f.name_lc !== r.name_lc
      && db.prepare('SELECT 1 FROM user_places WHERE user_id = ? AND name_lc = ? AND id <> ?').get(u.id, f.name_lc, r.id)) {
      throw new PlaceError('ERR_DUPLICATE', 'a place of this name exists', 'name');
    }
    try {
      db.prepare(`UPDATE user_places SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...cols.map((c) => f[c]), r.id);
    } catch (err) {
      if (uniqueViolation(err)) throw new PlaceError('ERR_DUPLICATE', 'a place of this name exists', 'name');
      throw err;
    }
    log('place_changed', u.id, ctx, { placeId: r.id, fields: cols.filter((c) => c !== 'name_lc') });
    emitChanged(u.id, [r.id], { exceptToken: ctx.exceptToken });
  }
  return getOwn(u.id, r.id, ctx);
}

/**
 * remove(userId, placeId, { force }, ctx) → { deleted: true }. A place that plugins still use (usedBy) is refused with
 * ERR_IN_USE (err.usedBy) unless force.
 */
function remove(userId, placeId, { force = false } = {}, ctx = {}) {
  const u = needUser(userId);
  const r = ownRow(u.id, placeId);
  const usedBy = usageOf([r.id], ctx.lang || 'de').get(r.id) || [];
  if (usedBy.length && !force) {
    const e = new PlaceError('ERR_IN_USE', 'the place is in use');
    e.usedBy = usedBy;
    throw e;
  }
  getDb().prepare('DELETE FROM user_places WHERE id = ?').run(r.id);
  log('place_removed', u.id, ctx, { placeId: r.id, ...(usedBy.length ? { force: true, usedBy: usedBy.map((x) => `${x.plugin}:${x.kind}`) } : {}) });
  emitChanged(u.id, [r.id], { deleted: true, exceptToken: ctx.exceptToken });
  return { deleted: true, id: r.id, usedBy };
}

/** markUsed(userId, placeId) → place — "zuletzt genutzt" (last_used_at, now). No event, no log. */
function markUsed(userId, placeId, ctx = {}) {
  const r = ownRow(userId, placeId);
  getDb().prepare("UPDATE user_places SET last_used_at = datetime('now') WHERE id = ?").run(r.id);
  return getOwn(r.user_id, r.id, ctx);
}

// ─── Who sees what (the profile's levels) ────────────────────────

/** How `viewerId` stands to `ownerId`: 'self' | 'family' | 'other'. */
function relation(viewerId, ownerId, cache) {
  if (viewerId === ownerId) return 'self';
  if (!viewerId) return 'other';
  if (cache && cache.has(ownerId)) return cache.get(ownerId);
  let rel = 'other';
  try { rel = require('./profile').sameFamily(viewerId, ownerId) ? 'family' : 'other'; } catch { rel = 'other'; }
  if (cache) cache.set(ownerId, rel);
  return rel;
}
const sees = (level, rel) => rel === 'self' || level === 'all' || (level === 'family' && rel === 'family');

/**
 * visibleTo(viewerId, { owner?, lang }) → the places `viewerId` may see: all own places, of other enabled accounts
 * those set to "Alle" and — when both belong to one family — "Familie". Others' places carry ownerId / ownerName and
 * no usedBy. owner narrows to one person.
 */
function visibleTo(viewerId, { owner = null, lang = 'de' } = {}) {
  const viewer = needUser(viewerId);
  const db = getDb();
  const ownerId = owner == null ? null : positive(owner);
  if (owner != null && !ownerId) throw invalid('owner');
  const rows = db.prepare(`SELECT ${COLS.split(', ').map((c) => 'p.' + c).join(', ')}, u.display_name AS owner_display, u.username AS owner_username
    FROM user_places p JOIN users u ON u.id = p.user_id
    WHERE (p.user_id = ? OR (u.enabled = 1 AND p.visibility IN ('family', 'all')))${ownerId ? ' AND p.user_id = ?' : ''}
    ORDER BY CASE WHEN p.user_id = ? THEN 0 ELSE 1 END, p.name_lc, p.id`).all(...(ownerId ? [viewer.id, ownerId, viewer.id] : [viewer.id, viewer.id]));
  const cache = new Map();
  const mine = rows.filter((r) => r.user_id === viewer.id);
  const usage = usageOf(mine.map((r) => r.id), lang);
  const out = [];
  for (const r of rows) {
    const rel = relation(viewer.id, r.user_id, cache);
    if (!sees(r.visibility, rel)) continue;
    if (rel === 'self') out.push(view(r, usage.get(r.id) || [], { ownerId: r.user_id, own: true }));
    else out.push(view(r, null, { ownerId: r.user_id, ownerName: r.owner_display || r.owner_username, own: false }));
  }
  return out;
}

/** One place as `viewerId` may see it (null: unknown or not visible). Without a viewer: any place (plugins). */
function placeFor(placeId, viewerId, { lang = 'de' } = {}) {
  const r = rowById(placeId);
  if (!r) return null;
  const owner = userOf(r.user_id);
  const viewer = viewerId == null ? null : positive(viewerId);
  if (viewerId != null && !viewer) throw invalid('userId');
  if (viewer) {
    const rel = relation(viewer, r.user_id, null);
    if (rel !== 'self' && (!owner || owner.enabled !== 1)) return null;
    if (!sees(r.visibility, rel)) return null;
    if (rel !== 'self') return view(r, null, { ownerId: r.user_id, ownerName: owner.display_name || owner.username, own: false });
  }
  return view(r, usageOf([r.id], lang).get(r.id) || [], { ownerId: r.user_id, ...(viewer ? { own: true } : {}) });
}

/** 'profile:<id>' → id, or null. */
function parseRef(ref) {
  const m = typeof ref === 'string' ? REF_RE.exec(ref.trim()) : null;
  return m ? Number(m[1]) : null;
}

// ─── Plugins: "Genutzt von" and the one-time import ──────────────

/**
 * reportUsage(pluginId, { userId, id, kind, count }) → { usedBy } — what the plugin keeps at a place it may see for
 * userId: `count` of `kind` (absolute, not added; 0 removes it).
 */
function reportUsage(pluginId, { userId, id, kind, count } = {}) {
  if (typeof kind !== 'string' || !KIND_RE.test(kind)) throw invalid('kind');
  const n = typeof count === 'number' ? count : NaN;
  if (!Number.isSafeInteger(n) || n < 0 || n > USAGE_MAX) throw invalid('count');
  const p = placeFor(id, userId);
  if (!p) throw new PlaceError('ERR_NOT_FOUND', 'unknown place');
  const db = getDb();
  if (n === 0) db.prepare('DELETE FROM user_place_usage WHERE place_id = ? AND plugin = ? AND kind = ?').run(p.id, pluginId, kind);
  else {
    db.prepare(`INSERT INTO user_place_usage (place_id, plugin, kind, count, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT (place_id, plugin, kind) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at`).run(p.id, pluginId, kind, n);
  }
  return { usedBy: usageOf([p.id], 'de').get(p.id) || [] };
}

/** A free name for an imported place: the name, else "Name 2", "Name 3" … (≤ NAME_MAX characters). */
function freeName(userId, name) {
  const db = getDb();
  const taken = (s) => !!db.prepare('SELECT 1 FROM user_places WHERE user_id = ? AND name_lc = ?').get(userId, s.toLowerCase());
  if (!taken(name)) return name;
  for (let i = 2; i < 1000; i++) {
    const suffix = ` ${i}`;
    const base = Array.from(name).slice(0, NAME_MAX - suffix.length).join('').trim();
    if (!taken(base + suffix)) return base + suffix;
  }
  return null;
}

/**
 * importFor({ userId, places: [{ sourceRef, name, lat, lon, icon?, radiusM?, address?, visibility? }], source }) →
 * { map: { [sourceRef]: { id, ref, created } }, skipped: [{ sourceRef, reason, field? }] } — a plugin moves the places
 * it kept into the profile (once, at an update). Idempotent over source + sourceRef: a place imported before is
 * answered again (created: false) and not changed. A name in use gets a number ("Baumarkt 2"); a place without a valid
 * point is skipped (reason invalid, field lat / lon) — so is one beyond MAX_PLACES (reason limit).
 */
function importFor({ userId, places, source } = {}, ctx = {}) {
  const u = needUser(userId);
  if (!SOURCES.includes(source) || source === 'manual') throw invalid('source');
  if (!Array.isArray(places) || places.length > IMPORT_MAX) throw invalid('places', `places: a list of at most ${IMPORT_MAX}`);
  const db = getDb();
  const map = {};
  const skipped = [];
  const created = [];
  const seen = new Set();
  const tx = db.transaction(() => {
    for (const raw of places) {
      const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      const ref = typeof item.sourceRef === 'string' ? item.sourceRef.trim() : '';
      if (!ref || ref.length > SOURCE_REF_MAX || /[\0-\x1f\x7f]/.test(ref) || seen.has(ref)) {
        skipped.push({ sourceRef: ref || null, reason: 'invalid', field: 'sourceRef' });
        continue;
      }
      seen.add(ref);
      const before = db.prepare('SELECT id FROM user_places WHERE user_id = ? AND source = ? AND source_ref = ?').get(u.id, source, ref);
      if (before) { map[ref] = { id: before.id, ref: `profile:${before.id}`, created: false }; continue; }
      const { sourceRef: _ignored, ...rest } = item;
      let f;
      try { f = fields(rest, { partial: false }); } catch (e) {
        skipped.push({ sourceRef: ref, reason: 'invalid', field: e.field || null });
        continue;
      }
      if (db.prepare('SELECT COUNT(*) AS n FROM user_places WHERE user_id = ?').get(u.id).n >= MAX_PLACES) { skipped.push({ sourceRef: ref, reason: 'limit' }); continue; }
      const name = freeName(u.id, f.name);
      if (!name) { skipped.push({ sourceRef: ref, reason: 'invalid', field: 'name' }); continue; }
      const id = Number(db.prepare(`INSERT INTO user_places (user_id, name, name_lc, icon, lat, lon, radius_m, address, visibility, source, source_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(u.id, name, name.toLowerCase(), f.icon, f.lat, f.lon, f.radius_m, f.address, f.visibility, source, ref).lastInsertRowid);
      created.push(id);
      map[ref] = { id, ref: `profile:${id}`, created: true };
    }
  });
  tx();
  if (created.length) {
    log('places_imported', u.id, { source: 'plugin', ...ctx }, { plugin: ctx.plugin || null, from: source, count: created.length });
    emitChanged(u.id, created);
  }
  return { map, skipped };
}

// ─── "Meine Daten" ───────────────────────────────────────────────

/** The person's places for "Meine Daten" (every field, "Genutzt von"). */
function exportFor(userId, { lang = 'de' } = {}) {
  const rows = rowsOf(Number(userId));
  const usage = usageOf(rows.map((r) => r.id), lang);
  return rows.map((r) => ({ ...view(r, usage.get(r.id) || []), sourceRef: r.source_ref || null }));
}

module.exports = {
  ICONS, VISIBILITY, SOURCES, MAX_PLACES, NAME_MAX, ADDRESS_MAX, RADIUS_MIN, RADIUS_MAX, RADIUS_DEFAULT, IMPORT_MAX,
  PlaceError,
  listOwn, getOwn, create, update, remove, markUsed,
  visibleTo, placeFor, parseRef, reportUsage, importFor, exportFor, emitChanged, hasFamily,
};
