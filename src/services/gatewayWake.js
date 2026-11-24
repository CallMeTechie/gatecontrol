'use strict';

// Wake-on-LAN for a stored target — the one place that decides WHERE the magic packet goes out:
//
//   target pinned to a gateway (peerId)      → that gateway sends it on its LAN (gateways.notifyWol → POST /api/wol)
//   target routed through a pool (poolId)    → a live member of the pool, in the order Caddy picks them
//                                              (priority, health check); a member that fails → the next one
//   neither                                  → the server's own broadcast (wol.sendMagicPacket)
//
// A pool without a live member never falls back to the server: its broadcast lands in the server's own network,
// not in the home network behind the gateways. Used by the auto-wake of the
// monitor (monitor.js) and gc.remote.wake (remote/targets.js).

const logger = require('../utils/logger');

class WakeError extends Error {
  /** code: 'gateway_offline' (no live member of the pool) | 'wake_failed' (no gateway / the server could send it) */
  constructor(code, message) { super(message); this.name = 'WakeError'; this.code = code; }
}

/**
 * The health snapshot the pool routing works with ({ [peerId]: { alive } }). Before the first tick of the health
 * check the alive flags of gateway_meta stand in, as for the Caddy config.
 */
function healthSnapshot() {
  let snap = {};
  try { snap = require('./gatewayHealth').getSnapshot() || {}; } catch { snap = {}; }
  if (Object.keys(snap).length === 0) {
    try {
      const rows = require('../db/connection').getDb().prepare('SELECT peer_id, alive FROM gateway_meta').all();
      for (const r of rows) snap[r.peer_id] = { alive: r.alive === 1 };
    } catch { /* no gateway_meta: nobody alive */ }
  }
  return snap;
}

/** The live members of a pool in the order Caddy uses them (the first one serves the pool now) → [peerId]. */
function livePoolMembers(poolId) {
  if (poolId == null) return [];
  try { return require('./gatewayPool').resolveActivePeers(Number(poolId), healthSnapshot()) || []; } catch { return []; }
}

/** The member of a pool that carries its traffic now → peerId | null. */
function activePoolMember(poolId) {
  return livePoolMembers(poolId)[0] || null;
}

/**
 * The gateways a wake-up for this target goes through, in order → [peerId]. A pinned peer wins over a pool
 * (the routes never hold both; the RDP routes refuse it).
 */
function wakeCandidates({ peerId, poolId } = {}) {
  if (peerId != null) return [Number(peerId)];
  if (poolId != null) return livePoolMembers(poolId);
  return [];
}

/** Did the gateway take the wake-up? notifyWol gives null on a transport error and { error } on a refusal. */
function accepted(resp) {
  return !!resp && typeof resp === 'object' && !resp.error;
}

/**
 * Wake a target → { sent: true, via: 'gateway', peerId, response } | { sent: true, via: 'server' }.
 * Throws WakeError: gateway_offline (a pool without a live member), wake_failed (every gateway failed,
 * or the server's broadcast failed).
 *
 * @param {object} t
 * @param {number|null} [t.peerId]   the gateway the target sits behind
 * @param {number|null} [t.poolId]   the failover pool the target is routed through
 * @param {string} t.mac
 * @param {string|null} [t.lanHost]  the target in the gateway's LAN (the gateway waits for it to answer)
 * @param {number|null} [t.lanPort]  the port it answers on once awake
 * @param {number} [t.timeoutMs]     how long the gateway waits for it
 */
async function wakeTarget({ peerId = null, poolId = null, mac, lanHost = null, lanPort = null, timeoutMs } = {}) {
  if (peerId == null && poolId == null) {
    try { await require('./wol').sendMagicPacket(mac); } catch (e) { throw new WakeError('wake_failed', String((e && e.message) || e).slice(0, 200)); }
    return { sent: true, via: 'server' };
  }
  const candidates = wakeCandidates({ peerId, poolId });
  if (candidates.length === 0) throw new WakeError('gateway_offline', 'no gateway of the pool is online');
  const gateways = require('./gateways');
  const opts = { mac, lan_host: lanHost };
  const port = Number(lanPort);
  if (Number.isInteger(port) && port > 0 && port < 65536) opts.lan_host_port = port;
  if (timeoutMs != null) opts.timeout_ms = timeoutMs;
  let last = null;
  for (const id of candidates) {
    let resp = null;
    try { resp = await gateways.notifyWol(id, opts); } catch (e) { last = String((e && e.message) || e); resp = null; }
    if (accepted(resp)) return { sent: true, via: 'gateway', peerId: id, response: resp };
    if (resp && resp.error) last = String(resp.error);
    if (candidates.length > 1) logger.warn({ peerId: id, poolId, err: last }, 'WoL via pool member failed, trying the next one');
  }
  throw new WakeError('wake_failed', (last || 'the gateway did not accept the wake-up').slice(0, 200));
}

module.exports = { WakeError, wakeTarget, wakeCandidates, livePoolMembers, activePoolMember, healthSnapshot };
