'use strict';

const { Router } = require('express');
const config = require('../../../../config/default');
const peers = require('../../../services/peers');
const tokens = require('../../../services/tokens');
const logger = require('../../../utils/logger');
const activity = require('../../../services/activity');
const { validatePeerName } = require('../../../utils/validate');
const { requireLimit, requireFeature } = require('../../../middleware/license');
const { hostnameReportLimiter } = require('../../../middleware/rateLimit');
const { getDb } = require('../../../db/connection');
const {
  clientLabel,
  requirePeerOwnership,
  verifyMachineBinding,
  hashConfig,
} = require('./helpers');

const router = Router();

const peerCountFn = () => getDb().prepare('SELECT COUNT(*) as count FROM peers').get().count;

/**
 * POST /api/v1/client/register
 * Register a desktop client as a new peer
 * Body: { hostname, platform, clientVersion }
 * Returns: { ok, peerId, config, hash }
 */
router.post('/register', requireLimit('vpn_peers', peerCountFn), async (req, res) => {
  try {
    const { hostname, platform, clientVersion, peerId: existingPeerId } = req.body;

    if (!hostname || typeof hostname !== 'string') {
      return res.status(400).json({ ok: false, error: req.t ? req.t('error.client.hostname_required') : 'Hostname is required' });
    }

    // If token is already bound to a peer, only allow re-registration for that peer
    if (req.tokenAuth && req.tokenPeerId != null) {
      const boundPeer = peers.getById(req.tokenPeerId);
      if (!boundPeer) {
        return res.status(404).json({ ok: false, error: 'Bound peer no longer exists' });
      }

      // Bind machine fingerprint on re-registration if not yet bound
      if (isBindingActive(req)) {
        const token = tokens.getById(req.tokenId);
        if (!token.machine_fingerprint) {
          const fp = req.headers['x-machine-fingerprint'];
          if (!fp || !FINGERPRINT_RE.test(fp)) {
            return res.status(400).json({ ok: false, error: req.t ? req.t('error.client.fingerprint_invalid') : 'Valid machine fingerprint required for binding' });
          }
          tokens.bindMachineFingerprint(req.tokenId, fp);
        } else {
          if (!verifyMachineBinding(req, res)) return;
        }
      }

      // Update description with latest client version
      const db = getDb();
      try {
        db.prepare('UPDATE peers SET description = ? WHERE id = ?')
          .run(`${clientLabel(platform)} (${platform || 'unknown'}, v${clientVersion || '?'})`, boundPeer.id);
      } catch {}

      const peerConfig = await peers.getClientConfig(boundPeer.id);
      const hash = hashConfig(peerConfig);
      return res.json({ ok: true, peerId: boundPeer.id, peerName: boundPeer.name, config: peerConfig, hash });
    }

    const db = getDb();
    let peer = null;
    let isNew = false;

    // 1. Check if client already has a registered peerId
    if (existingPeerId) {
      peer = peers.getById(Number(existingPeerId));
      if (peer) {
        logger.info({ peerId: peer.id, hostname }, 'Client reconnected with existing peer');
      }
    }

    // 2. Check if a peer with same hostname already exists
    if (!peer) {
      const baseName = hostname.replace(/[^\w.\-]/g, '_').substring(0, 50);
      const existing = db.prepare('SELECT * FROM peers WHERE name = ?').get(baseName);
      if (existing) {
        peer = existing;
        logger.info({ peerId: peer.id, hostname }, 'Client matched existing peer by hostname');
      }
    }

    // 3. Create new peer only if none found
    if (!peer) {
      const baseName = hostname.replace(/[^\w.\-]/g, '_').substring(0, 50);
      const nameErr = validatePeerName(baseName);
      if (nameErr) {
        return res.status(400).json({ ok: false, error: req.t ? req.t('error.client.invalid_hostname') : 'Invalid hostname for peer name' });
      }

      peer = await peers.create({
        name: baseName,
        description: `${clientLabel(platform)} (${platform || 'unknown'}, v${clientVersion || '?'})`,
        tags: platform === 'android' ? 'mobile-client' : 'desktop-client',
      });
      isNew = true;

      activity.log('client_registered', `${clientLabel(platform)} "${baseName}" registered`, {
        source: 'api',
        severity: 'info',
        details: { peerId: peer.id, hostname, platform, clientVersion },
      });

      logger.info({ peerId: peer.id, hostname, platform }, 'New desktop client registered');
    }

    // Bind token to peer (one-time)
    if (req.tokenAuth) {
      const bound = tokens.bindPeer(req.tokenId, peer.id);
      if (!bound) {
        return res.status(403).json({ ok: false, error: 'Token is already bound to a different peer' });
      }
      logger.info({ tokenId: req.tokenId, peerId: peer.id }, 'Token bound to peer on registration');

      // Bind machine fingerprint if binding is active
      if (isBindingActive(req)) {
        const fingerprint = req.headers['x-machine-fingerprint'];
        if (!fingerprint || !FINGERPRINT_RE.test(fingerprint)) {
          return res.status(400).json({ ok: false, error: req.t ? req.t('error.client.fingerprint_invalid') : 'Valid machine fingerprint required for binding' });
        }
        tokens.bindMachineFingerprint(req.tokenId, fingerprint);
      }
    }

    // Update description with latest client version
    if (!isNew) {
      try {
        db.prepare('UPDATE peers SET description = ? WHERE id = ?')
          .run(`${clientLabel(platform)} (${platform || 'unknown'}, v${clientVersion || '?'})`, peer.id);
      } catch {}
    }

    // Generate client config
    const peerConfig = await peers.getClientConfig(peer.id);
    const hash = hashConfig(peerConfig);

    res.status(isNew ? 201 : 200).json({
      ok: true,
      peerId: peer.id,
      peerName: peer.name,
      config: peerConfig,
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
    const peerId = requirePeerOwnership(req, res);
    if (peerId == null) return;
    if (!verifyMachineBinding(req, res)) return;

    const peer = peers.getById(peerId);
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
    const peerId = requirePeerOwnership(req, res);
    if (peerId == null) return;
    if (!verifyMachineBinding(req, res)) return;

    const peer = peers.getById(peerId);
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
/**
 * POST /api/v1/client/peer/hostname
 * Agent reports its OS hostname for internal DNS resolution. Token-bound:
 * the target peer is taken from req.tokenPeerId (ignores any body-level
 * peerId to prevent hostname-hijacking across peers). License-gated and
 * rate-limited (3/min/token). Respects sticky admin source.
 */
router.post('/peer/hostname', hostnameReportLimiter, requireFeature('internal_dns'), (req, res) => {
  try {
    if (!req.tokenAuth) {
      return res.status(401).json({ ok: false, error: 'API token required' });
    }
    if (req.tokenPeerId == null) {
      return res.status(403).json({ ok: false, error: 'Token is not bound to a peer. Register first.' });
    }
    if (!verifyMachineBinding(req, res)) return;

    const raw = req.body && req.body.hostname;
    if (typeof raw !== 'string' || !raw.trim()) {
      return res.status(400).json({ ok: false, error: req.t ? req.t('error.dns.hostname_required') : 'hostname is required' });
    }

    const result = peers.setHostname(req.tokenPeerId, raw, 'agent');
    res.json({ ok: true, assigned: result.assigned, changed: result.changed });
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('reserved')) {
      return res.status(400).json({ ok: false, error: req.t ? req.t('error.dns.hostname_reserved') : 'hostname is reserved' });
    }
    if (msg.includes('invalid characters') || msg.includes('empty') || msg.includes('too long') || msg.includes('disallowed byte')) {
      return res.status(400).json({ ok: false, error: req.t ? req.t('error.dns.hostname_invalid') : 'hostname is invalid' });
    }
    logger.error({ error: err.message, peerId: req.tokenPeerId }, 'Agent hostname report failed');
    res.status(500).json({ ok: false, error: 'Hostname report failed' });
  }
});


module.exports = router;
