'use strict';

/**
 * Location sharing on tap (docs/feature-device-location.md):
 *
 *   GET    /api/v1/client/location  → { ok, allowed, last, keep, retention_days }
 *   POST   /api/v1/client/location  { lat, lng, accuracy?, altitude?, provider?, captured_at? }
 *                                   → { ok, at }   403 location_not_allowed
 *   DELETE /api/v1/client/location  → { ok, deleted }
 *
 * Token only (scope `client` or `full-access`), machine binding, the token
 * must belong to a device (peer). The app only sends after its user tapped
 * the satellite button; the server never asks a device for its position.
 * Deleting is always possible, also when sharing is no longer allowed.
 */

const { Router } = require('express');
const { verifyMachineBinding } = require('./helpers');
const { clientLocationLimiter } = require('../../../middleware/rateLimit');
const locations = require('../../../services/deviceLocations');
const activity = require('../../../services/activity');
const { getDb } = require('../../../db/connection');
const logger = require('../../../utils/logger');

const router = Router();

/** Token, scope, machine binding, device. Returns the peer row or null (answered). */
function guard(req, res) {
  if (!req.tokenAuth) { res.status(403).json({ ok: false, error: 'token_required' }); return null; }
  const scopes = req.tokenScopes || [];
  if (!scopes.includes('client') && !scopes.includes('full-access')) {
    res.status(403).json({ ok: false, error: 'scope_required' });
    return null;
  }
  if (!verifyMachineBinding(req, res)) return null;
  const peer = req.tokenPeerId == null ? null
    : getDb().prepare('SELECT id, name FROM peers WHERE id = ?').get(req.tokenPeerId);
  if (!peer) { res.status(403).json({ ok: false, error: 'no_peer' }); return null; }
  res.set('Cache-Control', 'no-store');
  return peer;
}

/** The person the device belongs to: the token's owner, else the peer's. */
function ownerOf(req, peer) {
  return req.tokenUserId != null ? req.tokenUserId : locations.ownerOfPeer(peer.id);
}

router.get('/location', (req, res) => {
  const peer = guard(req, res);
  if (!peer) return undefined;
  try {
    const last = locations.last(peer.id);
    return res.json({
      ok: true,
      allowed: locations.isAllowedForUser(ownerOf(req, peer)),
      last: last ? { lat: last.lat, lng: last.lng, accuracy: last.accuracy, at: last.at } : null,
      keep: locations.LOCATION_KEEP,
      retention_days: locations.RETENTION_DAYS,
    });
  } catch (err) {
    logger.error({ tokenId: req.tokenId, err: err.message }, 'location: status failed');
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

router.post('/location', clientLocationLimiter, (req, res) => {
  const peer = guard(req, res);
  if (!peer) return undefined;
  const userId = ownerOf(req, peer);
  if (!locations.isAllowedForUser(userId)) {
    return res.status(403).json({ ok: false, error: 'location_not_allowed' });
  }
  const checked = locations.validate(req.body);
  if (!checked.ok) return res.status(400).json({ ok: false, error: checked.error });
  try {
    const via = locations.viaOf(req.ip);
    const stored = locations.record({ peerId: peer.id, tokenId: req.tokenId, userId, value: checked.value, via });
    // No coordinates in the activity log: the map on the device page is the
    // one place that shows them (and deleting there removes them for good).
    const acc = stored.accuracy != null ? ` (±${Math.round(stored.accuracy)} m)` : '';
    activity.log('client_location_shared', `Location sent from device "${peer.name}"${acc}`, {
      source: 'api',
      severity: 'info',
      ipAddress: req.ip,
      details: { peerId: peer.id, tokenId: req.tokenId, userId, accuracy: stored.accuracy, via },
    });
    return res.json({ ok: true, at: stored.at });
  } catch (err) {
    logger.error({ tokenId: req.tokenId, err: err.message }, 'location: storing failed');
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

router.delete('/location', clientLocationLimiter, (req, res) => {
  const peer = guard(req, res);
  if (!peer) return undefined;
  try {
    const deleted = locations.deleteForPeer(peer.id);
    activity.log('client_location_deleted', `Locations of device "${peer.name}" deleted by the device`, {
      source: 'api',
      severity: 'info',
      ipAddress: req.ip,
      details: { peerId: peer.id, tokenId: req.tokenId, userId: ownerOf(req, peer), deleted },
    });
    return res.json({ ok: true, deleted });
  } catch (err) {
    logger.error({ tokenId: req.tokenId, err: err.message }, 'location: delete failed');
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

module.exports = router;
