'use strict';

// Where the order of the apps' Start / Familie tabs applies
// (docs/feature-client-layout.md, services/clientLayout.js): per device,
// per account (default) or one order for everybody. Writing is admin-session
// only (TOKEN_FORBIDDEN in ./index.js + the requireAdmin role gate on /api/v1).

const { Router } = require('express');
const clientLayout = require('../../../services/clientLayout');
const control = require('../../../services/notify/control');
const activity = require('../../../services/activity');
const logger = require('../../../utils/logger');

const router = Router();

function payload() {
  return { scope: clientLayout.getScope(), scopes: [...clientLayout.SCOPES] };
}

/**
 * GET /api/settings/client-layout → { ok, data: { scope, scopes } }
 */
router.get('/client-layout', (req, res) => {
  try {
    res.json({ ok: true, data: payload() });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to read client layout scope');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * PUT /api/settings/client-layout
 * Body: { scope: 'device' | 'user' | 'global' }
 * A change tells every open push stream (control event `layout`): the apps
 * load GET /api/v1/client/layout again.
 */
router.put('/client-layout', (req, res) => {
  try {
    const scope = req.body && req.body.scope;
    if (!clientLayout.SCOPES.includes(scope)) {
      return res.status(400).json({ ok: false, error: req.t('error.client_layout.invalid_scope') });
    }
    const before = clientLayout.getScope();
    if (scope !== before) {
      clientLayout.setScope(scope);
      activity.log('client_layout_scope_updated', `Client layout scope changed to "${scope}"`, {
        source: 'admin', ipAddress: req.ip, severity: 'info', details: { from: before, to: scope },
      });
      control.layoutChanged({ all: true, scope, updatedAt: null });
    }
    res.json({ ok: true, data: payload() });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update client layout scope');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

module.exports = router;
