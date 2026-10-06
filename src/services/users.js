'use strict';

const argon2 = require('argon2');
const { getDb } = require('../db/connection');
const activity = require('./activity');
const logger = require('../utils/logger');
const argon2Options = require('../utils/argon2Options');
const mideaOwners = require('./midea/mideaOwners');
const smarthomeOwners = require('./smarthome/smarthomeOwners');
const skodaOwners = require('./skoda/skodaOwners');

const NO_PASSWORD_SENTINEL = '!';

const ROLE_SCOPES = {
  admin: null, // null = all scopes allowed
  // Members: the app scopes plus read-only Pi-hole statistics (per device,
  // off by default when a device is set up). Never pihole:control.
  user: ['client', 'client:services', 'client:traffic', 'client:dns', 'client:rdp', 'pihole'],
};

const ROLES = ['admin', 'user'];
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 200;

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
  // 2FA secret and recovery-code hashes never leave the service; the
  // totp_enabled flag stays (users list badge / policy checks). Instead of
  // the hash only the fact that a real password exists is exposed.
  const { password_hash, totp_secret_enc, recovery_codes, webauthn_user_id, portal_pin_hash, ...rest } = row;
  if (password_hash !== undefined) rest.has_password = !!password_hash && password_hash !== NO_PASSWORD_SENTINEL;
  // Portal PIN (shared devices): only whether one is set.
  if (portal_pin_hash !== undefined) rest.has_portal_pin = !!portal_pin_hash;
  return rest;
}

/**
 * Whether an account may sign in to the web UI at all (password, 2FA step,
 * passkey): enabled, and either an administrator or a member with
 * "Mein Bereich" switched on. Members without it only use their devices.
 */
function canWebLogin(user) {
  if (!user || user.enabled !== 1) return false;
  if (user.role === 'admin') return true;
  return user.role === 'user' && user.self_service_enabled === 1;
}

/**
 * Password policy for every password this service sets (admin reset, role
 * change, invitation): at least PASSWORD_MIN_LENGTH characters plus the
 * configurable complexity rules (Einstellungen → Anmeldung). Returns a list
 * of { key, params } (i18n keys) — empty when the password is fine.
 */
function passwordPolicyErrors(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return [{ key: 'error.security.password_min_length', params: { min: PASSWORD_MIN_LENGTH } }];
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return [{ key: 'error.users.password_too_long', params: { max: PASSWORD_MAX_LENGTH } }];
  }
  const { validatePasswordComplexity } = require('../utils/validate');
  return validatePasswordComplexity(password) || [];
}

function policyError(errors) {
  const err = new Error('Password does not meet the policy');
  err.code = 'PASSWORD_POLICY';
  err.policy = errors;
  return err;
}

/** New accounts start in the server's default language (GC_DEFAULT_LANGUAGE). */
function defaultLanguage() {
  try { return require('../../config/default').i18n.defaultLanguage || 'en'; } catch { return 'en'; }
}

function codedError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function countEnabledAdmins(db) {
  return db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND enabled = 1").get().c;
}

/**
 * Remove everything that lets an account sign in to the web UI: password,
 * pending password change, 2FA, passkeys and open invitations. Sessions are
 * destroyed by the route (it owns the session store). No own transaction.
 */
function clearWebLogin(db, id) {
  db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, totp_enabled = 0,
      totp_secret_enc = NULL, totp_confirmed_at = NULL, recovery_codes = NULL, updated_at = datetime('now')
    WHERE id = ?`).run(NO_PASSWORD_SENTINEL, id);
  db.prepare('DELETE FROM admin_passkeys WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM user_invites WHERE user_id = ?').run(id);
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
 * The Users page list: every account plus what the list shows — owned
 * peers (devices), tokens, passkeys, the last token use and an open
 * invitation. One query, no N+1.
 */
function listForAdmin() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM peers p WHERE p.user_id = u.id) AS peer_count,
      (SELECT COUNT(*) FROM api_tokens t WHERE t.user_id = u.id) AS token_count,
      (SELECT MAX(t.last_used_at) FROM api_tokens t WHERE t.user_id = u.id) AS last_token_use,
      (SELECT COUNT(*) FROM admin_passkeys k WHERE k.user_id = u.id) AS passkey_count,
      (SELECT COUNT(*) FROM user_invites i WHERE i.user_id = u.id AND i.used_at IS NULL AND i.expires_at > ?) AS open_invites
    FROM users u ORDER BY u.created_at ASC, u.id ASC
  `).all(Date.now());
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
 * Create a new user.
 * Admin users require a password. Client users get NO_PASSWORD_SENTINEL.
 */
async function create({ username, displayName, role, password, email, mustChangePassword = false }) {
  if (!username || typeof username !== 'string' || username.trim().length === 0) {
    throw new Error('Username is required');
  }
  validateProfileFields({ displayName, email });

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
    const policy = passwordPolicyErrors(password);
    if (policy.length) throw policyError(policy);
    passwordHash = await argon2.hash(password, argon2Options);
  } else {
    passwordHash = NO_PASSWORD_SENTINEL;
  }

  const isAdmin = effectiveRole === 'admin';
  const result = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, email, role, must_change_password, password_changed_at, language)
    VALUES (?, ?, ?, ?, ?, ?, ${isAdmin ? "datetime('now')" : 'NULL'}, ?)
  `).run(
    username.trim(),
    passwordHash,
    displayName || null,
    email || null,
    effectiveRole,
    isAdmin && mustChangePassword ? 1 : 0,
    defaultLanguage(),
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
  validateProfileFields({ displayName, email });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) {
    throw new Error('Username already exists');
  }

  const result = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, email, role, language)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    username.trim(),
    NO_PASSWORD_SENTINEL,
    displayName || null,
    email || null,
    'user',
    defaultLanguage(),
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

function validateProfileFields({ displayName, email }) {
  if (displayName !== undefined && displayName !== null
    && (typeof displayName !== 'string' || displayName.length > 100)) {
    throw codedError('INVALID', 'display_name must be a string of at most 100 characters');
  }
  if (email !== undefined && email !== null && email !== ''
    && (typeof email !== 'string' || email.length > 255 || require('../utils/validate').validateEmail(email))) {
    throw codedError('INVALID_EMAIL', 'email must be a valid address of at most 255 characters');
  }
}

/**
 * Update a user's fields (display name, e-mail, language). A role passed
 * here goes through changeRole() — promoting a member needs a password.
 */
async function update(id, data, opts = {}) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('User not found');

  if (data.role !== undefined && data.role !== user.role) {
    await changeRole(id, data.role, { password: data.password, mustChangePassword: !!data.mustChangePassword, actorId: opts.actorId, ip: opts.ip });
  } else if (data.role !== undefined && !ROLES.includes(data.role)) {
    throw codedError('INVALID_ROLE', 'role must be "admin" or "user"');
  }

  const fields = [];
  const values = [];

  validateProfileFields({ displayName: data.displayName, email: data.email });
  if (data.displayName !== undefined) {
    fields.push('display_name = ?');
    values.push(data.displayName === null ? null : String(data.displayName).trim() || null);
  }
  if (data.email !== undefined) {
    fields.push('email = ?');
    values.push(data.email === null ? null : String(data.email).trim() || null);
  }
  if (data.language !== undefined) {
    fields.push('language = ?');
    values.push(data.language);
  }
  // data.theme is ignored: Aurora is the only theme (docs/feature-aurora-only.md).
  // data.password is ignored here: use setPassword() (admin reset endpoint).

  if (fields.length === 0) return getById(id);

  fields.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  activity.log('user_updated', `User "${user.username}" updated`, {
    source: 'admin',
    ipAddress: opts.ip,
    severity: 'info',
    details: { userId: id },
  });

  return getById(id);
}

/**
 * Set a new web-login password for an account (admin reset or invitation).
 * Members need "Mein Bereich" for a password to mean anything.
 *   mustChangePassword  the next login asks for an own password first
 */
async function setPassword(id, password, { mustChangePassword = false, actorId = null, ip = null, source = 'admin' } = {}) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('User not found');
  if (user.role !== 'admin' && user.self_service_enabled !== 1) {
    throw codedError('NO_WEB_LOGIN', 'Members without "Mein Bereich" have no password');
  }
  const policy = passwordPolicyErrors(password);
  if (policy.length) throw policyError(policy);
  const hash = await argon2.hash(password, argon2Options);
  db.prepare(`UPDATE users SET password_hash = ?, must_change_password = ?, password_changed_at = datetime('now'),
      updated_at = datetime('now') WHERE id = ?`).run(hash, mustChangePassword ? 1 : 0, id);
  activity.log('user_password_reset', `Password for user "${user.username}" set by an administrator`, {
    source, ipAddress: ip, severity: 'warning', details: { userId: id, actorId, mustChange: !!mustChangePassword },
  });
  logger.info({ userId: id, actorId }, 'User password set');
  return getById(id);
}

/**
 * Change the role. Promotion to admin needs a password in the same step
 * (a member has none — '!' could never log in). Demotion removes every web
 * login (password, 2FA, passkeys, invitations) unless the member already
 * has "Mein Bereich"; the last enabled admin cannot be demoted.
 */
async function changeRole(id, role, { password, mustChangePassword = false, actorId = null, ip = null } = {}) {
  if (!ROLES.includes(role)) throw codedError('INVALID_ROLE', 'role must be "admin" or "user"');
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('User not found');
  if (user.role === role) return getById(id);

  if (role === 'admin') {
    if (!password) throw codedError('PASSWORD_REQUIRED', 'Password is required for admin users');
    const policy = passwordPolicyErrors(password);
    if (policy.length) throw policyError(policy);
    const hash = await argon2.hash(password, argon2Options);
    db.prepare(`UPDATE users SET role = 'admin', password_hash = ?, must_change_password = ?,
        password_changed_at = datetime('now'), self_service_enabled = 0, self_enroll_enabled = 0,
        updated_at = datetime('now') WHERE id = ?`).run(hash, mustChangePassword ? 1 : 0, id);
  } else {
    if (user.role === 'admin' && user.enabled === 1 && countEnabledAdmins(db) <= 1) {
      throw new Error('Cannot change role of last admin');
    }
    db.transaction(() => {
      db.prepare("UPDATE users SET role = 'user', self_service_enabled = 0, updated_at = datetime('now') WHERE id = ?").run(id);
      clearWebLogin(db, id);
    })();
  }

  activity.log('user_role_changed', `Role of user "${user.username}" changed to ${role}`, {
    source: 'admin', ipAddress: ip, severity: 'warning', details: { userId: id, actorId, from: user.role, to: role },
  });
  logger.info({ userId: id, from: user.role, to: role }, 'User role changed');
  return getById(id);
}

/**
 * "Mein Bereich" for a member. Switching it on happens with an invitation
 * (services/userInvites); switching it off removes the web login.
 */
function disableSelfService(id, { actorId = null, ip = null } = {}) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('User not found');
  if (user.role !== 'user') throw codedError('NOT_MEMBER', 'Only members have "Mein Bereich"');
  db.transaction(() => {
    db.prepare("UPDATE users SET self_service_enabled = 0, self_enroll_enabled = 0, updated_at = datetime('now') WHERE id = ?").run(id);
    clearWebLogin(db, id);
  })();
  activity.log('user_self_service_disabled', `"Mein Bereich" disabled for user "${user.username}"`, {
    source: 'admin', ipAddress: ip, severity: 'warning', details: { userId: id, actorId },
  });
  return getById(id);
}

/** Per member: may create setup codes for own new devices on /me. */
function setSelfEnroll(id, enabled, { actorId = null, ip = null } = {}) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('User not found');
  if (user.role !== 'user') throw codedError('NOT_MEMBER', 'Only members need this permission');
  db.prepare("UPDATE users SET self_enroll_enabled = ?, updated_at = datetime('now') WHERE id = ?").run(enabled ? 1 : 0, id);
  activity.log('user_self_enroll_changed', `Own device setup ${enabled ? 'allowed' : 'not allowed'} for user "${user.username}"`, {
    source: 'admin', ipAddress: ip, severity: 'info', details: { userId: id, actorId, enabled: !!enabled },
  });
  return getById(id);
}

/**
 * Toggle a user's enabled state. Disabling a member also removes the web
 * login of "Mein Bereich" (password, passkeys, invitations): after
 * re-enabling, a new invitation is needed.
 */
function toggle(id, { actorId = null, ip = null } = {}) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('User not found');

  // Prevent disabling the last enabled admin
  if (user.enabled === 1 && user.role === 'admin') {
    if (countEnabledAdmins(db) <= 1) {
      throw new Error('Cannot disable last enabled admin');
    }
  }

  const newEnabled = user.enabled === 1 ? 0 : 1;
  db.transaction(() => {
    db.prepare("UPDATE users SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(newEnabled, id);
    if (!newEnabled && user.role === 'user') {
      db.prepare('UPDATE users SET self_service_enabled = 0, self_enroll_enabled = 0 WHERE id = ?').run(id);
      clearWebLogin(db, id);
    }
  })();

  activity.log('user_toggled', `User "${user.username}" ${newEnabled ? 'enabled' : 'disabled'}`, {
    source: 'admin',
    ipAddress: ip,
    severity: newEnabled ? 'info' : 'warning',
    details: { userId: id, actorId, enabled: !!newEnabled },
  });

  return getById(id);
}

function parseIdList(json) {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) && v.length ? v : null;
  } catch { return null; }
}

/**
 * Everything a delete changes, computed from the data (the delete dialog
 * lists it): the user's tokens (revoked), owned peers (kept without an
 * owner), route / RDP visibility entries (removed; an entry that only named
 * this user stays so the route stays hidden instead of becoming public),
 * owned portal resources (ownership removed). Activity entries stay.
 */
function deleteImpact(id) {
  const db = getDb();
  const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('User not found');
  const tokens = db.prepare('SELECT id, name, peer_id, enrolled FROM api_tokens WHERE user_id = ? ORDER BY id').all(id);
  const peers = db.prepare('SELECT id, name, allowed_ips FROM peers WHERE user_id = ? ORDER BY name').all(id)
    .map((p) => ({ id: p.id, name: p.name, ip: String(p.allowed_ips || '').split('/')[0] }));
  const visibility = (table, label) => db.prepare(`SELECT id, ${label} AS name, user_ids FROM ${table} WHERE user_ids IS NOT NULL AND user_ids <> ''`).all()
    .map((r) => ({ id: r.id, name: r.name, ids: parseIdList(r.user_ids) }))
    .filter((r) => r.ids && r.ids.includes(id))
    .map((r) => ({ id: r.id, name: r.name, onlyThisUser: r.ids.length === 1 }));
  const routes = visibility('routes', "COALESCE(NULLIF(label, ''), domain)");
  const rdp = visibility('rdp_routes', 'name');
  const count = (sql) => { try { return db.prepare(sql).get(id).c; } catch { return 0; } };
  const portal = {
    midea: count('SELECT COUNT(*) AS c FROM midea_device_owners WHERE user_id = ?'),
    smarthome: count('SELECT COUNT(*) AS c FROM smarthome_resource_owners WHERE user_id = ?'),
    skoda: count('SELECT COUNT(*) AS c FROM skoda_vehicle_owners WHERE user_id = ?'),
  };
  const activityCount = count(`SELECT COUNT(*) AS c FROM activity_log WHERE json_valid(details) AND json_extract(details, '$.userId') = ?`);
  return {
    user: { id: user.id, username: user.username, role: user.role },
    tokens: tokens.map((t) => ({ id: t.id, name: t.name, device: t.peer_id != null || t.enrolled === 1 })),
    peers,
    routes,
    rdp,
    portal,
    activity: activityCount,
    lastAdmin: user.role === 'admin' && db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c <= 1,
  };
}

function stripFromVisibility(db, table, id) {
  const rows = db.prepare(`SELECT id, user_ids FROM ${table} WHERE user_ids IS NOT NULL AND user_ids <> ''`).all();
  const upd = db.prepare(`UPDATE ${table} SET user_ids = ? WHERE id = ?`);
  for (const r of rows) {
    const ids = parseIdList(r.user_ids);
    // A list that only named this user is left as it is: emptying it would
    // make the entry visible for everyone.
    if (!ids || !ids.includes(id) || ids.length === 1) continue;
    upd.run(JSON.stringify(ids.filter((x) => x !== id)), r.id);
  }
}

/**
 * Delete a user. Prevents deleting the last admin. Tokens are deleted,
 * owned peers stay without an owner, portal ownership and visibility
 * entries are removed (see deleteImpact).
 */
function remove(id, { actorId = null, ip = null } = {}) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('User not found');

  if (user.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count;
    if (adminCount <= 1) {
      throw new Error('Cannot delete last admin');
    }
  }

  const impact = deleteImpact(id);
  db.transaction(() => {
    db.prepare('DELETE FROM api_tokens WHERE user_id = ?').run(id);
    db.prepare('UPDATE peers SET user_id = NULL WHERE user_id = ?').run(id);
    mideaOwners.removeAllForUser(id);                 // clear AC ownership (no own tx)
    smarthomeOwners.removeAllForUser(id);             // clear smarthome ownership (no own tx)
    skodaOwners.removeAllForUser(id);                 // clear Skoda vehicle ownership (no own tx)
    stripFromVisibility(db, 'routes', id);
    stripFromVisibility(db, 'rdp_routes', id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  })();

  activity.log('user_deleted', `User "${user.username}" deleted`, {
    source: 'admin',
    ipAddress: ip,
    severity: 'warning',
    details: { userId: id, actorId, tokens: impact.tokens.length, peers: impact.peers.length },
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
  ROLES,
  PASSWORD_MIN_LENGTH,
  getAllowedScopes,
  filterScopesForRole,
  stripSensitive,
  canWebLogin,
  passwordPolicyErrors,
  list,
  listForAdmin,
  getById,
  create,
  createClientUser,
  update,
  setPassword,
  changeRole,
  disableSelfService,
  setSelfEnroll,
  toggle,
  deleteImpact,
  remove,
  isEnabled,
  hasPassword,
  getTokenCount,
  getPeerCount,
  getLastAccess,
};
