'use strict';

/**
 * /remote/session/:ref — the session page of gc.remote (docs/plugins.md
 * "Remote access", services/remote/sessions.js). A GateControl page, not the
 * plugin's frame: the frame has connect-src 'none', the page holds the
 * Guacamole WebSocket. It is the page of the old browser sessions
 * (rdp-session.njk) with another token endpoint.
 *
 * GET  /remote/session/:ref            the page — only for the person the plugin named, signed in (web or portal
 *                                      session, never a kiosk device), and only in the browser session that opened
 *                                      the address first. Anything else: one and the same 404. Three kinds:
 *                                      guacd (RDP/VNC/SSH/Telnet), the SSH terminal of the core (engine term,
 *                                      xterm.js, stage 3), the screen of a phone (engine screen, WebCodecs, stage 5)
 *                                      and the playback of a recording (recordings.stream).
 * POST /remote/session/:ref/token      a fresh single-use token (60 s) for a connect / reconnect — guacamole
 *                                      or gc-term.v1 (engine term) or gc-screen.v1 (engine screen, the viewer).
 * GET  /remote/session/:ref/recording  the decrypted recording of a playback ticket (asciicast or .guac).
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
  const theme = res.locals.theme || 'aurora';
  if (t.kind === 'play') {
    const rec = require('../services/remote/sessions').playbackOf(t);
    if (!rec) return notFound(req, res);
    return res.render(`${theme}/pages/remote-recording.njk`, {
      title: res.locals.t('remote.rec.title'), remoteRef: t.ref, recording: { format: rec.format === 'guac' ? 'guac' : 'asciicast', protocol: rec.protocol || null },
    });
  }
  if (t.engine === 'screen') {
    return res.render(`${theme}/pages/remote-screen.njk`, {
      title: res.locals.t('remote.screen.title'), remoteRef: t.ref, screen: { mode: t.mode, device: t.target.name || null },
    });
  }
  if (t.engine === 'term') {
    return res.render(`${theme}/pages/remote-term.njk`, {
      title: res.locals.t('remote.term.title'), remoteRef: t.ref, term: { mode: t.mode, record: !!t.record, tmux: t.tmux ? (t.tmux.attach || t.tmux.create) : null, target: t.target.name || null },
    });
  }
  const o = t.options || {};
  return res.render(`${theme}/pages/rdp-session.njk`, {
    title: res.locals.t('rdp.session.title'),
    route: { id: 0, protocol: t.protocol, resolution_mode: o.resolution_mode || 'fullscreen', resolution_width: o.resolution_width || null, resolution_height: o.resolution_height || null },
    remoteRef: t.ref,
    remoteRecord: !!t.record,
    guac: require('../../config/default').guac,
  });
}

async function token(req, res) {
  noStore(res);
  const t = ticketOf(req);
  if (!t) return res.status(404).json({ ok: false, error: 'not_found' });
  try {
    const r = await require('../services/remote/sessions').mint(t, { clientIp: req.ip, via: 'browser', language: require('../services/guacSettings').requestLanguage(req) });
    if (!r.ok) return res.status(r.status).json({ ok: false, error: r.code });
    return res.json({ ok: true, token: r.token, wsPath: r.wsPath, ttl: r.ttl, engine: r.engine });
  } catch (err) {
    logger.error({ err: err.message }, 'remote session token failed');
    return res.status(500).json({ ok: false, error: 'mint_failed' });
  }
}

/** The recording of a playback ticket, decrypted on the fly (never a file on disk in the clear). */
async function recording(req, res) {
  noStore(res);
  const t = ticketOf(req);
  const sessions = require('../services/remote/sessions');
  const rec = t ? sessions.playbackOf(t) : null;
  if (!rec) return res.status(404).json({ ok: false, error: 'not_found' });
  let c;
  try { c = require('../services/remote/recordings').content(t.pluginId, rec.id); } catch { c = null; }
  if (!c) return res.status(404).json({ ok: false, error: 'not_found' });
  res.set('Content-Type', c.type);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', 'inline');
  if (c.size) res.set('Content-Length', String(c.size));
  try {
    for await (const chunk of c.chunks()) {
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
      if (res.destroyed) return undefined;
    }
    return res.end();
  } catch (err) {
    logger.warn({ err: err.message }, 'remote recording could not be read');
    return res.destroy();
  }
}

module.exports = { page, token, recording };
