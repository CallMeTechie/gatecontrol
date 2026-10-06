'use strict';

/**
 * /api/v1/enrollment — admin issues a one-scan app setup code.
 * Session + admin only: an API token must never mint further tokens.
 * The public redeem side lives in routes/api/client/enroll.js.
 */

const { Router } = require('express');
const { requireAdminSession } = require('../../middleware/auth');
const enrollment = require('../../services/clientEnrollment');
const qrcode = require('../../services/qrcode');
const logger = require('../../utils/logger');
const config = require('../../../config/default');
const { validateSplitTunnelPreset } = require('../../utils/validate');

const router = Router();

router.use(requireAdminSession);

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
  } catch (err) { logger.debug({ err: err.message }, 'invalid app.baseUrl — falling back to request host'); }
  return `https://${req.get('host')}`;
}

const ERROR_STATUS = {
  peer_not_found: 404,
  user_not_found: 404,
  peer_not_client: 400,
  target_required: 400,
  no_valid_scopes: 400,
  name_required: 400,
  name_too_long: 400,
  expiry_in_past: 400,
  peer_owner_mismatch: 400,
  user_disabled: 400,
};

/**
 * kind 'token' — the token wizard. Same fields as POST /users/:id/tokens,
 * but the token is minted on redeem instead of being shown here.
 */
function createTokenCodeFromBody(body) {
  return enrollment.createTokenCode({
    name: body.name,
    scopes: body.scopes,
    userId: body.userId != null && body.userId !== '' ? Number(body.userId) : null,
    peerId: body.peer_id != null && body.peer_id !== '' ? Number(body.peer_id) : null,
    expiresAt: body.expires_at || null,
    machineBinding: !!body.machine_binding_enabled,
    splitTunnelOverride: body.split_tunnel_override || null,
  });
}

/**
 * POST /api/v1/enrollment
 * Body (device, default): { peerId?, userId?, scopes?, machineBinding?, name?,
 *   expires_at?, split_tunnel_override? }
 *   peerId  → the app takes over this peer (IP + config stay)
 *   userId only → a new peer owned by that user is created on redeem
 * Body (kind 'token', the token wizard): { kind:'token', name, scopes, userId,
 *   peer_id?, expires_at?, machine_binding_enabled?, split_tunnel_override? }
 * Returns: { ok, code, expiresAt, url, link, qr, scopes }
 */
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    let result;
    if (body.kind === 'token') {
      if (body.split_tunnel_override) {
        const stErr = validateSplitTunnelPreset(body.split_tunnel_override);
        if (stErr) return res.status(400).json({ ok: false, error: stErr });
      }
      result = createTokenCodeFromBody(body);
    } else {
      const { peerId, userId, scopes, machineBinding } = body;
      if (body.split_tunnel_override) {
        const stErr = validateSplitTunnelPreset(body.split_tunnel_override);
        if (stErr) return res.status(400).json({ ok: false, error: stErr });
      }
      result = enrollment.createCode({
        peerId: peerId != null && peerId !== '' ? Number(peerId) : null,
        userId: userId != null && userId !== '' ? Number(userId) : undefined,
        scopes: Array.isArray(scopes) ? scopes : undefined,
        machineBinding: !!machineBinding,
        name: typeof body.name === 'string' ? body.name : null,
        expiresAt: body.expires_at || null,
        splitTunnelOverride: body.split_tunnel_override || null,
      });
    }
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
