'use strict';

/**
 * Plugin quick actions of the apps (docs/plugins.md "Quick actions"):
 * Android home-screen shortcuts, Quick Settings tiles, widget.
 *
 *   GET  /api/v1/client/actions
 *     200 { ok: true, actions: [{ plugin, pluginName, id, title, subtitle,
 *                                 icon, kind, state, confirm }] }
 *   POST /api/v1/client/actions/:plugin/:id
 *     200 { ok, message, state }
 *     404 { ok: false, error: 'not_found' }       unknown plugin / action
 *     403 { ok: false, error: 'no_user' }         token without an owner
 *     502 { ok: false, error: 'plugin_error' }    the plugin failed
 *     504 { ok: false, error: 'timeout' }         no answer within 10 s
 *     429 { ok: false, error: 'rate_limited' }    > 30 runs / minute / token
 *
 * Token only (scope `client` or `full-access`), machine binding like the
 * other client routes. The plugins see the token's owner as the portal
 * viewer `{ id, name, role, portal: true, loggedIn: true, app: true }` —
 * a machine-bound device token of that person is a real credential. A token
 * without an owner gets no actions. Language: ?lang=de|en, else the owner's
 * language setting, else Accept-Language, else 'de'.
 */

const { Router } = require('express');
const quickActions = require('../../../services/plugins/quickActions');
const activity = require('../../../services/activity');
const { clientActionLimiter } = require('../../../middleware/rateLimit');
const { verifyMachineBinding } = require('./helpers');
const logger = require('../../../utils/logger');

const router = Router();

/** Token, scope, machine binding. false = answered. */
function guard(req, res) {
  if (!req.tokenAuth) { res.status(403).json({ ok: false, error: 'token_required' }); return false; }
  const scopes = req.tokenScopes || [];
  if (!scopes.includes('client') && !scopes.includes('full-access')) {
    res.status(403).json({ ok: false, error: 'scope_required' });
    return false;
  }
  return verifyMachineBinding(req, res);
}

/** The token's owner as the portal viewer the plugin hooks get; null without one. */
function viewerOf(req) {
  if (req.tokenUserId == null) return null;
  const u = require('../../../services/users').getById(req.tokenUserId);
  if (!u || u.enabled !== 1) return null;
  return { user: { id: u.id, name: u.display_name || u.username, role: u.role, portal: true, loggedIn: true, app: true }, language: u.language };
}

function langOf(req, v) {
  const q = typeof req.query.lang === 'string' ? req.query.lang.slice(0, 2).toLowerCase() : '';
  if (q === 'de' || q === 'en') return q;
  const own = typeof v.language === 'string' ? v.language.slice(0, 2).toLowerCase() : '';
  if (own === 'de' || own === 'en') return own;
  return req.language === 'en' ? 'en' : 'de';
}

router.get('/actions', async (req, res) => {
  if (!guard(req, res)) return;
  res.set('Cache-Control', 'no-store');
  const v = viewerOf(req);
  if (!v) return res.json({ ok: true, actions: [] });
  try {
    return res.json({ ok: true, actions: await quickActions.list(v.user, langOf(req, v)) });
  } catch (err) {
    logger.warn({ tokenId: req.tokenId, err: err.message }, 'quick actions: listing failed');
    return res.json({ ok: true, actions: [] });
  }
});

router.post('/actions/:plugin/:id', clientActionLimiter, async (req, res) => {
  if (!guard(req, res)) return;
  res.set('Cache-Control', 'no-store');
  const v = viewerOf(req);
  if (!v) return res.status(403).json({ ok: false, error: 'no_user' });
  const pluginId = String(req.params.plugin || '');
  const actionId = String(req.params.id || '');
  let r;
  try {
    r = await quickActions.run(pluginId, actionId, v.user, langOf(req, v));
  } catch (err) {
    logger.warn({ tokenId: req.tokenId, err: err.message }, 'quick action failed');
    r = { status: 502, body: { ok: false, error: 'plugin_error' } };
  }
  if (r.status !== 404) {
    // only ids the plugin listed reach this point (validated, no free text of the plugin)
    try {
      activity.log('plugin_quick_action', `Quick action "${actionId}" of plugin "${pluginId}" (${r.status === 200 && r.body.ok ? 'ok' : 'failed'})`, {
        source: 'api', severity: 'info', ipAddress: req.ip,
        details: { plugin: pluginId, action: actionId, userId: v.user.id, ok: r.status === 200 && r.body.ok === true },
      });
    } catch (err) { logger.debug({ err: err.message }, 'quick action: activity log failed'); }
  }
  return res.status(r.status).json(r.body);
});

module.exports = router;
