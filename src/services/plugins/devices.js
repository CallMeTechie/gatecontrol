'use strict';

// A person's devices for plugins (permissions.devices, docs/plugins.md
// "Devices", since 1.193.0): the GateControl apps (Android, Windows) of that
// person — an api_tokens row of the person that an app uses:
//   * scope `client` and the app showed up: it opened the push stream
//     (notify_device_prefs row), registered its peer (peers.client_platform)
//     or used the token at all;
//   * scope `full-access` (an app set up with an all-access token) only when
//     an app identified itself: client type / version on the push stream or a
//     registered peer — never a script or automation token.
// Online: the push stream, else the last sign of life within a minute.
//
//   list(userId)        gc.devices.list — [{ id, name, platform, clientType,
//                       appVersion, online, lastSeen, via }]
//   ownedBy(users, ids) which of the token ids are such devices of these people
//                       (gc.notify devices)
//   viewerDevice(req)   the device of an app request { id, platform }
//                       (user.device of the client plugin API)

const stream = require('../notify/stream');

const ONLINE_WINDOW_MS = 60 * 1000;
const PLATFORMS = new Set(['android', 'windows', 'ios', 'web']);
const ID_RE = /^[1-9]\d{0,14}$/;

function db() { return require('../../db/connection').getDb(); }

/** 'android' | 'windows' | 'ios' | 'web' | null from what an app reported. */
function platformOf(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'win32') return 'windows';
  return PLATFORMS.has(s) ? s : null;
}

function scopesOf(raw) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** A device id from a plugin ('42' or 42) → the token id, or null. */
function idOf(v) {
  if (Number.isSafeInteger(v) && v > 0) return v;
  return typeof v === 'string' && ID_RE.test(v) ? Number(v) : null;
}

const DEVICE_SQL = `SELECT t.id, t.name, t.scopes, t.expires_at, t.user_id, t.last_used_at,
    dp.token_id AS dp_token, dp.platform, dp.client_type, dp.app_version, dp.last_seen_at,
    p.client_platform, p.client_product, p.client_version, p.client_seen_at
  FROM api_tokens t LEFT JOIN notify_device_prefs dp ON dp.token_id = t.id LEFT JOIN peers p ON p.id = t.peer_id`;

/** An app identified itself on this token (push stream headers or a registered peer). */
function appSeen(r) {
  return !!(r.client_type || r.app_version || r.client_platform || r.client_product);
}

function isDevice(r, nowIso) {
  if (r.expires_at && r.expires_at <= nowIso) return false;
  const scopes = scopesOf(r.scopes);
  if (scopes.includes('client')) return r.dp_token != null || appSeen(r) || !!r.last_used_at;
  if (scopes.includes('full-access')) return appSeen(r);
  return false;
}

/** The latest sign of life of a device row (ISO) or null. */
function lastSeenOf(r) {
  const t = [r.last_seen_at, r.client_seen_at].filter((v) => v && Number.isFinite(Date.parse(v)));
  t.sort((a, b) => Date.parse(b) - Date.parse(a));
  return t[0] || null;
}

/** gc.devices.list({ userId }) for an existing, enabled person (checked by the caller). */
function list(userId, now = Date.now()) {
  const nowIso = new Date(now).toISOString();
  const rows = db().prepare(`${DEVICE_SQL} WHERE t.user_id = ? ORDER BY t.id`).all(userId);
  return rows.filter((r) => isDevice(r, nowIso)).map((r) => {
    const conn = stream.get(r.id);
    const last = lastSeenOf(r);
    const seen = conn ? now : Date.parse(last || '');
    const product = r.client_type || (['pro', 'community'].includes(r.client_product) ? r.client_product : null);
    return {
      id: String(r.id),
      name: r.name,
      platform: platformOf(r.platform || r.client_platform),
      clientType: product,
      appVersion: r.app_version || r.client_version || null,
      online: !!conn || (Number.isFinite(seen) && now - seen <= ONLINE_WINDOW_MS),
      lastSeen: conn ? nowIso : last,
      via: conn ? (conn.net || (conn.via === 'tunnel' ? 'vpn' : 'internet')) : null,
    };
  });
}

/** The token ids of `ids` that are app devices of one of `userIds`. */
function ownedBy(userIds, ids) {
  if (!userIds.length || !ids.length) return new Set();
  const nowIso = new Date().toISOString();
  const rows = db().prepare(`${DEVICE_SQL} WHERE t.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return new Set(rows.filter((r) => userIds.includes(r.user_id) && isDevice(r, nowIso)).map((r) => r.id));
}

/** user.device of an app's plugin request: { id, platform } (X-Client-Platform, else what the app reported). */
function viewerDevice(req) {
  if (req.tokenId == null) return null;
  let platform = platformOf(req.headers['x-client-platform']);
  if (!platform) {
    const r = db().prepare('SELECT platform FROM notify_device_prefs WHERE token_id = ?').get(req.tokenId);
    platform = r ? platformOf(r.platform) : null;
  }
  return { id: String(req.tokenId), platform };
}

module.exports = { list, ownedBy, viewerDevice, idOf, platformOf, ONLINE_WINDOW_MS };
