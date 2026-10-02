'use strict';

const { Router } = require('express');
const clientPolicy = require('../../../services/clientPolicy');
const logger = require('../../../utils/logger');

const router = Router();

// GET /api/v1/client/split-tunnel
// Returns the effective split-tunnel preset for this token.
// Resolution: token override > global preset > empty.
router.get('/split-tunnel', (req, res) => {
  try {
    const preset = clientPolicy.resolveSplitTunnelPreset(req.tokenAuth ? req.tokenId : null);
    if (preset.mode === 'off') {
      return res.json({ ok: true, mode: 'off', networks: [], locked: false, source: 'none' });
    }
    res.json({ ok: true, ...preset });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get split-tunnel config');
    res.status(500).json({ ok: false, error: 'Failed to load split-tunnel config' });
  }
});

module.exports = router;
