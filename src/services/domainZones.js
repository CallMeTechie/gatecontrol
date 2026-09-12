'use strict';

// Domain zones: a layer over `domains` (zone), `service_bundles` (host) and
// `routes` (entry). The routes table and the Caddy generation stay unchanged —
// this module only reads them, re-targets whole zones (applyGateway) and keeps
// the host ↔ zone links consistent (reconcile). Contract:
// docs/feature-domain-zones.md.

const { getDb } = require('../db/connection');
const logger = require('../utils/logger');
const { withCaddySync } = require('./routesSync');
const { restoreRouteRow } = require('./routesRollback');

function httpError(statusCode, message, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

function normalizeHost(h) {
  return String(h || '').trim().toLowerCase().replace(/\.$/, '');
}

// Looked up at call time (not destructured at load) so a test stub of
// caddyConfig.syncToCaddy applies no matter when it was installed.
function syncToCaddy() {
  return require('./caddyConfig').syncToCaddy();
}

function publish(domainId, hostId) {
  try {
    require('./eventBus').publish('routes', { domain_id: domainId == null ? null : domainId, host_id: hostId == null ? null : hostId });
  } catch (err) {
    logger.warn({ err: err.message }, 'routes event publish failed');
  }
}

// ─── Zone resolution ────────────────────────────────────

/**
 * Longest-suffix match of an fqdn against ALL domains rows (any status).
 * Unlike domainSeed.baseDomain() (last two labels) this finds
 * 'example.co.uk' for 'a.b.example.co.uk'.
 * → { domain_id, domain, subdomain } | null   (subdomain '@' = zone apex)
 */
function resolveZone(fqdn, db = getDb()) {
  const host = normalizeHost(fqdn);
  if (!host) return null;
  let best = null;
  for (const d of db.prepare('SELECT id, domain FROM domains').all()) {
    const dom = normalizeHost(d.domain);
    if (!dom) continue;
    if (host === dom || host.endsWith('.' + dom)) {
      if (!best || dom.length > best.domain.length) best = { domain_id: d.id, domain: dom };
    }
  }
  if (!best) return null;
  return {
    domain_id: best.domain_id,
    domain: best.domain,
    subdomain: host === best.domain ? '@' : host.slice(0, -(best.domain.length + 1)),
  };
}

function fqdnOf(subdomain, zoneDomain) {
  if (!zoneDomain) return null;
  if (!subdomain || subdomain === '@') return zoneDomain;
  return subdomain + '.' + zoneDomain;
}

// ─── Targets ────────────────────────────────────────────
//
// A zone's "gateway" is a target triple { kind, peer_id, pool_id } mapped
// onto the existing route columns (same mapping as migration 69):
//   gateway → target_kind='gateway', target_peer_id
//   pool    → target_kind='gateway', target_pool_id
//   peer    → target_kind='peer',    peer_id
// A route that is mid-failover (original_peer_id set) still belongs to its
// home gateway.

function routeTarget(r) {
  if (!r) return null;
  if (r.target_kind === 'gateway') {
    if (r.target_pool_id != null) return { kind: 'pool', peer_id: null, pool_id: r.target_pool_id };
    const home = r.original_peer_id != null ? r.original_peer_id : r.target_peer_id;
    return { kind: 'gateway', peer_id: home == null ? null : home, pool_id: null };
  }
  return { kind: 'peer', peer_id: r.peer_id == null ? null : r.peer_id, pool_id: null };
}

function zoneTarget(zoneRow) {
  if (!zoneRow || !zoneRow.gateway_kind) return null;
  return {
    kind: zoneRow.gateway_kind,
    peer_id: zoneRow.gateway_peer_id == null ? null : zoneRow.gateway_peer_id,
    pool_id: zoneRow.gateway_pool_id == null ? null : zoneRow.gateway_pool_id,
  };
}

function sameTarget(a, b) {
  if (!a || !b) return false;
  return a.kind === b.kind
    && (a.peer_id == null ? null : Number(a.peer_id)) === (b.peer_id == null ? null : Number(b.peer_id))
    && (a.pool_id == null ? null : Number(a.pool_id)) === (b.pool_id == null ? null : Number(b.pool_id));
}

// Validate a requested zone target; returns the normalized triple.
function validateTarget(input, db = getDb()) {
  const kind = input && input.kind;
  if (!['gateway', 'pool', 'peer'].includes(kind)) {
    throw httpError(400, 'kind must be gateway, pool or peer');
  }
  if (kind === 'pool') {
    const poolId = parseInt(input.pool_id, 10);
    if (!Number.isInteger(poolId)) throw httpError(400, 'pool_id required');
    const pool = db.prepare('SELECT id FROM gateway_pools WHERE id = ?').get(poolId);
    if (!pool) throw httpError(400, 'Gateway pool not found');
    const members = db.prepare('SELECT COUNT(*) AS n FROM gateway_pool_members WHERE pool_id = ?').get(poolId).n;
    if (members === 0) throw httpError(400, 'Gateway pool has no members');
    return { kind, peer_id: null, pool_id: poolId };
  }
  const peerId = parseInt(input.peer_id, 10);
  if (!Number.isInteger(peerId)) throw httpError(400, 'peer_id required');
  const peer = db.prepare('SELECT id, peer_type, enabled, allowed_ips FROM peers WHERE id = ?').get(peerId);
  if (!peer) throw httpError(400, 'Peer not found');
  if (!peer.enabled) throw httpError(400, 'Peer is disabled');
  if (kind === 'gateway') {
    const gm = db.prepare('SELECT peer_id FROM gateway_meta WHERE peer_id = ?').get(peerId);
    if (peer.peer_type !== 'gateway' || !gm) throw httpError(400, 'Peer is not a gateway');
  } else if (!peer.allowed_ips) {
    throw httpError(400, 'Peer has no VPN address');
  }
  return { kind, peer_id: peerId, pool_id: null };
}

/**
 * Rewrite the target columns of the given routes to `target` — the same
 * column conventions routes.create() uses per target kind:
 *   gateway/pool: target_kind='gateway', peer_id NULL, target_ip stays (or
 *     becomes the '127.0.0.1' placeholder when coming from a peer target),
 *     target_lan_port defaults to target_port, target_lan_host is kept.
 *   peer: target_kind='peer', peer_id + target_ip = the peer's VPN IP,
 *     gateway columns cleared like routes.update() does on a kind switch;
 *     target_port becomes the service port (target_lan_port) when the row
 *     was a gateway row.
 * original_peer_id is cleared: an explicit re-target ends any failover.
 * SQLite evaluates every SET expression against the OLD row, so the CASEs
 * see the previous target_kind. Caller owns transaction + sync.
 */
function rewriteTargets(db, routeIds, target) {
  if (!routeIds.length) return;
  const ph = routeIds.map(() => '?').join(',');
  if (target.kind === 'peer') {
    const peer = db.prepare('SELECT allowed_ips FROM peers WHERE id = ?').get(target.peer_id);
    const ip = String(peer.allowed_ips).split('/')[0];
    db.prepare(`UPDATE routes SET
        target_port = CASE WHEN target_kind = 'gateway' THEN COALESCE(target_lan_port, target_port) ELSE target_port END,
        target_kind = 'peer', peer_id = ?, target_ip = ?,
        target_peer_id = NULL, target_pool_id = NULL, original_peer_id = NULL,
        target_lan_host = NULL, target_lan_port = NULL, wol_enabled = 0, wol_mac = NULL,
        updated_at = datetime('now')
      WHERE id IN (${ph})`).run(target.peer_id, ip, ...routeIds);
    return;
  }
  db.prepare(`UPDATE routes SET
      target_ip = CASE WHEN target_kind = 'gateway' THEN target_ip ELSE '127.0.0.1' END,
      target_lan_port = COALESCE(target_lan_port, target_port),
      target_kind = 'gateway', peer_id = NULL,
      target_peer_id = ?, target_pool_id = ?, original_peer_id = NULL,
      updated_at = datetime('now')
    WHERE id IN (${ph})`).run(
    target.kind === 'gateway' ? target.peer_id : null,
    target.kind === 'pool' ? target.pool_id : null,
    ...routeIds,
  );
}

// Gateway peers whose companion config depends on these targets (for the
// fire-and-forget config push after a re-target).
function peersForTargets(db, targets) {
  const out = new Set();
  for (const t of targets) {
    if (!t) continue;
    if (t.kind === 'gateway' && t.peer_id != null) out.add(Number(t.peer_id));
    if (t.kind === 'pool' && t.pool_id != null) {
      for (const m of db.prepare('SELECT peer_id FROM gateway_pool_members WHERE pool_id = ?').all(t.pool_id)) {
        out.add(m.peer_id);
      }
    }
  }
  return out;
}

function notifyGateways(peerIds) {
  if (!peerIds || peerIds.size === 0) return;
  try {
    const gateways = require('./gateways');
    for (const pid of peerIds) gateways.notifyConfigChanged(pid).catch(() => {});
  } catch { /* module load guard */ }
}

function rebuildDns(label) {
  try { require('./dns').rebuildNow(); } catch (err) { logger.warn({ err: err?.message ?? String(err) }, `DNS rebuild after ${label} failed`); }
}

// Entries (without an explicit LAN host) cannot move behind a gateway: the
// gateway needs target_lan_host to know where to forward.
function assertLanHosts(rows, target) {
  if (target.kind === 'peer') return;
  const missing = rows.filter((r) => !(r.target_kind === 'gateway' && r.target_lan_host));
  if (missing.length > 0) {
    throw httpError(400, 'Entries without a LAN address cannot be moved behind a gateway (routes '
      + missing.map((r) => r.id).join(', ') + ')', 'LAN_HOST_REQUIRED');
  }
}

/**
 * Re-target routes (one transaction) and run exactly one Caddy sync; on sync
 * failure every route row is restored from its snapshot and `extraRollback`
 * runs in the same transaction. Returns the snapshots.
 */
async function retarget(db, routeIds, target, { beforeRows, extraWrite, extraRollback, label }) {
  const snapshots = beforeRows || (routeIds.length
    ? db.prepare(`SELECT * FROM routes WHERE id IN (${routeIds.map(() => '?').join(',')})`).all(...routeIds)
    : []);
  db.transaction(() => {
    if (extraWrite) extraWrite();
    rewriteTargets(db, snapshots.map((r) => r.id), target);
  })();
  if (snapshots.length === 0) return snapshots;
  await withCaddySync(syncToCaddy, () => {
    db.transaction(() => {
      for (const row of snapshots) restoreRouteRow(db, row.id, row);
      if (extraRollback) extraRollback();
    })();
  }, label);
  return snapshots;
}

// ─── Read model ─────────────────────────────────────────

const HEALTH_RANK = { disabled: 0, ok: 1, degraded: 2, down: 3 };

function hostHealth(entryHealths) {
  if (entryHealths.length === 0) return 'ok';
  const active = entryHealths.filter((h) => h !== 'disabled');
  if (active.length === 0) return 'disabled';
  const down = active.filter((h) => h === 'down').length;
  if (down === 0) return 'ok';
  return down < active.length ? 'degraded' : 'down';
}

function zoneHealth(hostHealths) {
  if (hostHealths.length === 0) return 'ok';
  return hostHealths.reduce((worst, h) => (HEALTH_RANK[h] > HEALTH_RANK[worst] ? h : worst), 'disabled');
}

function peerOnline(peer, timeoutS) {
  if (!peer || !peer.latest_handshake) return false;
  return (Date.now() / 1000 - Number(peer.latest_handshake)) < timeoutS;
}

function loadContext(db) {
  let timeoutS = 180;
  try { timeoutS = parseInt(require('./settings').get('data.peer_online_timeout', '180'), 10) || 180; } catch { /* default */ }
  const peers = new Map(db.prepare('SELECT id, name, allowed_ips, enabled, peer_type, latest_handshake FROM peers').all()
    .map((p) => [p.id, p]));
  const gwMeta = new Map(db.prepare('SELECT peer_id, alive FROM gateway_meta').all().map((g) => [g.peer_id, g]));
  const pools = db.prepare('SELECT id, name, enabled FROM gateway_pools ORDER BY name COLLATE NOCASE').all();
  const poolMembers = new Map();
  for (const m of db.prepare('SELECT pool_id, peer_id FROM gateway_pool_members').all()) {
    if (!poolMembers.has(m.pool_id)) poolMembers.set(m.pool_id, []);
    poolMembers.get(m.pool_id).push(m.peer_id);
  }
  return { timeoutS, peers, gwMeta, pools, poolById: new Map(pools.map((p) => [p.id, p])), poolMembers };
}

function gatewayOnline(ctx, peerId) {
  const gm = ctx.gwMeta.get(peerId);
  if (!gm) return null;
  return gm.alive === 1;
}

function poolOnline(ctx, poolId) {
  const members = ctx.poolMembers.get(poolId) || [];
  return members.some((pid) => gatewayOnline(ctx, pid) === true);
}

function entryHealth(e, ctx) {
  if (!e.enabled) return 'disabled';
  if (e.monitoring_enabled && e.monitoring_status === 'down') return 'down';
  if (e.target_kind === 'gateway') {
    if (e.target_pool_id != null) return poolOnline(ctx, e.target_pool_id) ? 'ok' : 'down';
    if (e.target_peer_id != null && gatewayOnline(ctx, e.target_peer_id) === false) return 'down';
    return 'ok';
  }
  if (e.peer_id != null) {
    const peer = ctx.peers.get(e.peer_id);
    if (!peer || !peer.enabled || !peerOnline(peer, ctx.timeoutS)) return 'down';
  }
  return 'ok';
}

function describeTarget(t, ctx) {
  const out = { kind: t ? t.kind : null, peer_id: t ? t.peer_id : null, pool_id: t ? t.pool_id : null, name: null, ip: null, online: null };
  if (!t) return out;
  if (t.kind === 'pool') {
    const pool = ctx.poolById.get(t.pool_id);
    out.name = pool ? pool.name : null;
    out.online = pool ? poolOnline(ctx, t.pool_id) : null;
    return out;
  }
  const peer = t.peer_id != null ? ctx.peers.get(t.peer_id) : null;
  if (peer) {
    out.name = peer.name;
    out.ip = peer.allowed_ips ? String(peer.allowed_ips).split('/')[0] : null;
    out.online = t.kind === 'gateway' ? gatewayOnline(ctx, t.peer_id) : (!!peer.enabled && peerOnline(peer, ctx.timeoutS));
  }
  return out;
}

function sortEntries(entries) {
  return entries.sort((a, b) => {
    const ah = a.route_type === 'l4' ? 1 : 0;
    const bh = b.route_type === 'l4' ? 1 : 0;
    if (ah !== bh) return ah - bh;
    const ap = parseInt(a.l4_listen_port, 10) || 0;
    const bp = parseInt(b.l4_listen_port, 10) || 0;
    if (ap !== bp) return ap - bp;
    return a.id - b.id;
  });
}

function sortHosts(hosts) {
  return hosts.sort((a, b) => {
    if (a.subdomain === '@' && b.subdomain !== '@') return -1;
    if (b.subdomain === '@' && a.subdomain !== '@') return 1;
    const as = a.subdomain || a.fqdn || a.name || '';
    const bs = b.subdomain || b.fqdn || b.name || '';
    const c = as.localeCompare(bs, undefined, { sensitivity: 'base' });
    return c !== 0 ? c : (a.id || 0) - (b.id || 0);
  });
}

function buildHost(bundle, entries, zone, ctx) {
  sortEntries(entries);
  const own = entries.filter((e) => !e.rdp_owned);
  const lead = own[0] || entries[0] || null;
  const gwEntry = own.find((e) => e.target_kind === 'gateway' && e.target_lan_host);
  const healths = entries.map((e) => e.health);
  const target = lead ? routeTarget(lead) : null;
  return {
    id: bundle ? bundle.id : null,
    domain_id: zone ? zone.id : null,
    subdomain: zone && bundle ? bundle.subdomain : null,
    fqdn: zone && bundle && bundle.subdomain ? fqdnOf(bundle.subdomain, zone.domain) : ((bundle && bundle.domain) || null),
    name: bundle ? bundle.name : (lead ? (lead.description || 'Remote Desktop') : 'Remote Desktop'),
    description: bundle ? (bundle.description || null) : null,
    template: bundle ? (bundle.template || null) : 'rdp',
    lan_host: target && target.kind !== 'peer' ? (gwEntry ? gwEntry.target_lan_host : null) : null,
    gateway_override: !!(bundle && bundle.gateway_override),
    target: describeTarget(target, ctx),
    entry_count: entries.length,
    enabled_count: entries.filter((e) => e.enabled).length,
    health: hostHealth(healths),
    entries,
  };
}

/**
 * The whole zones page in one call (fixed number of queries, no N+1).
 * → { zones: Zone[], unassigned: Host[], gateways, pools }
 */
function listZones() {
  const db = getDb();
  const routesSvc = require('./routes');
  const ctx = loadContext(db);

  const rdpByRoute = new Map(db.prepare(
    'SELECT id, gateway_l4_route_id FROM rdp_routes WHERE gateway_l4_route_id IS NOT NULL'
  ).all().map((r) => [r.gateway_l4_route_id, r.id]));

  const entries = routesSvc.toApiRows(routesSvc.getAll({ limit: 1000000 })).map((row) => {
    const e = { ...row, rdp_owned: rdpByRoute.has(row.id), rdp_route_id: rdpByRoute.get(row.id) || null };
    e.health = entryHealth(e, ctx);
    return e;
  });

  const domainRows = db.prepare('SELECT * FROM domains ORDER BY domain').all();
  const zoneById = new Map(domainRows.map((d) => [d.id, d]));
  const bundles = db.prepare('SELECT * FROM service_bundles').all();

  const entriesByBundle = new Map();
  const loose = [];
  for (const e of entries) {
    if (e.bundle_id != null) {
      if (!entriesByBundle.has(e.bundle_id)) entriesByBundle.set(e.bundle_id, []);
      entriesByBundle.get(e.bundle_id).push(e);
    } else {
      loose.push(e);
    }
  }

  // RDP-owned (and any other host-less) entries: shown read-only in the card
  // of the host that targets the same LAN address, else as a host-less card.
  const lanHostOf = (b) => {
    const m = (entriesByBundle.get(b.id) || []).find((e) => e.target_kind === 'gateway' && e.target_lan_host);
    return m ? m.target_lan_host : null;
  };
  const bundleByLan = new Map();
  for (const b of bundles) {
    const lan = lanHostOf(b);
    if (lan && !bundleByLan.has(lan)) bundleByLan.set(lan, b.id);
  }
  const orphans = [];
  for (const e of loose) {
    const hostId = e.target_lan_host ? bundleByLan.get(e.target_lan_host) : null;
    if (hostId != null) entriesByBundle.get(hostId).push(e);
    else orphans.push(e);
  }

  const zones = domainRows.map((d) => ({ row: d, hosts: [] }));
  const zoneSlot = new Map(zones.map((z) => [z.row.id, z]));
  const unassigned = [];
  for (const b of bundles) {
    const zone = b.domain_id != null ? zoneById.get(b.domain_id) : null;
    const host = buildHost(b, entriesByBundle.get(b.id) || [], zone || null, ctx);
    if (zone) zoneSlot.get(zone.id).hosts.push(host);
    else unassigned.push(host);
  }
  for (const e of orphans) unassigned.push(buildHost(null, [e], null, ctx));

  const outZones = zones.map(({ row, hosts }) => {
    sortHosts(hosts);
    const all = hosts.flatMap((h) => h.entries);
    return {
      domain_id: row.id,
      domain: row.domain,
      verification: row.status,
      gateway: describeTarget(zoneTarget(row), ctx),
      default_external_enabled: !!row.default_external_enabled,
      counts: {
        hosts: hosts.length,
        entries: all.length,
        http: all.filter((e) => e.route_type !== 'l4').length,
        l4: all.filter((e) => e.route_type === 'l4').length,
        disabled: all.filter((e) => !e.enabled).length,
      },
      health: zoneHealth(hosts.map((h) => h.health)),
      hosts,
    };
  });

  unassigned.sort((a, b) => String(a.fqdn || a.name).localeCompare(String(b.fqdn || b.name), undefined, { sensitivity: 'base' }));

  const gateways = [...ctx.peers.values()]
    .filter((p) => p.peer_type === 'gateway' && p.enabled && ctx.gwMeta.has(p.id))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }))
    .map((p) => ({
      id: p.id,
      name: p.name,
      ip: p.allowed_ips ? String(p.allowed_ips).split('/')[0] : null,
      online: gatewayOnline(ctx, p.id),
    }));
  const pools = ctx.pools.map((p) => ({ id: p.id, name: p.name }));

  return { zones: outZones, unassigned, gateways, pools };
}

function getZone(domainId) {
  return listZones().zones.find((z) => z.domain_id === Number(domainId)) || null;
}

function getHost(hostId) {
  const view = listZones();
  const id = Number(hostId);
  for (const z of view.zones) {
    const h = z.hosts.find((x) => x.id === id);
    if (h) return h;
  }
  return view.unassigned.find((x) => x.id === id) || null;
}

function getEntry(routeId) {
  const view = listZones();
  const id = Number(routeId);
  const hosts = [...view.zones.flatMap((z) => z.hosts), ...view.unassigned];
  for (const h of hosts) {
    const e = h.entries.find((x) => x.id === id);
    if (e) return e;
  }
  return null;
}

// ─── Mutations ──────────────────────────────────────────

function zoneRowOr404(db, domainId) {
  const id = parseInt(domainId, 10);
  const row = Number.isInteger(id) ? db.prepare('SELECT * FROM domains WHERE id = ?').get(id) : null;
  if (!row) throw httpError(404, 'Domain not found', 'NOT_FOUND');
  return row;
}

/**
 * Set the zone's gateway and re-target every entry of every host of the zone
 * without gateway_override: one transaction, one Caddy sync, snapshot restore
 * on sync failure. No license check here — the API endpoint does that.
 */
async function applyGateway(domainId, input) {
  const db = getDb();
  const zone = zoneRowOr404(db, domainId);
  const target = validateTarget(input, db);

  const rows = db.prepare(`
    SELECT r.* FROM routes r JOIN service_bundles sb ON sb.id = r.bundle_id
    WHERE sb.domain_id = ? AND sb.gateway_override = 0
  `).all(zone.id);
  assertLanHosts(rows, target);

  const before = zoneTarget(zone);
  const oldTargets = rows.map(routeTarget);
  const setZone = db.prepare('UPDATE domains SET gateway_kind = ?, gateway_peer_id = ?, gateway_pool_id = ? WHERE id = ?');

  await retarget(db, rows.map((r) => r.id), target, {
    beforeRows: rows,
    extraWrite: () => setZone.run(target.kind, target.peer_id, target.pool_id, zone.id),
    extraRollback: () => setZone.run(zone.gateway_kind, zone.gateway_peer_id, zone.gateway_pool_id, zone.id),
    label: 'zone gateway apply',
  });

  if (rows.length > 0) {
    notifyGateways(peersForTargets(db, [target, ...oldTargets]));
    rebuildDns('zone gateway apply');
  }
  try {
    require('./activity').log('zone_gateway_changed', `Gateway of "${zone.domain}" changed (${rows.length} routes)`, {
      source: 'admin',
      severity: 'info',
      details: { domainId: zone.id, from: before, to: target, routeIds: rows.map((r) => r.id) },
    });
  } catch { /* activity is best-effort */ }
  logger.info({ domainId: zone.id, target, routes: rows.length }, 'Zone gateway applied');
  publish(zone.id, null);
  return getZone(zone.id);
}

/** Only affects entries created from now on. */
function updateDefaults(domainId, { default_external_enabled } = {}) {
  const db = getDb();
  const zone = zoneRowOr404(db, domainId);
  if (default_external_enabled === undefined) throw httpError(400, 'default_external_enabled required');
  db.prepare('UPDATE domains SET default_external_enabled = ? WHERE id = ?')
    .run(default_external_enabled ? 1 : 0, zone.id);
  publish(zone.id, null);
  return getZone(zone.id);
}

// ─── Boot reconcile ─────────────────────────────────────

function majorityTarget(rows) {
  const counts = new Map();
  for (const r of rows) {
    const t = routeTarget(r);
    const key = `${t.kind}|${t.peer_id}|${t.pool_id}`;
    const cur = counts.get(key) || { t, n: 0, first: r.id };
    cur.n++;
    cur.first = Math.min(cur.first, r.id);
    counts.set(key, cur);
  }
  let best = null;
  for (const c of counts.values()) {
    if (!best || c.n > best.n || (c.n === best.n && c.first < best.first)) best = c;
  }
  return best ? best.t : null;
}

/**
 * Idempotent start-up reconcile (called from domainBoot). Never throws for a
 * single item — every step logs and moves on:
 *  - RDP-owned L4 routes that ended up in a host are detached again,
 *  - routes without host (not RDP-owned) get one,
 *  - hosts pointing at a deleted zone are unlinked,
 *  - hosts without zone are linked by longest suffix; for a public TLD a
 *    missing zone is seeded as 'pending' (base = last two labels),
 *  - zones without gateway get the most common target of their entries,
 *  - (domain_id, subdomain) duplicates are logged.
 */
function reconcile() {
  const db = getDb();
  const hosts = require('./hosts');
  const summary = { detached: 0, hostsAssigned: 0, linked: 0, seeded: 0, gatewaysSet: 0, duplicates: 0 };

  const step = (name, fn) => {
    try { fn(); } catch (err) { logger.warn({ err: err?.message ?? String(err), step: name }, 'Zone reconcile step failed'); }
  };

  step('detach_rdp', () => {
    const rows = db.prepare(`SELECT id, bundle_id FROM routes WHERE bundle_id IS NOT NULL
      AND id IN (SELECT gateway_l4_route_id FROM rdp_routes WHERE gateway_l4_route_id IS NOT NULL)`).all();
    for (const r of rows) {
      db.transaction(() => {
        db.prepare('UPDATE routes SET bundle_id = NULL WHERE id = ?').run(r.id);
        require('./routes').cleanupEmptyBundles(db, [r.bundle_id]);
      })();
      summary.detached++;
    }
  });

  step('hostless_routes', () => {
    const rows = db.prepare(`SELECT id FROM routes WHERE bundle_id IS NULL
      AND id NOT IN (SELECT gateway_l4_route_id FROM rdp_routes WHERE gateway_l4_route_id IS NOT NULL)
      ORDER BY id`).all();
    for (const r of rows) {
      try {
        if (hosts.assignRoute(r.id) != null) summary.hostsAssigned++;
      } catch (err) {
        logger.warn({ err: err.message, routeId: r.id }, 'Zone reconcile: host assignment failed');
      }
    }
  });

  step('dangling_zone', () => {
    db.prepare(`UPDATE service_bundles SET domain_id = NULL, subdomain = NULL
      WHERE domain_id IS NOT NULL AND domain_id NOT IN (SELECT id FROM domains)`).run();
  });

  step('link_hosts', () => {
    const { isPublicDomain } = require('./caddyTlsAutomation');
    const { baseDomain } = require('./domainSeed');
    const rows = db.prepare(`SELECT id, domain FROM service_bundles
      WHERE domain_id IS NULL AND domain IS NOT NULL AND domain != ''`).all();
    for (const b of rows) {
      let z = resolveZone(b.domain, db);
      if (!z && isPublicDomain(b.domain)) {
        const base = baseDomain(b.domain);
        if (base && isPublicDomain(base)) {
          require('./domains').seedPending(base);
          summary.seeded++;
          z = resolveZone(b.domain, db);
        }
      }
      if (!z) continue;
      hosts.attachZone(b.id);
      summary.linked++;
    }
    // Hosts linked without a subdomain (e.g. restored rows).
    for (const b of db.prepare('SELECT id FROM service_bundles WHERE domain_id IS NOT NULL AND subdomain IS NULL').all()) {
      hosts.attachZone(b.id);
    }
  });

  step('zone_gateways', () => {
    const zones = db.prepare('SELECT * FROM domains WHERE gateway_kind IS NULL').all();
    for (const z of zones) {
      const rows = db.prepare(`SELECT r.* FROM routes r JOIN service_bundles sb ON sb.id = r.bundle_id
        WHERE sb.domain_id = ?`).all(z.id);
      const t = majorityTarget(rows);
      if (!t) continue;
      const ext = rows.filter((r) => r.external_enabled === 1).length * 2 > rows.length ? 1 : 0;
      db.transaction(() => {
        db.prepare(`UPDATE domains SET gateway_kind = ?, gateway_peer_id = ?, gateway_pool_id = ?,
          default_external_enabled = ? WHERE id = ? AND gateway_kind IS NULL`)
          .run(t.kind, t.peer_id, t.pool_id, ext, z.id);
        const byHost = new Map();
        for (const r of rows) {
          if (!byHost.has(r.bundle_id)) byHost.set(r.bundle_id, []);
          byHost.get(r.bundle_id).push(r);
        }
        for (const [hostId, members] of byHost) {
          if (members.some((m) => !sameTarget(routeTarget(m), t))) {
            db.prepare('UPDATE service_bundles SET gateway_override = 1 WHERE id = ?').run(hostId);
          }
        }
      })();
      summary.gatewaysSet++;
    }
  });

  step('duplicates', () => {
    const dups = db.prepare(`SELECT domain_id, subdomain, group_concat(id) AS ids, COUNT(*) AS n
      FROM service_bundles WHERE domain_id IS NOT NULL AND subdomain IS NOT NULL
      GROUP BY domain_id, subdomain HAVING n > 1`).all();
    for (const d of dups) {
      logger.warn({ domainId: d.domain_id, subdomain: d.subdomain, hostIds: d.ids.split(',').map(Number) },
        'Duplicate host (domain, subdomain) — rename or merge in the zones page');
    }
    summary.duplicates = dups.length;
  });

  return summary;
}

module.exports = {
  httpError,
  resolveZone,
  fqdnOf,
  routeTarget,
  zoneTarget,
  sameTarget,
  validateTarget,
  rewriteTargets,
  retarget,
  assertLanHosts,
  peersForTargets,
  notifyGateways,
  rebuildDns,
  publish,
  entryHealth,
  hostHealth,
  zoneHealth,
  listZones,
  getZone,
  getHost,
  getEntry,
  applyGateway,
  updateDefaults,
  reconcile,
};
