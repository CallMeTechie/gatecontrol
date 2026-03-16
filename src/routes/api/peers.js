'use strict';

const { Router } = require('express');
const peers = require('../../services/peers');
const qrcode = require('../../services/qrcode');
const logger = require('../../utils/logger');

const router = Router();

/** Strip sensitive fields from peer objects before sending to client */
function stripSensitive(peer) {
  if (!peer) return peer;
  const { private_key_encrypted, preshared_key_encrypted, ...safe } = peer;
  return safe;
}

/** Map service-layer error messages to i18n keys */
const VALIDATION_ERROR_MAP = {
  'already exists': 'error.peers.name_exists',
  'No available': 'error.peers.no_ips',
  'not found': 'error.peers.not_found',
};

function resolveError(req, err, fallbackKey) {
  const msg = err.message || '';
  for (const [pattern, key] of Object.entries(VALIDATION_ERROR_MAP)) {
    if (msg.includes(pattern)) return { status: pattern === 'not found' ? 404 : 400, error: req.t(key) };
  }
  return { status: 500, error: req.t(fallbackKey) };
}

/**
 * GET /api/peers — List all peers with live status
 */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 250, 1), 250);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const list = await peers.getAll({ limit, offset });
    res.json({ ok: true, peers: list.map(stripSensitive), limit, offset });
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
    res.json({ ok: true, peer: stripSensitive(peer) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get peer');
    res.status(500).json({ ok: false, error: req.t('error.peers.get') });
  }
});

/**
 * POST /api/peers — Create new peer
 */
router.post('/', async (req, res) => {
  try {
    const { name, description, tags } = req.body;
    const peer = await peers.create({ name, description, tags });
    res.status(201).json({ ok: true, peer: stripSensitive(peer) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to create peer');
    const { status, error } = resolveError(req, err, 'error.peers.create');
    res.status(status).json({ ok: false, error });
  }
});

/**
 * PUT /api/peers/:id — Update peer
 */
router.put('/:id', async (req, res) => {
  try {
    const { name, description, dns, persistentKeepalive, enabled, tags } = req.body;
    const peer = await peers.update(req.params.id, { name, description, dns, persistentKeepalive, enabled, tags });
    res.json({ ok: true, peer: stripSensitive(peer) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update peer');
    const { status, error } = resolveError(req, err, 'error.peers.update');
    res.status(status).json({ ok: false, error });
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
    const { status, error } = resolveError(req, err, 'error.peers.delete');
    res.status(status).json({ ok: false, error });
  }
});

/**
 * POST /api/peers/:id/toggle — Toggle peer enabled/disabled
 */
router.post('/:id/toggle', async (req, res) => {
  try {
    const peer = await peers.toggle(req.params.id);
    res.json({ ok: true, peer: stripSensitive(peer) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to toggle peer');
    const { status, error } = resolveError(req, err, 'error.peers.toggle');
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

module.exports = router;
