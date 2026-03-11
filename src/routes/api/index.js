'use strict';

const { Router } = require('express');
const { csrfProtection } = require('../../middleware/csrf');

const router = Router();

// CSRF protection on all state-changing API methods
router.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    return csrfProtection(req, res, next);
  }
  next();
});

router.use('/dashboard', require('./dashboard'));
router.use('/system', require('./system'));
router.use('/logs', require('./logs'));
router.use('/peers', require('./peers'));
router.use('/routes', require('./routes'));
router.use('/settings', require('./settings'));
router.use('/wg', require('./wireguard'));
router.use('/caddy', require('./caddy'));
router.use('/webhooks', require('./webhooks'));

module.exports = router;
