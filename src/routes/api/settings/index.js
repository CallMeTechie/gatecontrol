'use strict';

// Aggregator router for /api/settings/* — splits 19 domain prefixes
// across six cluster modules. The token-auth-forbidden guard (was a
// sole-ownership middleware in the legacy 863-LOC settings.js) lives
// here so it covers every sub-cluster regardless of mounting order.

const { Router } = require('express');

const router = Router();

// A token with `settings` scope must not be able to perform admin-only
// system-level actions: downloading or restoring the full DB, wiping the
// activity log, changing account-lockout/DNS/machine-binding policy,
// unlocking accounts, or running autobackup. These are session-only.
const TOKEN_FORBIDDEN = [
  /^\/backup\b/,
  /^\/restore(\/preview)?$/,
  /^\/clear-logs$/,
  /^\/security$/,
  /^\/lockout(\/|$)/,
  /^\/dns$/,
  /^\/machine-binding$/,
  /^\/split-tunnel$/,
  /^\/autobackup(\/|$)/,
  /^\/ip2location(\/test)?$/,
  /^\/metrics$/,
  /^\/password$/,
  /^\/profile$/,
];
router.use((req, res, next) => {
  if (!req.tokenAuth) return next();
  if (TOKEN_FORBIDDEN.some(rx => rx.test(req.path))) {
    return res.status(403).json({ ok: false, error: 'Forbidden for token auth' });
  }
  next();
});

router.use('/', require('./user'));
router.use('/', require('./appearance'));
router.use('/', require('./security'));
router.use('/', require('./backup'));
router.use('/', require('./network'));
router.use('/', require('./observability'));

module.exports = router;
