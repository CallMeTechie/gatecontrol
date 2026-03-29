'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const peers = require('../../services/peers');
const logger = require('../../utils/logger');
const activity = require('../../services/activity');
const { validatePeerName } = require('../../utils/validate');
const { requireLimit } = require('../../middleware/license');
const { getDb } = require('../../db/connection');

const router = Router();

const peerCountFn = () => getDb().prepare('SELECT COUNT(*) as count FROM peers').get().count;

/**
 * Hash a WireGuard config string for change detection
 */
function hashConfig(config) {
  return crypto.createHash('sha256').update(config).digest('hex');
}

/**
 * GET /api/v1/client/ping
 * Health check for desktop clients — confirms auth works
 */
router.get('/ping', (req, res) => {
  const { version } = require('../../../package.json');
  res.json({ ok: true, version, timestamp: new Date().toISOString() });
});

/**
 * POST /api/v1/client/register
 * Register a desktop client as a new peer
 * Body: { hostname, platform, clientVersion }
 * Returns: { ok, peerId, config, hash }
 */
router.post('/register', requireLimit('vpn_peers', peerCountFn), async (req, res) => {
  try {
    const { hostname, platform, clientVersion } = req.body;

    if (!hostname || typeof hostname !== 'string') {
      return res.status(400).json({ ok: false, error: req.t ? req.t('error.client.hostname_required') : 'Hostname is required' });
    }

    // Generate a unique peer name from hostname
    const baseName = hostname.replace(/[^\w.\-]/g, '_').substring(0, 50);
    let peerName = baseName;
    const db = getDb();
    let attempt = 0;

    // Ensure unique name
    while (db.prepare('SELECT id FROM peers WHERE name = ?').get(peerName)) {
      attempt++;
      peerName = `${baseName}-${attempt}`;
    }

    const nameErr = validatePeerName(peerName);
    if (nameErr) {
      return res.status(400).json({ ok: false, error: req.t ? req.t('error.client.invalid_hostname') : 'Invalid hostname for peer name' });
    }

    // Create the peer
    const peer = await peers.create({
      name: peerName,
      description: `Desktop Client (${platform || 'unknown'}, v${clientVersion || '?'})`,
      tags: 'desktop-client',
    });

    // Generate client config
    const config = await peers.getClientConfig(peer.id);
    const hash = hashConfig(config);

    activity.log('client_registered', `Desktop client "${peerName}" registered`, {
      source: 'api',
      severity: 'info',
      details: { peerId: peer.id, hostname, platform, clientVersion },
    });

    logger.info({ peerId: peer.id, hostname, platform }, 'Desktop client registered');

    res.status(201).json({
      ok: true,
      peerId: peer.id,
      peerName,
      config,
      hash,
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Client registration failed');

    if (err.message.includes('No available')) {
      return res.status(409).json({ ok: false, error: req.t ? req.t('error.peers.no_ips') : 'No available IP addresses' });
    }
    if (err.message.includes('limit')) {
      return res.status(403).json({ ok: false, error: req.t ? req.t('error.license.limit_reached') : 'Peer limit reached' });
    }

    res.status(500).json({ ok: false, error: req.t ? req.t('error.client.register_failed') : 'Registration failed' });
  }
});

/**
 * GET /api/v1/client/config
 * Fetch WireGuard config for a registered peer
 * Query: ?peerId=123
 */
router.get('/config', async (req, res) => {
  try {
    const peerId = req.query.peerId || req.headers['x-peer-id'];
    if (!peerId) {
      return res.status(400).json({ ok: false, error: req.t ? req.t('error.client.peer_id_required') : 'Peer ID is required' });
    }

    const peer = peers.getById(Number(peerId));
    if (!peer) {
      return res.status(404).json({ ok: false, error: req.t ? req.t('error.peers.not_found') : 'Peer not found' });
    }

    const config = await peers.getClientConfig(peer.id);
    const hash = hashConfig(config);

    res.json({ ok: true, config, hash, peerName: peer.name });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to fetch client config');
    res.status(500).json({ ok: false, error: req.t ? req.t('error.peers.config') : 'Failed to get config' });
  }
});

/**
 * GET /api/v1/client/config/check
 * Check if config has changed (hash-based)
 * Query: ?peerId=123&hash=abc123
 */
router.get('/config/check', async (req, res) => {
  try {
    const peerId = req.query.peerId || req.headers['x-peer-id'];
    if (!peerId) {
      return res.status(400).json({ ok: false, error: req.t ? req.t('error.client.peer_id_required') : 'Peer ID is required' });
    }

    const peer = peers.getById(Number(peerId));
    if (!peer) {
      return res.status(404).json({ ok: false, error: req.t ? req.t('error.peers.not_found') : 'Peer not found' });
    }

    const config = await peers.getClientConfig(peer.id);
    const currentHash = hashConfig(config);
    const clientHash = req.query.hash;

    if (clientHash && clientHash === currentHash) {
      return res.json({ ok: true, updated: false });
    }

    res.json({ ok: true, updated: true, config, hash: currentHash });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to check client config');
    res.status(500).json({ ok: false, error: req.t ? req.t('error.peers.config') : 'Failed to check config' });
  }
});

/**
 * POST /api/v1/client/heartbeat
 * Receive heartbeat from desktop client
 * Body: { peerId, connected, rxBytes, txBytes, uptime, hostname }
 */
router.post('/heartbeat', (req, res) => {
  try {
    const { peerId, connected, rxBytes, txBytes, uptime, hostname } = req.body;

    if (!peerId) {
      return res.status(400).json({ ok: false, error: 'Peer ID is required' });
    }

    const peer = peers.getById(Number(peerId));
    if (!peer) {
      return res.status(404).json({ ok: false, error: 'Peer not found' });
    }

    // Update last seen timestamp
    const db = getDb();
    db.prepare(`UPDATE peers SET updated_at = datetime('now') WHERE id = ?`).run(peer.id);

    logger.debug({ peerId, connected, rxBytes, txBytes }, 'Client heartbeat received');

    res.json({ ok: true });
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
    const { peerId, status, timestamp } = req.body;

    if (!peerId) {
      return res.status(400).json({ ok: false, error: 'Peer ID is required' });
    }

    const peer = peers.getById(Number(peerId));
    if (!peer) {
      return res.status(404).json({ ok: false, error: 'Peer not found' });
    }

    activity.log('client_status', `Client "${peer.name}" reported: ${status}`, {
      source: 'api',
      severity: 'info',
      details: { peerId, status, timestamp },
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Status report failed');
    res.status(500).json({ ok: false, error: 'Status processing failed' });
  }
});

module.exports = router;
