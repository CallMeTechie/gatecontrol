'use strict';

const { Router } = require('express');
const tokens = require('../../services/tokens');
const logger = require('../../utils/logger');
const { requireFeature } = require('../../middleware/license');
const activity = require('../../services/activity');

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
 * GET /api/v1/tokens — List all tokens
 * Token auth cannot enumerate tokens — same escalation-prevention
 * principle as POST/DELETE. Only session-auth (admin UI) may list.
 */
router.get('/', (req, res) => {
  if (req.tokenAuth) {
    return res.status(403).json({ ok: false, error: req.t('error.tokens.no_escalation') });
  }
  try {
    const list = tokens.list();
    res.json({ ok: true, tokens: list });
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
      details: result.token,
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
    res.json({ ok: true, token });
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

    tokens.setMachineBindingEnabled(id, enabled);

    activity.log('machine_binding_toggled', `Machine binding for token "${token.name}" ${enabled ? 'enabled' : 'disabled'}`, {
      tokenId: id,
      enabled,
    }, {
      source: 'user',
      ipAddress: req.ip,
      severity: 'info',
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to toggle machine binding');
    res.status(500).json({ ok: false, error: req.t('error.tokens.binding_toggle_failed') || 'Failed to toggle machine binding' });
  }
});

/**
 * DELETE /api/v1/tokens/:id/binding — Reset machine binding
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
      tokenId: id,
    }, {
      source: 'user',
      ipAddress: req.ip,
      severity: 'warning',
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to reset machine binding');
    res.status(500).json({ ok: false, error: req.t('error.tokens.binding_reset_failed') });
  }
});

module.exports = router;
