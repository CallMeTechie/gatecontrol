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
//                       appVersion, online, lastSeen, via }]; GateControl TV:
//                       platform 'android', clientType 'android-tv'
//   ownedBy(users, ids) which of the token ids are such devices of these people
//                       (gc.notify devices)
//   viewerDevice(req)   the device of an app request { id, platform, clientType? }
//                       (user.device of the client plugin API; clientType only
//                       when known)
//
// Hook devicesChanged({ removed, added }) (since 1.322.0): a device token of a
// person was created, revoked ("Meine Geräte", the administration, a new
// enrollment replacing it, the directory sync), moved to another owner, or
// its person was disabled / enabled / deleted. The token services call
// announce(); the entries are batched (≤ 1×/s, an add and a removal of the
// same token in one batch cancel out) and go to every running plugin with
// permissions.devices — 10 s per call, never awaited, failures land in the
// plugin's log, so a plugin never holds up or breaks the change itself.
//   entriesFor({ tokenIds } | { userId }, reason)  the entries of device
//                       tokens (before a deletion: read them first)
//   announce({ removed, added })  queue them for the hook

const stream = require('../notify/stream');
const logger = require('../../utils/logger');

const ONLINE_WINDOW_MS = 60 * 1000;
// linux: the Linux agent (gatecontrol-agent, plugin "Fernzugriff" stage 4) and other Linux apps
const PLATFORMS = new Set(['android', 'windows', 'ios', 'web', 'linux']);
const ID_RE = /^[1-9]\d{0,14}$/;

function db() { return require('../../db/connection').getDb(); }

/** 'android' | 'windows' | 'ios' | 'web' | 'linux' | null from what an app reported. */
function platformOf(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'win32') return 'windows';
  // GateControl TV: an Android device for the plugins (the platform list of gc.devices.list stays as documented)
  if (s === 'android-tv') return 'android';
  return PLATFORMS.has(s) ? s : null;
}

// 'pro' | 'community': the Windows editions; 'android-tv': GateControl TV (since 1.320.0)
const CLIENT_TYPES = new Set(['pro', 'community', 'android-tv']);

function isTv(v) { return String(v || '').trim().toLowerCase() === 'android-tv'; }

/**
 * 'pro' | 'community' | 'android-tv' | null of a device row: the client type on
 * the push stream, else the product the registered peer reported, else a TV
 * by its reported platform.
 */
function clientTypeOf(r) {
  for (const v of [r.client_type, r.client_product]) {
    const s = String(v || '').trim().toLowerCase();
    if (CLIENT_TYPES.has(s)) return s;
  }
  return isTv(r.platform) || isTv(r.client_platform) ? 'android-tv' : null;
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
    return {
      id: String(r.id),
      name: r.name,
      platform: platformOf(r.platform || r.client_platform),
      clientType: clientTypeOf(r),
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

/**
 * user.device of an app's plugin request: { id, platform, clientType? }
 * (X-Client-Platform / X-Client-Type, else what the app reported). clientType
 * ('pro' | 'community' | 'android-tv') only when known, so the shape of other
 * devices stays { id, platform }.
 */
function viewerDevice(req) {
  if (req.tokenId == null) return null;
  const header = req.headers['x-client-platform'];
  let platform = platformOf(header);
  let clientType = isTv(header) ? 'android-tv' : clientTypeOf({ client_type: req.headers['x-client-type'] });
  if (!platform || !clientType) {
    const r = db().prepare(`SELECT dp.platform, dp.client_type, p.client_platform, p.client_product
      FROM api_tokens t LEFT JOIN notify_device_prefs dp ON dp.token_id = t.id LEFT JOIN peers p ON p.id = t.peer_id
      WHERE t.id = ?`).get(req.tokenId);
    if (!platform) platform = r ? platformOf(r.platform) : null;
    // a stored type only for the same kind of device the request comes from
    const stored = r ? clientTypeOf(r) : null;
    if (!clientType && stored && (stored === 'android-tv' ? platform === 'android' : platform !== 'android')) clientType = stored;
  }
  return clientType ? { id: String(req.tokenId), platform, clientType } : { id: String(req.tokenId), platform };
}

// ─── hook devicesChanged ───────────────────────────────────────────────────

const HOOK_MS = 10000;
const BATCH_MS = 1000;
const MAX_BATCH = 1000;
const REASONS = new Set(['created', 'revoked', 'owner_changed', 'user_disabled', 'user_enabled', 'user_deleted']);

/**
 * A token the plugins treat as a device of its person for the hook: an owner,
 * not expired, and scope `client` (an app token, even before the app first
 * used it) or what gc.devices.list counts (a `full-access` token an app
 * identified itself on).
 */
function hookCandidate(r, nowIso) {
  if (r.user_id == null || (r.expires_at && r.expires_at <= nowIso)) return false;
  return scopesOf(r.scopes).includes('client') || isDevice(r, nowIso);
}

/** { id, userId, name, platform, clientType, reason } of the device tokens among `tokenIds` / of `userId`. */
function entriesFor({ tokenIds = null, userId = null } = {}, reason) {
  let rows;
  if (Array.isArray(tokenIds)) {
    const ids = tokenIds.map(idOf).filter((v) => v != null);
    if (!ids.length) return [];
    rows = db().prepare(`${DEVICE_SQL} WHERE t.id IN (${ids.map(() => '?').join(',')}) ORDER BY t.id`).all(...ids);
  } else if (userId != null) {
    rows = db().prepare(`${DEVICE_SQL} WHERE t.user_id = ? ORDER BY t.id`).all(userId);
  } else return [];
  const nowIso = new Date().toISOString();
  return rows.filter((r) => hookCandidate(r, nowIso)).map((r) => ({
    id: String(r.id),
    userId: r.user_id,
    name: r.name,
    platform: platformOf(r.platform || r.client_platform),
    clientType: clientTypeOf(r),
    reason,
  }));
}

// token id + owner → { kind: 'added' | 'removed', entry, created }: the last state wins (a token moved to
// another person is a removal for the old owner and an addition for the new one)
let pending = new Map();
let timer = null;

/** Queue device changes for the hook. Never throws: the caller's change has happened. */
function announce(change) {
  try {
    const removed = change && Array.isArray(change.removed) ? change.removed : [];
    const added = change && Array.isArray(change.added) ? change.added : [];
    const put = (kind) => (e) => {
      if (!e || e.id == null || !REASONS.has(e.reason)) return;
      const id = String(e.id);
      const key = `${id}:${e.userId}`;
      const prev = pending.get(key);
      pending.set(key, { kind, entry: { ...e, id }, created: prev ? prev.created : kind === 'added' && e.reason === 'created' });
    };
    removed.forEach(put('removed'));
    added.forEach(put('added'));
    if (!pending.size || timer) return;
    timer = setTimeout(flush, module.exports._batchMs != null ? module.exports._batchMs : BATCH_MS);
    if (timer.unref) timer.unref();
  } catch (err) { logger.debug({ err: err.message }, 'devicesChanged not queued'); }
}

function pluginLog(id, level, message) {
  try { require('./registry').addLog(id, level, message); } catch { /* db closed */ }
}

/** The plugins with permissions.devices that run now. */
function hookPlugins() {
  const runtime = require('./runtime');
  const { evaluate } = require('./index');
  let rows;
  try { rows = require('./registry').list(); } catch { return []; }
  return rows.filter((p) => p.manifest && p.manifest.permissions && p.manifest.permissions.devices === true)
    .filter((p) => { try { return evaluate(p).run && runtime.info(p.id).state === 'running'; } catch { return false; } });
}

/** Send the queued batch to the plugins (never awaited by the token services). */
function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  const batch = [...pending.values()];
  pending = new Map();
  // an app token created and removed again in the same batch (a failed enrollment) never existed for the plugins
  const removed = batch.filter((b) => b.kind === 'removed' && !b.created).map((b) => b.entry).slice(0, MAX_BATCH);
  const added = batch.filter((b) => b.kind === 'added').map((b) => b.entry).slice(0, MAX_BATCH);
  if (!removed.length && !added.length) return;
  let targets;
  try { targets = hookPlugins(); } catch (err) { logger.debug({ err: err.message }, 'devicesChanged: no plugins'); return; }
  const runtime = require('./runtime');
  const ms = module.exports._hookMs || HOOK_MS;
  for (const p of targets) {
    let call;
    try { call = runtime.call(p.id, 'devicesChanged', { removed, added }, ms); } catch (e) { call = Promise.reject(e); }
    Promise.resolve(call).catch((e) => {
      // e.stopped: the host stopped the plugin meanwhile (runtime.js) — not a warning
      pluginLog(p.id, e && e.stopped ? 'debug' : 'warn', 'devicesChanged failed: ' + String((e && e.message) || e).slice(0, 200));
    });
  }
}

module.exports = { list, ownedBy, viewerDevice, idOf, platformOf, ONLINE_WINDOW_MS, entriesFor, announce, flush, _batchMs: null, _hookMs: null };
