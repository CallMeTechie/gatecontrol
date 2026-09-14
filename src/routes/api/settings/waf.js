'use strict';

// WAF settings (docs/feature-release-b.md §3), licence feature `waf`:
//   GET /api/v1/settings/waf  → { ok, trusted_ips, trusted_bypass, autoban: { enabled, threshold, window_min, duration_h } }
//   PUT /api/v1/settings/waf  same shape, every field optional → same answer (+ synced)
// A write can change the Caddy config (bypass directive, bans of addresses
// that became trusted) — sync failure → 502 CADDY_SYNC_FAILED, rolled back.
// PUT is session-only: a `settings` token must not be able to exempt
// addresses from the WAF.

const { Router } = require('express');
const wafBans = require('../../../services/wafBans');
const { requireFeature } = require('../../../middleware/license');
const logger = require('../../../utils/logger');

const router = Router();

function sendError(res, err, label) {
  if (err && err.statusCode && err.code) {
    return res.status(err.statusCode).json({ ok: false, error: err.message, code: err.code });
  }
  if (err && /caddy/i.test(String(err.message || ''))) {
    return res.status(502).json({ ok: false, error: err.message, code: 'CADDY_SYNC_FAILED' });
  }
  logger.warn({ err: err && err.message }, `${label} failed`);
  return res.status(500).json({ ok: false, error: `${label} failed` });
}

router.get('/waf', requireFeature('waf'), (req, res) => {
  try {
    res.json({ ok: true, ...wafBans.getSettings() });
  } catch (err) {
    sendError(res, err, 'GET /settings/waf');
  }
});

router.put('/waf', requireFeature('waf'), async (req, res) => {
  if (req.tokenAuth) return res.status(403).json({ ok: false, error: 'Forbidden for token auth', code: 'TOKEN_FORBIDDEN' });
  try {
    const { settings, synced } = await wafBans.updateSettings(req.body || {});
    res.json({ ok: true, ...settings, synced });
  } catch (err) {
    sendError(res, err, 'PUT /settings/waf');
  }
});

module.exports = router;
