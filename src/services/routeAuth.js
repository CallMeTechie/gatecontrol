'use strict';

const crypto = require('node:crypto');
const argon2 = require('argon2');
const OTPAuth = require('otpauth');
const { getDb } = require('../db/connection');
const { encrypt, decrypt } = require('../utils/crypto');
const argon2Options = require('../utils/argon2Options');
const activity = require('./activity');
const { sendOtpEmail } = require('./email');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Session cleanup
// ---------------------------------------------------------------------------

let cleanupInterval = null;

/**
 * Delete expired sessions, stale 2FA pending sessions (>5 min), and used/expired OTPs
 */
function runCleanup() {
  try {
    const db = getDb();

    // Expired sessions
    const expiredSessions = db.prepare(`
      DELETE FROM route_auth_sessions WHERE expires_at <= datetime('now')
    `).run();

    // Stale 2FA pending sessions older than 5 minutes
    const stalePending = db.prepare(`
      DELETE FROM route_auth_sessions
      WHERE two_factor_pending = 1
        AND created_at <= datetime('now', '-5 minutes')
    `).run();

    // Used or expired OTPs
    const expiredOtps = db.prepare(`
      DELETE FROM route_auth_otp
      WHERE used = 1 OR expires_at <= datetime('now')
    `).run();

    logger.debug(
      {
        expiredSessions: expiredSessions.changes,
        stalePending: stalePending.changes,
        expiredOtps: expiredOtps.changes,
      },
      'Route auth session cleanup complete'
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'Route auth session cleanup failed');
  }
}

/**
 * Start the periodic session cleanup (every 15 minutes)
 */
function startSessionCleanup() {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(runCleanup, 15 * 60 * 1000);
  cleanupInterval.unref();
  logger.info('Route auth session cleanup started (15 min interval)');
}

/**
 * Stop the periodic session cleanup
 */
function stopSessionCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.info('Route auth session cleanup stopped');
  }
}

// ---------------------------------------------------------------------------
// Route Auth CRUD
// ---------------------------------------------------------------------------

/**
 * Get auth config for a route
 */
function getAuthForRoute(routeId) {
  const db = getDb();
  return db.prepare('SELECT * FROM route_auth WHERE route_id = ?').get(routeId);
}

/**
 * Get auth config by domain (only enabled routes)
 */
function getAuthByDomain(domain) {
  const db = getDb();
  return db.prepare(`
    SELECT ra.*
    FROM route_auth ra
    JOIN routes r ON r.id = ra.route_id
    WHERE r.domain = ? AND r.enabled = 1
  `).get(domain);
}

/**
 * Create or update auth config for a route.
 * Disables basic_auth on the route (mutual exclusivity).
 * Hashes password with argon2, encrypts TOTP secret.
 */
async function createOrUpdateAuth(routeId, data, ipAddress) {
  const db = getDb();

  const {
    auth_type,
    two_factor_enabled,
    two_factor_method,
    email,
    password,
    totp_secret,
    session_max_age,
  } = data;

  // Hash password if provided
  let passwordHash = undefined;
  if (password !== undefined && password !== null && password !== '') {
    passwordHash = await argon2.hash(password, argon2Options);
  }

  // Encrypt TOTP secret if provided
  let totpSecretEncrypted = undefined;
  if (totp_secret !== undefined && totp_secret !== null && totp_secret !== '') {
    totpSecretEncrypted = encrypt(totp_secret);
  }

  const existing = db.prepare('SELECT id FROM route_auth WHERE route_id = ?').get(routeId);

  if (existing) {
    // Build dynamic UPDATE
    const fields = [];
    const values = [];

    if (auth_type !== undefined) { fields.push('auth_type = ?'); values.push(auth_type); }
    if (two_factor_enabled !== undefined) { fields.push('two_factor_enabled = ?'); values.push(two_factor_enabled ? 1 : 0); }
    if (two_factor_method !== undefined) { fields.push('two_factor_method = ?'); values.push(two_factor_method); }
    if (email !== undefined) { fields.push('email = ?'); values.push(email); }
    if (passwordHash !== undefined) { fields.push('password_hash = ?'); values.push(passwordHash); }
    if (totpSecretEncrypted !== undefined) { fields.push('totp_secret_encrypted = ?'); values.push(totpSecretEncrypted); }
    if (session_max_age !== undefined) { fields.push('session_max_age = ?'); values.push(session_max_age); }

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      values.push(routeId);
      db.prepare(`UPDATE route_auth SET ${fields.join(', ')} WHERE route_id = ?`).run(...values);
    }
  } else {
    db.prepare(`
      INSERT INTO route_auth (route_id, auth_type, two_factor_enabled, two_factor_method, email, password_hash, totp_secret_encrypted, session_max_age)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      routeId,
      auth_type || 'password',
      two_factor_enabled ? 1 : 0,
      two_factor_method || null,
      email || null,
      passwordHash || null,
      totpSecretEncrypted || null,
      session_max_age !== undefined ? session_max_age : 86400000
    );
  }

  // Disable basic_auth on the route (mutual exclusivity)
  db.prepare(`
    UPDATE routes SET basic_auth_enabled = 0, updated_at = datetime('now') WHERE id = ?
  `).run(routeId);

  activity.log('route_auth_updated', `Route auth configured for route ${routeId}`, {
    details: { routeId, auth_type, two_factor_enabled, two_factor_method },
    source: 'admin',
    ipAddress,
    severity: 'success',
  });

  return getAuthForRoute(routeId);
}

/**
 * Delete auth config for a route (also removes sessions and OTPs)
 */
function deleteAuth(routeId, ipAddress) {
  const db = getDb();

  db.prepare('DELETE FROM route_auth_otp WHERE route_id = ?').run(routeId);
  db.prepare('DELETE FROM route_auth_sessions WHERE route_id = ?').run(routeId);
  db.prepare('DELETE FROM route_auth WHERE route_id = ?').run(routeId);

  activity.log('route_auth_deleted', `Route auth removed for route ${routeId}`, {
    details: { routeId },
    source: 'admin',
    ipAddress,
    severity: 'warning',
  });
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/**
 * Create a new session for a route auth login
 */
function createSession(routeId, email, ip, maxAge, twoFactorPending = false) {
  const db = getDb();
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + maxAge).toISOString();

  db.prepare(`
    INSERT INTO route_auth_sessions (id, route_id, email, ip_address, two_factor_pending, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, routeId, email, ip || null, twoFactorPending ? 1 : 0, expiresAt);

  return { id, expiresAt };
}

/**
 * Verify a session is valid and not pending 2FA
 */
function verifySession(sessionId, routeId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM route_auth_sessions
    WHERE id = ?
      AND route_id = ?
      AND two_factor_pending = 0
      AND expires_at > datetime('now')
  `).get(sessionId, routeId);
}

/**
 * Get a session by id (includes pending sessions)
 */
function getSession(sessionId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM route_auth_sessions
    WHERE id = ? AND expires_at > datetime('now')
  `).get(sessionId);
}

/**
 * Complete 2FA: clear the pending flag and extend session expiry
 */
function completeTwoFactor(sessionId) {
  const db = getDb();

  // Find a 2FA pending session created <5 minutes ago
  const session = db.prepare(`
    SELECT ras.*, ra.session_max_age
    FROM route_auth_sessions ras
    JOIN route_auth ra ON ra.route_id = ras.route_id
    WHERE ras.id = ?
      AND ras.two_factor_pending = 1
      AND ras.created_at > datetime('now', '-5 minutes')
      AND ras.expires_at > datetime('now')
  `).get(sessionId);

  if (!session) return null;

  const newExpiresAt = new Date(Date.now() + session.session_max_age).toISOString();

  db.prepare(`
    UPDATE route_auth_sessions
    SET two_factor_pending = 0, expires_at = ?
    WHERE id = ?
  `).run(newExpiresAt, sessionId);

  return { ...session, two_factor_pending: 0, expires_at: newExpiresAt };
}

/**
 * Delete a session
 */
function deleteSession(sessionId) {
  const db = getDb();
  db.prepare('DELETE FROM route_auth_sessions WHERE id = ?').run(sessionId);
}

// ---------------------------------------------------------------------------
// Password verification
// ---------------------------------------------------------------------------

/**
 * Verify a user's email and password against the stored auth config
 */
async function verifyPassword(authConfig, email, password) {
  if (!authConfig || !authConfig.email || !authConfig.password_hash) return false;
  if (authConfig.email !== email) return false;
  return argon2.verify(authConfig.password_hash, password);
}

// ---------------------------------------------------------------------------
// OTP
// ---------------------------------------------------------------------------

/**
 * Generate a 6-digit OTP code as a zero-padded string
 */
function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/**
 * Hash an OTP code with SHA-256, returning hex
 */
function hashOtp(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

/**
 * Invalidate previous OTPs for this route+email, insert a new one, send via email
 */
async function createAndSendOtp(routeId, email, domain, lang) {
  const db = getDb();

  // Invalidate previous OTPs
  db.prepare(`
    UPDATE route_auth_otp SET used = 1
    WHERE route_id = ? AND email = ? AND used = 0
  `).run(routeId, email);

  const code = generateOtp();
  const codeHash = hashOtp(code);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutes

  db.prepare(`
    INSERT INTO route_auth_otp (route_id, code_hash, email, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(routeId, codeHash, email, expiresAt);

  await sendOtpEmail({ to: email, code, domain, lang });

  activity.log('route_auth_otp_sent', `OTP sent to ${maskEmail(email)} for route ${routeId}`, {
    details: { routeId, email: maskEmail(email), domain },
    source: 'system',
    severity: 'info',
  });

  return { expiresAt };
}

/**
 * Verify an OTP: find latest unused non-expired, compare hash, mark used
 */
function verifyOtp(routeId, email, code) {
  const db = getDb();
  const inputHash = hashOtp(code);

  // Atomic fetch-and-mark-used to prevent TOCTOU race condition
  // Two concurrent requests with the same OTP can no longer both succeed
  const markUsed = db.transaction(() => {
    const otp = db.prepare(`
      SELECT * FROM route_auth_otp
      WHERE route_id = ?
        AND email = ?
        AND used = 0
        AND expires_at > datetime('now')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(routeId, email);

    if (!otp) return null;

    // Timing-safe comparison to prevent side-channel attacks
    let isValid = false;
    try {
      const a = Buffer.from(otp.code_hash, 'hex');
      const b = Buffer.from(inputHash, 'hex');
      isValid = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      isValid = false;
    }

    if (isValid) {
      db.prepare('UPDATE route_auth_otp SET used = 1 WHERE id = ?').run(otp.id);
    }

    return isValid;
  });

  const result = markUsed();
  return result === true;
}

// ---------------------------------------------------------------------------
// TOTP — replay prevention
// ---------------------------------------------------------------------------

const usedTotpCodes = new Map();

function markTotpUsed(routeId, token) {
  const key = `${routeId}:${token}`;
  usedTotpCodes.set(key, Date.now());
  // Cleanup old entries every time
  const cutoff = Date.now() - 90000; // 90s = 3 windows
  for (const [k, ts] of usedTotpCodes) {
    if (ts < cutoff) usedTotpCodes.delete(k);
  }
}

function isTotpUsed(routeId, token) {
  const key = `${routeId}:${token}`;
  return usedTotpCodes.has(key);
}

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

/**
 * Generate a new TOTP secret for the given domain
 * Returns { secret: base32String, uri: otpauthUri }
 */
function generateTotpSecret(domain) {
  const secret = new OTPAuth.Secret();
  const totp = new OTPAuth.TOTP({
    issuer: 'GateControl',
    label: domain,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });

  return {
    secret: secret.base32,
    uri: totp.toString(),
  };
}

/**
 * Verify a TOTP token against an encrypted secret
 */
function verifyTotp(encryptedSecret, token, routeId) {
  if (routeId && isTotpUsed(routeId, String(token))) {
    return false; // replay detected
  }

  let secretBase32;
  try {
    secretBase32 = decrypt(encryptedSecret);
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to decrypt TOTP secret');
    return false;
  }

  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });

  const delta = totp.validate({ token: String(token), window: 1 });
  if (delta === null) return false;

  if (routeId) markTotpUsed(routeId, String(token));
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mask an email address for safe logging: m***@example.com
 */
function maskEmail(email) {
  if (!email || !email.includes('@')) return '***';
  const [local, domain] = email.split('@');
  if (!local || local.length === 0) return `***@${domain}`;
  return `${local[0]}***@${domain}`;
}

module.exports = {
  // Cleanup
  startSessionCleanup,
  stopSessionCleanup,
  // CRUD
  getAuthForRoute,
  getAuthByDomain,
  createOrUpdateAuth,
  deleteAuth,
  // Sessions
  createSession,
  verifySession,
  getSession,
  completeTwoFactor,
  deleteSession,
  // Password
  verifyPassword,
  // OTP
  generateOtp,
  hashOtp,
  createAndSendOtp,
  verifyOtp,
  // TOTP
  generateTotpSecret,
  verifyTotp,
  // Helpers
  maskEmail,
};
