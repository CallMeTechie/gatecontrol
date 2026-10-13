'use strict';

/**
 * Location sharing on tap (docs/feature-device-location.md).
 *
 * The app sends one position only when its user taps the satellite button.
 * The server keeps the newest LOCATION_KEEP positions per device (peer) for
 * at most RETENTION_DAYS days; the administrator allows the feature per user
 * (users.location_sharing). Nothing here ever asks a device for its position.
 */

const ipaddr = require('ipaddr.js');
const appConfig = require('../../config/default');
const { getDb } = require('../db/connection');

const LOCATION_KEEP = 20;
const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A device clock may be off; fix times outside this window become "now". */
const CAPTURED_PAST_MS = 10 * 60 * 1000;
const CAPTURED_FUTURE_MS = 2 * 60 * 1000;
const PROVIDER_RE = /^[a-z][a-z0-9_-]{0,15}$/;

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Validates a report from the app. Returns { ok: true, value } or
 * { ok: false, error } with a stable error code.
 */
function validate(body, now = Date.now()) {
  const b = body && typeof body === 'object' ? body : {};
  if (!finite(b.lat) || b.lat < -90 || b.lat > 90) return { ok: false, error: 'invalid_lat' };
  if (!finite(b.lng) || b.lng < -180 || b.lng > 180) return { ok: false, error: 'invalid_lng' };
  let accuracy = null;
  if (b.accuracy !== undefined && b.accuracy !== null) {
    if (!finite(b.accuracy) || b.accuracy < 0 || b.accuracy > 100000) return { ok: false, error: 'invalid_accuracy' };
    accuracy = round(b.accuracy, 1);
  }
  let altitude = null;
  if (b.altitude !== undefined && b.altitude !== null) {
    if (!finite(b.altitude) || Math.abs(b.altitude) > 20000) return { ok: false, error: 'invalid_altitude' };
    altitude = round(b.altitude, 1);
  }
  const provider = typeof b.provider === 'string' && PROVIDER_RE.test(b.provider) ? b.provider : null;
  let capturedAt = now;
  if (finite(b.captured_at) && b.captured_at >= now - CAPTURED_PAST_MS && b.captured_at <= now + CAPTURED_FUTURE_MS) {
    capturedAt = Math.round(b.captured_at);
  }
  // ~1 cm is far below what a phone can tell; no point in storing more digits.
  return { ok: true, value: { lat: round(b.lat, 7), lng: round(b.lng, 7), accuracy, altitude, provider, capturedAt } };
}

/** 'tunnel' when the request came through the WireGuard network. */
function viaOf(ip) {
  try {
    let addr = ipaddr.parse(String(ip || ''));
    if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) addr = addr.toIPv4Address();
    const [net, bits] = ipaddr.parseCIDR(appConfig.wireguard.subnet);
    return addr.kind() === net.kind() && addr.match(net, bits) ? 'tunnel' : 'direct';
  } catch { return 'direct'; }
}

/** Owner of a peer (device without an owned token), null when none. */
function ownerOfPeer(peerId) {
  const row = getDb().prepare('SELECT user_id FROM peers WHERE id = ?').get(peerId);
  return row && row.user_id != null ? row.user_id : null;
}

/** Whether the administrator allows [userId] to share locations. */
function isAllowedForUser(userId) {
  if (userId == null) return false;
  const row = getDb().prepare('SELECT enabled, location_sharing FROM users WHERE id = ?').get(userId);
  return !!row && row.enabled === 1 && row.location_sharing === 1;
}

function setAllowedForUser(userId, allowed) {
  getDb().prepare("UPDATE users SET location_sharing = ?, updated_at = datetime('now') WHERE id = ?")
    .run(allowed ? 1 : 0, userId);
}

function toView(row) {
  if (!row) return null;
  return {
    id: row.id,
    lat: row.lat,
    lng: row.lng,
    accuracy: row.accuracy,
    altitude: row.altitude,
    provider: row.provider,
    via: row.via,
    captured_at: row.captured_at,
    at: row.received_at,
  };
}

/** Stores one position and trims the device's history. Returns the stored view. */
function record({ peerId, tokenId, userId, value, via, now = Date.now() }) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO device_locations (peer_id, token_id, user_id, lat, lng, accuracy, altitude, provider, via, captured_at, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const trim = db.prepare(`
    DELETE FROM device_locations WHERE peer_id = ? AND id NOT IN (
      SELECT id FROM device_locations WHERE peer_id = ? ORDER BY received_at DESC, id DESC LIMIT ?)`);
  const id = db.transaction(() => {
    const r = insert.run(peerId, tokenId ?? null, userId ?? null, value.lat, value.lng, value.accuracy, value.altitude,
      value.provider, via || null, value.capturedAt, now);
    trim.run(peerId, peerId, LOCATION_KEEP);
    return r.lastInsertRowid;
  })();
  return toView(db.prepare('SELECT * FROM device_locations WHERE id = ?').get(id));
}

function minReceived(now = Date.now()) {
  return now - RETENTION_DAYS * DAY_MS;
}

/** Newest position of a device within the retention, or null. */
function last(peerId, now = Date.now()) {
  return toView(getDb().prepare(
    'SELECT * FROM device_locations WHERE peer_id = ? AND received_at >= ? ORDER BY received_at DESC, id DESC LIMIT 1',
  ).get(peerId, minReceived(now)));
}

/** Newest first, at most LOCATION_KEEP. */
function history(peerId, now = Date.now()) {
  return getDb().prepare(
    'SELECT * FROM device_locations WHERE peer_id = ? AND received_at >= ? ORDER BY received_at DESC, id DESC LIMIT ?',
  ).all(peerId, minReceived(now), LOCATION_KEEP).map(toView);
}

/** { peerId: last view } for the device cards of a profile. */
function lastForPeers(peerIds, now = Date.now()) {
  const ids = [...new Set((peerIds || []).filter((x) => Number.isInteger(x)))];
  if (ids.length === 0) return {};
  const marks = ids.map(() => '?').join(',');
  const rows = getDb().prepare(`
    SELECT d.* FROM device_locations d
    JOIN (SELECT peer_id, MAX(received_at) AS m FROM device_locations
          WHERE peer_id IN (${marks}) AND received_at >= ? GROUP BY peer_id) x
      ON x.peer_id = d.peer_id AND x.m = d.received_at
    ORDER BY d.id DESC`).all(...ids, minReceived(now));
  const out = {};
  for (const r of rows) if (!out[r.peer_id]) out[r.peer_id] = toView(r);
  return out;
}

function deleteForPeer(peerId) {
  return getDb().prepare('DELETE FROM device_locations WHERE peer_id = ?').run(peerId).changes;
}

function deleteForUser(userId) {
  return getDb().prepare('DELETE FROM device_locations WHERE user_id = ?').run(userId).changes;
}

/** Periodic cleanup: drops positions past the retention. */
function purgeExpired(now = Date.now()) {
  return getDb().prepare('DELETE FROM device_locations WHERE received_at < ?').run(minReceived(now)).changes;
}

module.exports = {
  LOCATION_KEEP,
  RETENTION_DAYS,
  validate,
  viaOf,
  ownerOfPeer,
  isAllowedForUser,
  setAllowedForUser,
  record,
  last,
  history,
  lastForPeers,
  deleteForPeer,
  deleteForUser,
  purgeExpired,
};
