'use strict';

/**
 * Admin API for support bundles of one peer (docs/feature-support-bundle.md).
 * Mounted at /api/v1/peers/:id/support-bundles — admin sessions only (API
 * tokens are refused: bundles hold device diagnostics).
 *
 *   GET    /                   → { ok, bundles: [...], requestedAt }
 *   GET    /:bundleId/download → the bundle JSON as attachment
 *   DELETE /:bundleId          → { ok }
 *   POST   /request            → ask the device for a bundle { ok, requestedAt }
 *   DELETE /request            → withdraw the request
 */

const { Router } = require('express');
const { requireAdminSession } = require('../../middleware/auth');
const peers = require('../../services/peers');
const activity = require('../../services/activity');
const supportBundles = require('../../services/supportBundles');
const logger = require('../../utils/logger');

const router = Router({ mergeParams: true });

router.use(requireAdminSession);

function loadPeer(req, res) {
  const id = Number(req.params.id);
  const peer = Number.isInteger(id) && id > 0 ? peers.getById(id) : null;
  if (!peer) {
    res.status(404).json({ ok: false, error: req.t ? req.t('error.peers.not_found') : 'Peer not found' });
    return null;
  }
  return peer;
}

function bundleId(req) {
  const id = Number(req.params.bundleId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.get('/', (req, res) => {
  const peer = loadPeer(req, res);
  if (!peer) return;
  res.json({ ok: true, bundles: supportBundles.list(peer.id), requestedAt: supportBundles.getRequest(peer.id) });
});

router.post('/request', (req, res) => {
  const peer = loadPeer(req, res);
  if (!peer) return;
  if (peer.peer_type === 'gateway') return res.status(400).json({ ok: false, error: req.t('support_bundles.error_gateway') });
  const requestedAt = supportBundles.requestBundle(peer.id);
  activity.log('support_bundle_requested', `Support bundle requested from "${peer.name}"`, {
    source: 'admin', severity: 'info', ipAddress: req.ip, details: { peerId: peer.id },
  });
  res.json({ ok: true, requestedAt });
});

router.delete('/request', (req, res) => {
  const peer = loadPeer(req, res);
  if (!peer) return;
  supportBundles.cancelRequest(peer.id);
  res.json({ ok: true });
});

router.get('/:bundleId/download', (req, res) => {
  const peer = loadPeer(req, res);
  if (!peer) return;
  const id = bundleId(req);
  const meta = id && supportBundles.getById(peer.id, id);
  const json = meta && supportBundles.readJson(peer.id, id);
  if (!json) return res.status(404).json({ ok: false, error: req.t('support_bundles.error_not_found') });

  activity.log('support_bundle_downloaded', `Support bundle #${id} of "${peer.name}" downloaded`, {
    source: 'admin', severity: 'info', ipAddress: req.ip, details: { peerId: peer.id, bundleId: id },
  });

  const safeName = String(peer.name || 'peer').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'peer';
  const stamp = String(meta.created_at || '').replace(/[^0-9]/g, '').slice(0, 14);
  res.set({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="support-${safeName}-${stamp || id}.json"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.send(json);
});

router.delete('/:bundleId', (req, res) => {
  const peer = loadPeer(req, res);
  if (!peer) return;
  const id = bundleId(req);
  try {
    if (!id || !supportBundles.remove(peer.id, id)) {
      return res.status(404).json({ ok: false, error: req.t('support_bundles.error_not_found') });
    }
  } catch (err) {
    logger.error({ err: err.message }, 'support bundle delete failed');
    return res.status(500).json({ ok: false, error: req.t('support_bundles.error_delete') });
  }
  activity.log('support_bundle_deleted', `Support bundle #${id} of "${peer.name}" deleted`, {
    source: 'admin', severity: 'info', ipAddress: req.ip, details: { peerId: peer.id, bundleId: id },
  });
  res.json({ ok: true });
});

module.exports = router;
