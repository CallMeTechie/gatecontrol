'use strict';

// Portal settings cluster — master switch + per-widget toggles.
// Keys: portal.enabled, portal.widget.{device,traffic,services}
// All default to '1' (on); '0' = off.

const { Router } = require('express');
const settings = require('../../../services/settings');
const portalConfig = require('../../../services/portalConfig');
const activity = require('../../../services/activity');

const router = Router();

/**
 * GET /api/v1/settings/portal — Return current portal settings as booleans
 */
router.get('/portal', (req, res) => {
  res.json({ ok: true, data: portalConfig() });
});

/**
 * PUT /api/v1/settings/portal — Update portal master switch + widget toggles
 *
 * Accepts:
 *   { enabled: bool, widgets: { device: bool, traffic: bool, services: bool } }
 */
router.put('/portal', (req, res) => {
  try {
    const body = req.body || {};
    const widgets = body.widgets || {};

    if (body.enabled !== undefined) {
      settings.set('portal.enabled', body.enabled ? '1' : '0');
    }
    if (widgets.device !== undefined) {
      settings.set('portal.widget.device', widgets.device ? '1' : '0');
    }
    if (widgets.traffic !== undefined) {
      settings.set('portal.widget.traffic', widgets.traffic ? '1' : '0');
    }
    if (widgets.services !== undefined) {
      settings.set('portal.widget.services', widgets.services ? '1' : '0');
    }

    activity.log('portal_settings_updated', 'Portal settings updated', {
      source: 'admin', ipAddress: req.ip, severity: 'info',
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

module.exports = router;
