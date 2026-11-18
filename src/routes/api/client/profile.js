'use strict';

/**
 * Own profile picture and favourite colour of the apps (docs/feature-avatars.md):
 *
 *   GET    /api/v1/client/me/profile
 *     200 { ok, user: { id, name, initials, color, colorHex, avatarUrl|null }, palette: [{ key, hex }], profile }
 *     (profile since the user profile, docs/feature-user-profile.md — its other endpoints: routes/api/profileApi.js)
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
const { clientAvatarLimiter, clientProfileLimiter } = require('../../../middleware/rateLimit');
const profileApi = require('../profileApi');
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

// The profile (docs/feature-user-profile.md, routes/api/profileApi.js): GET answers picture and colour as before plus
// `profile`; PATCH /me/profile, /me/profile/phones…, /me/profile/emails…, GET /me/profile/export, /me/profile/places…
// and /me/places/search ("Meine Orte").
// exceptToken: the device that changed "Meine Orte" gets no control event `places` for it
const p = profileApi.handlers((req) => req.avatarUserId, (req) => ({ actorId: req.avatarUserId, ip: req.ip, source: 'api', exceptToken: req.tokenId }));
router.get('/me/profile', guard, p.get);
const sub = Router();
profileApi.mount(sub, p, { write: [clientProfileLimiter, guard], read: [guard] });
router.use('/me', sub);
router.put('/me/avatar', clientAvatarLimiter, guard, avatarUpload, h.putAvatar);
router.delete('/me/avatar', clientAvatarLimiter, guard, h.deleteAvatar);
router.put('/me/color', clientAvatarLimiter, guard, h.putColor);

module.exports = router;
