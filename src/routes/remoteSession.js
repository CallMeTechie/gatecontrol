'use strict';

/**
 * /remote/session/:ref — the session page of gc.remote (docs/plugins.md
 * "Remote access", services/remote/sessions.js). A GateControl page, not the
 * plugin's frame: the frame has connect-src 'none', the page holds the
 * Guacamole WebSocket. It is the page of the old browser sessions
 * (rdp-session.njk) with another token endpoint.
 *
 * GET  /remote/session/:ref        the page — only for the person the plugin named, signed in (web or portal
 *                                  session, never a kiosk device), and only in the browser session that opened
 *                                  the address first. Anything else: one and the same 404.
 * POST /remote/session/:ref/token  a fresh single-use guacamole token (60 s) for a connect / reconnect.
 *
 * The ref is never logged.
 */

const { ensureCsrfToken } = require('../middleware/csrf');
const logger = require('../utils/logger');

function noStore(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
}

/** The signed-in person behind the request (portalOwner ran before), or null. */
function viewerId(req) {
  if (!req.portalLoggedIn || req.portalOwnerSource === 'kiosk') return null;
  return req.portalOwnerId != null ? Number(req.portalOwnerId) : null;
}

function ticketOf(req) {
  const uid = viewerId(req);
  if (uid == null || !req.session || !req.sessionID) return null;
  return require('../services/remote/sessions').claim(String(req.params.ref || ''), uid, req.sessionID);
}

function notFound(req, res) {
  noStore(res);
  const t = res.locals.t;
  return res.status(404).render(`${res.locals.theme || 'aurora'}/pages/error.njk`, {
    title: t('remote.session.gone_title'),
    message: t('remote.session.gone'),
  });
}

function page(req, res) {
  const t = ticketOf(req);
  if (!t) return notFound(req, res);
  ensureCsrfToken(req, res);
  noStore(res);
  const o = t.options || {};
  return res.render(`${res.locals.theme || 'aurora'}/pages/rdp-session.njk`, {
    title: res.locals.t('rdp.session.title'),
    route: { id: 0, protocol: t.protocol, resolution_mode: o.resolution_mode || 'fullscreen', resolution_width: o.resolution_width || null, resolution_height: o.resolution_height || null },
    remoteRef: t.ref,
    guac: require('../../config/default').guac,
  });
}

async function token(req, res) {
  noStore(res);
  const t = ticketOf(req);
  if (!t) return res.status(404).json({ ok: false, error: 'not_found' });
  try {
    const r = await require('../services/remote/sessions').mint(t, { clientIp: req.ip });
    if (!r.ok) return res.status(r.status).json({ ok: false, error: r.code });
    return res.json({ ok: true, token: r.token, wsPath: r.wsPath, ttl: r.ttl });
  } catch (err) {
    logger.error({ err: err.message }, 'remote session token failed');
    return res.status(500).json({ ok: false, error: 'mint_failed' });
  }
}

module.exports = { page, token };
