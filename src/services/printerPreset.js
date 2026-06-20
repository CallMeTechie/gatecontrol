// src/services/printerPreset.js
'use strict';
const { getDb } = require('../db/connection');
const { assertListenPortFree, suggestFreeListenPort, findListenPortConflict } = require('./l4');

// Print listen-port: prefer target port (9100->9100); if taken, next free.
function allocatePrintListenPort(targetPort, { protocol = 'tcp', excludeRouteIds = [] } = {}) {
  if (!findListenPortConflict(targetPort, { protocol, excludeRouteIds })) return targetPort;
  return suggestFreeListenPort(targetPort, { protocol, excludeRouteIds });
}

// Egress high-port: first free >=14450 not used by an ACTIVE egress route at
// the same near peer (no validate()/UNIQUE covers this — R2-M2). Caller MUST
// invoke this immediately before the synchronous egressRoutes.create (no await
// in between) so compute+insert is one synchronous span.
function allocateEgressHighPort(nearPeerId, db = getDb()) {
  // R1-G4: a pool-sibling egress route binds on the same gateway too — exclude
  // ports used by enabled egress routes at this peer OR at any pool the peer is in
  // (mirror egressRoutes.resolveForPeer's listener scope).
  const used = new Set(
    db.prepare(`SELECT lan_listen_port p FROM egress_routes WHERE enabled = 1 AND (
        near_peer_id = ?
        OR near_pool_id IN (SELECT pool_id FROM gateway_pool_members WHERE peer_id = ?)
      )`).all(nearPeerId, nearPeerId).map((r) => r.p)
  );
  for (let p = 14450; p <= 65535; p++) if (!used.has(p)) return p;
  throw new Error('no free egress high-port available');
}

module.exports = { allocatePrintListenPort, allocateEgressHighPort };
