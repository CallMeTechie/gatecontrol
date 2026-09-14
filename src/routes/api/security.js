'use strict';

// Security check and exposure (docs/feature-release-b.md §1 + §10), admin
// session or token scope `routes` (/api/v1/security → 'routes'):
//   GET /api/v1/security/check     → { ok, generated_at, summary, checks }
//   GET /api/v1/security/exposure  → { ok, entries }
// No licence gate: the checks that need a feature report status 'na'.

const { Router } = require('express');
const securityCheck = require('../../services/securityCheck');
const logger = require('../../utils/logger');

const router = Router();

router.get('/check', async (req, res) => {
  try {
    const userId = req.session && req.session.userId != null ? req.session.userId : null;
    res.json({ ok: true, ...(await securityCheck.runCheck({ userId })) });
  } catch (err) {
    logger.warn({ err: err.message }, 'GET /security/check failed');
    res.status(500).json({ ok: false, error: 'security check failed' });
  }
});

router.get('/exposure', (req, res) => {
  try {
    res.json({ ok: true, ...securityCheck.exposure() });
  } catch (err) {
    logger.warn({ err: err.message }, 'GET /security/exposure failed');
    res.status(500).json({ ok: false, error: 'exposure failed' });
  }
});

module.exports = router;
