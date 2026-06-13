'use strict';

/**
 * Pure aggregation and attribution helpers for Pi-hole multi-instance data.
 * No I/O — all functions are stateless transforms on plain JS values.
 */

/**
 * Merge per-instance summary objects into a single aggregate.
 * - queries.total / queries.blocked are summed
 * - queries.percent is recomputed (blocked / total * 100, 1 decimal)
 * - gravity = max(domains_being_blocked) across instances
 * - clients.active = sum of per-instance active counts, or union size of .ips arrays
 */
function mergeSummary(list) {
  let total = 0;
  let blocked = 0;
  let gravity = 0;
  let activeSum = 0;
  const ipUnion = new Set();
  let hasIps = false;

  for (const inst of list) {
    total += inst.queries?.total ?? 0;
    blocked += inst.queries?.blocked ?? 0;

    const g = inst.gravity?.domains_being_blocked ?? 0;
    if (g > gravity) gravity = g;

    if (Array.isArray(inst.clients?.ips)) {
      hasIps = true;
      for (const ip of inst.clients.ips) ipUnion.add(ip);
    } else {
      activeSum += inst.clients?.active ?? 0;
    }
  }

  const percent = total ? Math.round((blocked / total) * 1000) / 10 : 0;
  const active = hasIps ? ipUnion.size : activeSum;

  return {
    queries: { total, blocked, percent },
    gravity,
    clients: { active },
  };
}

/**
 * Merge multiple top-N lists (each list is an array of { [key]: string, count: number }).
 * Groups by key, sums counts, sorts descending, slices to limit.
 */
function mergeTopList(lists, key, limit = 10) {
  const map = new Map();

  for (const list of lists) {
    for (const item of list) {
      const k = item[key];
      map.set(k, (map.get(k) ?? 0) + item.count);
    }
  }

  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, count]) => ({ [key]: k, count }));
}

/**
 * Merge query-type counts across instances.
 * Returns a plain object { type: totalCount }.
 */
function mergeQueryTypes(list) {
  const result = {};
  for (const inst of list) {
    for (const [type, count] of Object.entries(inst ?? {})) {
      result[type] = (result[type] ?? 0) + count;
    }
  }
  return result;
}

/**
 * Merge time-series history from multiple instances onto a shared bucket grid.
 * bucket = Math.floor(t / bucketSec) * bucketSec
 * Returns array of { t, allowed, blocked } sorted ascending by t.
 */
function mergeHistory(histories, bucketSec) {
  const map = new Map();

  for (const history of histories) {
    for (const point of history) {
      const bucket = Math.floor(point.t / bucketSec) * bucketSec;
      const existing = map.get(bucket) ?? { t: bucket, allowed: 0, blocked: 0 };
      existing.allowed += point.allowed ?? 0;
      existing.blocked += point.blocked ?? 0;
      map.set(bucket, existing);
    }
  }

  return [...map.values()].sort((a, b) => a.t - b.t);
}

/**
 * Merge blocking state across instances.
 * - all true  → 'enabled'
 * - all false → 'disabled'
 * - mixed     → 'partial'
 * - timer: minimum of numeric timer values, or null if none
 */
function mergeBlocking(list) {
  const trueCount = list.filter(i => i.blocking === true).length;
  const falseCount = list.filter(i => i.blocking === false).length;

  let state;
  if (trueCount === list.length) state = 'enabled';
  else if (falseCount === list.length) state = 'disabled';
  else state = 'partial';

  const timers = list.map(i => i.timer).filter(t => typeof t === 'number');
  const timer = timers.length ? Math.min(...timers) : null;

  return { state, timer };
}

/**
 * Attach peer metadata to client entries based on their IP address.
 * peersByIp: { [ip]: { id, name, ... } }
 * Appends peerId / peerName (null when not found).
 */
function mapClientsToPeers(clients, peersByIp) {
  return clients.map(client => {
    const peer = peersByIp[client.ip] ?? null;
    return {
      ...client,
      peerId: peer ? peer.id : null,
      peerName: peer ? peer.name : null,
    };
  });
}

/**
 * Determine attribution mode for the aggregated view.
 * Returns 'per_peer' if any top-client IP is a known WireGuard peer IP,
 * otherwise 'collapsed' (cannot distinguish individual peers).
 */
function detectAttribution(topClientIps, peerIps) {
  const peerSet = new Set(peerIps);
  return topClientIps.some(ip => peerSet.has(ip)) ? 'per_peer' : 'collapsed';
}

module.exports = {
  mergeSummary,
  mergeTopList,
  mergeQueryTypes,
  mergeHistory,
  mergeBlocking,
  mapClientsToPeers,
  detectAttribution,
};
