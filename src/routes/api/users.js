'use strict';

const { Router } = require('express');
const { requireAdminSession } = require('../../middleware/auth');
const users = require('../../services/users');
const tokens = require('../../services/tokens');
const logger = require('../../utils/logger');
const { validateSplitTunnelPreset } = require('../../utils/validate');

const router = Router();

/** Destroy every login session of a user (sessionStore.destroyByUserId). */
function revokeSessions(req, userId, reason) {
  if (req.sessionStore && typeof req.sessionStore.destroyByUserId === 'function') {
    const removed = req.sessionStore.destroyByUserId(userId);
    if (removed > 0) logger.info({ userId, removed, reason }, 'Revoked user sessions');
  }
}

/**
 * Middleware: Block token auth and require admin role
 */
router.use(requireAdminSession);

/**
 * GET /api/v1/users — List all users with enrichment
 */
router.get('/', (req, res) => {
  try {
    const list = users.list();
    const enriched = list.map((u) => ({
      ...u,
      tokenCount: users.getTokenCount(u.id),
      peerCount: users.getPeerCount(u.id),
      lastAccess: users.getLastAccess(u.id),
    }));
    res.json({ ok: true, users: enriched });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list users');
    res.status(500).json({ ok: false, error: req.t('error.users.list') });
  }
});

/**
 * POST /api/v1/users — Create user
 */
router.post('/', async (req, res) => {
  try {
    const { username, displayName, role, password, email } = req.body;
    let user;
    if (role === 'user') {
      user = users.createClientUser({ username, displayName, email });
    } else {
      user = await users.create({ username, displayName, role, password, email });
    }
    res.status(201).json({ ok: true, user });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to create user');
    if (err.message.includes('UNIQUE') || err.message.includes('already exists')) {
      return res.status(409).json({ ok: false, error: req.t('error.users.duplicate') });
    }
    if (err.message.includes('required') || err.message.includes('Password')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    res.status(500).json({ ok: false, error: req.t('error.users.create') });
  }
});

/**
 * GET /api/v1/users/unassigned-tokens — List tokens without a user
 * MUST be before /:id to avoid Express matching "unassigned-tokens" as an id
 */
router.get('/unassigned-tokens', (req, res) => {
  try {
    const list = tokens.toAdminList(tokens.listUnassigned());
    res.json({ ok: true, tokens: list, machine_binding: tokens.machineBindingState() });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list unassigned tokens');
    res.status(500).json({ ok: false, error: req.t('error.users.unassigned_tokens') });
  }
});

/**
 * GET /api/v1/users/:id — User detail with tokens
 */
router.get('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const user = users.getById(id);
    if (!user) {
      return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    }
    // Token list incl. machine binding per token (shortened fingerprint,
    // bound-at, effective state) + the global state for the Users page.
    const userTokens = tokens.toAdminList(tokens.listByUserId(id));
    res.json({ ok: true, user, tokens: userTokens, machine_binding: tokens.machineBindingState() });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get user');
    res.status(500).json({ ok: false, error: req.t('error.users.get') });
  }
});

/**
 * PATCH /api/v1/users/:id — Update user
 */
router.patch('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const before = users.getById(id);
    const user = users.update(id, req.body);
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
    if (err.message === 'User not found') {
      return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    }
    if (err.message.includes('last admin')) {
      return res.status(400).json({ ok: false, error: req.t('error.users.last_admin') });
    }
    res.status(500).json({ ok: false, error: req.t('error.users.update') });
  }
});

/**
 * DELETE /api/v1/users/:id — Delete user (prevent self-deletion)
 */
router.delete('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.session.userId) {
      return res.status(400).json({ ok: false, error: req.t('error.users.self_delete') });
    }
    users.remove(id);
    // Invalidate the deleted user's sessions (route-level, like the password-change flow).
    revokeSessions(req, id, 'user deleted');
    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to delete user');
    if (err.message === 'User not found') {
      return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    }
    if (err.message.includes('last admin')) {
      return res.status(400).json({ ok: false, error: req.t('error.users.last_admin') });
    }
    res.status(500).json({ ok: false, error: req.t('error.users.delete') });
  }
});

/**
 * PUT /api/v1/users/:id/toggle — Enable/disable (prevent self-disable)
 */
router.put('/:id/toggle', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.session.userId) {
      return res.status(400).json({ ok: false, error: req.t('error.users.self_disable') });
    }
    const user = users.toggle(id);
    // Disabling logs the account out on every device. Its API tokens are
    // refused while the account is disabled (requireAuth checks the owner)
    // and work again once it is re-enabled.
    if (user && user.enabled !== 1) {
      revokeSessions(req, id, 'user disabled');
    }
    res.json({ ok: true, user });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to toggle user');
    if (err.message === 'User not found') {
      return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    }
    if (err.message.includes('last enabled admin')) {
      return res.status(400).json({ ok: false, error: req.t('error.users.last_admin') });
    }
    res.status(500).json({ ok: false, error: req.t('error.users.toggle') });
  }
});

/**
 * DELETE /api/v1/users/:id/2fa — Reset another user's two-factor login
 * (so nobody locks themselves out). Own account: use the profile "disable".
 */
router.delete('/:id/2fa', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.session.userId) {
      return res.status(400).json({ ok: false, error: req.t('two_fa.error_self_reset') });
    }
    const user = users.getById(id);
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
 * POST /api/v1/users/:id/tokens — Create token for this user
 */
router.post('/:id/tokens', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const user = users.getById(id);
    if (!user) {
      return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
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
