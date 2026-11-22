'use strict';

/**
 * Pairing of GateControl TV (Fire TV) with a signed-in phone or the portal —
 * from anywhere, not only in the own Wi-Fi (a device code like the streaming
 * apps, RFC 8628 in spirit):
 *
 *   1. The TV calls start() (public): it gets a pairing id, a poll secret
 *      and a short display code. It shows the code and a QR code with
 *        gatecontrol://tv-pair?url=<server>&id=<pairing id>
 *      — the id alone is worth nothing: approving needs the display code as
 *      well, polling the poll secret (only the TV has it).
 *   2. The phone app (its device token) or the portal (session) calls
 *      approve() with the display code (and the pairing id from the QR, when
 *      it scanned one) and a name for the TV. The account must be allowed to
 *      set up own devices (users.mayEnroll), like POST /api/v1/me/enrollment.
 *   3. The TV polls with id + poll secret. Once approved, the poll hands it
 *      an ordinary setup code (services/clientEnrollment.js createCode, app
 *      scopes, role cap) exactly once; the TV redeems it at
 *      POST /api/v1/client/enroll as every app does (token, WireGuard config,
 *      device fingerprint).
 *
 * Rules: 10 minutes, single use (a finished, locked or expired pairing never
 * comes back), at most MAX_ATTEMPTS wrong codes per pairing (then it is
 * locked and the TV starts over), at most USER_FAIL_LIMIT wrong codes per
 * account in USER_FAIL_WINDOW_MS (then the account's approvals are locked for
 * USER_LOCK_MS), at most MAX_PENDING pairings at a time. Only hashes of the
 * poll secret and the display code are kept, in memory: a restart ends every
 * pending pairing (the TV just starts a new one). Codes, ids and secrets are
 * never logged; approval, wrong codes, locks and the hand-over are in the
 * activity log (a start only in the server log: anyone may start one).
 */

const crypto = require('node:crypto');
const activity = require('./activity');
const users = require('./users');
const logger = require('../utils/logger');

const TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_S = 5;
// a poll sooner than this after the last one is answered slow_down
const POLL_MIN_MS = 2000;
const MAX_PENDING = 1000;
const MAX_ATTEMPTS = 5;
const USER_FAIL_LIMIT = 10;
const USER_FAIL_WINDOW_MS = 15 * 60 * 1000;
const USER_LOCK_MS = 15 * 60 * 1000;
// no 0/O, 1/I/L: read from a TV across the room and typed on a phone
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const NAME_MAX = 50;

/** id → { secretHash, codeHash, name, platform, clientVersion, ip, createdAt, expiresAt, attempts, status, userId, approvedAt, via, lastPollAt } */
const pairings = new Map();
/** userId → { times: [ms], lockedUntil } */
const userFailures = new Map();

function coded(code, extra = {}) {
  return Object.assign(new Error(code), { code }, extra);
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function equalHex(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function generateCode() {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

/** "abcd-efgh" / "ABCD EFGH" / "abcdefgh" → "ABCDEFGH", or null. */
function normalizeCode(raw) {
  if (typeof raw !== 'string' || raw.length > 32) return null;
  const s = raw.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== CODE_LEN) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

/** "ABCDEFGH" → "ABCD-EFGH" (how the TV shows it). */
function formatCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** A device name as typed (TV default or the phone's choice): printable, trimmed, ≤ NAME_MAX, or null. */
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return s || null;
}

function cleanPlatform(raw) {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return /^[a-z0-9._-]{1,20}$/.test(s) ? s : 'android-tv';
}

function cleanVersion(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return /^v?\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$/.test(s) ? s.replace(/^v/, '') : null;
}

function purge(now = Date.now()) {
  for (const [id, p] of pairings) if (p.expiresAt <= now) pairings.delete(id);
  for (const [uid, f] of userFailures) {
    f.times = f.times.filter((t) => now - t < USER_FAIL_WINDOW_MS);
    if (!f.times.length && f.lockedUntil <= now) userFailures.delete(uid);
  }
}

function log(type, message, { ip = null, severity = 'info', source = 'api', details = {} } = {}) {
  try { activity.log(type, message, { source, ipAddress: ip, severity, details }); } catch (err) {
    logger.warn({ err: err.message }, `activity log write failed (${type})`);
  }
}

/**
 * The TV starts a pairing (public).
 * → { pairingId, pollSecret, code ("ABCD-EFGH"), expiresAt (ms), interval (s) }
 * throws busy (MAX_PENDING pending pairings)
 */
function start({ name, platform, clientVersion } = {}, ip = null, now = Date.now()) {
  purge(now);
  if (pairings.size >= MAX_PENDING) throw coded('busy');
  const taken = new Set([...pairings.values()].filter((p) => p.status === 'pending').map((p) => p.codeHash));
  let code;
  for (let i = 0; i < 10; i++) {
    code = generateCode();
    if (!taken.has(sha(code))) break;
    code = null;
  }
  if (!code) throw coded('busy');
  const id = crypto.randomBytes(16).toString('base64url');
  const secret = crypto.randomBytes(32).toString('base64url');
  const entry = {
    secretHash: sha(secret), codeHash: sha(code),
    name: cleanName(name), platform: cleanPlatform(platform), clientVersion: cleanVersion(clientVersion),
    ip, createdAt: now, expiresAt: now + TTL_MS, attempts: 0, status: 'pending',
    userId: null, approvedAt: null, via: null, lastPollAt: 0,
  };
  pairings.set(id, entry);
  // anyone may start one (rate-limited per address): the server log only, the activity log gets the approval
  logger.info({ ip, platform: entry.platform }, 'TV pairing started');
  return { pairingId: id, pollSecret: secret, code: formatCode(code), expiresAt: entry.expiresAt, interval: POLL_INTERVAL_S };
}

function userLocked(userId, now) {
  const f = userFailures.get(userId);
  return f && f.lockedUntil > now ? f.lockedUntil : 0;
}

function countUserFailure(user, ip, now) {
  const f = userFailures.get(user.id) || { times: [], lockedUntil: 0 };
  f.times = f.times.filter((t) => now - t < USER_FAIL_WINDOW_MS);
  f.times.push(now);
  if (f.times.length >= USER_FAIL_LIMIT) {
    f.lockedUntil = now + USER_LOCK_MS;
    f.times = [];
    log('client_pair_locked', `TV pairing locked for user "${user.username}" for ${Math.round(USER_LOCK_MS / 60000)} minutes after ${USER_FAIL_LIMIT} wrong codes`, {
      ip, severity: 'warning', source: 'user', details: { userId: user.id, failures: USER_FAIL_LIMIT },
    });
  }
  userFailures.set(user.id, f);
}

/**
 * A signed-in account approves a TV.
 *   code       the display code (required)
 *   pairingId  from the QR code (optional; then code and id must both match)
 *   name       the TV's name (optional; else what the TV suggested, else "TV")
 *   via        'app' | 'portal' | 'web' (activity log)
 * → { name, platform, clientVersion, expiresAt }
 * throws enroll_not_allowed | user_disabled | invalid_code (wrong, expired,
 * used, locked alike) | locked (+ retryAfter s, the account's approvals)
 */
function approve(user, { code, pairingId, name, via = 'app', tokenId = null } = {}, ip = null, now = Date.now()) {
  purge(now);
  if (!user) throw coded('enroll_not_allowed');
  if (user.enabled !== 1) throw coded('user_disabled');
  if (!users.mayEnroll(user)) throw coded('enroll_not_allowed');
  const until = userLocked(user.id, now);
  if (until) throw coded('locked', { retryAfter: Math.max(1, Math.ceil((until - now) / 1000)) });

  const norm = normalizeCode(code);
  const hash = norm ? sha(norm) : null;
  const id = typeof pairingId === 'string' && ID_RE.test(pairingId) ? pairingId : null;
  let entryId = null;
  let entry = null;
  if (id) {
    const p = pairings.get(id);
    if (p && p.status === 'pending' && p.expiresAt > now) {
      if (hash && equalHex(p.codeHash, hash)) { entryId = id; entry = p; } else {
        p.attempts++;
        if (p.attempts >= MAX_ATTEMPTS) {
          p.status = 'locked';
          log('client_pair_locked', `TV pairing locked after ${MAX_ATTEMPTS} wrong codes`, {
            ip, severity: 'warning', source: 'user', details: { userId: user.id, attempts: p.attempts },
          });
        }
      }
    }
  } else if (hash && pairingId == null) {
    for (const [k, p] of pairings) {
      if (p.status === 'pending' && p.expiresAt > now && equalHex(p.codeHash, hash)) { entryId = k; entry = p; break; }
    }
  }
  if (!entry) {
    countUserFailure(user, ip, now);
    log('client_pair_failed', `TV pairing: wrong or expired code from user "${user.username}"`, {
      ip, severity: 'warning', source: 'user', details: { userId: user.id, via, withId: !!id },
    });
    throw coded('invalid_code');
  }

  entry.status = 'approved';
  entry.userId = user.id;
  entry.approvedAt = now;
  entry.via = via;
  entry.name = cleanName(name) || entry.name || 'TV';
  userFailures.delete(user.id);
  log('client_pair_approved', `User "${user.username}" approved the TV "${entry.name}"`, {
    ip, source: 'user', details: { userId: user.id, via, tokenId, platform: entry.platform, startIp: entry.ip, pairing: entryId.slice(0, 6) },
  });
  return { name: entry.name, platform: entry.platform, clientVersion: entry.clientVersion, expiresAt: entry.expiresAt };
}

/**
 * The TV asks for the result (public).
 * → { status: 'pending', interval, expiresAt }
 *   | { status: 'approved', code (setup code for POST /api/v1/client/enroll), expiresAt (of that code), name }
 * throws invalid_or_expired (unknown id, wrong secret, expired, used, locked
 * alike) | slow_down | enroll_not_allowed | user_disabled | limit_reached
 */
function poll({ pairingId, pollSecret } = {}, ip = null, now = Date.now()) {
  purge(now);
  if (typeof pairingId !== 'string' || !ID_RE.test(pairingId) || typeof pollSecret !== 'string' || !SECRET_RE.test(pollSecret)) {
    throw coded('invalid_or_expired');
  }
  const p = pairings.get(pairingId);
  if (!p || p.expiresAt <= now || !equalHex(p.secretHash, sha(pollSecret))) throw coded('invalid_or_expired');
  if (p.status === 'locked' || p.status === 'done') throw coded('invalid_or_expired');
  if (now - p.lastPollAt < POLL_MIN_MS) throw coded('slow_down', { interval: POLL_INTERVAL_S });
  p.lastPollAt = now;
  if (p.status === 'pending') return { status: 'pending', interval: POLL_INTERVAL_S, expiresAt: p.expiresAt };

  // approved: exactly one setup code, then the pairing is spent
  p.status = 'done';
  pairings.delete(pairingId);
  const fresh = users.getById(p.userId);
  if (!fresh) throw coded('enroll_not_allowed');
  if (fresh.enabled !== 1) throw coded('user_disabled');
  if (!users.mayEnroll(fresh)) throw coded('enroll_not_allowed');
  const license = require('./license');
  const count = require('../db/connection').getDb().prepare('SELECT COUNT(*) AS c FROM peers').get().c;
  if (!license.isWithinLimit('vpn_peers', count)) throw coded('limit_reached');
  const enrollment = require('./clientEnrollment');
  let result;
  try {
    result = enrollment.createCode({ userId: fresh.id, scopes: [...enrollment.DEFAULT_SCOPES], logSource: 'user' });
  } catch (err) {
    if (err.code === 'user_disabled' || err.code === 'limit_reached') throw coded(err.code);
    if (err.code === 'no_valid_scopes') throw coded('enroll_not_allowed');
    throw err;
  }
  log('client_pair_completed', `TV "${p.name}" of user "${fresh.username}" got its setup code${ip ? ` at ${ip}` : ''}`, {
    ip, source: 'user', details: { userId: fresh.id, via: p.via, platform: p.platform },
  });
  return { status: 'approved', code: result.code, expiresAt: result.expiresAt, name: p.name };
}

function _resetForTest() { pairings.clear(); userFailures.clear(); }

module.exports = {
  start, approve, poll, normalizeCode, formatCode,
  TTL_MS, POLL_INTERVAL_S, POLL_MIN_MS, MAX_ATTEMPTS, USER_FAIL_LIMIT, USER_LOCK_MS, MAX_PENDING, ALPHABET,
  _resetForTest,
  _pairings: pairings,
};
