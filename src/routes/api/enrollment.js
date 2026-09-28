'use strict';

/**
 * /api/v1/enrollment — admin issues a one-scan app setup code.
 * Session + admin only: an API token must never mint further tokens.
 * The public redeem side lives in routes/api/client/enroll.js.
 */

const { Router } = require('express');
const users = require('../../services/users');
const enrollment = require('../../services/clientEnrollment');
const qrcode = require('../../services/qrcode');
const logger = require('../../utils/logger');
const config = require('../../../config/default');

const router = Router();

router.use((req, res, next) => {
  if (req.tokenAuth) {
    return res.status(403).json({ ok: false, error: req.t('error.users.session_required') });
  }
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ ok: false, error: req.t('error.users.unauthorized') });
  }
  const user = users.getById(req.session.userId);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: req.t('error.users.admin_required') });
  }
  next();
});

/**
 * The URL the app should talk to. GC_BASE_URL when it is a real public
 * https URL, otherwise the host the admin is using right now (the admin UI
 * is served through Caddy on the public hostname).
 */
function publicServerUrl(req) {
  try {
    const u = new URL(config.app.baseUrl);
    if (u.protocol === 'https:' && !['localhost', '127.0.0.1', '::1'].includes(u.hostname)) {
      return u.origin;
    }
  } catch {}
  return `https://${req.get('host')}`;
}

const ERROR_STATUS = {
  peer_not_found: 404,
  user_not_found: 404,
  peer_not_client: 400,
  target_required: 400,
  no_valid_scopes: 400,
};

/**
 * POST /api/v1/enrollment
 * Body: { peerId?, userId?, scopes?, machineBinding? }
 *   peerId  → the app takes over this peer (IP + config stay)
 *   userId only → a new peer owned by that user is created on redeem
 * Returns: { ok, code, expiresAt, url, link, qr, scopes }
 */
router.post('/', async (req, res) => {
  try {
    const { peerId, userId, scopes, machineBinding } = req.body || {};
    const result = enrollment.createCode({
      peerId: peerId != null && peerId !== '' ? Number(peerId) : null,
      userId: userId != null && userId !== '' ? Number(userId) : undefined,
      scopes: Array.isArray(scopes) ? scopes : undefined,
      machineBinding: !!machineBinding,
    });
    const url = publicServerUrl(req);
    const link = `gatecontrol://enroll?url=${encodeURIComponent(url)}&code=${result.code}`;
    const qr = await qrcode.toDataUrl(link);
    res.status(201).json({
      ok: true,
      code: result.code,
      expiresAt: result.expiresAt,
      url,
      link,
      qr,
      scopes: result.scopes,
    });
  } catch (err) {
    const status = ERROR_STATUS[err.code];
    if (status) {
      return res.status(status).json({ ok: false, error: req.t(`error.enrollment.${err.code}`) });
    }
    logger.error({ error: err.message }, 'Failed to create enrollment code');
    res.status(500).json({ ok: false, error: req.t('error.enrollment.create_failed') });
  }
});

module.exports = router;
