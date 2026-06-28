'use strict';

const { Router } = require('express');
const { hasFeature } = require('../../../services/license');
const tokens = require('../../../services/tokens');
const portalConfig = require('../../../services/portalConfig');
const settings = require('../../../services/settings');

const router = Router();

// GET /api/v1/client/ping — health check, confirms auth works.
router.get('/ping', (req, res) => {
  const { version } = require('../../../../package.json');
  res.json({ ok: true, version, timestamp: new Date().toISOString() });
});

// GET /api/v1/client/permissions — scopes/permissions of the current token.
router.get('/permissions', (req, res) => {
  const scopes = req.tokenScopes || [];
  const hasScope = (s) => scopes.includes('full-access') || scopes.includes(s);

  const enabled = portalConfig().enabled;
  const portalUrl = enabled ? `https://${portalConfig.effectivePortalHost().host}` : null;
  const autoOpenPortal = enabled && settings.get('portal.autoappear', '1') !== '0';

  res.json({
    ok: true,
    portalUrl,
    autoOpenPortal,
    permissions: {
      services: hasScope('client:services'),
      traffic: hasScope('client:traffic'),
      dns: hasScope('client:dns'),
      rdp: hasScope('client:rdp') && hasFeature('remote_desktop'),
      // pihole flags derive from checkScope itself (single source of truth with enforcement).
      pihole: tokens.checkScope(scopes, '/api/v1/pihole/summary', 'GET') && hasFeature('pihole_integration'),
      piholeControl: tokens.checkScope(scopes, '/api/v1/pihole/blocking', 'POST') && hasFeature('pihole_integration'),
    },
    scopes,
  });
});

module.exports = router;
