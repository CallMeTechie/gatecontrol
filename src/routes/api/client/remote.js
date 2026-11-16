'use strict';

/**
 * POST /api/v1/client/remote/term-token { ref } — the native terminals of the apps (gc.remote stage 3,
 * docs/plugins.md "Remote access"). The plugin "Fernzugriff" answered POST devices/<id>/connect with a
 * ticket of engine term; the app turns its ref into a single-use token (60 s) here and opens
 * /api/v1/remote/ssh-tunnel with `Sec-WebSocket-Protocol: gc-term.v1, token.<token>`.
 *
 * App token only (scope client, machine binding), and only the person the ticket names. The ticket
 * binds itself to this app token on first use (a browser cannot use it afterwards, nor another
 * device). No key and no password ever leaves the core. Answers:
 *   200 { ok, token, wsPath, ttl } · 404 not_found (unknown, expired, another person / device, not a terminal)
 *   409 credential_unreadable / listener_required / target_* · 429 limit_reached · 503 plugin_unavailable
 */

const { Router } = require('express');
const { requireClientToken, tokenViewer } = require('./helpers');
const logger = require('../../../utils/logger');

const router = Router();

router.post('/remote/term-token', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!requireClientToken(req, res)) return undefined;
  const v = tokenViewer(req);
  if (!v) return res.status(403).json({ ok: false, error: 'no_user' });
  const ref = req.body && typeof req.body.ref === 'string' ? req.body.ref : '';
  const sessions = require('../../../services/remote/sessions');
  if (!sessions.REF_RE.test(ref)) return res.status(404).json({ ok: false, error: 'not_found' });
  const t = sessions.claimApp(ref, v.user.id, req.tokenId);
  if (!t || t.engine !== 'term') return res.status(404).json({ ok: false, error: 'not_found' });
  try {
    const r = await sessions.mint(t, { clientIp: req.ip, via: 'app' });
    if (!r.ok) return res.status(r.status).json({ ok: false, error: r.code });
    return res.json({ ok: true, token: r.token, wsPath: r.wsPath, ttl: r.ttl });
  } catch (err) {
    logger.error({ err: err.message }, 'remote term token failed');
    return res.status(500).json({ ok: false, error: 'mint_failed' });
  }
});

/**
 * POST /api/v1/client/remote/screen-token { ref } — the screen relay (gc.remote stage 5, gc-screen.v1). Two refs
 * of one ticket of gc.remote.screen: the phone's `senderRef` (only the app device and person the plugin named —
 * the phone that shares) and the viewer's `ref` (an app of the watching person; bound to that app token on first
 * use, like the terminal). The answer names the side; the app opens /api/v1/remote/screen-relay with
 * `Sec-WebSocket-Protocol: gc-screen.v1, token.<token>`. Answers:
 *   200 { ok, token, wsPath, ttl, role } · 404 not_found · 429 limit_reached · 503 plugin_unavailable · 403 unlicensed
 */
router.post('/remote/screen-token', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!requireClientToken(req, res)) return undefined;
  const v = tokenViewer(req);
  if (!v) return res.status(403).json({ ok: false, error: 'no_user' });
  const ref = req.body && typeof req.body.ref === 'string' ? req.body.ref : '';
  const sessions = require('../../../services/remote/sessions');
  if (!sessions.REF_RE.test(ref)) return res.status(404).json({ ok: false, error: 'not_found' });
  let t = sessions.claimSender(ref, v.user.id, req.tokenId);
  let role = 'sender';
  if (!t) {
    t = sessions.claimApp(ref, v.user.id, req.tokenId);
    role = 'viewer';
  }
  if (!t || t.engine !== 'screen') return res.status(404).json({ ok: false, error: 'not_found' });
  try {
    const r = await sessions.mint(t, { clientIp: req.ip, via: 'app', role });
    if (!r.ok) return res.status(r.status).json({ ok: false, error: r.code });
    return res.json({ ok: true, token: r.token, wsPath: r.wsPath, ttl: r.ttl, role });
  } catch (err) {
    logger.error({ err: err.message }, 'remote screen token failed');
    return res.status(500).json({ ok: false, error: 'mint_failed' });
  }
});

module.exports = router;
