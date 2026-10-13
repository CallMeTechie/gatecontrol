'use strict';

/**
 * Devices of a person for the user profile and the device page
 * (docs/feature-device-location.md): every peer the person owns plus every
 * peer one of their tokens is bound to, with app, online state and the
 * last shared location. A token not registered yet shows as a device
 * without a peer.
 */

const { getDb } = require('../db/connection');
const settings = require('./settings');
const tokens = require('./tokens');
const locations = require('./deviceLocations');

function onlineTimeout() {
  return Number.parseInt(settings.get('data.peer_online_timeout', '180'), 10) || 180;
}

function peerView(p, now = Date.now() / 1000) {
  const hs = Number(p.latest_handshake) || 0;
  return {
    id: p.id,
    name: p.name,
    hostname: p.hostname || null,
    ip: String(p.allowed_ips || '').split('/')[0],
    enabled: p.enabled === 1,
    online: p.enabled === 1 && hs > 0 && now - hs < onlineTimeout(),
    last_handshake: hs || null,
    platform: p.client_platform || null,
    client_version: p.client_version || null,
    product: p.client_product || null,
    client_seen_at: p.client_seen_at || null,
    expires_at: p.expires_at || null,
  };
}

/** Tokens of the user, newest first, in the admin shape (no secrets). */
function tokensOf(userId) {
  return tokens.toAdminList(tokens.listByUserId(userId));
}

/** All devices of [userId]; null when the user does not exist. */
function list(userId) {
  const db = getDb();
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) return null;
  const toks = tokensOf(userId);
  const peerIds = new Set(
    db.prepare("SELECT id FROM peers WHERE user_id = ? AND (peer_type IS NULL OR peer_type = 'regular')").all(userId).map((r) => r.id),
  );
  for (const t of toks) if (t.peer_id != null) peerIds.add(t.peer_id);
  const ids = [...peerIds];
  const peers = ids.length
    ? db.prepare(`SELECT * FROM peers WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : [];
  const last = locations.lastForPeers(ids);
  const now = Date.now() / 1000;
  const devices = peers.map((p) => {
    const token = toks.find((t) => t.peer_id === p.id) || null;
    return {
      key: `p${p.id}`,
      peer: peerView(p, now),
      token: token ? { id: token.id, name: token.name, last_used_at: token.last_used_at, created_at: token.created_at } : null,
      app: !!token,
      location: last[p.id] || null,
    };
  });
  for (const t of toks) {
    if (t.peer_id == null || !peers.some((p) => p.id === t.peer_id)) {
      devices.push({
        key: `t${t.id}`,
        peer: null,
        token: { id: t.id, name: t.name, last_used_at: t.last_used_at, created_at: t.created_at },
        app: true,
        location: null,
      });
    }
  }
  // Online first, then the most recent contact.
  const seen = (d) => (d.peer && d.peer.last_handshake) || 0;
  devices.sort((a, b) => (Number(!!(b.peer && b.peer.online)) - Number(!!(a.peer && a.peer.online))) || seen(b) - seen(a));
  return devices;
}

/** Whether peer [peerId] is one of [userId]'s devices. */
function belongsTo(userId, peerId) {
  const db = getDb();
  const p = db.prepare('SELECT user_id FROM peers WHERE id = ?').get(peerId);
  if (!p) return false;
  if (p.user_id === userId) return true;
  return !!db.prepare('SELECT 1 FROM api_tokens WHERE user_id = ? AND peer_id = ?').get(userId, peerId);
}

/** The device page: peer, token, push channel, location history. null = not found. */
function detail(userId, peerId) {
  if (!belongsTo(userId, peerId)) return null;
  const db = getDb();
  const p = db.prepare('SELECT * FROM peers WHERE id = ?').get(peerId);
  const token = tokensOf(userId).find((t) => t.peer_id === peerId) || null;
  let push = null;
  if (token) {
    const r = db.prepare('SELECT enabled, mode, via, platform, app_version, last_seen_at FROM notify_device_prefs WHERE token_id = ?').get(token.id);
    if (r) push = { enabled: r.enabled === 1, mode: r.mode || null, via: r.via || null, last_seen_at: r.last_seen_at || null };
  }
  return {
    peer: {
      ...peerView(p),
      public_key: p.public_key,
      transfer_rx: Number(p.total_rx || 0) + Number(p.transfer_rx || 0),
      transfer_tx: Number(p.total_tx || 0) + Number(p.transfer_tx || 0),
      created_at: p.created_at,
    },
    token: token ? {
      id: token.id,
      name: token.name,
      created_at: token.created_at,
      last_used_at: token.last_used_at,
      machine_binding: !!token.machine_binding_active,
      device_usage: token.device_usage || 'single',
    } : null,
    push,
    locations: locations.history(peerId),
  };
}

module.exports = { list, detail, belongsTo };
