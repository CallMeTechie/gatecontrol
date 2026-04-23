'use strict';

const { Router } = require('express');
const peers = require('../../../services/peers');
const logger = require('../../../utils/logger');
const { requirePeerOwnership, verifyMachineBinding } = require('./helpers');

const router = Router();

router.post('/heartbeat', (req, res) => {
  try {
    const validatedPeerId = requirePeerOwnership(req, res);
    if (validatedPeerId == null) return;
    if (!verifyMachineBinding(req, res)) return;

    const { connected, rxBytes, txBytes, uptime, hostname } = req.body;

    const peer = peers.getById(validatedPeerId);
    if (!peer) {
      return res.status(404).json({ ok: false, error: 'Peer not found' });
    }

    // Update last seen timestamp
    const db = getDb();
    db.prepare(`UPDATE peers SET updated_at = datetime('now') WHERE id = ?`).run(peer.id);

    // Opportunistic hostname capture via heartbeat (feature: internal_dns).
    // Clients ship os.hostname() in the heartbeat body on every beat.
    // Taking it here means the admin never has to wait for a tunnel
    // reconnect — any agent that's online will populate the peer
    // hostname within one heartbeat cycle. Sticky-admin policy stays
    // enforced server-side (setHostname ignores agent writes when the
    // source is 'admin').
    if (hostname && typeof hostname === 'string' && hasFeature('internal_dns')) {
      try {
        peers.setHostname(peer.id, hostname, 'agent');
      } catch (err) {
        // Malformed hostname — log at debug, never fail the heartbeat.
        logger.debug({ peerId: peer.id, err: err.message }, 'Heartbeat hostname rejected');
      }
    }

    logger.debug({ peerId: validatedPeerId, connected, rxBytes, txBytes }, 'Client heartbeat received');

    res.json({
      ok: true,
      peerEnabled: peer.enabled === 1,
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Heartbeat failed');
    res.status(500).json({ ok: false, error: 'Heartbeat processing failed' });
  }
});

/**
 * POST /api/v1/client/status
 * Receive status update from desktop client
 * Body: { peerId, status, timestamp, ... }
 */
router.post('/status', (req, res) => {
  try {
    const validatedPeerId = requirePeerOwnership(req, res);
    if (validatedPeerId == null) return;
    if (!verifyMachineBinding(req, res)) return;

    const { status, timestamp } = req.body;

    const peer = peers.getById(validatedPeerId);
    if (!peer) {
      return res.status(404).json({ ok: false, error: 'Peer not found' });
    }

    activity.log('client_status', `Client "${peer.name}" reported: ${status}`, {
      source: 'api',
      severity: 'info',
      details: { peerId: validatedPeerId, status, timestamp },
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Status report failed');
    res.status(500).json({ ok: false, error: 'Status processing failed' });
  }
});

// ── Peer-Info ───────────────────────────────────────────────

/**
 * GET /api/v1/client/peer-info
 * Returns peer details including expiry date
 * Query: ?peerId=123
 */
router.get('/peer-info', (req, res) => {
  try {
    const peerId = requirePeerOwnership(req, res);
    if (peerId == null) return;
    if (!verifyMachineBinding(req, res)) return;

    const peer = peers.getById(peerId);
    if (!peer) {
      return res.status(404).json({ ok: false, error: 'Peer not found' });
    }

    res.json({
      ok: true,
      peer: {
        id: peer.id,
        name: peer.name,
        enabled: peer.enabled === 1,
        expiresAt: peer.expires_at || null,
        createdAt: peer.created_at,
      },
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get peer info');
    res.status(500).json({ ok: false, error: 'Failed to get peer info' });
  }
});

// ── Traffic-Verbrauch ───────────────────────────────────────

/**
 * GET /api/v1/client/traffic
 * Returns traffic stats for a peer (total, 30d, 7d, 24h)
 * Query: ?peerId=123
 */

module.exports = router;
