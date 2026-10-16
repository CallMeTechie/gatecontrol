'use strict';

/**
 * Plugin quick actions of the apps (docs/plugins.md "Quick actions"):
 * Android home-screen shortcuts, Quick Settings tiles, widget.
 *
 *   GET  /api/v1/client/actions
 *     200 { ok: true, actions: [{ plugin, pluginName, id, title, subtitle,
 *                                 icon, kind, state, confirm, widget }] }
 *   POST /api/v1/client/actions/:plugin/:id
 *     body { source?: 'app' | 'notification', control?: string, value?: number | string }
 *     200 { ok, message, state, widget }
 *     400 { ok: false, error: 'invalid_source' }  source not one of those
 *     400 { ok: false, error: 'invalid_control' } control: not a control of the action's widget
 *     400 { ok: false, error: 'invalid_value' }   value not acceptable for that control
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
 * without an owner gets no actions. `source` (default 'app'; 'notification'
 * when the run comes from the action button of a push — docs/plugins.md
 * "Notifications") reaches the plugin's runQuickAction hook as `via`, with
 * `automation: false`. `control` + `value`: the app moved a control of the
 * action's widget (docs/plugins.md "Widgets") — the control must be one the
 * plugin currently lists for that action and the value acceptable for it
 * (a finite number within min..max, or one of the option ids); both reach
 * the hook validated. Language: ?lang=de|en, else the owner's language
 * setting, else Accept-Language, else 'de'.
 */

const { Router } = require('express');
const quickActions = require('../../../services/plugins/quickActions');
const activity = require('../../../services/activity');
const { clientActionLimiter } = require('../../../middleware/rateLimit');
const { requireClientToken: guard, tokenViewer: viewerOf, viewerLang: langOf } = require('./helpers');
const logger = require('../../../utils/logger');

const router = Router();

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
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const source = body.source == null ? 'app' : body.source;
  if (typeof source !== 'string' || !quickActions.VIA_PERSON.has(source)) {
    return res.status(400).json({ ok: false, error: 'invalid_source' });
  }
  const opts = { via: source };
  if (body.control != null) { opts.control = body.control; opts.value = body.value; }
  let r;
  try {
    r = await quickActions.run(pluginId, actionId, v.user, langOf(req, v), opts);
  } catch (err) {
    logger.warn({ tokenId: req.tokenId, err: err.message }, 'quick action failed');
    r = { status: 502, body: { ok: false, error: 'plugin_error' } };
  }
  if (r.status !== 404 && r.status !== 400) {
    // only ids the plugin listed reach this point (validated, no free text of
    // the plugin); of a control run the control's id, never its value
    try {
      activity.log('plugin_quick_action', `Quick action "${actionId}" of plugin "${pluginId}" (${r.status === 200 && r.body.ok ? 'ok' : 'failed'})`, {
        source: 'api', severity: 'info', ipAddress: req.ip,
        details: {
          plugin: pluginId, action: actionId, userId: v.user.id, ok: r.status === 200 && r.body.ok === true, via: source,
          ...(opts.control !== undefined ? { control: String(opts.control) } : {}),
        },
      });
    } catch (err) { logger.debug({ err: err.message }, 'quick action: activity log failed'); }
  }
  return res.status(r.status).json(r.body);
});

module.exports = router;
