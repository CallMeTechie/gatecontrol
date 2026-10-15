'use strict';

/**
 * Plugin Start tiles in the apps (docs/plugins.md "Portal" → "Start tiles"):
 * the start card of the Android app slides through them.
 *
 *   GET /api/v1/client/tiles?lang=de|en
 *     200 { ok: true, tiles: [{ key, plugin, pluginName, section, title,
 *                               value, unit, state, icon }] }
 *
 * Token only (scope `client` or `full-access`), machine binding like the
 * other client routes, rate limited like the quick-actions listing (the
 * general API limiter). The plugins see the token's owner as the portal
 * viewer `{ id, name, role, portal: true, loggedIn: true, app: true }` —
 * the viewer of the quick actions. A token without an owner gets no tiles.
 * Language: ?lang=de|en, else the owner's language setting, else
 * Accept-Language, else 'de'.
 */

const { Router } = require('express');
const clientTiles = require('../../../services/plugins/clientTiles');
const { requireClientToken: guard, tokenViewer: viewerOf, viewerLang: langOf } = require('./helpers');
const logger = require('../../../utils/logger');

const router = Router();

router.get('/tiles', async (req, res) => {
  if (!guard(req, res)) return;
  res.set('Cache-Control', 'no-store');
  const v = viewerOf(req);
  if (!v) return res.json({ ok: true, tiles: [] });
  try {
    return res.json({ ok: true, tiles: await clientTiles.list(v.user, langOf(req, v)) });
  } catch (err) {
    logger.warn({ tokenId: req.tokenId, err: err.message }, 'start tiles: listing failed');
    return res.json({ ok: true, tiles: [] });
  }
});

module.exports = router;
