'use strict';

const { Router } = require('express');
const tokens = require('../../services/tokens');
const logger = require('../../utils/logger');
const { validateSplitTunnelPreset } = require('../../utils/validate');
const { requireFeature } = require('../../middleware/license');
const activity = require('../../services/activity');

const router = Router();

/**
 * GET /api/v1/tokens — List all tokens
 * Token auth cannot enumerate tokens — same escalation-prevention
 * principle as POST/DELETE. Only session-auth (admin UI) may list.
 */
router.get('/', (req, res) => {
  if (req.tokenAuth) {
    return res.status(403).json({ ok: false, error: req.t('error.tokens.no_escalation') });
  }
  try {
    const list = tokens.toAdminList(tokens.list());
    res.json({ ok: true, tokens: list, machine_binding: tokens.machineBindingState() });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list tokens');
    res.status(500).json({ ok: false, error: req.t('error.tokens.list') });
  }
});

/**
 * POST /api/v1/tokens — Create a new token
 * Token auth CANNOT create tokens (escalation prevention)
 */
router.post('/', requireFeature('api_tokens'), (req, res) => {
  // Block token-based auth from creating tokens
  if (req.tokenAuth) {
    return res.status(403).json({ ok: false, error: req.t('error.tokens.no_escalation') });
  }

  try {
    const { name, scopes, expires_at, machine_binding_enabled, split_tunnel_override } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ ok: false, error: req.t('error.tokens.name_required') });
    }

    if (!scopes || !Array.isArray(scopes) || scopes.length === 0) {
      return res.status(400).json({ ok: false, error: req.t('error.tokens.scopes_required') });
    }

    const scopeErr = tokens.validateScopes(scopes);
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
      scopes,
      expiresAt: expires_at || null,
      machineBindingEnabled: machine_binding_enabled || false,
      splitTunnelOverride: split_tunnel_override ? JSON.stringify(split_tunnel_override) : null,
    }, req.ip);

    res.status(201).json({
      ok: true,
      token: result.rawToken,
      details: tokens.toAdminView(result.token),
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to create token');
    if (err.message.includes('required') || err.message.includes('too long') || err.message.includes('Invalid') || err.message.includes('future')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    res.status(500).json({ ok: false, error: req.t('error.tokens.create') });
  }
});

/**
 * PUT /api/v1/tokens/:id/assign — Assign token to a user
 */
router.put('/:id/assign', (req, res) => {
  if (req.tokenAuth) {
    return res.status(403).json({ ok: false, error: req.t('error.tokens.no_escalation') });
  }
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ ok: false, error: 'userId is required' });
    const token = tokens.assignToUser(parseInt(req.params.id, 10), parseInt(userId, 10));
    res.json({ ok: true, token: tokens.toAdminView(token) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to assign token');
    if (err.message === 'Token not found') {
      return res.status(404).json({ ok: false, error: req.t('error.tokens.not_found') });
    }
    if (err.message.includes('already assigned')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    res.status(500).json({ ok: false, error: 'Failed to assign token' });
  }
});

/**
 * PATCH /api/v1/tokens/:id — Edit a token ("Zugang bearbeiten")
 * Body (all optional): { name, expires_at (ISO | null = never), scopes,
 *   user_id (new owner | null), split_tunnel_override (preset | null),
 *   device_usage ('single' | 'multi'), device_users (user ids, shared device) }
 * Scopes are capped by the role of the (new) owner; the answer lists the
 * requested scopes that were dropped (`dropped`).
 */
router.patch('/:id', (req, res) => {
  if (req.tokenAuth) {
    return res.status(403).json({ ok: false, error: req.t('error.tokens.no_escalation') });
  }
  try {
    const id = Number.parseInt(req.params.id, 10);
    const body = req.body || {};
    const data = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.expires_at !== undefined) data.expiresAt = body.expires_at || null;
    if (body.scopes !== undefined) {
      if (!Array.isArray(body.scopes) || !body.scopes.length) {
        return res.status(400).json({ ok: false, error: req.t('error.tokens.scopes_required') });
      }
      data.scopes = body.scopes;
    }
    if (body.user_id !== undefined) data.userId = body.user_id === null || body.user_id === '' ? null : Number(body.user_id);
    if (body.split_tunnel_override !== undefined) {
      if (body.split_tunnel_override) {
        const stErr = validateSplitTunnelPreset(body.split_tunnel_override);
        if (stErr) return res.status(400).json({ ok: false, error: stErr });
      }
      data.splitTunnelOverride = body.split_tunnel_override || null;
    }
    // "Wer nutzt dieses Gerät?" (portal): 'single' | 'multi' + allowed people.
    const usageChange = body.device_usage !== undefined || body.device_users !== undefined;
    if (usageChange) {
      if (body.device_usage !== undefined && !['single', 'multi'].includes(body.device_usage)) {
        return res.status(400).json({ ok: false, error: req.t('error.tokens.device_usage_invalid') });
      }
      if (body.device_users !== undefined && !Array.isArray(body.device_users)) {
        return res.status(400).json({ ok: false, error: req.t('error.tokens.device_usage_invalid') });
      }
      const current = tokens.getById(id);
      if (!current) return res.status(404).json({ ok: false, error: req.t('error.tokens.not_found') });
      if (body.device_users !== undefined) {
        // Validate before anything is written (no half-saved dialog).
        const owner = data.userId !== undefined ? data.userId : current.user_id;
        try { require('../../services/portalDevices').checkUsers(body.device_users, owner); } catch (err) {
          if (err.code === 'USER_NOT_FOUND') return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
          return res.status(400).json({ ok: false, error: req.t('error.tokens.device_usage_invalid') });
        }
      }
    }
    const result = tokens.update(id, data, { ip: req.ip, actorId: req.session && req.session.userId });
    if (usageChange) {
      try {
        require('../../services/portalDevices').setUsage(id, { usage: body.device_usage, userIds: body.device_users },
          { ip: req.ip, actorId: req.session && req.session.userId });
      } catch (err) {
        if (err.code === 'USER_NOT_FOUND') return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
        if (err.code === 'INVALID_USAGE' || err.code === 'INVALID_USERS') return res.status(400).json({ ok: false, error: req.t('error.tokens.device_usage_invalid') });
        throw err;
      }
    }
    res.json({ ok: true, token: tokens.toAdminView(tokens.getById(id) || result.token), dropped: result.dropped });
  } catch (err) {
    if (err.message === 'Token not found') {
      return res.status(404).json({ ok: false, error: req.t('error.tokens.not_found') });
    }
    if (err.code === 'USER_NOT_FOUND') return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    if (err.code === 'OWNER_DISABLED') return res.status(400).json({ ok: false, error: req.t('error.users.disabled') });
    if (err.code === 'NO_VALID_SCOPES') return res.status(400).json({ ok: false, error: req.t('error.users.no_valid_scopes') });
    if (err.message.includes('required')) return res.status(400).json({ ok: false, error: req.t('error.tokens.name_required') });
    if (err.message.includes('too long')) return res.status(400).json({ ok: false, error: req.t('error.enrollment.name_too_long') });
    if (err.message.includes('future')) return res.status(400).json({ ok: false, error: req.t('error.enrollment.expiry_in_past') });
    if (err.message.startsWith('Invalid scope')) return res.status(400).json({ ok: false, error: err.message });
    logger.error({ error: err.message }, 'Failed to update token');
    res.status(500).json({ ok: false, error: req.t('error.tokens.update') });
  }
});

/**
 * DELETE /api/v1/tokens/:id — Revoke a token
 */
router.delete('/:id', (req, res) => {
  // Block token-based auth from deleting tokens
  if (req.tokenAuth) {
    return res.status(403).json({ ok: false, error: req.t('error.tokens.no_escalation') });
  }

  try {
    tokens.revoke(parseInt(req.params.id, 10), req.ip);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to revoke token');
    if (err.message === 'Token not found') {
      return res.status(404).json({ ok: false, error: req.t('error.tokens.not_found') });
    }
    res.status(500).json({ ok: false, error: req.t('error.tokens.delete') });
  }
});

/**
 * PUT /api/v1/tokens/:id/binding — Toggle machine_binding_enabled
 * The per-token flag only means something in the 'individual' mode: in
 * 'global' every token is bound anyway, in 'off' none is. Outside
 * 'individual' the request is refused (409 binding_mode) instead of storing
 * a flag that silently does nothing. Works for any user's token — the
 * /tokens router is admin-session only (requireAdmin + no token auth).
 */
router.put('/:id/binding', requireFeature('machine_binding'), (req, res) => {
  if (req.tokenAuth) {
    return res.status(403).json({ ok: false, error: req.t('error.tokens.no_escalation') });
  }

  try {
    const id = parseInt(req.params.id, 10);
    const token = tokens.getById(id);
    if (!token) {
      return res.status(404).json({ ok: false, error: req.t('error.tokens.not_found') });
    }

    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'enabled must be a boolean' });
    }

    const state = tokens.machineBindingState();
    if (state.mode !== 'individual') {
      return res.status(409).json({
        ok: false,
        code: 'binding_mode',
        mode: state.mode,
        error: req.t(state.mode === 'global' ? 'error.tokens.binding_mode_global' : 'error.tokens.binding_mode_off'),
      });
    }

    tokens.setMachineBindingEnabled(id, enabled);

    activity.log('machine_binding_toggled', `Machine binding for token "${token.name}" ${enabled ? 'enabled' : 'disabled'}`, {
      details: { tokenId: id, enabled },
      source: 'admin',
      ipAddress: req.ip,
      severity: 'info',
    });

    res.json({ ok: true, token: tokens.toAdminView(tokens.getById(id), state) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to toggle machine binding');
    res.status(500).json({ ok: false, error: req.t('error.tokens.binding_toggle_failed') });
  }
});

/**
 * DELETE /api/v1/tokens/:id/binding — Reset machine binding
 * Clears fingerprint + machine_bound_at; the next client request (in a mode
 * where the token is bound) binds it to the device that sends it.
 */
router.delete('/:id/binding', requireFeature('machine_binding'), (req, res) => {
  if (req.tokenAuth) {
    return res.status(403).json({ ok: false, error: req.t('error.tokens.no_escalation') });
  }

  try {
    const id = parseInt(req.params.id, 10);
    const token = tokens.getById(id);
    if (!token) {
      return res.status(404).json({ ok: false, error: req.t('error.tokens.not_found') });
    }

    tokens.resetMachineBinding(id);

    activity.log('machine_binding_reset', `Machine binding for token "${token.name}" reset`, {
      details: {
        tokenId: id,
        fingerprint: token.machine_fingerprint ? token.machine_fingerprint.substring(0, tokens.FINGERPRINT_DISPLAY_LEN) : null,
      },
      source: 'admin',
      ipAddress: req.ip,
      severity: 'warning',
    });

    res.json({ ok: true, token: tokens.toAdminView(tokens.getById(id)) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to reset machine binding');
    res.status(500).json({ ok: false, error: req.t('error.tokens.binding_reset_failed') });
  }
});

module.exports = router;
