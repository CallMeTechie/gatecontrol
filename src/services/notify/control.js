'use strict';

// Control events on the push stream (docs/feature-notification-center.md,
// "Vertrag", `event: control`): a server-side state change reaches the
// affected devices at once instead of with their next poll. Control events
// carry no SSE `id` — they are not stored, not acked and not replayed; a
// device that was offline reconciles from `hello.state` when it reconnects,
// and the apps keep polling slowly as a fallback.
//
//   policy_changed            { policy_version }   client policy of the device changed
//   support_bundle_requested  { requested_at }     an admin asked this device for a bundle
//   peer_state                { enabled }          the device's peer was enabled/disabled
//   config_changed            {}                   the device's WireGuard config changed
//   layout                    { scope, updated_at } the order of the apps' Start / Familie
//                                                  tabs changed (services/clientLayout.js)
//
// Every entry point is best-effort: it never throws (the admin action that
// triggered it must not fail because of push) and it touches the database
// only when at least one stream is open — then with one query for all open
// streams plus what the event needs per device.

const stream = require('./stream');
const logger = require('../../utils/logger');

let configCounter = 0;

const TYPES = Object.freeze(['policy_changed', 'support_bundle_requested', 'peer_state', 'config_changed', 'layout']);

function db() { return require('../../db/connection').getDb(); }

function ids(list) {
  const out = [];
  for (const v of Array.isArray(list) ? list : [list]) {
    const n = Number(v);
    if (Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Open streams with what their token is bound to right now (a token can be
 * bound to its peer after the stream opened, so this is read per event).
 * → [{ conn, tokenId, peerId, groupId }]
 */
function openDevices() {
  const conns = stream.list().filter((c) => !c.closed);
  if (!conns.length) return [];
  const byToken = new Map();
  const tokenIds = conns.map((c) => c.tokenId);
  // In chunks: SQLite caps bound parameters, max_streams is configurable.
  for (let i = 0; i < tokenIds.length; i += 500) {
    const part = tokenIds.slice(i, i + 500);
    const rows = db().prepare(`SELECT t.id, t.peer_id, p.group_id FROM api_tokens t LEFT JOIN peers p ON p.id = t.peer_id
       WHERE t.id IN (${part.map(() => '?').join(',')})`).all(...part);
    for (const r of rows) byToken.set(r.id, r);
  }
  const out = [];
  for (const conn of conns) {
    const r = byToken.get(conn.tokenId);
    if (!r) continue; // token gone — its stream is being closed
    out.push({ conn, tokenId: conn.tokenId, peerId: r.peer_id == null ? null : r.peer_id, groupId: r.group_id == null ? null : r.group_id });
  }
  return out;
}

/**
 * Open devices matching a scope:
 *   { all: true } | { peerIds: [...] } | { groupIds: [...] } | { tokenIds: [...] }
 * (several keys = union).
 */
function targets(scope = {}) {
  const devices = openDevices();
  if (!devices.length || scope.all) return devices;
  const peers = new Set(ids(scope.peerIds || []));
  const groups = new Set(ids(scope.groupIds || []));
  const tokens = new Set(ids(scope.tokenIds || []));
  return devices.filter((d) => (d.peerId != null && peers.has(d.peerId))
    || (d.groupId != null && groups.has(d.groupId))
    || tokens.has(d.tokenId));
}

/**
 * Write one control event. Under backpressure the newest event of each type
 * is kept on the connection and goes out when the socket drains (flush()).
 */
function write(conn, data) {
  if (conn.closed) return false;
  if (conn.lagging) {
    if (!conn.pendingControl) conn.pendingControl = new Map();
    conn.pendingControl.set(data.type, data);
    return false;
  }
  return stream.writeEvent(conn, 'control', data);
}

/** After backpressure: send what was held back (called from the stream's onDrain). */
function flush(conn) {
  if (!conn || !conn.pendingControl || !conn.pendingControl.size) return;
  const pending = [...conn.pendingControl.values()];
  conn.pendingControl.clear();
  for (const data of pending) write(conn, data);
}

/** Run an emission; any error is logged at debug and swallowed. Returns the number of streams written to. */
function safely(what, fn) {
  try { return fn(); } catch (err) {
    logger.debug({ err: err.message, what }, 'push control event not sent');
    return 0;
  }
}

function peerRow(peerId) {
  if (peerId == null) return null;
  return require('../peers').getById(peerId) || null;
}

/** Policy version of a device — the value heartbeat and GET /client/policy (ETag) report. */
function policyVersionOf(peerId, tokenId) {
  return require('../clientPolicy').versionFor(peerRow(peerId), { tokenId });
}

/**
 * The client policy changed for the devices in `scope` (see targets()).
 * Each device gets its own effective version.
 */
function policyChanged(scope) {
  return safely('policy_changed', () => {
    let n = 0;
    for (const d of targets(scope)) {
      const version = safely('policy_changed', () => policyVersionOf(d.peerId, d.tokenId));
      if (write(d.conn, { type: 'policy_changed', policy_version: version == null ? null : version })) n += 1;
    }
    return n;
  });
}

/** An admin asked the devices of `peerId` for a support bundle. */
function supportBundleRequested(peerId, requestedAt) {
  return safely('support_bundle_requested', () => {
    let n = 0;
    for (const d of targets({ peerIds: [peerId] })) {
      if (write(d.conn, { type: 'support_bundle_requested', requested_at: requestedAt || null })) n += 1;
    }
    return n;
  });
}

/** Peer(s) enabled or disabled. Sent before the tunnel is torn down. */
function peerState(peerIds, enabled) {
  return safely('peer_state', () => {
    let n = 0;
    for (const d of targets({ peerIds: ids(peerIds) })) {
      if (write(d.conn, { type: 'peer_state', enabled: !!enabled })) n += 1;
    }
    // A disabled peer has no VPN any more: its VPN-gated streams end (after the event).
    if (!enabled) require('./vpnPresence').drop(ids(peerIds));
    return n;
  });
}

/** The WireGuard client config of the devices in `scope` changed. */
function configChanged(scope) {
  configCounter += 1;
  return safely('config_changed', () => {
    let n = 0;
    for (const d of targets(scope)) {
      if (write(d.conn, { type: 'config_changed' })) n += 1;
    }
    return n;
  });
}

/**
 * The shared layout of the apps' tabs changed (services/clientLayout.js):
 * { userId } → that person's open streams (scope user), { all: true } →
 * every open stream (scope global, or the administrator changed the scope).
 * exceptToken: the device that saved it already knows. updated_at is what
 * GET /api/v1/client/layout now reports as updatedAt (null: nothing stored /
 * scope device). No database access — the streams know their person.
 */
function layoutChanged({ userId = null, all = false, exceptToken = null, scope, updatedAt = null }) {
  return safely('layout', () => {
    let n = 0;
    for (const conn of stream.list()) {
      if (conn.closed || conn.tokenId === exceptToken) continue;
      if (!all && (userId == null || conn.userId !== userId)) continue;
      if (write(conn, { type: 'layout', scope, updated_at: updatedAt })) n += 1;
    }
    return n;
  });
}

/**
 * Hash of the device's WireGuard client config — exactly what
 * GET /client/config and /client/config/check return as `hash`; null for a
 * token without a peer or when the config cannot be built. Never throws.
 */
async function configHashFor(peerId) {
  if (peerId == null) return null;
  try {
    const { hashConfig } = require('../../routes/api/client/helpers');
    return hashConfig(await require('../peers').getClientConfig(peerId));
  } catch (err) {
    logger.debug({ err: err.message, peerId }, 'hello.state: config hash failed');
    return null;
  }
}

/**
 * `hello.state` for a (re)connecting device — the same values the polling
 * endpoints report, so a device reconciles whatever it missed offline:
 *   policy_version              heartbeat `policyVersion` / GET /client/policy `version` (ETag)
 *   peer_enabled                heartbeat `peerEnabled` / peer-info `peer.enabled`
 *   support_bundle_requested    heartbeat `supportBundleRequested`
 *   support_bundle_requested_at heartbeat `supportBundleRequestedAt`
 *   config_hash                 GET /client/config(/check) `hash` (configHashFor())
 * A token not bound to a peer yet: global policy version, false/false/null/null.
 * Synchronous on purpose: the stream registers right after it, so no change
 * falls between the snapshot and the first live event. Never throws.
 */
function stateFor(tokenId, peerId, configHash = null) {
  const state = {
    policy_version: null,
    peer_enabled: false,
    support_bundle_requested: false,
    support_bundle_requested_at: null,
    config_hash: null,
  };
  let peer = null;
  try { peer = peerRow(peerId); } catch (err) { logger.debug({ err: err.message, tokenId }, 'hello.state: peer lookup failed'); }
  try {
    const v = require('../clientPolicy').versionFor(peer, { tokenId });
    state.policy_version = v == null ? null : v;
  } catch (err) { logger.debug({ err: err.message, tokenId }, 'hello.state: policy version failed'); }
  if (!peer) return state;
  state.peer_enabled = peer.enabled === 1;
  state.support_bundle_requested = !!peer.support_bundle_requested_at;
  state.support_bundle_requested_at = peer.support_bundle_requested_at || null;
  state.config_hash = configHash || null;
  return state;
}

/** Counts config_changed emissions — lets a stream that was opening notice one it missed. */
function configSeq() { return configCounter; }

module.exports = {
  TYPES,
  policyChanged,
  supportBundleRequested,
  peerState,
  configChanged,
  layoutChanged,
  stateFor,
  configHashFor,
  configSeq,
  write,
  flush,
  targets,
};
