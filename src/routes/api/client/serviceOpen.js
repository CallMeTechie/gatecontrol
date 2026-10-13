'use strict';

/**
 * POST /api/v1/client/services/:id/open — open a route from the apps.
 *
 * The apps call this when the user taps a service of GET /client/services
 * and open the returned URL. Fixed contract:
 *
 *   200 { ok: true, url: "https://<domain>/route-auth/app/<ticket>", autoLogin: true, expiresIn: 60 }
 *       the route has route-auth with "Anmeldung aus den GateControl-Apps
 *       erlauben" (route_auth.app_login = 1): one-time ticket, redeemed by
 *       GET /route-auth/app/:ticket on the route's own domain, which sets the
 *       route-auth session cookie (no login page, no second factor)
 *   200 { ok: true, url: "https://<domain>", autoLogin: false }
 *       everything else (no auth, Basic Auth, route-auth without app login)
 *   404 { ok: false, error: 'not_found' }  unknown id, disabled, not http or
 *       not visible to the token's owner (same rule as GET /client/services)
 *   401/403 token missing / without `client` scope / session request /
 *           machine binding mismatch
 *   429 { ok: false, error: 'rate_limited' }
 *
 * Neither the ticket nor the URL is ever logged (only ids are).
 */

const { Router } = require('express');
const { getDb } = require('../../../db/connection');
const routes = require('../../../services/routes');
const routeAppTickets = require('../../../services/routeAppTickets');
const { serviceOpenLimiter } = require('../../../middleware/rateLimit');
const { verifyMachineBinding, routeAuthSummary } = require('./helpers');
const logger = require('../../../utils/logger');

const router = Router();

const ID_RE = /^[1-9][0-9]{0,15}$/;

router.post('/services/:id/open', serviceOpenLimiter, (req, res) => {
  // Token only — the ticket is bound to the device's token.
  if (!req.tokenAuth) return res.status(403).json({ ok: false, error: 'token_required' });
  const scopes = req.tokenScopes || [];
  if (!scopes.includes('client') && !scopes.includes('full-access')) {
    return res.status(403).json({ ok: false, error: 'scope_required' });
  }
  if (!verifyMachineBinding(req, res)) return;
  res.set('Cache-Control', 'no-store');

  const raw = String(req.params.id || '');
  const routeId = ID_RE.test(raw) ? Number(raw) : null;
  try {
    // Same visibility as the services list: enabled http routes the token's
    // owner may see (routes.user_ids).
    const route = routeId == null ? null : routes.getForUser(req.tokenUserId || null).find((r) => r.id === routeId);
    if (!route) return res.status(404).json({ ok: false, error: 'not_found' });

    const base = `https://${route.domain}`;
    const authRow = getDb().prepare('SELECT app_login FROM route_auth WHERE route_id = ?').get(route.id);
    if (!routeAuthSummary(route, authRow).appLogin) {
      logger.debug({ tokenId: req.tokenId, routeId: route.id }, 'route open (no auto-login)');
      return res.json({ ok: true, url: base, autoLogin: false });
    }

    const { ticket, expiresIn } = routeAppTickets.create({ routeId: route.id, tokenId: req.tokenId, userId: req.tokenUserId });
    logger.debug({ tokenId: req.tokenId, routeId: route.id }, 'route app login link issued');
    return res.json({ ok: true, url: `${base}/route-auth/app/${ticket}`, autoLogin: true, expiresIn });
  } catch (err) {
    logger.error({ tokenId: req.tokenId, routeId, err: err.code || 'error' }, 'route open failed');
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

module.exports = router;
