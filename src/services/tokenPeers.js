'use strict';

/** Peer facts for token rows: name, IP, online state, client. */
function withPeers(list) {
  const { getDb } = require('../db/connection');
  const db = getDb();
  const settings = require('./settings');
  const timeout = Number.parseInt(settings.get('data.peer_online_timeout', '180'), 10) || 180;
  const now = Date.now() / 1000;
  const stmt = db.prepare('SELECT id, name, allowed_ips, latest_handshake, enabled, client_platform, client_version, client_product, user_id FROM peers WHERE id = ?');
  return list.map((t) => {
    if (t.peer_id == null) return { ...t, peer: null };
    const p = stmt.get(t.peer_id);
    if (!p) return { ...t, peer: null };
    const hs = Number(p.latest_handshake) || 0;
    return {
      ...t,
      peer: {
        id: p.id,
        name: p.name,
        ip: String(p.allowed_ips || '').split('/')[0],
        online: p.enabled === 1 && hs > 0 && now - hs < timeout,
        last_handshake: hs || null,
        platform: p.client_platform || null,
        client_version: p.client_version || null,
        product: p.client_product || null,
        owner_id: p.user_id,
      },
    };
  });
}

module.exports = { withPeers };
