'use strict';

// Admin API "Kameras" of a gateway (phase 3c, step 4 — services/homeCameras.js),
// mounted at /api/v1/gateways next to routes/api/gateways.js behind requireAuth +
// apiLimiter + CSRF + requireAdmin (routes/api/index.js). Admin SESSION only.
//
//   GET /:id/cameras    switch, cameras, storage, service, hints (live from the gateway when it answers)
// The switch itself goes through PUT /:id/features { cameras: { enabled, subnets } };
// adding, testing and watching the cameras is the plugin "Tür & Kamera" (gc.cameras).

const { Router } = require('express');
const { requireAdminSession } = require('../../middleware/auth');
const cameras = require('../../services/homeCameras');
const features = require('../../services/gatewayFeatures');
const logger = require('../../utils/logger');

const router = Router();

router.get('/:id/cameras', requireAdminSession, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const g = features.needGateway(req.params.id);
    res.json({ ok: true, cameras: await cameras.view(g.id) });
  } catch (e) {
    if (e && e.code === 'not_found') return res.status(404).json({ ok: false, code: 'not_found', error: e.message });
    logger.error({ err: e && e.message }, 'gateway cameras admin API failed');
    return res.status(500).json({ ok: false, code: 'internal', error: 'internal error' });
  }
});

module.exports = router;
