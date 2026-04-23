'use strict';

const { Router } = require('express');
const { hasFeature } = require('../../../services/license');

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

  res.json({
    ok: true,
    permissions: {
      services: hasScope('client:services'),
      traffic: hasScope('client:traffic'),
      dns: hasScope('client:dns'),
      rdp: hasScope('client:rdp') && hasFeature('remote_desktop'),
    },
    scopes,
  });
});

module.exports = router;
