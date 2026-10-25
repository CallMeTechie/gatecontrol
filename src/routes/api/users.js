'use strict';

const { Router } = require('express');
const { requireAdminSession } = require('../../middleware/auth');
const users = require('../../services/users');
const tokens = require('../../services/tokens');
const logger = require('../../utils/logger');
const { validateSplitTunnelPreset } = require('../../utils/validate');
const { withPeers } = require('../../services/tokenPeers');
const avatars = require('../../services/avatars');
const { avatarWriteLimiter } = require('../../middleware/rateLimit');
const { avatarUpload, handlers: avatarHandlers } = require('./avatarApi');

const router = Router();

/** Profile picture and favourite colour of a user row (docs/feature-avatars.md). */
function lookOf(f) {
  return f ? { avatarUrl: f.avatarUrl, color: f.color, colorHex: f.colorHex } : { avatarUrl: null, color: null, colorHex: null };
}

/** Destroy every login session of a user (sessionStore.destroyByUserId). */
function revokeSessions(req, userId, reason, exceptSid = null) {
  if (req.sessionStore && typeof req.sessionStore.destroyByUserId === 'function') {
    const removed = req.sessionStore.destroyByUserId(userId, exceptSid);
    if (removed > 0) logger.info({ userId, removed, reason }, 'Revoked user sessions');
    return removed;
  }
  return 0;
}

/** The person's groups for the profile (services/groups.js); [] when unavailable. */
function groupsOf(id) {
  try { return require('../../services/groups').groupsOfUser(id, { includeInherited: true }); } catch (err) {
    logger.warn({ err: err.message }, 'groups of user unavailable');
    return [];
  }
}

/** The directory an account belongs to (null = local account). */
function directoryOf(id) {
  try {
    const row = require('../../db/connection').getDb().prepare(`SELECT l.directory_id, l.login_name, l.upn, l.state, l.last_seen_at,
        l.linked_at, d.name, d.kind FROM directory_links l JOIN directories d ON d.id = l.directory_id WHERE l.user_id = ?`).get(id);
    if (!row) return null;
    return {
      id: row.directory_id, name: row.name, kind: row.kind, loginName: row.login_name || row.upn || null,
      state: row.state, lastSeenAt: row.last_seen_at, linkedAt: row.linked_at,
    };
  } catch (err) {
    logger.warn({ err: err.message }, 'directory of user unavailable');
    return null;
  }
}

function parseId(req) {
  const id = Number.parseInt(req.params.id, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Policy violations → one translated message. */
function policyMessage(req, policy) {
  return (policy || []).map((e) => {
    let s = req.t(e.key);
    for (const [k, v] of Object.entries(e.params || {})) s = s.split(`{{${k}}}`).join(String(v));
    return s;
  }).join(' · ');
}

/** Map a service error to a response. Returns true when handled. */
function sendKnownError(req, res, err) {
  if (err.message === 'User not found' || err.code === 'NOT_FOUND') {
    res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    return true;
  }
  if (err.code === 'PASSWORD_POLICY') {
    res.status(400).json({ ok: false, code: 'PASSWORD_POLICY', error: policyMessage(req, err.policy) });
    return true;
  }
  const map = {
    PASSWORD_REQUIRED: [400, 'error.users.password_required'],
    INVALID_ROLE: [400, 'error.users.invalid_role'],
    INVALID: [400, 'error.users.display_name_too_long'],
    INVALID_EMAIL: [400, 'error.users.email_invalid'],
    INVALID_LANGUAGE: [400, 'error.users.invalid_language'],
    NO_WEB_LOGIN: [400, 'error.users.no_web_login'],
    NOT_MEMBER: [400, 'error.users.not_member'],
    DISABLED: [400, 'error.users.disabled'],
  };
  if (map[err.code]) {
    res.status(map[err.code][0]).json({ ok: false, code: err.code, error: req.t(map[err.code][1]) });
    return true;
  }
  if (/last (enabled )?admin/.test(err.message)) {
    res.status(400).json({ ok: false, code: 'LAST_ADMIN', error: req.t('error.users.last_admin') });
    return true;
  }
  return false;
}

/**
 * Middleware: Block token auth and require admin role
 */
router.use(requireAdminSession);

/**
 * GET /api/v1/users — List all users with what the list shows
 */
router.get('/', (req, res) => {
  try {
    const rows = users.listForAdmin();
    const looks = avatars.infoMany(rows);
    const list = rows.map((u) => ({
      ...u,
      // Kept for older callers: number of tokens / bound peers / last token use.
      tokenCount: u.token_count,
      peerCount: u.peer_count,
      lastAccess: u.last_token_use,
      ...lookOf(looks.get(u.id)),
    }));
    res.json({ ok: true, users: list, current_user_id: req.session.userId });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list users');
    res.status(500).json({ ok: false, error: req.t('error.users.list') });
  }
});

/**
 * POST /api/v1/users — Create user
 * Admin: password (+ mustChangePassword). Member: no password; the
 * "Mein Bereich" invitation is a second call (POST /:id/invite).
 */
router.post('/', async (req, res) => {
  try {
    const { username, displayName, role, password, email, mustChangePassword } = req.body || {};
    if (typeof username === 'string' && username.trim().length > 100) {
      return res.status(400).json({ ok: false, error: req.t('error.users.username_too_long') });
    }
    let user;
    if (role === 'user') {
      user = users.createClientUser({ username, displayName, email });
    } else if (role === 'admin' || role === undefined) {
      user = await users.create({ username, displayName, role: 'admin', password, email, mustChangePassword: !!mustChangePassword });
    } else {
      return res.status(400).json({ ok: false, error: req.t('error.users.invalid_role') });
    }
    res.status(201).json({ ok: true, user });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to create user');
    if (err.message.includes('UNIQUE') || err.message.includes('already exists')) {
      return res.status(409).json({ ok: false, error: req.t('error.users.duplicate') });
    }
    if (err.message === 'Username is required') {
      return res.status(400).json({ ok: false, error: req.t('error.users.username_required') });
    }
    if (err.message.startsWith('Password is required')) {
      return res.status(400).json({ ok: false, error: req.t('error.users.password_required') });
    }
    if (sendKnownError(req, res, err)) return undefined;
    res.status(500).json({ ok: false, error: req.t('error.users.create') });
  }
});

/**
 * GET /api/v1/users/unassigned-tokens — List tokens without a user
 * MUST be before /:id to avoid Express matching "unassigned-tokens" as an id
 */
router.get('/unassigned-tokens', (req, res) => {
  try {
    const list = withPeers(tokens.toAdminList(tokens.listUnassigned()));
    res.json({ ok: true, tokens: list, machine_binding: tokens.machineBindingState() });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list unassigned tokens');
    res.status(500).json({ ok: false, error: req.t('error.users.unassigned_tokens') });
  }
});

/**
 * GET /api/v1/users/:id — User detail with tokens, passkeys and flags
 */
router.get('/:id', (req, res) => {
  try {
    const id = parseId(req);
    const user = id && users.getById(id);
    if (!user) {
      return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    }
    // Token list incl. machine binding per token (shortened fingerprint,
    // bound-at, effective state) + the global state for the Users page.
    const userTokens = withPeers(tokens.toAdminList(tokens.listByUserId(id)));
    const passkeys = require('../../services/adminPasskeys').list(id);
    const { getDb } = require('../../db/connection');
    const peers = getDb().prepare("SELECT id, name, allowed_ips FROM peers WHERE user_id = ? AND (peer_type IS NULL OR peer_type = 'regular') ORDER BY name")
      .all(id).map((p) => ({ id: p.id, name: p.name, ip: String(p.allowed_ips || '').split('/')[0] }));
    const enabledAdmins = getDb().prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND enabled = 1").get().c;
    res.json({
      ok: true,
      user: { ...user, ...lookOf(avatars.info(id)) },
      tokens: userTokens,
      peers,
      passkeys,
      invite: require('../../services/userInvites').openFor(id),
      is_self: id === req.session.userId,
      last_admin: user.role === 'admin' && user.enabled === 1 && enabledAdmins <= 1,
      machine_binding: tokens.machineBindingState(),
      // Person groups with role; inherited ones (from a subgroup) direct: false.
      groups: groupsOf(id),
      // Source of the account (docs/groups.md "Verzeichnis-Abgleich"): null = local.
      directory: directoryOf(id),
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get user');
    res.status(500).json({ ok: false, error: req.t('error.users.get') });
  }
});

/**
 * PATCH /api/v1/users/:id — Update display name / e-mail / language (a role passed here
 * follows the same rules as POST /:id/role).
 */
router.patch('/:id', async (req, res) => {
  try {
    const id = parseId(req);
    if (!id) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    const body = req.body || {};
    if (body.role !== undefined && body.role !== 'admin' && id === req.session.userId) {
      return res.status(400).json({ ok: false, error: req.t('error.users.self_role') });
    }
    const before = users.getById(id);
    const user = await users.update(id, body, { actorId: req.session.userId, ip: req.ip });
    // A role change (e.g. admin → user) must not survive in sessions that
    // were opened under the old role: log the account out everywhere.
    // API tokens stay; their scopes are capped by the current role on every
    // request (filterScopesForRole in requireAuth).
    if (before && user && before.role !== user.role) {
      revokeSessions(req, id, 'role changed');
    }
    res.json({ ok: true, user });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update user');
    if (sendKnownError(req, res, err)) return undefined;
    res.status(500).json({ ok: false, error: req.t('error.users.update') });
  }
});

/**
 * POST /api/v1/users/:id/role — { role, password?, mustChangePassword? }
 * Promotion needs a password; demotion removes the web login; the last
 * enabled admin and the own account are protected. Signs the user out.
 */
router.post('/:id/role', async (req, res) => {
  try {
    const id = parseId(req);
    if (!id) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    if (id === req.session.userId) {
      return res.status(400).json({ ok: false, error: req.t('error.users.self_role') });
    }
    const { role, password, mustChangePassword } = req.body || {};
    const before = users.getById(id);
    if (!before) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    const user = await users.changeRole(id, role, { password, mustChangePassword: !!mustChangePassword, actorId: req.session.userId, ip: req.ip });
    if (before.role !== user.role) revokeSessions(req, id, 'role changed');
    res.json({ ok: true, user });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to change role');
    if (sendKnownError(req, res, err)) return undefined;
    res.status(500).json({ ok: false, error: req.t('error.users.update') });
  }
});

/**
 * POST /api/v1/users/:id/password — admin sets a new password for ANOTHER
 * account ({ password, mustChangePassword }). Signs that user out
 * everywhere; devices (tokens) keep working. Own account: /profile.
 */
router.post('/:id/password', async (req, res) => {
  try {
    const id = parseId(req);
    if (!id) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    if (id === req.session.userId) {
      return res.status(400).json({ ok: false, error: req.t('error.users.self_password') });
    }
    const { password, mustChangePassword } = req.body || {};
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({ ok: false, error: req.t('error.users.password_required') });
    }
    const user = await users.setPassword(id, password, { mustChangePassword: !!mustChangePassword, actorId: req.session.userId, ip: req.ip });
    const signedOut = revokeSessions(req, id, 'password reset by admin');
    res.json({ ok: true, user, signed_out: signedOut });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to set user password');
    if (sendKnownError(req, res, err)) return undefined;
    res.status(500).json({ ok: false, error: req.t('error.users.update') });
  }
});

/**
 * GET /api/v1/users/:id/delete-impact — what a delete would change
 */
router.get('/:id/delete-impact', (req, res) => {
  try {
    const id = parseId(req);
    if (!id) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    res.json({ ok: true, impact: users.deleteImpact(id), is_self: id === req.session.userId });
  } catch (err) {
    if (sendKnownError(req, res, err)) return undefined;
    logger.error({ error: err.message }, 'Failed to compute delete impact');
    res.status(500).json({ ok: false, error: req.t('error.users.get') });
  }
});

/**
 * GET /api/v1/users/:id/visibility — "Was sieht <Name>?"
 */
router.get('/:id/visibility', (req, res) => {
  try {
    const id = parseId(req);
    const data = id && require('../../services/userVisibility').forUser(id);
    if (!data) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    res.json({ ok: true, ...data });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to compute user visibility');
    res.status(500).json({ ok: false, error: req.t('error.users.get') });
  }
});

/**
 * GET /api/v1/users/:id/activity?limit= — latest activity of this user
 */
router.get('/:id/activity', (req, res) => {
  try {
    const id = parseId(req);
    const user = id && users.getById(id);
    if (!user) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const entries = require('../../services/activity').getForUser(id, user.username, limit)
      .map((e) => ({ id: e.id, event_type: e.event_type, message: e.message, severity: e.severity, created_at: e.created_at }));
    res.json({ ok: true, entries });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to load user activity');
    res.status(500).json({ ok: false, error: req.t('error.logs.recent') });
  }
});

/**
 * GET /api/v1/users/:id/sessions — active browser sessions (no session ids:
 * each is addressed by a digest `ref`)
 * DELETE /api/v1/users/:id/sessions/:ref — sign out one session
 * DELETE /api/v1/users/:id/sessions — sign out all (own account: all others)
 */
router.get('/:id/sessions', (req, res) => {
  const id = parseId(req);
  if (!id || !users.getById(id)) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
  const sessions = require('../../services/userSessions').list(id, id === req.session.userId ? req.sessionID : null);
  res.json({ ok: true, sessions });
});

router.delete('/:id/sessions/:ref', (req, res) => {
  const id = parseId(req);
  const user = id && users.getById(id);
  if (!user) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
  const svc = require('../../services/userSessions');
  if (id === req.session.userId && svc.refOf(req.sessionID) === req.params.ref) {
    return res.status(400).json({ ok: false, error: req.t('error.users.own_session') });
  }
  if (!svc.destroyByRef(id, req.params.ref)) {
    return res.status(404).json({ ok: false, error: req.t('error.users.session_not_found') });
  }
  require('../../services/activity').log('user_session_revoked', `A session of user "${user.username}" was signed out by an administrator`, {
    source: 'admin', ipAddress: req.ip, severity: 'warning', details: { userId: id, actorId: req.session.userId },
  });
  res.json({ ok: true });
});

router.delete('/:id/sessions', (req, res) => {
  const id = parseId(req);
  const user = id && users.getById(id);
  if (!user) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
  const removed = revokeSessions(req, id, 'signed out by admin', id === req.session.userId ? req.sessionID : null);
  require('../../services/activity').log('user_session_revoked', `All sessions of user "${user.username}" were signed out by an administrator`, {
    source: 'admin', ipAddress: req.ip, severity: 'warning', details: { userId: id, actorId: req.session.userId, removed },
  });
  res.json({ ok: true, removed });
});

/**
 * DELETE /api/v1/users/:id/passkeys/:pid — remove another user's passkey
 * (own passkeys: /profile, with re-authentication)
 */
router.delete('/:id/passkeys/:pid', (req, res) => {
  const id = parseId(req);
  if (!id || !users.getById(id)) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
  if (id === req.session.userId) {
    return res.status(400).json({ ok: false, error: req.t('error.users.self_passkey') });
  }
  const pid = Number.parseInt(req.params.pid, 10);
  const passkeys = require('../../services/adminPasskeys');
  try {
    passkeys.remove(id, pid, req.ip);
    res.json({ ok: true, passkeys: passkeys.list(id) });
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ ok: false, error: req.t('passkey.error_not_found') });
    logger.error({ error: err.message }, 'Failed to remove passkey');
    res.status(500).json({ ok: false, error: req.t('error.users.update') });
  }
});

/**
 * POST /api/v1/users/:id/invite — invite a member to "Mein Bereich":
 * one-time link (72 h), shown once; mailed when SMTP and an address exist.
 * DELETE /api/v1/users/:id/self-service — switch "Mein Bereich" off
 * PUT /api/v1/users/:id/self-enroll { enabled } — own device setup on /me
 */
router.post('/:id/invite', async (req, res) => {
  try {
    const id = parseId(req);
    const user = id && users.getById(id);
    if (!user) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    const invites = require('../../services/userInvites');
    const { token, expiresAt } = invites.create(id, { actorId: req.session.userId, ip: req.ip });
    const config = require('../../../config/default');
    let base = '';
    try { base = new URL(config.app.baseUrl).origin; } catch { base = `${req.protocol}://${req.get('host')}`; }
    const link = `${base}/invite/${token}`;
    const emailed = req.body && req.body.email === false ? false : await invites.sendMail({
      to: user.email, link, name: user.display_name || user.username, expiresAt, t: req.t,
    });
    res.status(201).json({ ok: true, link, expiresAt, emailed, user: users.getById(id) });
  } catch (err) {
    if (sendKnownError(req, res, err)) return undefined;
    logger.error({ error: err.message }, 'Failed to create invitation');
    res.status(500).json({ ok: false, error: req.t('error.users.invite') });
  }
});

router.delete('/:id/self-service', (req, res) => {
  try {
    const id = parseId(req);
    if (!id) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    const user = users.disableSelfService(id, { actorId: req.session.userId, ip: req.ip });
    revokeSessions(req, id, 'self-service disabled');
    res.json({ ok: true, user });
  } catch (err) {
    if (sendKnownError(req, res, err)) return undefined;
    logger.error({ error: err.message }, 'Failed to disable self-service');
    res.status(500).json({ ok: false, error: req.t('error.users.update') });
  }
});

/**
 * Devices and shared locations (docs/feature-device-location.md):
 *   GET    /api/v1/users/:id/devices                   → { ok, devices, location }
 *   GET    /api/v1/users/:id/devices/:peerId           → { ok, user, device, location }
 *   DELETE /api/v1/users/:id/devices/:peerId/locations → { ok, deleted }
 *   PUT    /api/v1/users/:id/location-sharing          { enabled } → { ok, user }
 */
function locationInfo(user) {
  const loc = require('../../services/deviceLocations');
  return { allowed: user.location_sharing === 1, keep: loc.LOCATION_KEEP, retention_days: loc.RETENTION_DAYS };
}

function parsePeerId(req) {
  const id = Number.parseInt(req.params.peerId, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

router.get('/:id/devices', (req, res) => {
  try {
    const id = parseId(req);
    const user = id && users.getById(id);
    if (!user) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, devices: require('../../services/userDevices').list(id), location: locationInfo(user) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list user devices');
    res.status(500).json({ ok: false, error: req.t('error.users.get') });
  }
});

router.get('/:id/devices/:peerId', (req, res) => {
  try {
    const id = parseId(req);
    const peerId = parsePeerId(req);
    const user = id && users.getById(id);
    const device = user && peerId && require('../../services/userDevices').detail(id, peerId);
    if (!device) return res.status(404).json({ ok: false, error: req.t('error.users.device_not_found') });
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role, enabled: user.enabled },
      device,
      location: locationInfo(user),
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to load user device');
    res.status(500).json({ ok: false, error: req.t('error.users.get') });
  }
});

router.delete('/:id/devices/:peerId/locations', (req, res) => {
  try {
    const id = parseId(req);
    const peerId = parsePeerId(req);
    const user = id && users.getById(id);
    const devices = require('../../services/userDevices');
    if (!user || !peerId || !devices.belongsTo(id, peerId)) {
      return res.status(404).json({ ok: false, error: req.t('error.users.device_not_found') });
    }
    const deleted = require('../../services/deviceLocations').deleteForPeer(peerId);
    require('../../services/activity').log('user_device_locations_deleted', `Locations of a device of user "${user.username}" deleted by an administrator`, {
      source: 'admin', ipAddress: req.ip, severity: 'info', details: { userId: id, peerId, actorId: req.session.userId, deleted },
    });
    res.json({ ok: true, deleted });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to delete device locations');
    res.status(500).json({ ok: false, error: req.t('error.users.update') });
  }
});

router.put('/:id/location-sharing', (req, res) => {
  try {
    const id = parseId(req);
    const user = id && users.getById(id);
    if (!user) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    if (typeof (req.body || {}).enabled !== 'boolean') {
      return res.status(400).json({ ok: false, error: req.t('error.users.invalid_input') });
    }
    const { enabled } = req.body;
    require('../../services/deviceLocations').setAllowedForUser(id, enabled);
    require('../../services/activity').log('user_location_sharing_changed', `Location sharing ${enabled ? 'allowed' : 'not allowed'} for user "${user.username}"`, {
      source: 'admin', ipAddress: req.ip, severity: 'info', details: { userId: id, actorId: req.session.userId, enabled },
    });
    res.json({ ok: true, user: users.getById(id) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to change location sharing');
    res.status(500).json({ ok: false, error: req.t('error.users.update') });
  }
});

router.put('/:id/self-enroll', (req, res) => {
  try {
    const id = parseId(req);
    if (!id) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    if (typeof (req.body || {}).enabled !== 'boolean') {
      return res.status(400).json({ ok: false, error: req.t('error.users.invalid_input') });
    }
    const user = users.setSelfEnroll(id, req.body.enabled, { actorId: req.session.userId, ip: req.ip });
    res.json({ ok: true, user });
  } catch (err) {
    if (sendKnownError(req, res, err)) return undefined;
    logger.error({ error: err.message }, 'Failed to change self-enroll');
    res.status(500).json({ ok: false, error: req.t('error.users.update') });
  }
});

/**
 * Kiosk devices (docs/feature-kiosk-devices.md) — wall tablets that stay
 * signed in to the portal as this user:
 *   GET    /api/v1/users/:id/kiosk            → { ok, eligible, reason, plugins, devices }
 *   POST   /api/v1/users/:id/kiosk/pair       { name } → { ok, code, expiresAt, url, qr }
 *   DELETE /api/v1/users/:id/kiosk/:deviceId  → { ok }
 * Only for kiosk-eligible users (a plugin with permissions.kiosk marks them;
 * never administrators or disabled accounts). The code is shown once, only
 * its HMAC is stored.
 */
function kioskPluginNames(ids, lang) {
  const plugins = require('../../services/plugins');
  const { loc } = require('../../services/plugins/manifest');
  return ids.map((pid) => {
    const p = plugins.get(pid);
    return p ? (p.manifest && p.manifest.name ? loc(p.manifest.name, lang) : p.name) : pid;
  });
}

function kioskPairUrl(code) {
  const { effectivePortalHost } = require('../../services/portalConfig');
  return `https://${effectivePortalHost().host}/portal/kiosk?code=${encodeURIComponent(code)}`;
}

router.get('/:id/kiosk', (req, res) => {
  try {
    const id = parseId(req);
    const user = id && users.getById(id);
    if (!user) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    const kiosk = require('../../services/kiosk');
    const el = kiosk.eligibility(id);
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      eligible: el.eligible,
      reason: el.reason,
      plugins: kioskPluginNames(el.plugins, req.language === 'en' ? 'en' : 'de'),
      devices: kiosk.listForUser(id),
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list kiosk devices');
    res.status(500).json({ ok: false, error: req.t('error.users.get') });
  }
});

router.post('/:id/kiosk/pair', require('../../middleware/rateLimit').kioskCodeLimiter, async (req, res) => {
  const id = parseId(req);
  const user = id && users.getById(id);
  if (!user) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
  const kiosk = require('../../services/kiosk');
  try {
    const { code, expiresAt } = kiosk.createCode(id, { name: (req.body || {}).name, actorId: req.session.userId, ip: req.ip });
    const url = kioskPairUrl(code);
    let qr = null;
    try { qr = await require('../../services/qrcode').toDataUrl(url); } catch (e) { logger.warn({ err: e.message }, 'kiosk: QR code failed'); }
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ ok: true, code, expiresAt, url, qr });
  } catch (err) {
    const map = {
      NOT_ELIGIBLE: [403, 'error.users.kiosk_not_eligible'],
      INVALID_NAME: [400, 'error.users.kiosk_invalid_name'],
      TOO_MANY_CODES: [409, 'error.users.kiosk_too_many'],
    };
    if (map[err.code]) return res.status(map[err.code][0]).json({ ok: false, code: err.code, error: req.t(map[err.code][1]) });
    logger.error({ error: err.message }, 'Failed to create a kiosk pairing code');
    return res.status(500).json({ ok: false, error: req.t('error.users.update') });
  }
});

router.delete('/:id/kiosk/:deviceId', (req, res) => {
  try {
    const id = parseId(req);
    if (!id || !users.getById(id)) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    const deviceId = Number.parseInt(req.params.deviceId, 10);
    const kiosk = require('../../services/kiosk');
    const done = Number.isSafeInteger(deviceId) && deviceId > 0
      && kiosk.revoke(deviceId, { userId: id, reason: 'revoked', actorId: req.session.userId, ip: req.ip });
    if (!done) return res.status(404).json({ ok: false, error: req.t('error.users.kiosk_not_found') });
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to revoke a kiosk device');
    return res.status(500).json({ ok: false, error: req.t('error.users.update') });
  }
});

/**
 * Profile picture and favourite colour (docs/feature-avatars.md):
 *   PUT    /api/v1/users/:id/avatar  raw body (image/png | image/jpeg | image/webp, ≤ 96 KB) → { ok, avatarUrl }
 *   DELETE /api/v1/users/:id/avatar  → { ok }
 *   PUT    /api/v1/users/:id/color   { color: key | null } → { ok, color, colorHex }
 * Errors as in routes/api/avatarApi.js; unknown user → 404 NOT_FOUND.
 */
function avatarTarget(req, res, next) {
  const id = parseId(req);
  if (!id || !users.getById(id)) return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: req.t('error.users.not_found') });
  req.avatarUserId = id;
  return next();
}
const avatarApi = avatarHandlers((req) => req.avatarUserId, (req) => ({ actorId: req.session.userId, ip: req.ip, source: 'admin' }));
router.put('/:id/avatar', avatarWriteLimiter, avatarTarget, avatarUpload, avatarApi.putAvatar);
router.delete('/:id/avatar', avatarWriteLimiter, avatarTarget, avatarApi.deleteAvatar);
router.put('/:id/color', avatarWriteLimiter, avatarTarget, avatarApi.putColor);

/**
 * DELETE /api/v1/users/:id — Delete user (prevent self-deletion)
 */
router.delete('/:id', (req, res) => {
  try {
    const id = parseId(req);
    if (!id) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    if (id === req.session.userId) {
      return res.status(400).json({ ok: false, error: req.t('error.users.self_delete') });
    }
    users.remove(id, { actorId: req.session.userId, ip: req.ip });
    // Invalidate the deleted user's sessions (route-level, like the password-change flow).
    revokeSessions(req, id, 'user deleted');
    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to delete user');
    if (sendKnownError(req, res, err)) return undefined;
    res.status(500).json({ ok: false, error: req.t('error.users.delete') });
  }
});

/**
 * PUT /api/v1/users/:id/toggle — Enable/disable (prevent self-disable)
 */
router.put('/:id/toggle', (req, res) => {
  try {
    const id = parseId(req);
    if (!id) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    if (id === req.session.userId) {
      return res.status(400).json({ ok: false, error: req.t('error.users.self_disable') });
    }
    const user = users.toggle(id, { actorId: req.session.userId, ip: req.ip });
    // Disabling logs the account out on every device. Its API tokens are
    // refused while the account is disabled (requireAuth checks the owner)
    // and work again once it is re-enabled.
    if (user && user.enabled !== 1) {
      revokeSessions(req, id, 'user disabled');
    }
    res.json({ ok: true, user });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to toggle user');
    if (sendKnownError(req, res, err)) return undefined;
    res.status(500).json({ ok: false, error: req.t('error.users.toggle') });
  }
});

/**
 * DELETE /api/v1/users/:id/2fa — Reset another user's two-factor login
 * (so nobody locks themselves out). Own account: use the profile "disable".
 */
router.delete('/:id/2fa', (req, res) => {
  try {
    const id = parseId(req);
    if (id === req.session.userId) {
      return res.status(400).json({ ok: false, error: req.t('two_fa.error_self_reset') });
    }
    const user = id && users.getById(id);
    if (!user) {
      return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    }
    require('../../services/adminTwoFactor').resetByAdmin(id, req.session.userId, req.ip);
    res.json({ ok: true, user: users.getById(id) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to reset user 2FA');
    res.status(500).json({ ok: false, error: req.t('error.users.update') });
  }
});

/**
 * DELETE /api/v1/users/:id/portal-pin — "PIN zurücksetzen": removes the
 * portal PIN (shared devices). The person sets a new one under "Konto &
 * Sicherheit" or with a new invitation; until then the picker refuses them.
 * Their open portal sessions end as well.
 */
router.delete('/:id/portal-pin', require('../../middleware/rateLimit').portalPinSetLimiter, (req, res) => {
  try {
    const id = parseId(req);
    const user = id && users.getById(id);
    if (!user) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    require('../../services/portalPin').clearPin(id, { actorId: req.session.userId, ip: req.ip });
    if (req.sessionStore && typeof req.sessionStore.destroyPortalSessions === 'function') {
      req.sessionStore.destroyPortalSessions(id);
    }
    res.json({ ok: true, user: users.getById(id) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to reset the portal PIN');
    res.status(500).json({ ok: false, error: req.t('error.users.update') });
  }
});

/**
 * POST /api/v1/users/:id/tokens — Create token for this user ("Schlüssel
 * direkt anzeigen": the raw token is returned once)
 */
router.post('/:id/tokens', (req, res) => {
  try {
    const id = parseId(req);
    const user = id && users.getById(id);
    if (!user) {
      return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    }
    if (user.enabled !== 1) {
      return res.status(400).json({ ok: false, error: req.t('error.users.disabled') });
    }

    const { name, scopes, expires_at, machine_binding_enabled, peer_id, split_tunnel_override } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ ok: false, error: req.t('error.tokens.name_required') });
    }

    if (!scopes || !Array.isArray(scopes) || scopes.length === 0) {
      return res.status(400).json({ ok: false, error: req.t('error.tokens.scopes_required') });
    }

    const filteredScopes = users.filterScopesForRole(scopes, user.role);
    if (filteredScopes.length === 0) {
      return res.status(400).json({ ok: false, error: req.t('error.users.no_valid_scopes') });
    }

    const scopeErr = tokens.validateScopes(filteredScopes);
    if (scopeErr) {
      return res.status(400).json({ ok: false, error: scopeErr });
    }

    if (split_tunnel_override) {
      const stErr = validateSplitTunnelPreset(split_tunnel_override);
      if (stErr) {
        return res.status(400).json({ ok: false, error: stErr });
      }
    }

    const result = tokens.create({
      name: name.trim(),
      scopes: filteredScopes,
      expiresAt: expires_at || null,
      machineBindingEnabled: machine_binding_enabled || false,
      userId: id,
      peerId: peer_id || null,
      splitTunnelOverride: split_tunnel_override ? JSON.stringify(split_tunnel_override) : null,
    }, req.ip);

    res.status(201).json({
      ok: true,
      token: result.rawToken,
      details: tokens.toAdminView(result.token),
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to create token for user');
    if (err.message.includes('required') || err.message.includes('too long') || err.message.includes('Invalid') || err.message.includes('future')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    res.status(500).json({ ok: false, error: req.t('error.users.create_token') });
  }
});

module.exports = router;
