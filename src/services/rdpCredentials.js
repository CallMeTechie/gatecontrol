'use strict';

const { getDb } = require('../db/connection');
const { encrypt, decrypt } = require('../utils/crypto');
const activity = require('./activity');
const logger = require('../utils/logger');

const VALID_CREDENTIAL_MODES = ['none', 'user_only', 'full'];

/**
 * Encryption helpers
 *
 * encryptCredentials() returns a partial row patch (only the columns
 * the caller actually changed). Empty-string and null inputs explicitly
 * clear the column — undefined leaves it alone.
 */
function encryptCredentials(data) {
  const result = {};
  if (data.username !== undefined && data.username !== null && data.username !== '') {
    result.username_encrypted = encrypt(data.username);
  } else if (data.username === '' || data.username === null) {
    result.username_encrypted = null;
  }
  if (data.password !== undefined && data.password !== null && data.password !== '') {
    result.password_encrypted = encrypt(data.password);
  } else if (data.password === '' || data.password === null) {
    result.password_encrypted = null;
  }
  return result;
}

/**
 * Decrypt the stored ciphertext columns. Each column is wrapped in its
 * own try/catch so a single corrupted blob doesn't fail the whole row;
 * decrypt_failed flags either failure for the caller.
 */
function decryptCredentials(row) {
  const result = { username: null, password: null, decrypt_failed: false };
  try {
    if (row.username_encrypted) result.username = decrypt(row.username_encrypted);
  } catch (err) {
    logger.warn({ error: err.message }, 'Failed to decrypt RDP username');
    result.decrypt_failed = true;
  }
  try {
    if (row.password_encrypted) result.password = decrypt(row.password_encrypted);
  } catch (err) {
    logger.warn({ error: err.message }, 'Failed to decrypt RDP password');
    result.decrypt_failed = true;
  }
  return result;
}

// ─── Public CRUD-like helpers ───────────────────────────────────

function getCredentials(id) {
  const db = getDb();
  const row = db.prepare(
    'SELECT username_encrypted, password_encrypted, credential_mode, domain FROM rdp_routes WHERE id = ?'
  ).get(id);
  if (!row) throw new Error('RDP route not found');
  if (row.credential_mode === 'none') {
    return { credential_mode: 'none', username: null, password: null, domain: null };
  }

  const creds = decryptCredentials(row);
  return {
    credential_mode: row.credential_mode,
    username: creds.username,
    // 'user_only' means we deliberately withhold the password — only
    // the username is shared back to the client. The DB still stores
    // the password ciphertext for completeness; it just never leaves
    // the server in this mode.
    password: row.credential_mode === 'full' ? creds.password : null,
    domain: row.domain,
  };
}

function setCredentials(id, { username, password, domain, credential_mode }) {
  const db = getDb();
  const route = db.prepare('SELECT id, name FROM rdp_routes WHERE id = ?').get(id);
  if (!route) throw new Error('RDP route not found');

  const sets = [];
  const values = [];

  if (credential_mode !== undefined) {
    if (!VALID_CREDENTIAL_MODES.includes(credential_mode)) {
      throw new Error('Invalid credential mode');
    }
    sets.push('credential_mode = ?');
    values.push(credential_mode);
  }
  if (username !== undefined) {
    sets.push('username_encrypted = ?');
    values.push(username ? encrypt(username) : null);
  }
  if (password !== undefined) {
    sets.push('password_encrypted = ?');
    values.push(password ? encrypt(password) : null);
  }
  if (domain !== undefined) {
    sets.push('domain = ?');
    values.push(domain || null);
  }

  if (sets.length === 0) return;

  sets.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE rdp_routes SET ${sets.join(', ')} WHERE id = ?`).run(...values);

  activity.log('rdp_credentials_updated', `Credentials for RDP route "${route.name}" updated`, {
    source: 'admin',
    severity: 'info',
    details: { routeId: id },
  });
}

function clearCredentials(id) {
  const db = getDb();
  const route = db.prepare('SELECT id, name FROM rdp_routes WHERE id = ?').get(id);
  if (!route) throw new Error('RDP route not found');

  db.prepare(`UPDATE rdp_routes SET
    credential_mode = 'none',
    username_encrypted = NULL,
    password_encrypted = NULL,
    domain = NULL,
    updated_at = datetime('now')
    WHERE id = ?`).run(id);

  activity.log('rdp_credentials_cleared', `Credentials for RDP route "${route.name}" cleared`, {
    source: 'admin',
    severity: 'warning',
    details: { routeId: id },
  });
}

module.exports = {
  VALID_CREDENTIAL_MODES,
  encryptCredentials,
  decryptCredentials,
  getCredentials,
  setCredentials,
  clearCredentials,
};
