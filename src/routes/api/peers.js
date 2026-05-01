'use strict';

const { Router } = require('express');
const peers = require('../../services/peers');
const qrcode = require('../../services/qrcode');
const logger = require('../../utils/logger');
const resolveError = require('../../utils/resolveError');
const stripFields = require('../../utils/stripFields');
const { validatePeerName, validateDescription } = require('../../utils/validate');
const { requireLimit, requireFeature } = require('../../middleware/license');
const { getDb } = require('../../db/connection');

const router = Router();

const peerCountFn = () => getDb().prepare('SELECT COUNT(*) as count FROM peers').get().count;

const stripPeer = (p) => stripFields(p, ['private_key_encrypted', 'preshared_key_encrypted']);

/** Map service-layer error messages to i18n keys */
const VALIDATION_ERROR_MAP = {
  'already exists': 'error.peers.name_exists',
  'No available': 'error.peers.no_ips',
  'not found': 'error.peers.not_found',
};

/**
 * POST /api/peers/batch — Batch enable/disable/delete peers
 */
router.post('/batch', async (req, res) => {
  try {
    const { action, ids } = req.body;

    if (!action || !['enable', 'disable', 'delete'].includes(action)) {
      return res.status(400).json({ ok: false, error: req.t('error.batch.invalid_action') });
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ ok: false, error: req.t('error.batch.no_ids') });
    }

    const affected = await peers.batch(action, ids);
    res.json({ ok: true, affected });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to batch operate on peers');
    if (err.message.includes('not found')) {
      return res.status(404).json({ ok: false, error: req.t('error.batch.not_found') });
    }
    res.status(500).json({ ok: false, error: req.t('error.batch.failed') });
  }
});

/**
 * GET /api/peers — List all peers with live status
 */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 250, 1), 250);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const list = await peers.getAll({ limit, offset });
    res.json({ ok: true, peers: list.map(stripPeer), limit, offset });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list peers');
    res.status(500).json({ ok: false, error: req.t('error.peers.list') });
  }
});

/**
 * GET /api/peers/:id — Get single peer
 */
router.get('/:id', (req, res) => {
  try {
    const peer = peers.getById(req.params.id);
    if (!peer) return res.status(404).json({ ok: false, error: req.t('error.peers.not_found') });
    res.json({ ok: true, peer: stripPeer(peer) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get peer');
    res.status(500).json({ ok: false, error: req.t('error.peers.get') });
  }
});

/**
 * POST /api/peers — Create new peer
 */
router.post('/', requireLimit('vpn_peers', peerCountFn), async (req, res) => {
  try {
    const { name, description, tags, expires_at, group_id, dns, is_gateway, api_port, proxy_port } = req.body;

    // Field-level validation
    const fields = {};
    const nameErr = validatePeerName(name);
    if (nameErr) fields.name = req.t('error.peers.name_invalid') || nameErr;
    const descErr = validateDescription(description);
    if (descErr) fields.description = req.t('error.peers.description_invalid') || descErr;
    if (Object.keys(fields).length > 0) {
      return res.status(400).json({ ok: false, error: Object.values(fields)[0], fields });
    }

    if (is_gateway) {
      // Gateway path: create peer + meta + tokens in one go. Return plaintext
      // tokens ONCE + full env-file content so the admin can copy or download.
      const gateways = require('../../services/gateways');
      const parsedApiPort = api_port != null && api_port !== ''
        ? parseInt(api_port, 10)
        : gateways.DEFAULT_API_PORT;
      if (!Number.isInteger(parsedApiPort) || parsedApiPort < 1 || parsedApiPort > 65535) {
        return res.status(400).json({ ok: false, error: 'api_port must be 1..65535' });
      }
      const parsedProxyPort = proxy_port != null && proxy_port !== ''
        ? parseInt(proxy_port, 10)
        : 8080;
      if (!Number.isInteger(parsedProxyPort) || parsedProxyPort < 1 || parsedProxyPort > 65535) {
        return res.status(400).json({ ok: false, error: 'proxy_port must be 1..65535' });
      }
      const result = await gateways.createGateway({
        name,
        apiPort: parsedApiPort,
        proxyPort: parsedProxyPort,
      });
      const envContent = gateways.buildEnvForPeer(result.peer.id, result.apiToken, result.pushToken);
      return res.status(201).json({
        ok: true,
        peer: stripPeer(result.peer),
        gateway: {
          apiToken: result.apiToken,
          pushToken: result.pushToken,
          envContent,
        },
      });
    }

    const peer = await peers.create({ name, description, tags, expiresAt: expires_at || null, groupId: group_id !== undefined ? group_id : null, dns });
    res.status(201).json({ ok: true, peer: stripPeer(peer) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to create peer');
    const { status, error } = resolveError(req, err, VALIDATION_ERROR_MAP, 'error.peers.create');
    res.status(status).json({ ok: false, error });
  }
});

/**
 * PUT /api/peers/:id — Update peer
 */
router.put('/:id', async (req, res) => {
  try {
    const { name, description, dns, persistentKeepalive, enabled, tags, expires_at, group_id } = req.body;

    // Field-level validation
    const fields = {};
    if (name !== undefined) {
      const nameErr = validatePeerName(name);
      if (nameErr) fields.name = req.t('error.peers.name_invalid') || nameErr;
    }
    if (description !== undefined) {
      const descErr = validateDescription(description);
      if (descErr) fields.description = req.t('error.peers.description_invalid') || descErr;
    }
    if (Object.keys(fields).length > 0) {
      return res.status(400).json({ ok: false, error: Object.values(fields)[0], fields });
    }

    // Pass expires_at: explicit null clears it, undefined means don't change
    const updateData = { name, description, dns, persistentKeepalive, enabled, tags };
    if (expires_at !== undefined) {
      updateData.expiresAt = expires_at || null;
    }
    if (group_id !== undefined) {
      updateData.groupId = group_id || null;
    }

    const peer = await peers.update(req.params.id, updateData);
    res.json({ ok: true, peer: stripPeer(peer) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update peer');
    const { status, error } = resolveError(req, err, VALIDATION_ERROR_MAP, 'error.peers.update');
    res.status(status).json({ ok: false, error });
  }
});

/**
 * GET /api/peers/:id/delete-impact — Preview which routes would be
 * disabled if this peer were deleted. Used by the gateway-delete modal
 * to show the user what they're about to break before they confirm.
 */
router.get('/:id/delete-impact', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const peer = peers.getById(id);
    if (!peer) return res.status(404).json({ ok: false, error: 'not_found' });

    const db = getDb();
    let httpRoutes = [];
    let rdpRoutes = [];

    if (peer.peer_type === 'gateway') {
      httpRoutes = db.prepare(`
        SELECT id, domain, route_type, target_lan_host, target_lan_port
        FROM routes
        WHERE target_peer_id = ? AND target_kind = 'gateway'
        ORDER BY domain
      `).all(id);
      rdpRoutes = db.prepare(`
        SELECT id, name, host, port
        FROM rdp_routes
        WHERE gateway_peer_id = ?
        ORDER BY name
      `).all(id);
    } else {
      // Regular peer — legacy peer_id link on http routes
      httpRoutes = db.prepare(`
        SELECT id, domain, route_type
        FROM routes
        WHERE peer_id = ?
        ORDER BY domain
      `).all(id);
    }

    res.json({
      ok: true,
      peer: {
        id: peer.id,
        name: peer.name,
        ip: (peer.allowed_ips || '').split(',')[0].split('/')[0].trim(),
        peer_type: peer.peer_type,
        enabled: !!peer.enabled,
      },
      httpRoutes,
      rdpRoutes,
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to compute delete impact');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * DELETE /api/peers/:id — Delete peer
 */
router.delete('/:id', async (req, res) => {
  try {
    await peers.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to delete peer');
    const { status, error } = resolveError(req, err, VALIDATION_ERROR_MAP, 'error.peers.delete');
    res.status(status).json({ ok: false, error });
  }
});

/**
 * PUT /api/peers/:id/toggle — Toggle peer enabled/disabled
 */
router.put('/:id/toggle', async (req, res) => {
  try {
    // Check if trying to enable and limit would be exceeded
    const existing = peers.getById(req.params.id);
    if (existing && !existing.enabled) {
      const { isWithinLimit, getFeatureLimit } = require('../../services/license');
      const count = getDb().prepare('SELECT COUNT(*) as count FROM peers WHERE enabled = 1').get().count;
      if (!isWithinLimit('vpn_peers', count)) {
        const limit = getFeatureLimit('vpn_peers');
        return res.status(403).json({
          ok: false,
          error: req.t ? req.t('error.license.limit_reached') : 'Peer limit reached',
          feature: 'vpn_peers',
          current: count,
          limit,
          upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing',
        });
      }
    }
    const peer = await peers.toggle(req.params.id);
    res.json({ ok: true, peer: stripPeer(peer) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to toggle peer');
    const { status, error } = resolveError(req, err, VALIDATION_ERROR_MAP, 'error.peers.toggle');
    res.status(status).json({ ok: false, error });
  }
});

/**
 * GET /api/peers/:id/config — Download client WireGuard config
 */
router.get('/:id/config', async (req, res) => {
  try {
    const peer = peers.getById(req.params.id);
    if (!peer) return res.status(404).json({ ok: false, error: req.t('error.peers.not_found') });

    const conf = await peers.getClientConfig(req.params.id);

    if (req.query.download === '1') {
      res.setHeader('Content-Type', 'application/octet-stream');
      const safeName = peer.name.replace(/[^\w.\-]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.conf"`);
      return res.send(conf);
    }

    res.json({ ok: true, config: conf, name: peer.name });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get peer config');
    res.status(500).json({ ok: false, error: req.t('error.peers.config') });
  }
});

/**
 * GET /api/peers/:id/qr — Get QR code for peer config
 */
router.get('/:id/qr', async (req, res) => {
  try {
    const peer = peers.getById(req.params.id);
    if (!peer) return res.status(404).json({ ok: false, error: req.t('error.peers.not_found') });

    const conf = await peers.getClientConfig(req.params.id);
    const dataUrl = await qrcode.toDataUrl(conf);

    res.json({ ok: true, qr: dataUrl, config: conf, name: peer.name });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to generate QR code');
    res.status(500).json({ ok: false, error: req.t('error.peers.qr') });
  }
});

/**
 * PATCH /api/peers/:id/hostname — Admin-set internal DNS hostname.
 * License-gated via 'internal_dns'. Empty/null clears the hostname.
 */
router.patch('/:id/hostname', requireFeature('internal_dns'), (req, res) => {
  try {
    const peer = peers.getById(req.params.id);
    if (!peer) return res.status(404).json({ ok: false, error: req.t('error.peers.not_found') });

    const raw = req.body && Object.prototype.hasOwnProperty.call(req.body, 'hostname')
      ? req.body.hostname
      : undefined;
    if (raw === undefined) {
      return res.status(400).json({ ok: false, error: req.t('error.dns.hostname_required') });
    }

    const result = peers.setHostname(peer.id, raw || null, 'admin');
    res.json({ ok: true, peer: stripPeer(peers.getById(peer.id)), assigned: result.assigned, changed: result.changed });
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('reserved')) {
      return res.status(400).json({ ok: false, error: req.t('error.dns.hostname_reserved') });
    }
    if (msg.includes('invalid characters') || msg.includes('empty') || msg.includes('too long') || msg.includes('disallowed byte')) {
      return res.status(400).json({ ok: false, error: req.t('error.dns.hostname_invalid') });
    }
    logger.error({ error: err.message }, 'Failed to set peer hostname');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * GET /api/peers/:id/gateway-info — telemetry snapshot for a gateway peer.
 * Returns the parsed last_health JSON (written by gateways.handleHeartbeat)
 * alongside metadata: last_seen_at, health-state-machine status, api_port.
 * Non-gateway peers get a 404.
 */
router.get('/:id/gateway-info', (req, res) => {
  try {
    const peer = peers.getById(req.params.id);
    if (!peer) return res.status(404).json({ ok: false, error: req.t('error.peers.not_found') });
    if (peer.peer_type !== 'gateway') {
      return res.status(404).json({ ok: false, error: 'Not a gateway peer' });
    }

    const meta = getDb().prepare(
      'SELECT last_seen_at, last_health, api_port FROM gateway_meta WHERE peer_id = ?'
    ).get(peer.id);
    if (!meta) return res.status(404).json({ ok: false, error: 'Gateway meta missing' });

    let health = {};
    if (meta.last_health) {
      try { health = JSON.parse(meta.last_health); } catch (_) { health = {}; }
    }

    const gateways = require('../../services/gateways');
    const status = gateways.getHealthStatus(peer.id);

    res.json({
      ok: true,
      gateway: {
        peer_id: peer.id,
        status,
        api_port: meta.api_port,
        last_seen_at: meta.last_seen_at,
        health,
      },
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get gateway info');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * GET /api/peers/:id/traffic — Get per-peer traffic chart data
 */
router.get('/:id/traffic', (req, res) => {
  try {
    const peer = peers.getById(req.params.id);
    if (!peer) return res.status(404).json({ ok: false, error: req.t('error.peers.not_found') });

    const { getPeerChartData } = require('../../services/traffic');
    const period = ['24h', '7d', '30d'].includes(req.query.period) ? req.query.period : '24h';
    const data = getPeerChartData(peer.id, period);

    res.json({
      ok: true,
      peer: { id: peer.id, name: peer.name, total_rx: peer.total_rx, total_tx: peer.total_tx },
      data,
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get peer traffic');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * POST /api/v1/peers/:id/gateway-env/rotate — regenerate tokens and return
 * fresh gateway.env file for a gateway peer. Uses POST (not GET) to prevent
 * accidental browser-prefetch from invalidating live tokens.
 */
router.post('/:id/gateway-env/rotate', (req, res) => {
  const peerId = parseInt(req.params.id, 10);
  try {
    const { apiToken, pushToken, envContent } = require('../../services/gateways').rotateGatewayTokens(peerId);
    res.json({ ok: true, apiToken, pushToken, envContent });
  } catch (err) {
    if (err.message === 'not_a_gateway') {
      return res.status(404).json({ ok: false, error: 'not_a_gateway' });
    }
    logger.error({ error: err.message, peerId }, 'Failed to rotate gateway tokens');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * POST /api/v1/peers/:id/gateway-pairing-code — generate a one-shot
 * pairing code that the install-pve.sh installer can redeem to bootstrap
 * the gateway without manual gateway.env transfer. Single-active per
 * peer, 10-min TTL, hashed at rest. The cleartext token is returned ONCE.
 */
router.post('/:id/gateway-pairing-code', (req, res) => {
  const peerId = parseInt(req.params.id, 10);
  try {
    const { token, expiresAt } = require('../../services/gateways').createPairingCode(peerId);
    res.json({ ok: true, token, expiresAt });
  } catch (err) {
    if (err.message === 'not_a_gateway') {
      return res.status(404).json({ ok: false, error: 'not_a_gateway' });
    }
    logger.error({ error: err.message, peerId }, 'Failed to create gateway pairing code');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

module.exports = router;
