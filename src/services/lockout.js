'use strict';

const { getDb } = require('../db/connection');
const settings = require('./settings');
const logger = require('../utils/logger');

const DEFAULTS = {
  enabled: true,
  maxAttempts: 5,
  duration: 15, // minutes
};

/**
 * Read lockout settings from DB with defaults
 */
function getSettings() {
  return {
    enabled: settings.get('security.lockout.enabled', 'true') === 'true',
    maxAttempts: parseInt(settings.get('security.lockout.max_attempts', String(DEFAULTS.maxAttempts)), 10) || DEFAULTS.maxAttempts,
    duration: parseInt(settings.get('security.lockout.duration', String(DEFAULTS.duration)), 10) || DEFAULTS.duration,
  };
}

/**
 * Record a failed login attempt
 * @param {string} identifier - Username (admin) or IP:routeId (route-auth)
 * @param {string} type - 'admin' or 'route_auth'
 * @param {string} ip - IP address
 */
function recordFailedAttempt(identifier, type, ip) {
  const db = getDb();
  db.prepare(`
    INSERT INTO login_attempts (identifier, type, ip_address)
    VALUES (?, ?, ?)
  `).run(identifier, type, ip || null);
}

/**
 * Check if an identifier is currently locked out
 * @returns {{ locked: boolean, remainingSeconds: number }}
 */
function isLocked(identifier) {
  const cfg = getSettings();
  if (!cfg.enabled) return { locked: false, remainingSeconds: 0 };

  const db = getDb();
  // failed_at is stored via datetime('now') → 'YYYY-MM-DD HH:MM:SS' (space, UTC).
  // Compute the cutoff with the SAME SQLite formatter so the string comparison
  // is valid. A JS toISOString() value ('...T...Z') sorts before the space-
  // separated failed_at at char 10 (' ' < 'T'), which silently made the count
  // always 0 and the lockout never trigger. cleanup() already uses this pattern.
  const count = db.prepare(`
    SELECT COUNT(*) as cnt FROM login_attempts
    WHERE identifier = ? AND failed_at >= datetime('now', '-' || ? || ' minutes')
  `).get(identifier, cfg.duration);

  if (count.cnt >= cfg.maxAttempts) {
    // Find the oldest relevant attempt to calculate remaining time
    const oldest = db.prepare(`
      SELECT failed_at FROM login_attempts
      WHERE identifier = ? AND failed_at >= datetime('now', '-' || ? || ' minutes')
      ORDER BY failed_at ASC
      LIMIT 1
    `).get(identifier, cfg.duration);

    const expiresAt = new Date(oldest.failed_at + 'Z').getTime() + cfg.duration * 60 * 1000;
    const remainingSeconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));

    return { locked: true, remainingSeconds };
  }

  return { locked: false, remainingSeconds: 0 };
}

/**
 * Clear all failed attempts for an identifier (on successful login or manual unlock)
 */
function clearAttempts(identifier) {
  const db = getDb();
  db.prepare('DELETE FROM login_attempts WHERE identifier = ?').run(identifier);
}

/**
 * Get all currently locked accounts
 * @returns {Array<{ identifier: string, type: string, attempts: number, remainingSeconds: number }>}
 */
function getLockedAccounts() {
  const cfg = getSettings();
  if (!cfg.enabled) return [];

  const db = getDb();
  // Same datetime('now', ...) cutoff as isLocked() — see the note there for why
  // a JS toISOString() string would never match the space-separated failed_at.
  const rows = db.prepare(`
    SELECT identifier, type, COUNT(*) as attempts, MIN(failed_at) as first_attempt
    FROM login_attempts
    WHERE failed_at >= datetime('now', '-' || ? || ' minutes')
    GROUP BY identifier
    HAVING attempts >= ?
  `).all(cfg.duration, cfg.maxAttempts);

  return rows.map(row => {
    const expiresAt = new Date(row.first_attempt + 'Z').getTime() + cfg.duration * 60 * 1000;
    const remainingSeconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    return {
      identifier: row.identifier,
      type: row.type,
      attempts: row.attempts,
      remainingSeconds,
    };
  });
}

/**
 * Manually unlock a specific account
 */
function unlockAccount(identifier) {
  clearAttempts(identifier);
  logger.info({ identifier }, 'Account manually unlocked');
}

/**
 * Cleanup old login attempts (called from periodic cleanup job)
 */
function cleanup(daysToKeep = 1) {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM login_attempts
    WHERE failed_at < datetime('now', '-' || ? || ' days')
  `).run(daysToKeep);
  return result.changes;
}

module.exports = {
  getSettings,
  recordFailedAttempt,
  isLocked,
  clearAttempts,
  getLockedAccounts,
  unlockAccount,
  cleanup,
};
