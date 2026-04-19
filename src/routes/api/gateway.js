'use strict';

const express = require('express');
const { requireGateway } = require('../../middleware/gatewayAuth');
const gateways = require('../../services/gateways');
const logger = require('../../utils/logger');

const router = express.Router();

router.use(requireGateway);

/** GET /api/v1/gateway/config */
router.get('/config', (req, res) => {
  const peerId = req.gateway.peer_id;
  const cfg = gateways.getGatewayConfig(peerId);
  const hash = gateways.computeConfigHash(peerId);
  res.json({ ...cfg, config_hash: hash });
});

/** GET /api/v1/gateway/config/check?hash=sha256:... */
router.get('/config/check', (req, res) => {
  const peerId = req.gateway.peer_id;
  const clientHash = req.query.hash;
  const currentHash = gateways.computeConfigHash(peerId);
  if (clientHash === currentHash) {
    return res.status(304).end();
  }
  res.status(200).json({ config_hash: currentHash });
});

module.exports = router;
