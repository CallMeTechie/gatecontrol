'use strict';

// Client update policy: global default channel (stable/beta), minimum
// version per Windows product and the version overview of all peers.
// Writing is admin-session only (TOKEN_FORBIDDEN in ./index.js + the
// requireAdmin role gate on /api/v1).

const { Router } = require('express');
const clientUpdates = require('../../../services/clientUpdates');
const activity = require('../../../services/activity');
const logger = require('../../../utils/logger');

const router = Router();

const ERROR_KEYS = {
  invalid_channel: 'error.client_updates.invalid_channel',
  invalid_min_version: 'error.client_updates.invalid_min_version',
  invalid_product: 'error.client_updates.invalid_product',
};

function policyPayload(policy) {
  return {
    default_channel: policy.defaultChannel,
    min_versions: { ...policy.minVersions },
    channels: [...clientUpdates.CHANNELS],
  };
}

/**
 * GET /api/settings/client-updates — policy + version overview
 */
router.get('/client-updates', (req, res) => {
  try {
    const policy = clientUpdates.getPolicy();
    res.json({ ok: true, data: { ...policyPayload(policy), overview: clientUpdates.getOverview(policy) } });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to read client update policy');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * PUT /api/settings/client-updates
 * Body: { default_channel?: 'stable'|'beta', min_versions?: { pro?, community? } }
 * An empty string / null min version clears it.
 */
router.put('/client-updates', (req, res) => {
  try {
    const result = clientUpdates.validatePolicyInput(req.body);
    if (result.error) {
      return res.status(400).json({ ok: false, error: req.t(ERROR_KEYS[result.error] || 'common.error') });
    }
    if (Object.keys(result.changes).length > 0) {
      clientUpdates.savePolicy(result.next);
      activity.log('client_update_policy_updated', 'Client update policy updated', {
        source: 'admin', ipAddress: req.ip, severity: 'info', details: result.changes,
      });
    }
    const policy = clientUpdates.getPolicy();
    res.json({ ok: true, data: { ...policyPayload(policy), overview: clientUpdates.getOverview(policy) } });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update client update policy');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

module.exports = router;
