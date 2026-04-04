'use strict';

const argon2 = require('argon2');
const { getDb } = require('../db/connection');
const activity = require('./activity');
const logger = require('../utils/logger');
const argon2Options = require('../utils/argon2Options');

const NO_PASSWORD_SENTINEL = '!';

const ROLE_SCOPES = {
  admin: null, // null = all scopes allowed
  user: ['client', 'client:services', 'client:traffic', 'client:dns', 'client:rdp'],
};

/**
 * Get the allowed scopes for a role.
 * Admin gets all VALID_SCOPES, user gets the subset defined in ROLE_SCOPES.
 */
function getAllowedScopes(role) {
  if (ROLE_SCOPES[role] === null) {
    const { VALID_SCOPES } = require('./tokens');
    return [...VALID_SCOPES];
  }
  return ROLE_SCOPES[role] || [];
}

/**
 * Filter a scopes array to only what the role allows.
 */
function filterScopesForRole(scopes, role) {
  const allowed = getAllowedScopes(role);
  return scopes.filter((s) => allowed.includes(s));
}

/**
 * Remove password_hash from a user row.
 */
function stripSensitive(row) {
  if (!row) return row;
  const { password_hash, ...rest } = row;
  return rest;
}

/**
 * List all users (without password_hash).
 */
function list() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all();
  return rows.map(stripSensitive);
}

/**
 * Get a user by ID (without password_hash).
 */
function getById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row ? stripSensitive(row) : null;
}

/**
 * Get a user by username (without password_hash).
 */
function getByUsername(username) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  return row ? stripSensitive(row) : null;
}

/**
 * Get a user by ID with password_hash (for auth).
 */
function getByIdWithHash(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

/**
 * Get a user by username with password_hash (for auth).
 */
function getByUsernameWithHash(username) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}

/**
 * Create a new user.
 * Admin users require a password. Client users get NO_PASSWORD_SENTINEL.
 */
async function create({ username, displayName, role, password, email }) {
  if (!username || typeof username !== 'string' || username.trim().length === 0) {
    throw new Error('Username is required');
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) {
    throw new Error('Username already exists');
  }

  const effectiveRole = role || 'admin';
  let passwordHash;

  if (effectiveRole === 'admin') {
    if (!password) {
      throw new Error('Password is required for admin users');
    }
    passwordHash = await argon2.hash(password, argon2Options);
  } else {
    passwordHash = NO_PASSWORD_SENTINEL;
  }

  const result = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, email, role)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    username.trim(),
    passwordHash,
    displayName || null,
    email || null,
    effectiveRole,
  );

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);

  activity.log('user_created', `User "${username.trim()}" created`, {
    source: 'admin',
    severity: 'info',
    details: { userId: user.id, role: effectiveRole },
  });

  logger.info({ userId: user.id, username: username.trim(), role: effectiveRole }, 'User created');

  return stripSensitive(user);
}

/**
 * Create a client user (synchronous, no password).
 */
function createClientUser({ username, displayName, email }) {
  if (!username || typeof username !== 'string' || username.trim().length === 0) {
    throw new Error('Username is required');
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) {
    throw new Error('Username already exists');
  }

  const result = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, email, role)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    username.trim(),
    NO_PASSWORD_SENTINEL,
    displayName || null,
    email || null,
    'user',
  );

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);

  activity.log('user_created', `Client user "${username.trim()}" created`, {
    source: 'admin',
    severity: 'info',
    details: { userId: user.id, role: 'user' },
  });

  logger.info({ userId: user.id, username: username.trim() }, 'Client user created');

  return stripSensitive(user);
}

/**
 * Update a user's fields.
 */
function update(id, data) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('User not found');

  // Prevent changing the last admin's role to 'user'
  if (data.role === 'user' && user.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count;
    if (adminCount <= 1) {
      throw new Error('Cannot change role of last admin');
    }
  }

  const fields = [];
  const values = [];

  if (data.displayName !== undefined) {
    fields.push('display_name = ?');
    values.push(data.displayName);
  }
  if (data.email !== undefined) {
    fields.push('email = ?');
    values.push(data.email);
  }
  if (data.role !== undefined) {
    fields.push('role = ?');
    values.push(data.role);
  }
  if (data.language !== undefined) {
    fields.push('language = ?');
    values.push(data.language);
  }
  if (data.theme !== undefined) {
    fields.push('theme = ?');
    values.push(data.theme);
  }

  if (fields.length === 0) return getById(id);

  fields.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  activity.log('user_updated', `User "${user.username}" updated`, {
    source: 'admin',
    severity: 'info',
    details: { userId: id },
  });

  return getById(id);
}

/**
 * Toggle a user's enabled state.
 */
function toggle(id) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('User not found');

  // Prevent disabling the last enabled admin
  if (user.enabled === 1 && user.role === 'admin') {
    const enabledAdminCount = db.prepare(
      "SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND enabled = 1"
    ).get().count;
    if (enabledAdminCount <= 1) {
      throw new Error('Cannot disable last enabled admin');
    }
  }

  const newEnabled = user.enabled === 1 ? 0 : 1;
  db.prepare("UPDATE users SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(newEnabled, id);

  activity.log('user_toggled', `User "${user.username}" ${newEnabled ? 'enabled' : 'disabled'}`, {
    source: 'admin',
    severity: 'info',
    details: { userId: id, enabled: !!newEnabled },
  });

  return getById(id);
}

/**
 * Delete a user. Prevents deleting the last admin.
 */
function remove(id) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('User not found');

  if (user.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count;
    if (adminCount <= 1) {
      throw new Error('Cannot delete last admin');
    }
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(id);

  activity.log('user_deleted', `User "${user.username}" deleted`, {
    source: 'admin',
    severity: 'warning',
    details: { userId: id },
  });

  logger.info({ userId: id, username: user.username }, 'User deleted');

  return true;
}

/**
 * Check if a user is enabled.
 */
function isEnabled(id) {
  const db = getDb();
  const row = db.prepare('SELECT enabled FROM users WHERE id = ?').get(id);
  return row ? row.enabled === 1 : false;
}

/**
 * Check if a user has a real password (not sentinel).
 */
function hasPassword(id) {
  const db = getDb();
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id);
  return row ? row.password_hash !== NO_PASSWORD_SENTINEL : false;
}

/**
 * Count of tokens for a user.
 */
function getTokenCount(userId) {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM api_tokens WHERE user_id = ?').get(userId);
  return row.count;
}

/**
 * Count of distinct peers for a user's tokens.
 */
function getPeerCount(userId) {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(DISTINCT peer_id) as count FROM api_tokens WHERE user_id = ? AND peer_id IS NOT NULL'
  ).get(userId);
  return row.count;
}

/**
 * Most recent last_used_at across a user's tokens.
 */
function getLastAccess(userId) {
  const db = getDb();
  const row = db.prepare(
    'SELECT MAX(last_used_at) as last_access FROM api_tokens WHERE user_id = ?'
  ).get(userId);
  return row ? row.last_access : null;
}

module.exports = {
  NO_PASSWORD_SENTINEL,
  ROLE_SCOPES,
  getAllowedScopes,
  filterScopesForRole,
  stripSensitive,
  list,
  getById,
  getByUsername,
  getByIdWithHash,
  getByUsernameWithHash,
  create,
  createClientUser,
  update,
  toggle,
  remove,
  isEnabled,
  hasPassword,
  getTokenCount,
  getPeerCount,
  getLastAccess,
};
