// src/middleware/portalOwner.js
'use strict';
const { getDb } = require('../db/connection');
const settings = require('../services/settings');

/**
 * "Geräte-Besitzer automatisch erkennen" (setting portal.trust_owner_mapping).
 * On by default since the portal redesign (migration 90 stores '1' unless
 * the admin had switched it off); kill switch for the automatic owner
 * recognition — the VPN-address trust below and the one-time login link of
 * the apps (routes/portal.js) on single-person devices.
 */
function trustEnabled() {
  return settings.get('portal.trust_owner_mapping', '1') !== '0';
}

/** Owner (users.id) of a peer via the TP1 peers.user_id column, or null. */
function ownerOfPeer(peerId) {
  if (peerId == null) return null;
  const row = getDb().prepare('SELECT user_id FROM peers WHERE id = ?').get(peerId);
  return row && row.user_id != null ? row.user_id : null;
}

/** True when the session's account still exists and is enabled. */
function sessionUserActive(userId) {
  const row = getDb().prepare('SELECT enabled FROM users WHERE id = ?').get(userId);
  return !!(row && row.enabled === 1);
}

/**
 * A portal-only session (session.portalOnly, set by the one-time login link
 * or the "Wer bist du?" picker in routes/portal.js) is valid while
 *   * its account is enabled,
 *   * the request comes from the device it was issued for (when the device
 *     identity is known), and
 *   * the account may still use that device (owner / listed person).
 */
// Absolute lifetime of a portal session (routes/portal.js PORTAL_SESSION_MS),
// also for a browser-session cookie that the browser keeps alive.
const PORTAL_SESSION_MS = 8 * 60 * 60 * 1000;

function portalSessionUser(req) {
  const s = req.session;
  if (!s || s.portalOnly !== true || s.portalUserId == null) return null;
  if (!Number.isFinite(s.portalAt) || Date.now() - s.portalAt > PORTAL_SESSION_MS) return null;
  if (req.portalPeerId != null && s.portalPeerId != null && req.portalPeerId !== s.portalPeerId) return null;
  if (!sessionUserActive(s.portalUserId)) return null;
  const peerId = s.portalPeerId != null ? s.portalPeerId : req.portalPeerId;
  if (peerId != null && !require('../services/portalDevices').userMayUseDevice(s.portalUserId, peerId)) return null;
  return s.portalUserId;
}

/**
 * Resolve the portal OWNER on top of portalIdentity (which set req.portalPeerId).
 * Precedence:
 *   1. a full web session (password/passkey login, session.userId)
 *   2. a portal-only session (login link of the app, or picker + PIN)
 *   3. the anonymous mode the visitor chose ("nur die Dienste für alle")
 *   4. a shared device: nobody — the page asks "Wer bist du?" (never IP trust)
 *   5. a single-person device + automatic owner recognition: peers.user_id
 * The owner id never comes from the request body/query/header (no IDOR).
 *
 * Sets req.portalOwnerId, req.portalOwnerSource ('session' | 'portal' |
 * 'device' | null), req.portalLoggedIn (may control devices),
 * req.portalAnonymous and req.portalSharedDevice.
 */
function portalOwner(req, _res, next) {
  req.portalOwnerId = null;
  req.portalOwnerSource = null;
  req.portalLoggedIn = false;
  req.portalAnonymous = false;
  req.portalSharedDevice = false;

  if (req.portalPeerId != null) {
    try {
      const info = require('../services/portalDevices').usageForPeer(req.portalPeerId);
      req.portalSharedDevice = !!(info && info.mode === 'multi');
    } catch { req.portalSharedDevice = false; }
  }

  // A session of a deleted/disabled account counts as logged out here too
  // (the portal is mounted outside requireAuth).
  if (req.session && req.session.userId && sessionUserActive(req.session.userId)) {
    req.portalLoggedIn = true;
    req.portalOwnerId = req.session.userId;
    req.portalOwnerSource = 'session';
    return next();
  }
  const portalUser = portalSessionUser(req);
  if (portalUser != null) {
    req.portalLoggedIn = true;
    req.portalOwnerId = portalUser;
    req.portalOwnerSource = 'portal';
    return next();
  }
  if (req.session && req.session.portalAnonymous === true) {
    req.portalAnonymous = true;
    return next();
  }
  if (req.portalSharedDevice) return next();
  // Device trust: the owner's view without a login (read-only — controlling
  // a device needs req.portalLoggedIn). Admin kill switch: trustEnabled().
  if (trustEnabled() && req.portalPeerId != null) {
    const uid = ownerOfPeer(req.portalPeerId);
    if (uid != null && sessionUserActive(uid)) {
      req.portalOwnerId = uid;
      req.portalOwnerSource = 'device';
    }
  }
  next();
}

module.exports = portalOwner;
module.exports.ownerOfPeer = ownerOfPeer;
module.exports.trustEnabled = trustEnabled;
module.exports.portalSessionUser = portalSessionUser;
