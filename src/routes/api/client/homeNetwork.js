'use strict';

/**
 * GET /api/v1/client/home-network[?local=<ipv4>[,<ipv4>…]] — trusted-network
 * detection of the apps ("VPN off in a trusted network"), the mode that
 * needs no location permission, and the presence probe of Familie: "the
 * device is at home". The app asks through the normal path (public
 * hostname), with the VPN up or down.
 *
 *   200 { ok: true, lan: ["192.168.1.10", …], same_lan: <bool>,
 *         via: 'tunnel'|'direct',
 *         site: null | { type: 'server' }
 *                    | { type: 'gateway', gatewayId: <int>, name: <string> } }
 *
 *   local     optional: the device's own private IPv4 addresses on its
 *             Wi-Fi/Ethernet interfaces, comma-separated, at most 4 looked
 *             at; anything that is not a strict RFC 1918 dotted quad is
 *             ignored. Needed for the gateway rule only.
 *   lan       the server's private IPv4 addresses (RFC 1918) on its real LAN
 *             interfaces — max 8 (services/homeNetwork.js)
 *   same_lan  true when either rule matches (site != null):
 *             - server: request through the tunnel of the token's own peer
 *               whose current WireGuard endpoint lies in one of those LAN
 *               subnets (not the server itself, not the host's default
 *               gateway); never for a direct request;
 *             - gateway: the device shares the public address of an enabled,
 *               online gateway peer and a `local` address lies in a LAN
 *               subnet that gateway reports (tunnel and direct requests)
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
    const r = await homeNetwork.check(req.ip, req.tokenPeerId, { local: req.query.local });
    const site = r.same_lan === true && r.site ? r.site : null;
    return res.json({ ok: true, lan: r.lan, same_lan: site != null, via: r.via, site });
  } catch (err) {
    logger.error({ tokenId: req.tokenId, err: err.message }, 'home network check failed');
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

module.exports = router;
