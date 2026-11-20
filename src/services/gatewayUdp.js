'use strict';

// UDP through a gateway (docs/feature-domain-zones.md "UDP über ein Gateway").
//
// A gateway forwards UDP once it names the capability `udp-routes` in its
// heartbeat (telemetry.capabilities, gatecontrol-gateway docs/udp.md). Every
// gateway since 1.21.0 reports its capabilities, so the capability alone
// decides — MIN_GATEWAY_UDP is only the version named in the hint "update the
// gateway". A gateway that has not reported yet (never online) counts as not
// able to.
//
// - A UDP entry on a gateway target needs that gateway to be able to; on a
//   pool, at least one member. Otherwise 400 UDP_VIA_GATEWAY with the hint.
// - Only a capable gateway gets `udp_routes` in its config pull
//   (gateways.getGatewayConfig); Caddy hands a pool's UDP entries only to
//   capable members (caddyConfig.resolveRouteUpstreams).
// - After the update the gateway's next heartbeat names the capability, its
//   config hash changes (udp_routes appears), it pulls the config — UDP
//   entries that sat behind it "without effect" work from then on.

const { getDb } = require('../db/connection');

const UDP_CAPABILITY = 'udp-routes';
const MIN_GATEWAY_UDP = '1.40.0';

function capabilitiesOf(lastHealth) {
  let h = lastHealth;
  if (typeof h === 'string') {
    try { h = JSON.parse(h); } catch { return []; }
  }
  const t = h && typeof h === 'object' && h.telemetry && typeof h.telemetry === 'object' ? h.telemetry : null;
  return t && Array.isArray(t.capabilities) ? t.capabilities.filter((c) => typeof c === 'string') : [];
}

/** Does the gateway (peer id) forward UDP? */
function peerSupportsUdp(peerId, db = getDb()) {
  const id = Number(peerId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const row = db.prepare('SELECT last_health FROM gateway_meta WHERE peer_id = ?').get(id);
  return !!row && capabilitiesOf(row.last_health).includes(UDP_CAPABILITY);
}

/** Members of a pool that forward UDP (peer ids, priority order). */
function poolUdpPeers(poolId, db = getDb()) {
  const id = Number(poolId);
  if (!Number.isInteger(id) || id <= 0) return [];
  return db.prepare(`
    SELECT m.peer_id, gm.last_health FROM gateway_pool_members m
    LEFT JOIN gateway_meta gm ON gm.peer_id = m.peer_id
    WHERE m.pool_id = ? ORDER BY m.priority, m.peer_id
  `).all(id).filter((r) => capabilitiesOf(r.last_health).includes(UDP_CAPABILITY)).map((r) => r.peer_id);
}

const hasId = (v) => v !== undefined && v !== null && v !== '';

/**
 * Can the target forward UDP? { peerId, poolId } — a pool wins when both are
 * set (the pool is what Caddy dials). No target → false.
 */
function targetSupportsUdp({ peerId, poolId } = {}, db = getDb()) {
  if (hasId(poolId)) return poolUdpPeers(poolId, db).length > 0;
  if (hasId(peerId)) return peerSupportsUdp(peerId, db);
  return false;
}

/** The refusal: 400 UDP_VIA_GATEWAY, message prefix udp_via_gateway / udp_via_pool (translated in the API layer). */
function udpRefusal({ pool = false, field = null } = {}) {
  const prefix = pool ? 'udp_via_pool' : 'udp_via_gateway';
  const message = pool
    ? `${prefix}: no gateway of this pool forwards UDP yet — update a gateway of the pool (from version ${MIN_GATEWAY_UDP})`
    : `${prefix}: this gateway does not forward UDP yet — update the gateway (from version ${MIN_GATEWAY_UDP})`;
  const err = new Error(message);
  err.statusCode = 400;
  err.code = 'UDP_VIA_GATEWAY';
  err.minVersion = MIN_GATEWAY_UDP;
  err.i18nKey = pool ? 'error.routes.udp_via_pool' : 'error.routes.udp_via_gateway';
  if (field) err.fields = { [field]: message };
  return err;
}

/** Throws the refusal unless the target can forward UDP. */
function assertUdpTarget({ peerId, poolId } = {}, { field = null, db = getDb() } = {}) {
  if (targetSupportsUdp({ peerId, poolId }, db)) return;
  throw udpRefusal({ pool: hasId(poolId), field });
}

/**
 * For listings: a memo (one query per gateway/pool per call) → for a route row
 * with target_kind 'gateway' whether its target forwards UDP; null for other rows.
 */
function makeRowJudge(db = getDb()) {
  const peers = new Map();
  const pools = new Map();
  return (row) => {
    if (!row || (row.target_kind || 'peer') !== 'gateway') return null;
    if (hasId(row.target_pool_id)) {
      const k = Number(row.target_pool_id);
      if (!pools.has(k)) pools.set(k, poolUdpPeers(k, db).length > 0);
      return pools.get(k);
    }
    if (hasId(row.target_peer_id)) {
      const k = Number(row.target_peer_id);
      if (!peers.has(k)) peers.set(k, peerSupportsUdp(k, db));
      return peers.get(k);
    }
    return false;
  };
}

module.exports = {
  UDP_CAPABILITY,
  MIN_GATEWAY_UDP,
  capabilitiesOf,
  peerSupportsUdp,
  poolUdpPeers,
  targetSupportsUdp,
  assertUdpTarget,
  udpRefusal,
  makeRowJudge,
};
