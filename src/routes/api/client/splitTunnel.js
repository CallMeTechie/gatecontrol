'use strict';

const { Router } = require('express');
const tokens = require('../../../services/tokens');
const settings = require('../../../services/settings');
const logger = require('../../../utils/logger');

const router = Router();

// GET /api/v1/client/split-tunnel
// Returns the effective split-tunnel preset for this token.
// Resolution: token override > global preset > empty.
router.get('/split-tunnel', (req, res) => {
  try {
    let preset = null;
    let source = 'none';

    // 1. Check token-specific override
    if (req.tokenAuth && req.tokenId) {
      const token = tokens.getById(req.tokenId);
      if (token && token.split_tunnel_override) {
        try {
          preset = JSON.parse(token.split_tunnel_override);
          source = 'token';
        } catch {}
      }
    }

    // 2. Fall back to global preset
    if (!preset) {
      const raw = settings.get('split_tunnel_preset', '');
      if (raw) {
        try {
          preset = JSON.parse(raw);
          source = 'global';
        } catch {}
      }
    }

    // 3. No preset
    if (!preset || preset.mode === 'off') {
      return res.json({ ok: true, mode: 'off', networks: [], locked: false, source: 'none' });
    }

    res.json({
      ok: true,
      mode: preset.mode || 'exclude',
      networks: preset.networks || [],
      locked: !!preset.locked,
      source,
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get split-tunnel config');
    res.status(500).json({ ok: false, error: 'Failed to load split-tunnel config' });
  }
});

module.exports = router;
