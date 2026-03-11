'use strict';

const { getDb } = require('../db/connection');
const logger = require('../utils/logger');

/**
 * Get a setting value by key
 */
function get(key, defaultValue = null) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

/**
 * Set a setting value
 */
function set(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, String(value));
}

/**
 * Get all settings as key-value object
 */
function getAll() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const result = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

/**
 * Delete a setting
 */
function remove(key) {
  const db = getDb();
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

/**
 * Update user profile (display name, email, language)
 */
function updateUserProfile(userId, data) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('User not found');

  db.prepare(`
    UPDATE users SET
      display_name = COALESCE(?, display_name),
      email = COALESCE(?, email),
      language = COALESCE(?, language),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    data.display_name !== undefined ? data.display_name : null,
    data.email !== undefined ? data.email : null,
    data.language !== undefined ? data.language : null,
    userId
  );

  logger.info({ userId, changes: Object.keys(data) }, 'User profile updated');
  return db.prepare('SELECT id, username, display_name, email, role, language, theme, last_login_at, created_at FROM users WHERE id = ?').get(userId);
}

/**
 * Get user profile (safe fields)
 */
function getUserProfile(userId) {
  const db = getDb();
  return db.prepare('SELECT id, username, display_name, email, role, language, theme, last_login_at, created_at FROM users WHERE id = ?').get(userId);
}

module.exports = {
  get,
  set,
  getAll,
  remove,
  updateUserProfile,
  getUserProfile,
};
