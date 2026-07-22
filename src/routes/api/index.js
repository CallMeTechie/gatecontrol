'use strict';

const { Router } = require('express');
const { csrfProtection } = require('../../middleware/csrf');

const router = Router();

// CSRF protection on all state-changing API methods
// Skip CSRF for token-authenticated requests (stateless, no session)
router.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    if (req.tokenAuth) {
      return next(); // Token auth bypasses CSRF
    }
    return csrfProtection(req, res, next);
  }
  next();
});

// Lightweight authed probe — the SSE client fetches this after repeated
// reconnect failures: 200 = session alive, 401 = expired (client logs out).
router.get('/ping', (req, res) => res.json({ ok: true }));

router.use('/dashboard', require('./dashboard'));
router.use('/system', require('./system'));
router.use('/logs', require('./logs'));
router.use('/peers/:id/access-rules', require('./accessRules')('peer'));
router.use('/peers', require('./peers'));
router.use('/peer-groups', require('./peerGroups'));
router.use('/gateways', require('./gateways'));
router.use('/gateway-pools', require('./gatewayPools'));
router.use('/egress-routes', require('./egressRoutes'));
router.use('/tags', require('./tags'));
router.use('/routes/:id/auth', require('./routeAuth'));
router.use('/routes/:id/share-links', require('./shareLinks'));
router.use('/routes/:id/access-rules', require('./accessRules')('route'));
router.use('/routes', require('./routes'));
router.use('/service-bundles', require('./serviceBundles'));
router.use('/printer-presets', require('./printerPresets'));
router.use('/settings', require('./settings'));
router.use('/smtp', require('./smtp'));
router.use('/wg', require('./wireguard'));
router.use('/caddy', require('./caddy'));
router.use('/webhooks', require('./webhooks'));
router.use('/users', require('./users'));
router.use('/tokens', require('./tokens'));
router.use('/license', require('./license'));
router.use('/client', require('./client'));
router.use('/rdp', require('./rdp'));
router.use('/pihole', require('./pihole'));
router.use('/midea', require('./midea'));
router.use('/skoda', require('./skoda'));
router.use('/smarthome', require('./smarthome'));

module.exports = router;
