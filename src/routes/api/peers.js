'use strict';

const { Router } = require('express');
const peers = require('../../services/peers');
const qrcode = require('../../services/qrcode');
const logger = require('../../utils/logger');
const resolveError = require('../../utils/resolveError');
const stripFields = require('../../utils/stripFields');
const { validatePeerName, validateDescription } = require('../../utils/validate');
const { requireLimit } = require('../../middleware/license');
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
    const { name, description, tags, expires_at, group_id } = req.body;

    // Field-level validation
    const fields = {};
    const nameErr = validatePeerName(name);
    if (nameErr) fields.name = req.t('error.peers.name_invalid') || nameErr;
    const descErr = validateDescription(description);
    if (descErr) fields.description = req.t('error.peers.description_invalid') || descErr;
    if (Object.keys(fields).length > 0) {
      return res.status(400).json({ ok: false, error: Object.values(fields)[0], fields });
    }

    const peer = await peers.create({ name, description, tags, expiresAt: expires_at || null, groupId: group_id !== undefined ? group_id : null });
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

module.exports = router;
