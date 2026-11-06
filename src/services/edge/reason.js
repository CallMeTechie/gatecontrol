'use strict';

// Why the edge channel of a gateway is down. hub.online() only says whether
// the edge CONTAINER's WebSocket (/api/v1/gateway/edge/ws) is open — the
// gateway itself can be fine (heartbeat) while its edge container is missing,
// stopped, fenced off or cannot reach this server. The gateway reports what it
// knows in every heartbeat as telemetry.edge (gatecontrol-gateway
// src/edge/gatewayLink.js telemetry(), docs/edge.md "Telemetrie"):
//
//   null    no edge service in the compose file (the gateway has no /run/gc-edge volume)
//   { deployed, error, fence: { active, backend, error }, host: { at, stale, connected, … } | null }
//
// Reasons, the first that applies (docs/plugins.md "Edge part" › "Server part"):
//   gateway_offline     no heartbeat within the down threshold — the gateway itself is away
//   edge_missing        telemetry.edge === null — no edge service (or the gateway service lacks the edge-run volume)
//   edge_not_running    no fresh summary of the edge host — container stopped or restarting, or edge-status not shared
//   edge_fence          the gateway could not set the network fence; edge parts stay off (fail closed),
//                       e.g. a kernel without the owner match (Synology: xt_owner)
//   edge_not_connected  the edge host runs but has no channel to this server (address/DNS, firewall,
//                       a reverse proxy that does not pass WebSocket upgrades)
//   null                the channel is up, the gateway is older than the edge release or reports no
//                       edge telemetry, or the edge host just (re)connected — the plain 'offline' stays

const semver = require('../plugins/semver');

const REASONS = ['gateway_offline', 'edge_missing', 'edge_not_running', 'edge_fence', 'edge_not_connected'];
const DETAIL_MAX = 300;

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }

// the gateway's own error text, shown as is: one line, printable, bounded
function detailOf(v) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, DETAIL_MAX);
  return s || null;
}

/**
 * @param {{ online: boolean, seenAt: number|null, now?: number, thresholdMs: number,
 *           telemetry: object|null, minGateway?: string }} o
 *   online      hub.online() — the edge channel
 *   seenAt      gateway_meta.last_seen_at (last heartbeat, ms)
 *   telemetry   the telemetry of the last heartbeat (last_health.telemetry)
 *   minGateway  the first gateway release with the edge container (EDGE_MIN_GATEWAY)
 * @returns {{ reason: string|null, detail: string|null }}  detail: the gateway's error text (edge_fence, edge_not_connected)
 */
function diagnose(o) {
  const none = { reason: null, detail: null };
  if (!o || o.online) return none;
  const tel = obj(o.telemetry);
  const version = tel && typeof tel.gateway_version === 'string' ? tel.gateway_version : null;
  // older gateways keep the plain 'offline' (the UI offers an update there)
  if (o.minGateway && version && semver.valid(version) && semver.compare(version, o.minGateway) < 0) return none;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const seen = Number(o.seenAt);
  if (!Number.isFinite(seen) || seen <= 0 || now - seen > o.thresholdMs) return { reason: 'gateway_offline', detail: null };
  if (!tel || !Object.prototype.hasOwnProperty.call(tel, 'edge')) return none;
  if (tel.edge === null) return { reason: 'edge_missing', detail: null };
  const edge = obj(tel.edge);
  if (!edge) return none;
  const host = obj(edge.host);
  if (!host || host.stale === true) return { reason: 'edge_not_running', detail: null };
  const fence = obj(edge.fence);
  if (fence && fence.active === false) return { reason: 'edge_fence', detail: detailOf(fence.error) };
  // the edge host says it is connected: it just (re)connected or the heartbeat is behind — no verdict
  if (host.connected === true) return none;
  return { reason: 'edge_not_connected', detail: detailOf(edge.error) };
}

module.exports = { diagnose, REASONS };
