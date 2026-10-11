'use strict';

/**
 * POST /api/v1/client/portal-link — automatic portal login on connect.
 *
 * The apps (Windows, Android) call this right after the tunnel is up and
 * open the returned one-time URL instead of the bare portal address. Fixed
 * contract (the clients fall back to the plain portal URL on any non-2xx):
 *
 *   200 { ok: true, url: "<portalUrl>/auto?t=<ticket>[&next=<target>]", expiresIn: 60 }
 *
 * Optional body (or query) `next` (alias `path`): a portal tab to open after
 * the login ('/portal#mitteilungen', '/#geraete', … — services/portalTickets
 * portalNext); an unusable value is ignored, never an error.
 *   404 { ok: false, error: 'portal_disabled' }
 *   401/403 token missing / without `client` scope / session request /
 *           machine binding mismatch
 *   409 { ok: false, error: 'not_registered' }  token not bound to a peer
 *   429 { ok: false, error: 'rate_limited' }
 *
 * The ticket is bound to the token's peer and owner (services/portalTickets);
 * neither the ticket nor the URL is ever logged.
 */

const { Router } = require('express');
const portalConfig = require('../../../services/portalConfig');
const portalTickets = require('../../../services/portalTickets');
const { portalLinkLimiter } = require('../../../middleware/rateLimit');
const { verifyMachineBinding } = require('./helpers');
const logger = require('../../../utils/logger');

const router = Router();

router.post('/portal-link', portalLinkLimiter, (req, res) => {
  // Token only — a browser session has no device to bind the ticket to.
  if (!req.tokenAuth) return res.status(403).json({ ok: false, error: 'token_required' });
  const scopes = req.tokenScopes || [];
  if (!scopes.includes('client') && !scopes.includes('full-access')) {
    return res.status(403).json({ ok: false, error: 'scope_required' });
  }
  if (!verifyMachineBinding(req, res)) return;
  const cfg = portalConfig();
  if (!cfg.enabled) return res.status(404).json({ ok: false, error: 'portal_disabled' });
  if (req.tokenPeerId == null) return res.status(409).json({ ok: false, error: 'not_registered' });
  try {
    const { ticket, expiresIn } = portalTickets.create({ tokenId: req.tokenId, peerId: req.tokenPeerId, userId: req.tokenUserId });
    const base = `https://${portalConfig.effectivePortalHost().host}`;
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const pick = (v) => (typeof v === 'string' ? v : undefined);
    const next = portalTickets.portalNext(pick(b.next) ?? pick(b.path) ?? pick(req.query.next) ?? pick(req.query.path));
    res.set('Cache-Control', 'no-store');
    logger.debug({ tokenId: req.tokenId, peerId: req.tokenPeerId, next: !!next }, 'portal login link issued');
    return res.json({ ok: true, url: `${base}/auto?t=${ticket}${next ? `&next=${encodeURIComponent(next)}` : ''}`, expiresIn });
  } catch (err) {
    logger.error({ tokenId: req.tokenId, err: err.code || 'error' }, 'portal login link failed');
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

module.exports = router;
