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
  'gateway',
  'pihole', 'pihole:control',
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
  // Gateway scope
  ['/api/v1/gateway', 'gateway'],
  // Pi-hole scopes (control path before base path)
  ['/api/v1/pihole/blocking', 'pihole:control'],
  ['/api/v1/pihole', 'pihole'],
  // Server resource scopes
  ['/api/v1/peers', 'peers'],
  ['/api/v1/routes', 'routes'],
  // Domain zones (routes page): zones, per-domain gateway, hosts, templates
  ['/api/v1/zones', 'routes'],
  ['/api/v1/domains', 'routes'],
  ['/api/v1/hosts', 'routes'],
  ['/api/v1/host-templates', 'routes'],
  // TLS guard (certificate status, preflight, retry)
  ['/api/v1/tls', 'routes'],
  // Web Application Firewall (status, events, per-route exclusions)
  ['/api/v1/waf', 'routes'],
  // Security check + exposure (docs/feature-release-b.md §1/§10)
  ['/api/v1/security', 'routes'],
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
 * GET endpoints that return secrets (decrypted key material, credentials,
 * credential-bearing URLs, full backups) or manage identities. `read-only`
 * does NOT cover them: they need `full-access` or the resource scope from
 * SCOPE_MAP (e.g. `peers` for a peer config; /api/v1/rdp has no resource
 * scope, so RDP credentials need `full-access`). Matched against the
 * normalised path (lower case, no duplicate or trailing slashes) because
 * Express routes case-insensitively and ignores a trailing slash.
 */
const READ_ONLY_DENY = [
  // WireGuard client config incl. private + preshared key (download and QR)
  /^\/api\/v1\/peers\/[^/]+\/(?:config|qr)(?:\/|$)/,
  // Decrypted RDP credentials (admin API) and the client connect endpoint,
  // which hands out route credentials E2EE-wrapped to a caller-chosen key
  // (needs `client:rdp`, like the RDP clients have)
  /^\/api\/v1\/rdp\/[^/]+\/credentials(?:\/|$)/,
  /^\/api\/v1\/client\/rdp\/[^/]+\/connect(?:\/|$)/,
  // Webhook target URLs routinely embed the receiver's secret token
  /^\/api\/v1\/webhooks(?:\/|$)/,
  // Full database backups, autobackup files, off-site targets / SSH key
  /^\/api\/v1\/settings\/(?:backup|autobackup|restore)(?:\/|$)/,
  // Identity + token management (session-only anyway; defence in depth)
  /^\/api\/v1\/(?:tokens|users|enrollment)(?:\/|$)/,
];

function normalizeApiPath(path) {
  return String(path || '').toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
}

function isReadOnlyDenied(path) {
  const p = normalizeApiPath(path);
  return READ_ONLY_DENY.some((rx) => rx.test(p));
}

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
 * Check if a token's scopes permit access to a given path (method-agnostic).
 * Used for tests + simple scope-gating. Delegates to the per-method checker
 * via a method that exercises the full deny path (POST).
 */
function hasPathAccess(path, scopes) {
  if (!Array.isArray(scopes)) return false;
  // full-access allows everything
  if (scopes.includes('full-access')) return true;
  // Check per-resource scopes (ordered: specific paths first)
  for (const [prefix, scope] of SCOPE_MAP) {
    if (path.startsWith(prefix)) {
      return scopes.includes(scope);
    }
  }
  return false;
}

/**
 * Check if a token's scopes permit access to a given path and method
 */
function checkScope(scopes, path, method) {
  if (!Array.isArray(scopes)) return false;

  // full-access allows everything
  if (scopes.includes('full-access')) return true;

  // read-only allows GET on any endpoint except the secret-returning ones
  // (READ_ONLY_DENY) — those fall through to the per-resource scopes below.
  if (scopes.includes('read-only') && method === 'GET' && !isReadOnlyDenied(path)) return true;

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
function create({ name, scopes, expiresAt, machineBindingEnabled, userId, peerId, splitTunnelOverride }, ipAddress) {
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
    INSERT INTO api_tokens (name, token_hash, scopes, expires_at, machine_binding_enabled, user_id, peer_id, split_tunnel_override)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(),
    tokenHash,
    JSON.stringify(scopes),
    expiresAt || null,
    machineBindingEnabled ? 1 : 0,
    userId || null,
    peerId || null,
    splitTunnelOverride || null
  );

  const token = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(result.lastInsertRowid);

  activity.log('token_created', `API token "${name.trim()}" created`, {
    source: 'admin',
    ipAddress,
    severity: 'info',
    details: { tokenId: token.id, userId: userId || null, peerId: peerId || null, scopes, expiresAt: expiresAt || null },
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

  // Defense-in-depth: explicit timing-safe comparison of stored vs computed
  // hash, mirroring gatewayAuth, to neutralise any theoretical timing leak
  // from the b-tree index lookup.
  const storedBuf = Buffer.from(row.token_hash, 'utf8');
  const computedBuf = Buffer.from(tokenHash, 'utf8');
  if (storedBuf.length !== computedBuf.length || !crypto.timingSafeEqual(storedBuf, computedBuf)) {
    return null;
  }

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
 * Machine binding state as the server applies it (licence + setting
 * machine_binding.mode). `mode` is the stored setting ('off' | 'global' |
 * 'individual'), `licensed` whether the licence carries machine_binding.
 */
function machineBindingState() {
  const license = require('./license');
  const settings = require('./settings');
  const raw = settings.get('machine_binding.mode', 'off');
  const mode = ['off', 'global', 'individual'].includes(raw) ? raw : 'off';
  return { licensed: !!license.hasFeature('machine_binding'), mode };
}

/**
 * Whether a token is machine-bound right now: licensed and either the global
 * mode, or the individual mode with the token's own flag set.
 * `token` is a row or a formatted token (machine_binding_enabled 1/true).
 */
function isMachineBindingActive(token, state) {
  const st = state || machineBindingState();
  if (!st.licensed) return false;
  if (st.mode === 'global') return true;
  if (st.mode === 'individual') {
    return !!(token && (token.machine_binding_enabled === true || token.machine_binding_enabled === 1));
  }
  return false;
}

/**
 * Store a machine fingerprint on a token (one-time binding)
 * Returns true if bound, false if already bound to a different machine.
 * The first binding (NULL → fingerprint) also stamps machine_bound_at and
 * logs `machine_binding_bound` — exactly once per binding: the UPDATE only
 * matches while the column is still empty, so two concurrent first requests
 * cannot both log.
 */
function bindMachineFingerprint(tokenId, fingerprint) {
  const db = getDb();
  const row = db.prepare('SELECT machine_fingerprint, name FROM api_tokens WHERE id = ?').get(tokenId);
  if (!row) return false;

  if (row.machine_fingerprint === fingerprint) return true;
  if (row.machine_fingerprint != null) return false;

  const res = db.prepare(`UPDATE api_tokens SET machine_fingerprint = ?, machine_bound_at = datetime('now')
    WHERE id = ? AND machine_fingerprint IS NULL`).run(fingerprint, tokenId);
  if (res.changes === 0) {
    // Lost a race against a concurrent first request: accept only the same device.
    const now = db.prepare('SELECT machine_fingerprint FROM api_tokens WHERE id = ?').get(tokenId);
    return !!now && now.machine_fingerprint === fingerprint;
  }
  logger.info({ tokenId, fingerprint: fingerprint.substring(0, 8) }, 'Token bound to machine');
  try {
    activity.log('machine_binding_bound', `Token "${row.name}" bound to device ${fingerprint.substring(0, 8)}…`, {
      details: { tokenId, fingerprint: fingerprint.substring(0, 8) },
      source: 'api',
      severity: 'info',
    });
  } catch (err) { logger.warn({ err: err.message }, 'activity log write failed (machine_binding_bound)'); }
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
 * Clear machine fingerprint and its timestamp (admin reset): the next client
 * request binds the token again, to whichever device sends it.
 */
function resetMachineBinding(tokenId) {
  const db = getDb();
  const row = db.prepare('SELECT machine_fingerprint, name FROM api_tokens WHERE id = ?').get(tokenId);
  if (!row) throw new Error('Token not found');
  db.prepare('UPDATE api_tokens SET machine_fingerprint = NULL, machine_bound_at = NULL WHERE id = ?').run(tokenId);
  logger.info({ tokenId }, 'Machine binding reset');
  return true;
}

/**
 * Edit an existing token (Users page, "Zugang bearbeiten"):
 *   name, expiresAt (ISO in the future, or null = never), scopes, userId
 *   (new owner; must exist and be enabled, null = no owner) and
 *   splitTunnelOverride (validated preset object, or null = server default).
 * Scopes are always capped by the role of the (new) owner — a token can
 * never do more than its owner. Returns { token, dropped } where `dropped`
 * lists requested scopes the owner's role does not allow.
 */
function update(id, data, { ip = null, actorId = null } = {}) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id);
  if (!row) throw new Error('Token not found');
  const users = require('./users');
  const fields = [];
  const values = [];
  const changes = [];

  let ownerId = row.user_id;
  if (data.userId !== undefined) {
    if (data.userId === null) {
      ownerId = null;
    } else {
      const owner = users.getById(Number(data.userId));
      if (!owner) throw Object.assign(new Error('User not found'), { code: 'USER_NOT_FOUND' });
      if (owner.enabled !== 1) throw Object.assign(new Error('Owner is disabled'), { code: 'OWNER_DISABLED' });
      ownerId = owner.id;
    }
    if (ownerId !== row.user_id) {
      fields.push('user_id = ?'); values.push(ownerId); changes.push('owner');
    }
  }

  if (data.name !== undefined) {
    if (typeof data.name !== 'string' || !data.name.trim()) throw new Error('Token name is required');
    if (data.name.trim().length > 100) throw new Error('Token name too long (max 100 chars)');
    fields.push('name = ?'); values.push(data.name.trim()); changes.push('name');
  }

  if (data.expiresAt !== undefined) {
    if (data.expiresAt) {
      const d = new Date(data.expiresAt);
      if (isNaN(d.getTime()) || d <= new Date()) throw new Error('Expiry date must be in the future');
      fields.push('expires_at = ?'); values.push(d.toISOString());
    } else {
      fields.push('expires_at = NULL');
    }
    changes.push('expiry');
  }

  let requested = data.scopes !== undefined ? data.scopes : (typeof row.scopes === 'string' ? JSON.parse(row.scopes) : row.scopes);
  let dropped = [];
  if (data.scopes !== undefined || changes.includes('owner')) {
    const scopeErr = validateScopes(requested);
    if (scopeErr) throw new Error(scopeErr);
    let capped = [...new Set(requested)];
    if (ownerId != null) {
      const owner = users.getById(ownerId);
      capped = users.filterScopesForRole(capped, owner.role);
    }
    dropped = requested.filter((s) => !capped.includes(s));
    if (!capped.length) throw Object.assign(new Error('No valid scopes for the owner role'), { code: 'NO_VALID_SCOPES' });
    fields.push('scopes = ?'); values.push(JSON.stringify(capped)); changes.push('scopes');
  }

  if (data.splitTunnelOverride !== undefined) {
    fields.push('split_tunnel_override = ?');
    values.push(data.splitTunnelOverride ? JSON.stringify(data.splitTunnelOverride) : null);
    changes.push('split_tunnel');
  }

  if (!fields.length) return { token: formatToken(row), dropped };
  values.push(id);
  db.prepare(`UPDATE api_tokens SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  activity.log('token_updated', `API token "${row.name}" updated (${changes.join(', ')})`, {
    source: 'admin', ipAddress: ip, severity: changes.includes('owner') || changes.includes('scopes') ? 'warning' : 'info',
    details: { tokenId: id, userId: ownerId, previousUserId: row.user_id, actorId, changes },
  });
  return { token: formatToken(db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id)), dropped };
}

/**
 * Delete/revoke a token
 */
function revoke(id, ipAddress, { source = 'admin' } = {}) {
  const db = getDb();
  const token = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id);
  if (!token) throw new Error('Token not found');

  db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id);
  // A revoked device loses its push stream at once (notification center).
  require('./notify').onTokenRevoked(id);

  activity.log('token_deleted', `API token "${token.name}" revoked`, {
    source,
    ipAddress,
    severity: 'warning',
    details: { tokenId: id, userId: token.user_id || null, peerId: token.peer_id || null },
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
    machine_bound_at: row.machine_bound_at || null,
    created_at: row.created_at,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    split_tunnel_override: row.split_tunnel_override || null,
    enrolled: row.enrolled === 1,
    // Portal: 'single' (owner only) | 'multi' (shared device, "Wer bist du?")
    device_usage: row.device_usage === 'multi' ? 'multi' : 'single',
  };
}

// Hex characters of the fingerprint the admin API shows — enough to tell two
// devices apart on the Users page, never the full hash.
const FINGERPRINT_DISPLAY_LEN = 8;

/**
 * A formatted token for the admin API (token lists on the Users page):
 * the fingerprint shortened to FINGERPRINT_DISPLAY_LEN, plus the machine
 * binding as the server applies it:
 *   machine_binding_mode    the global setting ('off'|'global'|'individual')
 *   machine_binding_active  binding enforced for this token right now
 * `state` (machineBindingState()) can be passed in for a whole list.
 */
function deviceUsersOf(tokenId) {
  try { return require('./portalDevices').listForToken(tokenId); } catch { return []; }
}

function toAdminView(token, state) {
  if (!token) return token;
  const st = state || machineBindingState();
  const fp = token.machine_fingerprint;
  return {
    ...token,
    machine_fingerprint: fp ? String(fp).substring(0, FINGERPRINT_DISPLAY_LEN) : null,
    machine_binding_mode: st.mode,
    machine_binding_active: isMachineBindingActive(token, st),
    // People who may pick themselves on a shared device (owner excluded).
    device_users: deviceUsersOf(token.id),
  };
}

function toAdminList(list) {
  const st = machineBindingState();
  return list.map((t) => toAdminView(t, st));
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
  update,
  revoke,
  bindPeer,
  bindMachineFingerprint,
  resetMachineBinding,
  setMachineBindingEnabled,
  machineBindingState,
  isMachineBindingActive,
  toAdminView,
  toAdminList,
  FINGERPRINT_DISPLAY_LEN,
  validateFingerprint,
  checkScope,
  validateScopes,
  hashToken,
  hasPathAccess,
  listByUserId,
  listUnassigned,
  assignToUser,
  isReadOnlyDenied,
  VALID_SCOPES,
  SCOPE_MAP,
  READ_ONLY_DENY,
};
