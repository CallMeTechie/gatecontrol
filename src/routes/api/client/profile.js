'use strict';

/**
 * Own profile picture and favourite colour of the apps (docs/feature-avatars.md):
 *
 *   GET    /api/v1/client/me/profile
 *     200 { ok, user: { id, name, initials, color, colorHex, avatarUrl|null }, palette: [{ key, hex }] }
 *   PUT    /api/v1/client/me/avatar   raw body (image/png | image/jpeg | image/webp, ≤ 96 KB)
 *     200 { ok, avatarUrl }
 *   DELETE /api/v1/client/me/avatar   → { ok }
 *   PUT    /api/v1/client/me/color    { color: key | null } → { ok, color, colorHex }
 *
 *     403 { ok: false, code: 'NO_USER' }       token without an owner (machine / service token)
 *     429 { ok: false, code: 'RATE_LIMITED' }  > 30 changes per hour and token
 *     415 / 413 / 400                          see routes/api/avatarApi.js
 *
 * Token only (scope `client` or `full-access`), machine binding — the guard
 * of the quick actions. Always the token's owner; no user id from the
 * request. avatarUrl is a path (/avatars/<id>.<ext>) on the same base URL
 * as this API.
 */

const { Router } = require('express');
const { requireClientToken, tokenViewer } = require('./helpers');
const { clientAvatarLimiter } = require('../../../middleware/rateLimit');
const { avatarUpload, handlers } = require('../avatarApi');

const router = Router();

/** Token + owner; sets req.avatarUserId. */
function guard(req, res, next) {
  if (!requireClientToken(req, res)) return undefined;
  res.set('Cache-Control', 'no-store');
  const v = tokenViewer(req);
  if (!v) return res.status(403).json({ ok: false, code: 'NO_USER', error: req.t ? req.t('avatar.err.no_user') : 'no_user' });
  req.avatarUserId = v.user.id;
  return next();
}

const h = handlers((req) => req.avatarUserId, (req) => ({ actorId: req.avatarUserId, ip: req.ip, source: 'api' }));

router.get('/me/profile', guard, h.profile);
router.put('/me/avatar', clientAvatarLimiter, guard, avatarUpload, h.putAvatar);
router.delete('/me/avatar', clientAvatarLimiter, guard, h.deleteAvatar);
router.put('/me/color', clientAvatarLimiter, guard, h.putColor);

module.exports = router;
