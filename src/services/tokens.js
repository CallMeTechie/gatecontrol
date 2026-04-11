'use strict';

const crypto = require('node:crypto');
const { getDb } = require('../db/connection');
const logger = require('../utils/logger');
const activity = require('./activity');

const TOKEN_PREFIX = 'gc_';
const TOKEN_BYTES = 48;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;

const VALID_SCOPES = [
  'read-only', 'full-access',
  'peers', 'routes', 'settings', 'webhooks', 'logs', 'system', 'backup',
  'client', 'client:services', 'client:traffic', 'client:dns', 'client:rdp',
];

/**
 * Map API path prefixes to required scopes
 * Order matters: more specific paths must come first
 */
const SCOPE_MAP = [
  // Client sub-scopes (specific paths first)
  ['/api/v1/client/services', 'client:services'],
  ['/api/v1/client/traffic', 'client:traffic'],
  ['/api/v1/client/dns-check', 'client:dns'],
  ['/api/v1/client/rdp', 'client:rdp'],
  // Client base (ping, register, config, heartbeat, status, peer-info, update)
  ['/api/v1/client', 'client'],
  // Server resource scopes
  ['/api/v1/peers', 'peers'],
  ['/api/v1/routes', 'routes'],
  ['/api/v1/settings', 'settings'],
  ['/api/v1/webhooks', 'webhooks'],
  ['/api/v1/logs', 'logs'],
  ['/api/v1/system', 'system'],
  ['/api/v1/dashboard', 'read-only'],
  ['/api/v1/wg', 'system'],
  ['/api/v1/caddy', 'system'],
  ['/api/v1/smtp', 'settings'],
];

/**
 * Hash a raw token string with SHA-256
 */
function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Generate a new raw token
 */
function generateRawToken() {
  return TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Validate scopes array
 */
function validateScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return 'At least one scope is required';
  }
  for (const s of scopes) {
    if (!VALID_SCOPES.includes(s)) {
      return `Invalid scope: ${s}`;
    }
  }
  return null;
}

/**
 * Validate a machine fingerprint (SHA256 hex string)
 */
function validateFingerprint(fp) {
  if (!fp || typeof fp !== 'string') return 'Fingerprint is required';
  if (!FINGERPRINT_RE.test(fp)) return 'Invalid fingerprint format (expected SHA256 hex)';
  return null;
}

/**
 * Check if a token's scopes permit access to a given path and method
 */
function checkScope(scopes, path, method) {
  if (!Array.isArray(scopes)) return false;

  // full-access allows everything
  if (scopes.includes('full-access')) return true;

  // read-only allows GET on any endpoint
  if (scopes.includes('read-only') && method === 'GET') return true;

  // Check per-resource scopes (ordered: specific paths first)
  for (const [prefix, scope] of SCOPE_MAP) {
    if (path.startsWith(prefix)) {
      return scopes.includes(scope);
    }
  }

  // If no specific scope mapping, deny
  return false;
}

/**
 * Create a new API token
 * Returns the raw token (shown once) and the stored record
 */
function create({ name, scopes, expiresAt, machineBindingEnabled, userId, peerId }, ipAddress) {
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Token name is required');
  }
  if (name.trim().length > 100) {
    throw new Error('Token name too long (max 100 chars)');
  }

  const scopeErr = validateScopes(scopes);
  if (scopeErr) throw new Error(scopeErr);

  if (expiresAt) {
    const expDate = new Date(expiresAt);
    if (isNaN(expDate.getTime()) || expDate <= new Date()) {
      throw new Error('Expiry date must be in the future');
    }
  }

  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO api_tokens (name, token_hash, scopes, expires_at, machine_binding_enabled, user_id, peer_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(),
    tokenHash,
    JSON.stringify(scopes),
    expiresAt || null,
    machineBindingEnabled ? 1 : 0,
    userId || null,
    peerId || null
  );

  const token = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(result.lastInsertRowid);

  activity.log('token_created', `API token "${name.trim()}" created`, {
    tokenId: token.id,
    scopes,
    expiresAt: expiresAt || null,
  }, {
    source: 'user',
    ipAddress,
    severity: 'info',
  });

  logger.info({ tokenId: token.id, name: name.trim() }, 'API token created');

  return {
    rawToken,
    token: formatToken(token),
  };
}

/**
 * List all tokens (without hashes)
 */
function list() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_tokens ORDER BY created_at DESC').all();
  return rows.map(formatToken);
}

/**
 * Get a token by ID (without hash)
 */
function getById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id);
  return row ? formatToken(row) : null;
}

/**
 * Authenticate a raw token
 * Returns the token record if valid, null otherwise
 */
function authenticate(rawToken) {
  if (!rawToken || typeof rawToken !== 'string' || !rawToken.startsWith(TOKEN_PREFIX)) {
    return null;
  }

  const tokenHash = hashToken(rawToken);
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(tokenHash);

  if (!row) return null;

  // Check expiry
  if (row.expires_at) {
    const expiry = new Date(row.expires_at);
    if (expiry <= new Date()) return null;
  }

  // Update last_used_at
  db.prepare(`UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(row.id);

  return formatToken(row);
}

/**
 * Bind a token to a specific peer (one-time after registration)
 * Returns true if bound, false if already bound to a different peer
 */
function bindPeer(tokenId, peerId) {
  const db = getDb();
  const row = db.prepare('SELECT peer_id FROM api_tokens WHERE id = ?').get(tokenId);
  if (!row) return false;

  // Already bound to this peer — ok
  if (row.peer_id === peerId) return true;

  // Already bound to a different peer — reject
  if (row.peer_id != null) return false;

  db.prepare('UPDATE api_tokens SET peer_id = ? WHERE id = ?').run(peerId, tokenId);
  logger.info({ tokenId, peerId }, 'API token bound to peer');
  return true;
}

/**
 * Get the bound peer ID for a token (null if unbound)
 */
function getBoundPeerId(tokenId) {
  const db = getDb();
  const row = db.prepare('SELECT peer_id FROM api_tokens WHERE id = ?').get(tokenId);
  return row ? row.peer_id : null;
}

/**
 * Store a machine fingerprint on a token (one-time binding)
 * Returns true if bound, false if already bound to a different machine
 */
function bindMachineFingerprint(tokenId, fingerprint) {
  const db = getDb();
  const row = db.prepare('SELECT machine_fingerprint FROM api_tokens WHERE id = ?').get(tokenId);
  if (!row) return false;

  if (row.machine_fingerprint === fingerprint) return true;
  if (row.machine_fingerprint != null) return false;

  db.prepare('UPDATE api_tokens SET machine_fingerprint = ? WHERE id = ?').run(fingerprint, tokenId);
  logger.info({ tokenId, fingerprint: fingerprint.substring(0, 8) }, 'Token bound to machine');
  return true;
}

/**
 * Toggle machine_binding_enabled on an existing token
 */
function setMachineBindingEnabled(tokenId, enabled) {
  const db = getDb();
  const row = db.prepare('SELECT id FROM api_tokens WHERE id = ?').get(tokenId);
  if (!row) throw new Error('Token not found');
  db.prepare('UPDATE api_tokens SET machine_binding_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, tokenId);
  logger.info({ tokenId, enabled }, 'Machine binding toggled');
  return true;
}

/**
 * Clear machine fingerprint (admin reset)
 */
function resetMachineBinding(tokenId) {
  const db = getDb();
  const row = db.prepare('SELECT machine_fingerprint, name FROM api_tokens WHERE id = ?').get(tokenId);
  if (!row) throw new Error('Token not found');
  db.prepare('UPDATE api_tokens SET machine_fingerprint = NULL WHERE id = ?').run(tokenId);
  logger.info({ tokenId }, 'Machine binding reset');
  return true;
}

/**
 * Delete/revoke a token
 */
function revoke(id, ipAddress) {
  const db = getDb();
  const token = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id);
  if (!token) throw new Error('Token not found');

  db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id);

  activity.log('token_deleted', `API token "${token.name}" revoked`, {
    tokenId: id,
  }, {
    source: 'user',
    ipAddress,
    severity: 'warning',
  });

  logger.info({ tokenId: id, name: token.name }, 'API token revoked');
  return true;
}

/**
 * Format a token row for API output (strip hash)
 */
function formatToken(row) {
  return {
    id: row.id,
    name: row.name,
    scopes: typeof row.scopes === 'string' ? JSON.parse(row.scopes) : row.scopes,
    peer_id: row.peer_id || null,
    machine_fingerprint: row.machine_fingerprint || null,
    user_id: row.user_id || null,
    machine_binding_enabled: row.machine_binding_enabled === 1,
    created_at: row.created_at,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
  };
}

/**
 * List tokens belonging to a specific user
 */
function listByUserId(userId) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  return rows.map(formatToken);
}

/**
 * List tokens not assigned to any user
 */
function listUnassigned() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_tokens WHERE user_id IS NULL ORDER BY created_at DESC').all();
  return rows.map(formatToken);
}

/**
 * Assign an unassigned token to a user
 */
function assignToUser(tokenId, userId) {
  const db = getDb();
  const token = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(tokenId);
  if (!token) throw new Error('Token not found');
  if (token.user_id !== null) throw new Error('Token is already assigned to a user');
  db.prepare('UPDATE api_tokens SET user_id = ? WHERE id = ?').run(userId, tokenId);
  return formatToken(db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(tokenId));
}

module.exports = {
  create,
  list,
  getById,
  authenticate,
  revoke,
  bindPeer,
  getBoundPeerId,
  bindMachineFingerprint,
  resetMachineBinding,
  setMachineBindingEnabled,
  validateFingerprint,
  checkScope,
  validateScopes,
  hashToken,
  listByUserId,
  listUnassigned,
  assignToUser,
  VALID_SCOPES,
};
