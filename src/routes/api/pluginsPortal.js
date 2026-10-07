'use strict';

// Portal side of plugins with the `portal` permission (docs/plugins.md):
//   *  /api/v1/portal/plugins/:id/api/<path>   forwarded to the plugin
// Mounted inside the portal API router (routes/api/portal.js): the portal
// gate, portalIdentity/portalOwner and the CSRF check of signed-in viewers
// have run. The plugin sees the portal viewer as the acting user — reads
// need an identified owner, changes a portal or web login (like the
// built-in portal widgets: device trust is read-only).

const { Router } = require('express');
const plugins = require('../../services/plugins');
const { forwarder } = require('./plugins');
const { ID_RE } = require('../../services/plugins/constants');
const { pluginApiLimiter } = require('../../middleware/rateLimit');

const router = Router();
router.use(pluginApiLimiter);

function portalUser(req) {
  if (req.portalOwnerId == null) return null;
  if (req.method !== 'GET' && !req.portalLoggedIn) return null;
  const u = require('../../services/users').getById(req.portalOwnerId);
  if (!u || u.enabled !== 1) return null;
  return { id: u.id, name: u.display_name || u.username, role: u.role, portal: true };
}

router.all('/:id/api/*', (req, res, next) => {
  const id = String(req.params.id || '');
  const p = ID_RE.test(id) ? plugins.get(id) : null;
  if (!p || !p.manifest || !p.manifest.permissions || !p.manifest.permissions.portal) return res.status(404).json({ ok: false, code: 'not_found' });
  next();
}, forwarder(portalUser));

module.exports = router;
