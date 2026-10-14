'use strict';

/**
 * Kiosk devices (docs/feature-kiosk-devices.md): a wall tablet that stays
 * signed in to the portal as one user for 90 days (rolling).
 *
 *   * Eligible users: a plugin with permissions.kiosk marks them
 *     (gc.kiosk.allow, table plugin_kiosk_users). A user is eligible while
 *     at least one installed, enabled, usable plugin with that permission
 *     lists them — never an administrator, never a disabled account.
 *     The plugin part is cached for at most ELIGIBILITY_CACHE_MS; the
 *     account itself (role, enabled) is read on every call.
 *   * Pairing: an administrator creates a one-time code (8 characters, 10
 *     minutes, at most MAX_OPEN_CODES open per user); only an HMAC of it is
 *     stored. The tablet redeems it at /portal/kiosk.
 *   * Device token: 32 random bytes (cookie gc_kiosk), only the SHA-256 is
 *     stored. Each use (at most once per ROLL_MS) moves the expiry to
 *     now + DEVICE_TTL_MS.
 * Neither a code nor a token is ever logged or returned twice.
 */

const crypto = require('node:crypto');
const config = require('../../config/default');
const { getDb } = require('../db/connection');
const activity = require('./activity');
const logger = require('../utils/logger');

const CODE_TTL_MS = 10 * 60 * 1000;
const DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const ROLL_MS = 60 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ELIGIBILITY_CACHE_MS = 60 * 1000;
const MAX_OPEN_CODES = 3;
const NAME_MAX = 60;

// Without 0/O, 1/I/L: nothing to confuse when typing the code on a tablet.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// Global failure counter of the pairing page: FAIL_LIMIT wrong codes within
// FAIL_WINDOW_MS (from any address) lock pairing for LOCK_MS.
const FAIL_LIMIT = 50;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 5 * 60 * 1000;

class KioskError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function db() { return getDb(); }

// ─── Codes and tokens ────────────────────────────────────────────────────

/** Typed code → 'ABCDEFGH' (upper case, separators dropped) or null. */
function normalizeCode(raw) {
  if (typeof raw !== 'string' || raw.length > 32) return null;
  const s = raw.toUpperCase().replace(/[\s-]+/g, '');
  return CODE_RE.test(s) ? s : null;
}

/** 'ABCDEFGH' → 'ABCD-EFGH'. */
function formatCode(code) { return `${code.slice(0, 4)}-${code.slice(4)}`; }

function generateCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

/** HMAC with the server secret: a code has ~40 bits, a plain hash would be guessable offline. */
function hashCode(code) {
  return crypto.createHmac('sha256', String(config.app.secret)).update(`kiosk-code:${code}`).digest('hex');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s && s.length <= NAME_MAX ? s : null;
}

function cleanUserAgent(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, 200);
  return s || null;
}

function cleanIp(ip) {
  if (typeof ip !== 'string' || !ip) return null;
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return v.length <= 64 ? v : null;
}

// ─── Eligibility ─────────────────────────────────────────────────────────

let cache = null; // { at, users: Map<userId, pluginId[]> }

function invalidate() { cache = null; }

/** Plugins that may mark kiosk users right now: installed, enabled, usable, permissions.kiosk. */
function kioskPluginUsable(pluginId, memo) {
  if (memo.has(pluginId)) return memo.get(pluginId);
  let ok = false;
  try {
    const plugins = require('./plugins');
    const p = plugins.get(pluginId);
    ok = !!(p && p.manifest && p.manifest.permissions && p.manifest.permissions.kiosk === true && plugins.evaluate(p).run);
  } catch (e) {
    logger.debug({ err: e.message, plugin: pluginId }, 'kiosk: plugin check failed');
    ok = false;
  }
  memo.set(pluginId, ok);
  return ok;
}

/** userId → ids of the usable plugins that allow the user (cached ≤ ELIGIBILITY_CACHE_MS). */
function allowedUsers() {
  const now = Date.now();
  if (cache && now - cache.at < ELIGIBILITY_CACHE_MS) return cache.users;
  const memo = new Map();
  const users = new Map();
  for (const r of db().prepare('SELECT plugin_id, user_id FROM plugin_kiosk_users ORDER BY plugin_id').all()) {
    if (!kioskPluginUsable(r.plugin_id, memo)) continue;
    if (!users.has(r.user_id)) users.set(r.user_id, []);
    users.get(r.user_id).push(r.plugin_id);
  }
  cache = { at: now, users };
  return users;
}

function account(userId) {
  return db().prepare('SELECT id, username, display_name, role, enabled FROM users WHERE id = ?').get(userId) || null;
}

/**
 * { eligible, reason, plugins } of an account. reason: null | 'not_found' |
 * 'admin' | 'disabled' | 'no_plugin'. Role and state are read every time.
 */
function eligibility(userId) {
  const u = Number.isSafeInteger(userId) && userId > 0 ? account(userId) : null;
  if (!u) return { eligible: false, reason: 'not_found', plugins: [] };
  if (u.role === 'admin') return { eligible: false, reason: 'admin', plugins: [] };
  if (u.enabled !== 1) return { eligible: false, reason: 'disabled', plugins: [] };
  const plugins = allowedUsers().get(u.id) || [];
  if (!plugins.length) return { eligible: false, reason: 'no_plugin', plugins: [] };
  return { eligible: true, reason: null, plugins: [...plugins] };
}

function isEligible(userId) { return eligibility(userId).eligible; }

// ─── Host API of plugins (gc.kiosk.*) ────────────────────────────────────

/**
 * gc.kiosk.allow(userId, allowed) of plugin `plugin`. Allowing an
 * administrator, a disabled or an unknown account → KioskError ERR_INVALID.
 * Returns true when something changed.
 */
function allow(plugin, userId, allowed) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0 || typeof allowed !== 'boolean') throw new KioskError('ERR_INVALID', 'invalid arguments');
  const pluginId = plugin.id;
  const u = account(id);
  let changed = false;
  if (allowed) {
    if (!u) throw new KioskError('ERR_INVALID', 'unknown user');
    if (u.role === 'admin') throw new KioskError('ERR_INVALID', 'administrators cannot be kiosk users');
    if (u.enabled !== 1) throw new KioskError('ERR_INVALID', 'disabled users cannot be kiosk users');
    changed = db().prepare('INSERT OR IGNORE INTO plugin_kiosk_users (plugin_id, user_id, created_at) VALUES (?, ?, ?)')
      .run(pluginId, id, Date.now()).changes > 0;
  } else {
    changed = db().prepare('DELETE FROM plugin_kiosk_users WHERE plugin_id = ? AND user_id = ?').run(pluginId, id).changes > 0;
  }
  if (changed) {
    invalidate();
    const name = u ? (u.display_name || u.username) : `#${id}`;
    activity.log(allowed ? 'kiosk_user_allowed' : 'kiosk_user_disallowed',
      allowed ? `Plugin "${plugin.name}" marked user "${name}" as a kiosk user` : `Plugin "${plugin.name}" no longer marks user "${name}" as a kiosk user`,
      { source: 'plugin', severity: 'info', details: { plugin: pluginId, userId: id } });
  }
  return changed;
}

/** gc.kiosk.list() → user ids the plugin marks (ascending). */
function listAllowed(pluginId) {
  return db().prepare('SELECT user_id FROM plugin_kiosk_users WHERE plugin_id = ? ORDER BY user_id').all(pluginId).map((r) => r.user_id);
}

/** A plugin was removed with its data ("Alles löschen"): its marks go too. */
function forgetPlugin(pluginId) {
  db().prepare('DELETE FROM plugin_kiosk_users WHERE plugin_id = ?').run(pluginId);
  invalidate();
}

// ─── Pairing codes ───────────────────────────────────────────────────────

function purgeCodes(now = Date.now()) {
  db().prepare('DELETE FROM kiosk_pair_codes WHERE expires_at <= ? OR used_at IS NOT NULL').run(now);
}

function openCodes(userId, now = Date.now()) {
  return db().prepare('SELECT COUNT(*) AS c FROM kiosk_pair_codes WHERE user_id = ? AND used_at IS NULL AND expires_at > ?').get(userId, now).c;
}

/**
 * New pairing code for an eligible user. Returns { code: 'ABCD-EFGH',
 * expiresAt } — the code leaves this function once and is never stored.
 * Errors (KioskError): NOT_ELIGIBLE, INVALID_NAME, TOO_MANY_CODES.
 */
function createCode(userId, { name, actorId = null, ip = null } = {}) {
  const el = eligibility(userId);
  if (!el.eligible) throw new KioskError('NOT_ELIGIBLE', el.reason || 'not eligible');
  const deviceName = cleanName(name);
  if (!deviceName) throw new KioskError('INVALID_NAME', 'invalid name');
  const now = Date.now();
  purgeCodes(now);
  if (openCodes(userId, now) >= MAX_OPEN_CODES) throw new KioskError('TOO_MANY_CODES', 'too many open pairing codes');
  let code;
  for (let i = 0; i < 5; i++) {
    code = generateCode();
    try {
      db().prepare('INSERT INTO kiosk_pair_codes (code_hash, user_id, name, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(hashCode(code), userId, deviceName, actorId, now, now + CODE_TTL_MS);
      break;
    } catch (e) {
      if (i === 4 || !/UNIQUE|PRIMARY KEY/.test(e.message)) throw e;
    }
  }
  const u = account(userId);
  activity.log('kiosk_code_created', `Kiosk pairing code created for user "${u.display_name || u.username}" (device "${deviceName}")`, {
    source: 'admin', ipAddress: ip, severity: 'info', details: { userId, actorId, device: deviceName },
  });
  return { code: formatCode(code), expiresAt: now + CODE_TTL_MS };
}

const failures = { times: [], lockedUntil: 0 };

function pairingLocked(now = Date.now()) { return failures.lockedUntil > now; }

function countFailure(now = Date.now()) {
  failures.times = failures.times.filter((t) => now - t < FAIL_WINDOW_MS);
  failures.times.push(now);
  if (failures.times.length >= FAIL_LIMIT) {
    failures.lockedUntil = now + LOCK_MS;
    failures.times = [];
    activity.log('kiosk_pairing_locked', `Kiosk pairing locked for ${Math.round(LOCK_MS / 60000)} minutes after ${FAIL_LIMIT} wrong codes`, {
      source: 'system', severity: 'warning', details: { failures: FAIL_LIMIT },
    });
  }
}

function resetFailures() { failures.times = []; failures.lockedUntil = 0; }

/**
 * Redeem a code typed on the tablet. Returns { ok: true, token, device } or
 * { ok: false, reason: 'locked' | 'invalid' } — wrong, expired, used and
 * "user no longer eligible" all look the same to the tablet. The UPDATE only
 * matches an unused, unexpired code, so two requests can never both win.
 * `replaceDeviceId`: the device this browser was paired as so far (revoked).
 */
function redeem(rawCode, { ip = null, userAgent = null, replaceDeviceId = null } = {}) {
  const now = Date.now();
  if (pairingLocked(now)) return { ok: false, reason: 'locked' };
  const code = normalizeCode(rawCode);
  purgeCodes(now);
  if (!code) { countFailure(now); return { ok: false, reason: 'invalid' }; }
  const hash = hashCode(code);
  const row = db().prepare('SELECT * FROM kiosk_pair_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?').get(hash, now);
  const used = row ? db().prepare('UPDATE kiosk_pair_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?').run(now, hash, now).changes : 0;
  if (used !== 1) { countFailure(now); return { ok: false, reason: 'invalid' }; }
  db().prepare('DELETE FROM kiosk_pair_codes WHERE code_hash = ?').run(hash);
  if (!isEligible(row.user_id)) {
    logger.warn({ userId: row.user_id }, 'kiosk: pairing code of a user who is no longer eligible');
    return { ok: false, reason: 'invalid' };
  }
  if (replaceDeviceId != null) revoke(replaceDeviceId, { reason: 'replaced', ip });
  const token = crypto.randomBytes(32).toString('base64url');
  const id = Number(db().prepare(`INSERT INTO kiosk_devices (user_id, name, token_hash, created_at, created_by, last_seen_at, last_ip, user_agent, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.user_id, row.name, hashToken(token), now, row.created_by, now, cleanIp(ip), cleanUserAgent(userAgent), now + DEVICE_TTL_MS).lastInsertRowid);
  const u = account(row.user_id);
  activity.log('kiosk_paired', `Kiosk device "${row.name}" paired for user "${u.display_name || u.username}"`, {
    source: 'user', ipAddress: ip, severity: 'info', details: { userId: row.user_id, deviceId: id, device: row.name, actorId: row.created_by },
  });
  return { ok: true, token, device: getDevice(id) };
}

// ─── Devices ─────────────────────────────────────────────────────────────

function getDevice(id) {
  return db().prepare('SELECT * FROM kiosk_devices WHERE id = ?').get(id) || null;
}

/** The device of a cookie value: active (not revoked, not expired) or null. */
function resolve(rawToken, now = Date.now()) {
  if (typeof rawToken !== 'string' || !TOKEN_RE.test(rawToken)) return null;
  const d = db().prepare('SELECT * FROM kiosk_devices WHERE token_hash = ?').get(hashToken(rawToken));
  if (!d || d.revoked_at != null || d.expires_at <= now) return null;
  return d;
}

/**
 * Rolling expiry: at most once per ROLL_MS, expires_at = now + 90 days and
 * last seen / last address. Returns true when it rolled (→ re-issue the cookie).
 */
function touch(device, { ip = null, now = Date.now() } = {}) {
  if (device.last_seen_at != null && now - device.last_seen_at < ROLL_MS) return false;
  const r = db().prepare('UPDATE kiosk_devices SET last_seen_at = ?, last_ip = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(now, cleanIp(ip), now + DEVICE_TTL_MS, device.id);
  return r.changes === 1;
}

function deviceView(d, now = Date.now()) {
  return {
    id: d.id,
    name: d.name,
    created_at: d.created_at,
    last_seen_at: d.last_seen_at,
    last_ip: d.last_ip,
    user_agent: d.user_agent,
    expires_at: d.expires_at,
    expired: d.expires_at <= now,
  };
}

/** Devices of a user that are not revoked (an expired one until the clean-up). */
function listForUser(userId) {
  const now = Date.now();
  return db().prepare('SELECT * FROM kiosk_devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id DESC').all(userId)
    .map((d) => deviceView(d, now));
}

/**
 * Revoke a device. reason: 'revoked' (administrator), 'logout' ("Abmelden"
 * on the tablet), 'replaced' (paired again). `userId` (optional) must own it.
 * Returns the device row or null when there is nothing to revoke.
 */
function revoke(deviceId, { userId = null, reason = 'revoked', actorId = null, ip = null } = {}) {
  const d = getDevice(Number(deviceId));
  if (!d || d.revoked_at != null || (userId != null && d.user_id !== userId)) return null;
  const now = Date.now();
  if (db().prepare('UPDATE kiosk_devices SET revoked_at = ?, end_reason = ? WHERE id = ? AND revoked_at IS NULL').run(now, reason, d.id).changes !== 1) return null;
  const u = account(d.user_id);
  const who = u ? (u.display_name || u.username) : `#${d.user_id}`;
  const how = { revoked: 'revoked by an administrator', logout: 'signed out on the device', replaced: 'replaced by a new pairing' }[reason] || reason;
  activity.log('kiosk_revoked', `Kiosk device "${d.name}" of user "${who}" ${how}`, {
    source: reason === 'revoked' ? 'admin' : 'user', ipAddress: ip, severity: reason === 'revoked' ? 'warning' : 'info',
    details: { userId: d.user_id, deviceId: d.id, device: d.name, reason, actorId },
  });
  return d;
}

/**
 * Clean-up (periodic): expired codes go at once; devices that expired are
 * logged once (kiosk_expired) and marked; revoked or expired devices are
 * deleted RETENTION_MS later.
 */
function cleanup(now = Date.now()) {
  purgeCodes(now);
  const expired = db().prepare('SELECT * FROM kiosk_devices WHERE revoked_at IS NULL AND expires_at <= ?').all(now);
  for (const d of expired) {
    if (db().prepare("UPDATE kiosk_devices SET revoked_at = expires_at, end_reason = 'expired' WHERE id = ? AND revoked_at IS NULL").run(d.id).changes !== 1) continue;
    const u = account(d.user_id);
    activity.log('kiosk_expired', `Kiosk device "${d.name}" of user "${u ? (u.display_name || u.username) : '#' + d.user_id}" expired (not used for 90 days)`, {
      source: 'system', severity: 'info', details: { userId: d.user_id, deviceId: d.id, device: d.name },
    });
  }
  const removed = db().prepare('DELETE FROM kiosk_devices WHERE revoked_at IS NOT NULL AND revoked_at <= ?').run(now - RETENTION_MS).changes;
  return { expired: expired.length, removed };
}

module.exports = {
  KioskError,
  normalizeCode, formatCode, hashCode, hashToken,
  eligibility, isEligible, invalidate,
  allow, listAllowed, forgetPlugin,
  createCode, redeem, pairingLocked, resetFailures,
  resolve, touch, getDevice, listForUser, revoke, cleanup,
  CODE_TTL_MS, DEVICE_TTL_MS, ROLL_MS, RETENTION_MS, ELIGIBILITY_CACHE_MS, MAX_OPEN_CODES, CODE_ALPHABET,
  FAIL_LIMIT, LOCK_MS,
};
