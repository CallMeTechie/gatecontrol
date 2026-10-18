'use strict';

/**
 * Order of the apps' Start and Familie tabs, shared by the account
 * (docs/feature-client-layout.md, services/clientLayout.js):
 *
 *   GET /api/v1/client/layout
 *     200 { ok: true, scope: 'device'|'user'|'global', editable,
 *           layout: { start, startHidden, familie, familieHidden } | null, updatedAt }
 *   PUT /api/v1/client/layout
 *     body { layout: { start?, startHidden?, familie?, familieHidden? } | null }
 *     200 { ok: true, updatedAt }                 (null after layout: null — removed)
 *     400 { ok: false, error: 'invalid_layout' }  not an object, a list no array or > 100
 *                                                 entries, an entry not 1–120 [A-Za-z0-9:_./@-]
 *     409 { ok: false, error: 'device_scope' }    the administrator chose "per device"
 *     403 { ok: false, error: 'forbidden' }       scope global and the owner is no administrator
 *
 * Token only (scope `client` or `full-access`), machine binding like the
 * other client routes; the layout belongs to the token's owner — a token
 * without an (enabled) owner gets 403 { error: 'no_user' }. A save sends the
 * control event `layout` to the person's other open push streams (scope
 * user) or to every open stream (scope global).
 */

const { Router } = require('express');
const clientLayout = require('../../../services/clientLayout');
const control = require('../../../services/notify/control');
const { requireClientToken: guard } = require('./helpers');
const logger = require('../../../utils/logger');

const router = Router();

/** The token's owner { id, role } (enabled accounts only), or null. */
function ownerOf(req) {
  if (req.tokenUserId == null) return null;
  const u = require('../../../services/users').getById(req.tokenUserId);
  return u && u.enabled === 1 ? { id: u.id, role: u.role } : null;
}

router.get('/layout', (req, res) => {
  if (!guard(req, res)) return;
  res.set('Cache-Control', 'no-store');
  const user = ownerOf(req);
  if (!user) return res.status(403).json({ ok: false, error: 'no_user' });
  try {
    return res.json({ ok: true, ...clientLayout.read(user) });
  } catch (err) {
    logger.error({ err: err.message, tokenId: req.tokenId }, 'client layout: read failed');
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

router.put('/layout', (req, res) => {
  if (!guard(req, res)) return;
  res.set('Cache-Control', 'no-store');
  const user = ownerOf(req);
  if (!user) return res.status(403).json({ ok: false, error: 'no_user' });
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  let layout = null;
  if (body.layout !== null) {
    const v = clientLayout.validate(body.layout);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    layout = v.layout;
  }
  let r;
  try {
    r = clientLayout.save(user, layout);
  } catch (err) {
    logger.error({ err: err.message, tokenId: req.tokenId }, 'client layout: save failed');
    return res.status(500).json({ ok: false, error: 'internal' });
  }
  if (r.error === 'device_scope') return res.status(409).json({ ok: false, error: 'device_scope' });
  if (r.error) return res.status(403).json({ ok: false, error: r.error });
  control.layoutChanged({
    ...(r.scope === 'global' ? { all: true } : { userId: user.id }),
    exceptToken: req.tokenId, scope: r.scope, updatedAt: r.updatedAt,
  });
  return res.json({ ok: true, updatedAt: r.updatedAt });
});

module.exports = router;
