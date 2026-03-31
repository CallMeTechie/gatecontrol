'use strict';

const { Router } = require('express');
const tokens = require('../../services/tokens');
const logger = require('../../utils/logger');
const { requireFeature } = require('../../middleware/license');
const activity = require('../../services/activity');

const router = Router();

/**
 * GET /api/v1/tokens — List all tokens
 */
router.get('/', (req, res) => {
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
    const { name, scopes, expires_at, machine_binding_enabled } = req.body;

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

    const result = tokens.create({
      name: name.trim(),
      scopes,
      expiresAt: expires_at || null,
      machineBindingEnabled: machine_binding_enabled || false,
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
