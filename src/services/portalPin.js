'use strict';

/**
 * Portal PIN — 4 to 6 digits, confirms the person on a shared device
 * ("Wer bist du?"). Stored as an argon2 hash in users.portal_pin_hash.
 *
 * Lockout: MAX_FAILURES wrong PINs for one person on one device lock that
 * pair for LOCK_MS (other people on the device and the same person on
 * other devices are not affected). Failures older than LOCK_MS are
 * forgotten; a correct PIN clears the counter.
 */

const argon2 = require('argon2');
const { getDb } = require('../db/connection');
const argon2Options = require('../utils/argon2Options');
const activity = require('./activity');

const PIN_RE = /^\d{4,6}$/;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

function validPin(pin) {
  return typeof pin === 'string' && PIN_RE.test(pin);
}

function hasPin(userId) {
  const row = getDb().prepare('SELECT portal_pin_hash FROM users WHERE id = ?').get(userId);
  return !!(row && row.portal_pin_hash);
}

async function setPin(userId, pin, { actorId = null, ip = null, source = 'user' } = {}) {
  if (!validPin(pin)) throw Object.assign(new Error('The PIN must have 4 to 6 digits'), { code: 'INVALID_PIN' });
  const db = getDb();
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
  if (!user) throw Object.assign(new Error('User not found'), { code: 'NOT_FOUND' });
  const hash = await argon2.hash(pin, argon2Options);
  db.prepare("UPDATE users SET portal_pin_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, userId);
  db.prepare('DELETE FROM portal_pin_failures WHERE user_id = ?').run(userId);
  activity.log('portal_pin_set', `Portal PIN set for user "${user.username}"`, {
    source, ipAddress: ip, severity: 'info', details: { userId, actorId },
  });
  return true;
}

function clearPin(userId, { actorId = null, ip = null, source = 'admin' } = {}) {
  const db = getDb();
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
  if (!user) throw Object.assign(new Error('User not found'), { code: 'NOT_FOUND' });
  db.prepare("UPDATE users SET portal_pin_hash = NULL, updated_at = datetime('now') WHERE id = ?").run(userId);
  db.prepare('DELETE FROM portal_pin_failures WHERE user_id = ?').run(userId);
  activity.log('portal_pin_reset', `Portal PIN removed for user "${user.username}"`, {
    source, ipAddress: ip, severity: 'warning', details: { userId, actorId },
  });
  return true;
}

/** Current lock of a person on a device: { locked, retryAfter (s) }. */
function lockState(userId, peerId, now = Date.now()) {
  const row = getDb().prepare('SELECT locked_until FROM portal_pin_failures WHERE user_id = ? AND peer_id = ?').get(userId, peerId);
  if (row && row.locked_until && row.locked_until > now) {
    return { locked: true, retryAfter: Math.ceil((row.locked_until - now) / 1000) };
  }
  return { locked: false, retryAfter: 0 };
}

function recordFailure(userId, peerId, now) {
  const db = getDb();
  const row = db.prepare('SELECT failures, updated_at FROM portal_pin_failures WHERE user_id = ? AND peer_id = ?').get(userId, peerId);
  const fresh = row && now - row.updated_at < LOCK_MS ? row.failures : 0;
  const failures = fresh + 1;
  const lockedUntil = failures >= MAX_FAILURES ? now + LOCK_MS : null;
  db.prepare(`INSERT INTO portal_pin_failures (user_id, peer_id, failures, locked_until, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, peer_id) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until, updated_at = excluded.updated_at`)
    .run(userId, peerId, lockedUntil ? 0 : failures, lockedUntil, now);
  return { failures, lockedUntil };
}

/**
 * Check a PIN for a person on a device.
 * → { ok: true } | { ok: false, reason: 'locked'|'no_pin'|'wrong', retryAfter?, attemptsLeft? }
 */
async function verify(userId, peerId, pin, { ip = null } = {}) {
  const now = Date.now();
  const lock = lockState(userId, peerId, now);
  if (lock.locked) return { ok: false, reason: 'locked', retryAfter: lock.retryAfter };
  const row = getDb().prepare('SELECT username, portal_pin_hash FROM users WHERE id = ? AND enabled = 1').get(userId);
  if (!row || !row.portal_pin_hash) return { ok: false, reason: 'no_pin' };
  let good = false;
  if (validPin(pin)) {
    try { good = await argon2.verify(row.portal_pin_hash, pin); } catch { good = false; }
  }
  if (good) {
    getDb().prepare('DELETE FROM portal_pin_failures WHERE user_id = ? AND peer_id = ?').run(userId, peerId);
    return { ok: true };
  }
  const f = recordFailure(userId, peerId, now);
  if (f.lockedUntil) {
    activity.log('portal_pin_locked', `Portal PIN of "${row.username}" locked on a shared device after ${MAX_FAILURES} wrong attempts`, {
      source: 'system', ipAddress: ip, severity: 'warning', details: { userId, peerId, minutes: LOCK_MS / 60000 },
    });
    return { ok: false, reason: 'locked', retryAfter: Math.ceil(LOCK_MS / 1000) };
  }
  return { ok: false, reason: 'wrong', attemptsLeft: MAX_FAILURES - f.failures };
}

module.exports = { validPin, hasPin, setPin, clearPin, verify, lockState, PIN_RE, MAX_FAILURES, LOCK_MS };
