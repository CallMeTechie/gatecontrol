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

const isIpv4 = (s) => /^(\d{1,3}\.){3}\d{1,3}$/.test(String(s || '')) && String(s).split('.').every((o) => +o >= 0 && +o <= 255);
function badRequest(msg) { const e = new Error(msg); e.statusCode = 400; return e; }

// Minimal IPv4-in-CIDR (matches egressRoutes' subnet-check intent).
function ipToInt(ip) { return ip.split('.').reduce((a, o) => (a << 8) + (+o), 0) >>> 0; }
function ipInCidr(ip, cidr) {
  const [net, bitsRaw] = String(cidr).split('/'); const bits = parseInt(bitsRaw, 10);
  if (!isIpv4(ip) || !isIpv4(net) || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(net) & mask);
}
function gatewayLanSubnets(db, peerId) {
  const row = db.prepare('SELECT last_health FROM gateway_meta WHERE peer_id = ?').get(peerId);
  try { return (JSON.parse(row.last_health || '{}').telemetry.lan_subnets || []).map((s) => s.cidr).filter(Boolean); } catch (_e) { return []; }
}

// Stage A: everything checkable WITHOUT an existing NAS route. The target-route
// internal-only check is Stage B (Task 6) because egressRoutes.validate needs
// the route to exist; in the 'new' path it doesn't yet.
function validateStageA(input, db = getDb()) {
  if (!input || !Number.isInteger(input.near_peer_id)) throw badRequest('near_peer_id required');
  // R1-G1 / DA#9: validate the gateway itself (also covers the print-only path).
  const peer = db.prepare('SELECT peer_type, enabled FROM peers WHERE id = ?').get(input.near_peer_id);
  if (!peer || peer.peer_type !== 'gateway' || !peer.enabled) throw badRequest('near_peer_id must be an enabled gateway');
  if (!isIpv4(input.printer_ip)) throw badRequest('printer_ip must be IPv4');
  if (!input.name || !String(input.name).trim()) throw badRequest('name required');
  const ports = Array.isArray(input.print_ports) ? input.print_ports : [];
  if (!ports.length) throw badRequest('at least one print port required');
  if (input.ews && input.ews.enabled && !String(input.ews.domain || '').trim()) throw badRequest('EWS requires a domain');
  if (input.scan && input.scan.enabled) {
    const subnets = gatewayLanSubnets(db, input.near_peer_id);
    if (!subnets.length) throw badRequest('gateway has not reported LAN subnets yet — wait for a health report');
    if (!isIpv4(input.scan.vip_ip)) throw badRequest('scan.vip_ip must be IPv4');
    if (!subnets.some((c) => ipInCidr(input.scan.vip_ip, c))) throw badRequest('scan.vip_ip must lie within the gateway LAN subnets');
    const t = input.scan.target || {};
    if (t.mode === 'new') { if (!isIpv4(t.nas_ip)) throw badRequest('scan.target.nas_ip must be IPv4'); if (!Number.isInteger(t.nas_peer_id)) throw badRequest('scan.target.nas_peer_id required'); }
    else if (t.mode === 'existing') { if (!Number.isInteger(t.route_id)) throw badRequest('scan.target.route_id required'); }
    else throw badRequest('scan.target.mode must be existing|new');
  }
}

// Build createBundle input. listenPorts: Map(targetPort -> listenPort).
function buildBundleInput(input, listenPorts) {
  const l4 = input.print_ports.map((tp) => ({ l4_protocol: 'tcp', l4_listen_port: String(listenPorts.get(tp)), l4_tls_mode: 'none', target_port: tp }));
  const http = (input.ews && input.ews.enabled) ? { target_port: 443, backend_https: true } : null;
  return {
    name: input.name.trim(),
    domain: (input.ews && input.ews.enabled) ? input.ews.domain.trim().toLowerCase() : null,
    target: { target_kind: 'gateway', target_peer_id: input.near_peer_id, target_lan_host: input.printer_ip },
    http, l4,
  };
}

function buildEgressInput(input, targetRouteId, highPort) {
  return {
    name: `${input.name.trim()} → Scan`,
    near_peer_id: input.near_peer_id,
    vip_ip: input.scan.vip_ip,
    vip_prefix: input.scan.vip_prefix || 24,
    lan_listen_port: highPort,
    target_route_id: targetRouteId,
    allowed_source_ips: [`${input.printer_ip}/32`],
  };
}

module.exports = { allocatePrintListenPort, allocateEgressHighPort, validateStageA, buildBundleInput, buildEgressInput };
