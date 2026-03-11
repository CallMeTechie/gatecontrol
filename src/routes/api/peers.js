'use strict';

const { Router } = require('express');
const peers = require('../../services/peers');
const qrcode = require('../../services/qrcode');
const logger = require('../../utils/logger');

const router = Router();

/**
 * GET /api/peers — List all peers with live status
 */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 250, 1), 250);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const list = await peers.getAll({ limit, offset });
    res.json({ ok: true, peers: list, limit, offset });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list peers');
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/peers/:id — Get single peer
 */
router.get('/:id', (req, res) => {
  try {
    const peer = peers.getById(req.params.id);
    if (!peer) return res.status(404).json({ ok: false, error: 'Peer not found' });
    res.json({ ok: true, peer });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get peer');
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/peers — Create new peer
 */
router.post('/', async (req, res) => {
  try {
    const { name, description } = req.body;
    const peer = await peers.create({ name, description });
    res.status(201).json({ ok: true, peer });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to create peer');
    const isValidation = err.message.includes('already exists') || err.message.includes('required') || err.message.includes('must be') || err.message.includes('No available');
    res.status(isValidation ? 400 : 500).json({ ok: false, error: err.message });
  }
});

/**
 * PUT /api/peers/:id — Update peer
 */
router.put('/:id', async (req, res) => {
  try {
    const { name, description, dns, persistentKeepalive, enabled } = req.body;
    const peer = await peers.update(req.params.id, { name, description, dns, persistentKeepalive, enabled });
    res.json({ ok: true, peer });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update peer');
    const status = err.message.includes('not found') ? 404 : err.message.includes('already exists') ? 400 : 500;
    res.status(status).json({ ok: false, error: err.message });
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
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/peers/:id/toggle — Toggle peer enabled/disabled
 */
router.post('/:id/toggle', async (req, res) => {
  try {
    const peer = await peers.toggle(req.params.id);
    res.json({ ok: true, peer });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to toggle peer');
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/peers/:id/config — Download client WireGuard config
 */
router.get('/:id/config', async (req, res) => {
  try {
    const peer = peers.getById(req.params.id);
    if (!peer) return res.status(404).json({ ok: false, error: 'Peer not found' });

    const conf = await peers.getClientConfig(req.params.id);

    if (req.query.download === '1') {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${peer.name}.conf"`);
      return res.send(conf);
    }

    res.json({ ok: true, config: conf, name: peer.name });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get peer config');
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/peers/:id/qr — Get QR code for peer config
 */
router.get('/:id/qr', async (req, res) => {
  try {
    const peer = peers.getById(req.params.id);
    if (!peer) return res.status(404).json({ ok: false, error: 'Peer not found' });

    const conf = await peers.getClientConfig(req.params.id);
    const dataUrl = await qrcode.toDataUrl(conf);

    res.json({ ok: true, qr: dataUrl, config: conf, name: peer.name });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to generate QR code');
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
