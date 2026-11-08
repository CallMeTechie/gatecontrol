'use strict';

// Gateway-Standorte (docs/feature-gateway-locations.md): where the gateways
// stand — "Zuhause", "Büro", "Eltern" — with an optional address. A gateway
// has at most one location (gateway_meta.location_id); a location without
// gateways is allowed (it shows in the dialog "Standorte" only).
//
// Data (migration 141):
//   gateway_locations  id, name (unique, case-insensitive), street (with the
//                      house number), postal_code, city, country (ISO 3166
//                      alpha-2), created_at / updated_at (epoch ms)
//   gateway_meta.location_id  ON DELETE SET NULL
//
// Admin only: the routes sit under /api/v1 (admin session + CSRF, or a token
// with the scope `gateway` / `full-access` — services/tokens.js SCOPE_MAP).
// The peer group of a gateway (peers.group_id) is a different thing and is
// not touched here.

const { getDb } = require('../db/connection');

const LIMITS = Object.freeze({ name: 80, street: 120, postal_code: 16, city: 80 });
const FIELDS = Object.freeze(['name', 'street', 'postal_code', 'city', 'country']);
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
const POSTAL_RE = /^[\p{L}\p{N}][\p{L}\p{N} -]*$/u;
const COUNTRY_RE = /^[A-Z]{2}$/;

class LocationError extends Error {
  constructor(code, fields) {
    super(code);
    this.code = code;
    this.fields = fields || null;
  }
}

function db() { return getDb(); }

/** Trimmed text with inner runs of white space folded to one space; '' for nothing. */
function clean(v) {
  if (v == null) return '';
  return String(v).replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
}

function foldName(name) { return clean(name).toLocaleLowerCase('de-DE'); }

/**
 * The fields of a location from a request body → { value, fields }. `fields`
 * maps a field to an error code (name_required, too_long, postal_invalid,
 * country_invalid) and is null when everything is fine. Missing optional
 * fields become null.
 */
function normalize(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  const fields = {};
  out.name = clean(src.name);
  if (!out.name) fields.name = 'name_required';
  else if (out.name.length > LIMITS.name) fields.name = 'too_long';
  for (const k of ['street', 'postal_code', 'city']) {
    const v = clean(src[k]);
    out[k] = v || null;
    if (v.length > LIMITS[k]) fields[k] = 'too_long';
  }
  if (out.postal_code && !fields.postal_code && !POSTAL_RE.test(out.postal_code)) fields.postal_code = 'postal_invalid';
  const c = clean(src.country).toUpperCase();
  out.country = c || null;
  if (c && !COUNTRY_RE.test(c)) fields.country = 'country_invalid';
  return { value: out, fields: Object.keys(fields).length ? fields : null };
}

function rowOut(r) {
  return {
    id: r.id, name: r.name, street: r.street || null, postal_code: r.postal_code || null,
    city: r.city || null, country: r.country || null, created_at: r.created_at, updated_at: r.updated_at,
  };
}

function gatewaysOf(id) {
  return db().prepare(`SELECT p.id AS peer_id, p.name FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id
    WHERE gm.location_id = ? AND p.peer_type = 'gateway' ORDER BY p.name COLLATE NOCASE`).all(id);
}

/** All locations, by name, each with its gateways ({ peer_id, name }) and their count. */
function list() {
  const rows = db().prepare('SELECT * FROM gateway_locations ORDER BY name COLLATE NOCASE, id').all();
  const byLoc = new Map();
  for (const g of db().prepare(`SELECT gm.location_id, p.id AS peer_id, p.name FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id
      WHERE gm.location_id IS NOT NULL AND p.peer_type = 'gateway' ORDER BY p.name COLLATE NOCASE`).all()) {
    if (!byLoc.has(g.location_id)) byLoc.set(g.location_id, []);
    byLoc.get(g.location_id).push({ peer_id: g.peer_id, name: g.name });
  }
  return rows.map((r) => {
    const gws = byLoc.get(r.id) || [];
    return { ...rowOut(r), gateway_count: gws.length, gateways: gws };
  });
}

function get(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
  const r = db().prepare('SELECT * FROM gateway_locations WHERE id = ?').get(n);
  if (!r) return null;
  const gws = gatewaysOf(n);
  return { ...rowOut(r), gateway_count: gws.length, gateways: gws };
}

function nameTaken(name, exceptId) {
  const f = foldName(name);
  return db().prepare('SELECT id, name FROM gateway_locations').all()
    .some((r) => r.id !== exceptId && foldName(r.name) === f);
}

function isUniqueError(err) { return /UNIQUE constraint failed/.test(String(err && err.message)); }

/** → the new location. Throws LocationError('invalid' | 'name_taken', fields). */
function create(input) {
  const { value, fields } = normalize(input);
  if (fields) throw new LocationError('invalid', fields);
  if (nameTaken(value.name)) throw new LocationError('name_taken', { name: 'name_taken' });
  const now = Date.now();
  let id;
  try {
    id = db().prepare(`INSERT INTO gateway_locations (name, street, postal_code, city, country, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(value.name, value.street, value.postal_code, value.city, value.country, now, now).lastInsertRowid;
  } catch (err) {
    if (isUniqueError(err)) throw new LocationError('name_taken', { name: 'name_taken' });
    throw err;
  }
  return get(Number(id));
}

/** All fields are replaced (a missing optional field is cleared). → { before, after }. */
function update(id, input) {
  const before = get(id);
  if (!before) throw new LocationError('not_found');
  const { value, fields } = normalize(input);
  if (fields) throw new LocationError('invalid', fields);
  if (nameTaken(value.name, before.id)) throw new LocationError('name_taken', { name: 'name_taken' });
  try {
    db().prepare(`UPDATE gateway_locations SET name = ?, street = ?, postal_code = ?, city = ?, country = ?, updated_at = ?
      WHERE id = ?`).run(value.name, value.street, value.postal_code, value.city, value.country, Date.now(), before.id);
  } catch (err) {
    if (isUniqueError(err)) throw new LocationError('name_taken', { name: 'name_taken' });
    throw err;
  }
  return { before, after: get(before.id) };
}

/** Deletes a location; its gateways stay, without a location. → { location, released: [{ peer_id, name }] }. */
function remove(id) {
  const loc = get(id);
  if (!loc) throw new LocationError('not_found');
  db().transaction(() => {
    db().prepare('UPDATE gateway_meta SET location_id = NULL WHERE location_id = ?').run(loc.id);
    db().prepare('DELETE FROM gateway_locations WHERE id = ?').run(loc.id);
  })();
  return { location: loc, released: loc.gateways };
}

function gatewayRow(peerId) {
  const n = Number(peerId);
  if (!Number.isInteger(n) || n < 1) return null;
  return db().prepare(`SELECT p.id, p.name, gm.location_id FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id
    WHERE p.id = ? AND p.peer_type = 'gateway'`).get(n) || null;
}

/** The location id of a request (null / '' / 0 = none) → id | null; throws LocationError('not_found'). */
function resolveId(locationId) {
  if (locationId == null || locationId === '' || locationId === 0 || locationId === '0') return null;
  const n = Number(locationId);
  if (!Number.isInteger(n) || n < 1 || !db().prepare('SELECT 1 FROM gateway_locations WHERE id = ?').get(n)) {
    throw new LocationError('not_found', { location_id: 'not_found' });
  }
  return n;
}

/**
 * Sets (or clears, with null) the location of gateways. All or none: an unknown
 * gateway or location changes nothing. → [{ peer_id, name, from, to }] for the
 * gateways whose location really changed.
 */
function setForGateways(peerIds, locationId) {
  const to = resolveId(locationId);
  const ids = [...new Set((Array.isArray(peerIds) ? peerIds : [peerIds]).map(Number))];
  const rows = ids.map((id) => gatewayRow(id));
  if (!rows.length || rows.some((r) => !r)) throw new LocationError('gateway_not_found');
  const changed = rows.filter((r) => (r.location_id || null) !== to);
  if (changed.length) {
    db().transaction(() => {
      const st = db().prepare('UPDATE gateway_meta SET location_id = ? WHERE peer_id = ?');
      for (const r of changed) st.run(to, r.id);
    })();
  }
  return changed.map((r) => ({ peer_id: r.id, name: r.name, from: r.location_id || null, to }));
}

/** peer id → { id, name, city, country } of every gateway with a location (GET /api/v1/gateways). */
function byGateway() {
  const out = new Map();
  for (const r of db().prepare(`SELECT gm.peer_id, l.id, l.name, l.city, l.country FROM gateway_meta gm
      JOIN gateway_locations l ON l.id = gm.location_id`).all()) {
    out.set(r.peer_id, { id: r.id, name: r.name, city: r.city || null, country: r.country || null });
  }
  return out;
}

module.exports = {
  LIMITS, FIELDS, LocationError, normalize, list, get, create, update, remove,
  resolveId, setForGateways, byGateway,
};
