'use strict';

// Client policies: global defaults and per-peer-group overrides (the
// per-peer override lives on PUT /api/v1/peers/:id, field client_policy).
// Writing is admin-session only (TOKEN_FORBIDDEN in ./index.js + the
// requireAdmin role gate on /api/v1). See services/clientPolicy.js.

const { Router } = require('express');
const clientPolicy = require('../../../services/clientPolicy');
const activity = require('../../../services/activity');
const { getDb } = require('../../../db/connection');
const logger = require('../../../utils/logger');

const router = Router();

const ERROR_KEYS = {
  invalid_policy: 'error.client_policy.invalid',
  unknown_field: 'error.client_policy.unknown_field',
  invalid_value: 'error.client_policy.invalid_value',
};

function errorResponse(req, res, result) {
  return res.status(400).json({
    ok: false,
    error: req.t(ERROR_KEYS[result.error] || 'common.error', { field: result.field || '' }),
    field: result.field || null,
  });
}

function payload() {
  const global = clientPolicy.getGlobal();
  const preset = clientPolicy.resolveSplitTunnelPreset(null);
  return {
    global,
    defaults: clientPolicy.DEFAULTS,
    fields: {
      enums: clientPolicy.ENUM_FIELDS,
      split_modes: clientPolicy.SPLIT_MODES,
      booleans: clientPolicy.BOOL_FIELDS,
    },
    groups: clientPolicy.listGroups(),
    split_tunnel_preset: { mode: preset.mode, locked: preset.locked },
    warnings: clientPolicy.warningsFor(global),
  };
}

/**
 * GET /api/settings/client-policy — global policy, group overrides, meta
 */
router.get('/client-policy', (req, res) => {
  try {
    res.json({ ok: true, data: payload() });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to read client policy');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * PUT /api/settings/client-policy — partial update of the global policy
 * Body: { kill_switch?, auto_connect?, autostart?, split_tunnel_modes?,
 *         lock_settings?, lock_server? }
 */
router.put('/client-policy', (req, res) => {
  try {
    const current = clientPolicy.getGlobal();
    const result = clientPolicy.validateInput(req.body, { mode: 'global', current });
    if (result.error) return errorResponse(req, res, result);
    if (Object.keys(result.changes).length > 0) {
      clientPolicy.saveGlobal(result.next);
      activity.log('client_policy_updated', 'Global client policy updated', {
        source: 'admin', ipAddress: req.ip, severity: 'info', details: result.changes,
      });
    }
    res.json({ ok: true, data: payload() });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update client policy');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * PUT /api/settings/client-policy/groups/:id — replace a group override
 * Body: { <field>: value | null } — missing/null = inherit; {} clears.
 */
router.put('/client-policy/groups/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const group = Number.isInteger(id)
      ? getDb().prepare('SELECT id, name FROM peer_groups WHERE id = ?').get(id)
      : null;
    if (!group) return res.status(404).json({ ok: false, error: req.t('error.peer_groups.not_found') });

    const current = clientPolicy.getGroupOverride(group.id);
    const result = clientPolicy.validateInput(req.body, { mode: 'override', current });
    if (result.error) return errorResponse(req, res, result);
    if (Object.keys(result.changes).length > 0) {
      clientPolicy.setGroupOverride(group.id, result.next);
      activity.log('client_policy_group_updated', `Client policy of group "${group.name}" updated`, {
        source: 'admin', ipAddress: req.ip, severity: 'info',
        details: { groupId: group.id, changes: result.changes },
      });
    }
    res.json({ ok: true, data: payload() });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update group client policy');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

module.exports = router;
