'use strict';

/**
 * Own devices and services of a signed-in account — the "Meine Geräte" tab
 * of the portal. Mounted twice (createMeRouter):
 *   /api/v1/me          web session (session.userId, behind requireAuth)
 *   /api/v1/portal/me   portal session (link of the app, or picker + PIN;
 *                       routes/api/portal.js — req.portalLoggedIn)
 *
 * Security model:
 *   * session only — an API token never reaches these endpoints, whatever
 *     its scopes (a device must not manage its siblings); device trust by
 *     VPN address (read-only portal view) does not either;
 *   * every query is scoped to the session's user; no endpoint accepts a
 *     user id from the client, and a token id from the path is only ever
 *     looked up together with the session's user id (anything else is 404,
 *     the same answer as "does not exist");
 *   * device setup codes only with the per-member permission
 *     (users.self_enroll_enabled, admins always), app scopes only, capped
 *     by the role like every other token;
 *   * services: names and hosts only — never credentials, never who else
 *     an entry is shared with;
 *   * the mutating endpoints are rate-limited per account and logged.
 */

const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../../../config/default');
const { getDb } = require('../../db/connection');
const tokens = require('../../services/tokens');
const users = require('../../services/users');
const activity = require('../../services/activity');
const logger = require('../../utils/logger');
const qrcode = require('../../services/qrcode');
const { isDeviceToken } = require('../../services/userVisibility');

/** The web session's account (the /api/v1/me mount). */
function webSessionUser(req) {
  return req.session && req.session.userId ? req.session.userId : null;
}

/**
 * Build the router. `userIdOf(req)` returns the signed-in account's id or
 * null (→ 401) — the only source of the user id.
 */
function createMeRouter(userIdOf = webSessionUser) {
const router = Router();

const selfServiceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => Math.max(1, config.auth.rateLimitLogin) * 4,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `me:${userIdOf(req) || req.ip}`,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: req.t('error.me.rate_limited') });
  },
});

router.use((req, res, next) => {
  if (req.tokenAuth) {
    return res.status(403).json({ ok: false, error: req.t('error.users.session_required') });
  }
  const uid = userIdOf(req);
  if (uid == null) {
    return res.status(401).json({ ok: false, error: req.t('error.users.unauthorized') });
  }
  req.meUserId = uid;
  return next();
});

function me(req) {
  return users.getById(req.meUserId);
}

function mayEnroll(user) {
  return !!user && user.enabled === 1 && (user.role === 'admin' || user.self_enroll_enabled === 1);
}

/** GET /api/v1/me — who am I, who runs this server, what may I do here */
router.get('/', (req, res) => {
  const user = me(req);
  if (!user) return res.status(401).json({ ok: false, error: req.t('error.users.unauthorized') });
  const admins = getDb().prepare("SELECT username, display_name FROM users WHERE role = 'admin' AND enabled = 1 ORDER BY id LIMIT 3").all()
    .map((a) => a.display_name || a.username);
  res.json({
    ok: true,
    user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
    admins,
    can_enroll: mayEnroll(user),
  });
});

/** GET /api/v1/me/devices — own device tokens with their peer and online state */
router.get('/devices', (req, res) => {
  try {
    const { withPeers } = require('../../services/tokenPeers');
    const own = withPeers(tokens.listByUserId(req.meUserId));
    const devices = own.filter(isDeviceToken).map((t) => ({
      id: t.id,
      name: t.name,
      created_at: t.created_at,
      expires_at: t.expires_at,
      last_used_at: t.last_used_at,
      usage: t.device_usage === 'multi' ? 'multi' : 'single',
      peer: t.peer ? {
        name: t.peer.name, ip: t.peer.ip, online: t.peer.online, last_handshake: t.peer.last_handshake,
        platform: t.peer.platform, client_version: t.peer.client_version,
      } : null,
    }));
    res.json({ ok: true, devices, can_enroll: mayEnroll(me(req)) });
  } catch (err) {
    logger.error({ err: err.message }, 'me: listing devices failed');
    res.status(500).json({ ok: false, error: req.t('error.me.load') });
  }
});

/** DELETE /api/v1/me/devices/:tokenId — lock an own device (revoke its token) */
router.delete('/devices/:tokenId', selfServiceLimiter, (req, res) => {
  const tokenId = Number.parseInt(req.params.tokenId, 10);
  const row = Number.isSafeInteger(tokenId)
    ? getDb().prepare('SELECT id, name, user_id, peer_id, enrolled FROM api_tokens WHERE id = ? AND user_id = ?').get(tokenId, req.meUserId)
    : null;
  if (!row || !isDeviceToken(row)) {
    return res.status(404).json({ ok: false, error: req.t('error.me.device_not_found') });
  }
  try {
    tokens.revoke(row.id, req.ip, { source: 'user' });
    activity.log('self_device_revoked', `User "${me(req).username}" locked own device "${row.name}"`, {
      source: 'user', ipAddress: req.ip, severity: 'warning', details: { userId: req.meUserId, tokenId: row.id, peerId: row.peer_id },
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err: err.message }, 'me: revoking a device failed');
    res.status(500).json({ ok: false, error: req.t('error.me.revoke') });
  }
});

/**
 * POST /api/v1/me/enrollment — setup code for an own new device.
 * Body: { pihole?: boolean } — the only choice a member makes; everything
 * else is fixed (new peer owned by the member, app scopes, role cap).
 */
router.post('/enrollment', selfServiceLimiter, async (req, res) => {
  const user = me(req);
  if (!mayEnroll(user)) {
    return res.status(403).json({ ok: false, error: req.t('error.me.enroll_not_allowed') });
  }
  try {
    const enrollment = require('../../services/clientEnrollment');
    const scopes = [...enrollment.DEFAULT_SCOPES];
    if (req.body && req.body.pihole === true) scopes.push('pihole');
    const result = enrollment.createCode({ userId: user.id, scopes });
    let base;
    try {
      const u = new URL(config.app.baseUrl);
      base = u.protocol === 'https:' && !['localhost', '127.0.0.1', '::1'].includes(u.hostname) ? u.origin : `https://${req.get('host')}`;
    } catch { base = `https://${req.get('host')}`; }
    const link = `gatecontrol://enroll?url=${encodeURIComponent(base)}&code=${result.code}`;
    activity.log('self_enrollment_created', `User "${user.username}" created a setup code for an own device`, {
      source: 'user', ipAddress: req.ip, severity: 'info', details: { userId: user.id, scopes: result.scopes },
    });
    res.status(201).json({ ok: true, code: result.code, expiresAt: result.expiresAt, url: base, link, qr: await qrcode.toDataUrl(link), scopes: result.scopes });
  } catch (err) {
    if (err.code === 'limit_reached' || err.code === 'no_valid_scopes' || err.code === 'user_disabled') {
      return res.status(400).json({ ok: false, error: req.t(`error.enrollment.${err.code === 'limit_reached' ? 'create_failed' : err.code}`) });
    }
    logger.error({ err: err.message }, 'me: creating a setup code failed');
    res.status(500).json({ ok: false, error: req.t('error.enrollment.create_failed') });
  }
});

/** GET /api/v1/me/services — HTTP services and RDP entries this account reaches */
router.get('/services', (req, res) => {
  try {
    const services = require('../../services/userVisibility').servicesForSelf(req.meUserId);
    res.json({ ok: true, services });
  } catch (err) {
    logger.error({ err: err.message }, 'me: listing services failed');
    res.status(500).json({ ok: false, error: req.t('error.me.load') });
  }
});

return router;
}

module.exports = createMeRouter();
module.exports.createMeRouter = createMeRouter;
