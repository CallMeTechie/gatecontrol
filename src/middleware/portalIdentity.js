// src/middleware/portalIdentity.js
'use strict';
const { getDb } = require('../db/connection');
const { effectivePortalHost } = require('../services/portalConfig');

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** Find a direct, enabled peer whose allowed_ips contains the /32 `ip`. */
function peerFromIp(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const db = getDb();
  // allowed_ips may be a comma-separated list; match any /32 entry robustly in JS.
  const rows = db.prepare(`
    SELECT id, name, allowed_ips FROM peers
    WHERE enabled = 1 AND peer_type != 'gateway'
  `).all();
  for (const r of rows) {
    const entries = String(r.allowed_ips || '').split(',').map(s => s.trim().split('/')[0]);
    if (entries.includes(v4)) return { id: r.id, name: r.name };
  }
  return null;
}

/**
 * Establish per-device identity ONLY when the request provably arrived via the
 * internal home-site Caddy vhost:
 *   (a) the direct connection is from loopback (Caddy → Node),
 *   (b) the Caddy-set reserved header X-GC-Portal-Peer-IP is present, AND
 *   (c) the request Host matches the configured portal host (effectivePortalHost,
 *       belt-and-suspenders: the management-UI vhost also proxies over loopback
 *       but has a different Host, so without this check a forged X-GC-Portal-Peer-IP
 *       header reaching Node via the mgmt vhost would establish false identity).
 * Caddy strips any client-supplied copy of that header on the home vhost
 * (see Task 10), so a VPN client cannot forge it via that path.
 * Generic X-Forwarded-For is intentionally NOT used for identity.
 */
function portalIdentity(req, _res, next) {
  req.portalPeerId = null;
  req.portalPeerName = null;
  const direct = req.socket && req.socket.remoteAddress;
  const headerIp = req.get && req.get('X-GC-Portal-Peer-IP');
  if (isLoopback(direct) && headerIp && req.hostname === effectivePortalHost().host) {
    const peer = peerFromIp(headerIp);
    if (peer) { req.portalPeerId = peer.id; req.portalPeerName = peer.name; }
  }
  next();
}

module.exports = portalIdentity;
module.exports.peerFromIp = peerFromIp;
