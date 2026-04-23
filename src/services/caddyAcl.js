'use strict';

const { getDb } = require('../db/connection');

function getAclPeers(routeId) {
  const db = getDb();
  return db.prepare(`
    SELECT rpa.peer_id, p.name, p.allowed_ips
    FROM route_peer_acl rpa
    JOIN peers p ON p.id = rpa.peer_id
    WHERE rpa.route_id = ?
  `).all(routeId);
}

function setAclPeers(routeId, peerIds) {
  const db = getDb();
  db.prepare('DELETE FROM route_peer_acl WHERE route_id = ?').run(routeId);
  if (Array.isArray(peerIds) && peerIds.length > 0) {
    const insert = db.prepare('INSERT OR IGNORE INTO route_peer_acl (route_id, peer_id) VALUES (?, ?)');
    for (const peerId of peerIds) {
      insert.run(routeId, peerId);
    }
  }
}

module.exports = { getAclPeers, setAclPeers };
