'use strict';

const { Router } = require('express');
const users = require('../../services/users');
const tokens = require('../../services/tokens');
const logger = require('../../utils/logger');

const router = Router();

/**
 * Validate a split-tunnel preset object
 * @param {object} obj - The preset to validate
 * @returns {string|null} Error message or null if valid
 */
function validateSplitTunnelPreset(obj) {
  if (!obj || typeof obj !== 'object') return 'Invalid preset format';
  if (obj.mode && !['off', 'exclude', 'include'].includes(obj.mode)) return 'Invalid mode';
  if (obj.networks) {
    if (!Array.isArray(obj.networks)) return 'networks must be an array';
    if (obj.networks.length > 50) return 'Maximum 50 networks';
    const cidrRe = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;
    for (const n of obj.networks) {
      if (!n.cidr || !cidrRe.test(n.cidr)) return `Invalid CIDR: ${n.cidr}`;
      const prefix = parseInt(n.cidr.split('/')[1], 10);
      if (prefix < 0 || prefix > 32) return `Invalid prefix: ${n.cidr}`;
      if (n.label && n.label.length > 100) return 'Label too long (max 100)';
    }
  }
  return null;
}

/**
 * Middleware: Block token auth and require admin role
 */
router.use((req, res, next) => {
  if (req.tokenAuth) {
    return res.status(403).json({ ok: false, error: req.t('error.users.session_required') });
  }

  if (!req.session || !req.session.userId) {
    return res.status(401).json({ ok: false, error: req.t('error.users.unauthorized') });
  }

  const user = users.getById(req.session.userId);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: req.t('error.users.admin_required') });
  }

  next();
});

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
    const list = tokens.listUnassigned();
    res.json({ ok: true, tokens: list });
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
    const userTokens = tokens.listByUserId(id);
    res.json({ ok: true, user, tokens: userTokens });
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
    const user = users.update(id, req.body);
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
      details: result.token,
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
