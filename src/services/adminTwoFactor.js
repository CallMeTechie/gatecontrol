'use strict';

// Admin two-factor login (docs/feature-admin-2fa.md).
//
// Owns the per-user TOTP state on `users` (totp_secret_enc / totp_enabled /
// totp_confirmed_at / recovery_codes) and the replay table admin_totp_used.
// The TOTP primitives (secret generation, code check, hashing, replay window)
// are the route-auth ones — reused, not copied. Codes and secrets are never
// logged.

const crypto = require('node:crypto');
const argon2 = require('argon2');
const { getDb } = require('../db/connection');
const { encrypt } = require('../utils/crypto');
const argon2Options = require('../utils/argon2Options');
const routeAuth = require('./routeAuth');
const activity = require('./activity');
const logger = require('../utils/logger');

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 10;
// No 0/O/1/I — the codes are typed by hand from a printout.
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ISSUER = 'GateControl';

function getRow(userId) {
  return getDb().prepare(
    'SELECT id, username, role, totp_secret_enc, totp_enabled, totp_confirmed_at, recovery_codes FROM users WHERE id = ?'
  ).get(userId);
}

function parseHashes(json) {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((h) => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Public status for the profile card / users list.
 */
function getStatus(userId) {
  const row = getRow(userId);
  if (!row) return null;
  return {
    enabled: row.totp_enabled === 1,
    confirmed_at: row.totp_confirmed_at || null,
    // A secret without activation = setup started but not confirmed.
    pending: row.totp_enabled !== 1 && !!row.totp_secret_enc,
    recovery_codes_remaining: row.totp_enabled === 1 ? parseHashes(row.recovery_codes).length : 0,
  };
}

function isEnabled(userId) {
  const row = getDb().prepare('SELECT totp_enabled FROM users WHERE id = ?').get(userId);
  return !!row && row.totp_enabled === 1;
}

/**
 * Start (or restart) the setup: a fresh secret is stored encrypted but NOT
 * active until confirmSetup() sees a valid code. An already active 2FA is
 * left untouched — disable() first.
 */
function beginSetup(userId) {
  const row = getRow(userId);
  if (!row) throw Object.assign(new Error('User not found'), { code: 'NOT_FOUND' });
  if (row.totp_enabled === 1) throw Object.assign(new Error('2FA already enabled'), { code: 'ALREADY_ENABLED' });

  const { secret, uri } = routeAuth.generateTotpSecret(row.username);
  getDb().prepare(
    "UPDATE users SET totp_secret_enc = ?, totp_enabled = 0, totp_confirmed_at = NULL, recovery_codes = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(encrypt(secret), userId);

  return { secret, otpauth_url: uri };
}

function generateRecoveryCodes() {
  const codes = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    let c = '';
    for (let j = 0; j < RECOVERY_CODE_LENGTH; j++) {
      c += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    }
    codes.push(c);
  }
  return codes;
}

// Recovery codes are shown as XXXXX-XXXXX; accept any spacing/case on input.
function normalizeRecoveryCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function formatRecoveryCode(code) {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

async function storeNewRecoveryCodes(userId) {
  const codes = generateRecoveryCodes();
  const hashes = await Promise.all(codes.map((c) => argon2.hash(c, argon2Options)));
  getDb().prepare("UPDATE users SET recovery_codes = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(hashes), userId);
  return codes.map(formatRecoveryCode);
}

/**
 * Activate 2FA once the user proves the authenticator works. Returns the
 * plaintext recovery codes — the only time they are ever visible.
 */
async function confirmSetup(userId, code, ip) {
  const row = getRow(userId);
  if (!row) throw Object.assign(new Error('User not found'), { code: 'NOT_FOUND' });
  if (row.totp_enabled === 1) throw Object.assign(new Error('2FA already enabled'), { code: 'ALREADY_ENABLED' });
  if (!row.totp_secret_enc) throw Object.assign(new Error('Setup not started'), { code: 'NO_SETUP' });

  if (!routeAuth.checkTotpCode(row.totp_secret_enc, code)) {
    return { ok: false };
  }
  // The confirmation code counts as used, so it cannot double as the first
  // login code within the same 90 s window.
  markUsed(userId, code);

  getDb().prepare(
    "UPDATE users SET totp_enabled = 1, totp_confirmed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(userId);
  const recovery_codes = await storeNewRecoveryCodes(userId);

  activity.log('user_2fa_enabled', `Two-factor login enabled for user "${row.username}"`, {
    source: 'admin', ipAddress: ip, severity: 'info', details: { userId },
  });
  logger.info({ userId }, 'Admin 2FA enabled');
  return { ok: true, recovery_codes };
}

/**
 * Replace the recovery codes (caller has verified the password).
 */
async function regenerateRecoveryCodes(userId, ip) {
  const row = getRow(userId);
  if (!row) throw Object.assign(new Error('User not found'), { code: 'NOT_FOUND' });
  if (row.totp_enabled !== 1) throw Object.assign(new Error('2FA not enabled'), { code: 'NOT_ENABLED' });
  const recovery_codes = await storeNewRecoveryCodes(userId);
  activity.log('user_2fa_recovery_regenerated', `Recovery codes regenerated for user "${row.username}"`, {
    source: 'admin', ipAddress: ip, severity: 'info', details: { userId },
  });
  return recovery_codes;
}

/**
 * Wipe all 2FA state; the caller names the activity-log event (own
 * "disable" vs. admin reset).
 */
function clear(userId, { eventType, message, ip, details } = {}) {
  const db = getDb();
  db.prepare(
    "UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0, totp_confirmed_at = NULL, recovery_codes = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(userId);
  db.prepare('DELETE FROM admin_totp_used WHERE user_id = ?').run(userId);
  if (eventType) {
    activity.log(eventType, message, { source: 'admin', ipAddress: ip, severity: 'warning', details: { userId, ...(details || {}) } });
  }
}

function disable(userId, ip) {
  const row = getRow(userId);
  if (!row) throw Object.assign(new Error('User not found'), { code: 'NOT_FOUND' });
  clear(userId, { eventType: 'user_2fa_disabled', message: `Two-factor login disabled for user "${row.username}"`, ip });
  logger.info({ userId }, 'Admin 2FA disabled');
}

function resetByAdmin(userId, adminUserId, ip) {
  const row = getRow(userId);
  if (!row) throw Object.assign(new Error('User not found'), { code: 'NOT_FOUND' });
  clear(userId, {
    eventType: 'user_2fa_reset',
    message: `Two-factor login reset for user "${row.username}" by an administrator`,
    ip,
    details: { byUserId: adminUserId },
  });
  logger.info({ userId, adminUserId }, 'Admin 2FA reset by administrator');
}

// ── replay protection (admin_totp_used) ─────────────────────────────────

function isUsed(userId, code) {
  const cutoff = Date.now() - routeAuth.TOTP_REPLAY_WINDOW_MS;
  try {
    return !!getDb().prepare(
      'SELECT 1 FROM admin_totp_used WHERE user_id = ? AND code = ? AND used_at >= ?'
    ).get(userId, routeAuth.totpHash(code), cutoff);
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to check admin TOTP replay state');
    return false;
  }
}

// Returns true when THIS call claimed the code (first use).
function markUsed(userId, code) {
  const db = getDb();
  const now = Date.now();
  let claimed = true;
  try {
    const info = db.prepare(
      'INSERT OR IGNORE INTO admin_totp_used (user_id, code, used_at) VALUES (?, ?, ?)'
    ).run(userId, routeAuth.totpHash(code), now);
    claimed = info.changes > 0;
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to record used admin TOTP code');
  }
  try {
    db.prepare('DELETE FROM admin_totp_used WHERE used_at < ?').run(now - routeAuth.TOTP_REPLAY_WINDOW_MS);
  } catch { /* opportunistic cleanup */ }
  return claimed;
}

/**
 * Login-time check of a 6-digit code: replay guard + otpauth (window ±1) +
 * atomic claim. Only for users with active 2FA.
 */
function verifyCode(userId, code) {
  const token = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(token)) return false;
  const row = getRow(userId);
  if (!row || row.totp_enabled !== 1 || !row.totp_secret_enc) return false;
  if (isUsed(userId, token)) return false;
  if (!routeAuth.checkTotpCode(row.totp_secret_enc, token)) return false;
  return markUsed(userId, token);
}

/**
 * Single-use recovery code. Every stored hash is verified (no early exit)
 * so a match position is not observable through timing; the matched hash
 * is removed afterwards.
 */
async function verifyRecoveryCode(userId, input) {
  const code = normalizeRecoveryCode(input);
  if (code.length !== RECOVERY_CODE_LENGTH) return false;
  const row = getRow(userId);
  if (!row || row.totp_enabled !== 1) return false;
  const hashes = parseHashes(row.recovery_codes);
  if (hashes.length === 0) return false;

  const results = await Promise.all(hashes.map(async (h) => {
    try { return await argon2.verify(h, code); } catch { return false; }
  }));
  const idx = results.indexOf(true);
  if (idx === -1) return false;

  const remaining = hashes.filter((_, i) => i !== idx);
  getDb().prepare("UPDATE users SET recovery_codes = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(remaining), userId);
  activity.log('user_2fa_recovery_used', `Recovery code used for user "${row.username}" (${remaining.length} left)`, {
    source: 'admin', severity: 'warning', details: { userId, remaining: remaining.length },
  });
  return true;
}

module.exports = {
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  getStatus,
  isEnabled,
  beginSetup,
  confirmSetup,
  regenerateRecoveryCodes,
  disable,
  resetByAdmin,
  verifyCode,
  verifyRecoveryCode,
  normalizeRecoveryCode,
};
