// src/middleware/portalOwner.js
'use strict';
const { getDb } = require('../db/connection');
const settings = require('../services/settings');

function trustEnabled() {
  return settings.get('portal.trust_owner_mapping', '0') !== '0';
}

/** Owner (users.id) of a peer via the TP1 peers.user_id column, or null. */
function ownerOfPeer(peerId) {
  if (peerId == null) return null;
  const row = getDb().prepare('SELECT user_id FROM peers WHERE id = ?').get(peerId);
  return row && row.user_id != null ? row.user_id : null;
}

/**
 * Resolve the portal OWNER on top of portalIdentity (which set req.portalPeerId).
 * Precedence: an authenticated session ALWAYS wins over device-owner trust.
 * Device-owner trust only applies when there is no session AND the admin enabled it.
 * The owner id never comes from the request body/query/header (no IDOR).
 */
function portalOwner(req, _res, next) {
  req.portalLoggedIn = !!(req.session && req.session.userId);
  if (req.portalLoggedIn) {
    req.portalOwnerId = req.session.userId;
    req.portalOwnerSource = 'session';
  } else if (trustEnabled() && req.portalPeerId != null) {
    const uid = ownerOfPeer(req.portalPeerId);
    req.portalOwnerId = uid;
    req.portalOwnerSource = uid != null ? 'device' : null;
  } else {
    req.portalOwnerId = null;
    req.portalOwnerSource = null;
  }
  next();
}

module.exports = portalOwner;
module.exports.ownerOfPeer = ownerOfPeer;
