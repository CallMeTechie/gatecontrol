'use strict';

const tokens = require('../../../services/tokens');
const logger = require('../../../utils/logger');
const crypto = require('node:crypto');

function clientLabel(platform) {
  switch ((platform || '').toLowerCase()) {
    case 'android': return 'Android Client';
    case 'win32':
    case 'windows': return 'Desktop Client';
    default: return 'Client';
  }
}

// Verify the requesting token owns the given peerId.
// Returns the validated peerId (Number) or null (and has written an
// error response into res) if ownership is missing/mismatched.
function requirePeerOwnership(req, res) {
  const peerId = req.query.peerId || req.headers['x-peer-id'] || req.body?.peerId;
  if (!peerId) {
    res.status(400).json({ ok: false, error: 'Peer ID is required' });
    return null;
  }

  // Session-based auth (admin UI) can access any peer
  if (!req.tokenAuth) return Number(peerId);

  const boundPeerId = req.tokenPeerId;
  if (boundPeerId == null) {
    res.status(403).json({ ok: false, error: 'Token is not bound to a peer. Register first.' });
    return null;
  }

  if (boundPeerId !== Number(peerId)) {
    logger.warn({ tokenId: req.tokenId, requestedPeerId: peerId, boundPeerId }, 'Peer ownership mismatch');
    res.status(403).json({ ok: false, error: 'Token is not authorized for this peer' });
    return null;
  }

  return Number(peerId);
}

const FINGERPRINT_RE = /^[a-f0-9]{64}$/;

function isBindingActive(req) {
  if (!req.tokenAuth) return false;
  // Licence + mode first: in 'off'/'global' no token lookup is needed.
  const state = tokens.machineBindingState();
  if (!state.licensed || state.mode === 'off') return false;
  if (state.mode === 'global') return true;
  return tokens.isMachineBindingActive(tokens.getById(req.tokenId), state);
}

// Verify machine fingerprint for bound tokens.
// Returns true if OK to proceed, false if response was sent (error).
function verifyMachineBinding(req, res) {
  if (!isBindingActive(req)) return true;

  const fingerprint = req.headers['x-machine-fingerprint'];
  const token = tokens.getById(req.tokenId);
  const stored = token?.machine_fingerprint;

  if (!stored) {
    if (fingerprint && FINGERPRINT_RE.test(fingerprint)) {
      tokens.bindMachineFingerprint(req.tokenId, fingerprint);
      return true;
    }
    res.status(403).json({ ok: false, error: req.t ? req.t('error.client.fingerprint_required') : 'Machine fingerprint required' });
    return false;
  }

  if (!fingerprint) {
    res.status(403).json({ ok: false, error: req.t ? req.t('error.client.fingerprint_required') : 'Machine fingerprint required' });
    return false;
  }

  if (!FINGERPRINT_RE.test(fingerprint)) {
    res.status(400).json({ ok: false, error: req.t ? req.t('error.client.fingerprint_invalid') : 'Invalid machine fingerprint format' });
    return false;
  }

  if (fingerprint !== stored) {
    logger.warn({ tokenId: req.tokenId, stored: stored.substring(0, 8), received: fingerprint.substring(0, 8) }, 'Machine fingerprint mismatch');
    res.status(403).json({ ok: false, error: req.t ? req.t('error.client.binding_mismatch') : 'Token is bound to a different machine' });
    return false;
  }

  return true;
}

// Hash a WireGuard config string for change detection.
function hashConfig(config) {
  return crypto.createHash('sha256').update(config).digest('hex');
}

module.exports = {
  clientLabel,
  requirePeerOwnership,
  verifyMachineBinding,
  isBindingActive,
  hashConfig,
  FINGERPRINT_RE,
};
