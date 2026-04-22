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

router.use('/dashboard', require('./dashboard'));
router.use('/system', require('./system'));
router.use('/logs', require('./logs'));
router.use('/peers', require('./peers'));
router.use('/peer-groups', require('./peerGroups'));
router.use('/gateways', require('./gateways'));
router.use('/tags', require('./tags'));
router.use('/routes/:id/auth', require('./routeAuth'));
router.use('/routes', require('./routes'));
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

module.exports = router;
