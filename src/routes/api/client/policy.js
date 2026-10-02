'use strict';

const { Router } = require('express');
const peers = require('../../../services/peers');
const clientPolicy = require('../../../services/clientPolicy');
const logger = require('../../../utils/logger');
const { verifyMachineBinding } = require('./helpers');

const router = Router();

/**
 * GET /api/v1/client/policy
 * Effective client policy for the requesting token's peer
 * (defaults <- global <- peer group <- peer; a locked split-tunnel preset
 * narrows the allowed split modes to the preset mode).
 *
 * Response: { ok, version, managed, policy: { killSwitch, autoConnect,
 *   autostart, splitTunnelModes, lockSettings, lockServer,
 *   splitTunnelLocked }, sources: { <field>: 'default'|'global'|'group'|'peer'|'preset' } }
 *
 * ETag = "<version>"; a client sending If-None-Match gets 304. The heartbeat
 * and /permissions answers carry the same version (policyVersion) so a
 * client notices a change without polling this endpoint.
 *
 * A token not bound to a peer gets the global policy. An admin session may
 * preview a peer with ?peerId=.
 */
router.get('/policy', (req, res) => {
  try {
    let peer = null;
    if (req.tokenAuth) {
      if (req.tokenPeerId != null) {
        if (!verifyMachineBinding(req, res)) return;
        peer = peers.getById(req.tokenPeerId) || null;
      }
    } else if (req.query.peerId) {
      peer = peers.getById(Number(req.query.peerId)) || null;
    }

    const result = clientPolicy.forClient(peer, { tokenId: req.tokenAuth ? req.tokenId : null });
    res.set('ETag', `"${result.version}"`);
    res.set('Cache-Control', 'private, no-cache');
    if (req.fresh) return res.status(304).end();
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get client policy');
    res.status(500).json({ ok: false, error: 'Failed to load client policy' });
  }
});

module.exports = router;
