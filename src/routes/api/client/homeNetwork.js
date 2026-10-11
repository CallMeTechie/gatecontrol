'use strict';

/**
 * GET /api/v1/client/home-network — trusted-network detection of the apps
 * ("VPN off in a trusted network"), the mode that needs no location
 * permission: "the device is in the server's own home LAN". The app asks
 * through the normal path (public hostname) with the VPN up.
 *
 *   200 { ok: true, lan: ["192.168.1.10", …], same_lan: <bool>, via: 'tunnel'|'direct' }
 *
 *   lan       the server's private IPv4 addresses (RFC 1918) on its real LAN
 *             interfaces — max 8 (services/homeNetwork.js)
 *   same_lan  true only for a request through the tunnel of the token's
 *             own peer whose current WireGuard endpoint lies in one of those
 *             LAN subnets (not the server itself, not the host's default
 *             gateway); a direct request is always false
 *   via       informational only; the apps must not base decisions on it
 *
 *   401/403 token missing / without `client` scope / session request /
 *           machine binding mismatch
 *   429 { ok: false, error: 'rate_limited' }
 *
 * Never cached (Cache-Control: no-store): the answer depends on where the
 * device is right now.
 */

const { Router } = require('express');
const homeNetwork = require('../../../services/homeNetwork');
const { homeNetworkLimiter } = require('../../../middleware/rateLimit');
const { verifyMachineBinding } = require('./helpers');
const logger = require('../../../utils/logger');

const router = Router();

router.get('/home-network', homeNetworkLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  // Token only — the answer is about a device, a browser session has none.
  if (!req.tokenAuth) return res.status(403).json({ ok: false, error: 'token_required' });
  const scopes = req.tokenScopes || [];
  if (!scopes.includes('client') && !scopes.includes('full-access')) {
    return res.status(403).json({ ok: false, error: 'scope_required' });
  }
  if (!verifyMachineBinding(req, res)) return;
  try {
    const r = await homeNetwork.check(req.ip, req.tokenPeerId);
    return res.json({ ok: true, lan: r.lan, same_lan: r.same_lan === true, via: r.via });
  } catch (err) {
    logger.error({ tokenId: req.tokenId, err: err.message }, 'home network check failed');
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

module.exports = router;
