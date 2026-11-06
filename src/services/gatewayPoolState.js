'use strict';

// Live state of the gateway pools for the gateways page (public/js/gateway-pools-ui.js):
// which member serves a pool's routes right now, how the others stand, whether
// a standby reaches the targets of the pool's routes, and the history of the
// switches (table gateway_pool_events, migration 131).
//
// "Serving" follows the routing exactly: caddyConfig.resolveRouteUpstreams()
// takes gatewayPool.resolveActivePeer() (failover: the first member by
// priority whose gateway_meta.alive is 1) or resolveActivePeers() (load
// balancing: every alive member). alive turns 0 after gateway_down_threshold_s
// without a heartbeat and back to 1 only after the failback cooldown
// (gatewayHealth.evaluatePeer) — a member in between is 'recovering'.
//
// Reserve check: every member gets the routes of its pools in its config
// (gateways.getGatewayConfig: target_pool_id IN its pools) and probes their
// LAN targets — route_reachability in its last heartbeat. Routes pinned to a
// single member are only in that member's config, so the standbys cannot say
// anything about them.

const { getDb } = require('../db/connection');
const gatewayPool = require('./gatewayPool');
const logger = require('../utils/logger');

const HISTORY_KEEP = 50;

function threshold() {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'gateway_down_threshold_s'").get();
  const n = parseInt(row && row.value, 10);
  return Number.isFinite(n) && n > 0 ? n : 90;
}

function json(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

function metaRows(db) {
  const out = new Map();
  for (const r of db.prepare(`
    SELECT p.id, p.name, p.enabled, gm.alive, gm.last_seen_at, gm.went_down_at, gm.recovered_first_hb_at,
           gm.last_health, gm.platform
    FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id
    WHERE p.peer_type = 'gateway'`).all()) out.set(r.id, r);
  return out;
}

/** The members serving the pool now, in priority order (failover: at most one). */
function servingIds(pool, members, meta) {
  if (!pool.enabled) return [];
  const alive = members.filter((m) => { const r = meta.get(m.peer_id); return r && r.alive === 1; }).map((m) => m.peer_id);
  return pool.mode === 'load_balancing' ? alive : alive.slice(0, 1);
}

/**
 * What a member reports about the LAN targets of the pool's routes.
 * null when it reports nothing about them (offline, older gateway, no routes).
 */
function reserveOf(row, poolRoutes) {
  if (!row || row.alive !== 1 || !poolRoutes.length) return null;
  const health = json(row.last_health) || {};
  const rr = Array.isArray(health.route_reachability) ? health.route_reachability : null;
  if (!rr) return null;
  const byId = new Map();
  for (const r of rr) if (r && Number.isInteger(r.route_id)) byId.set(r.route_id, r);
  const checked = poolRoutes.filter((r) => byId.has(r.id));
  if (!checked.length) return null;
  const missing = checked.filter((r) => !byId.get(r.id).reachable).map((r) => ({ id: r.id, domain: r.domain }));
  return { total: poolRoutes.length, checked: checked.length, reachable: checked.length - missing.length, missing };
}

/**
 * 'off' (pool disabled), 'down' (no member alive), 'single' (only one member),
 * 'on_reserve' (failover: the first member is not the one serving),
 * 'no_reserve' (serving, but no other member alive), 'protected'.
 */
function statusOf(pool, members, states) {
  if (!pool.enabled) return 'off';
  const alive = states.filter((s) => s.state === 'active' || s.state === 'standby').length;
  if (!alive) return 'down';
  if (members.length < 2) return 'single';
  if (pool.mode !== 'load_balancing' && states[0] && states[0].state !== 'active') return 'on_reserve';
  if (alive < 2) return 'no_reserve';
  return 'protected';
}

function historyOf(db, poolId, meta) {
  const rows = db.prepare('SELECT id, at, kind, from_peer_id, to_peer_id FROM gateway_pool_events WHERE pool_id = ? ORDER BY id DESC LIMIT ?')
    .all(poolId, HISTORY_KEEP);
  const name = (id) => (id == null ? null : (meta.get(id) ? meta.get(id).name : null));
  const out = [];
  let since = null;
  // newest first: the duration of a takeover / outage is the time until the next row
  let nextAt = null;
  for (const r of rows) {
    if (r.kind === 'initial') {
      if (!since) since = { at: r.at, peer_id: r.to_peer_id, name: name(r.to_peer_id) };
      nextAt = r.at;
      continue;
    }
    out.push({
      at: r.at, kind: r.kind,
      from_peer_id: r.from_peer_id, from_name: name(r.from_peer_id),
      to_peer_id: r.to_peer_id, to_name: name(r.to_peer_id),
      duration_ms: (r.kind === 'failover' || r.kind === 'outage') && nextAt != null ? nextAt - r.at : null,
    });
    nextAt = r.at;
  }
  return { history: out, last_switch_at: out.length ? out[0].at : null, since };
}

function poolState(db, pool, meta, maxCooldown) {
  const members = gatewayPool.listMembers(pool.id);
  const serving = servingIds(pool, members, meta);
  const routes = db.prepare(`
    SELECT id, domain, route_type, target_lan_host, target_lan_port, l4_listen_port, enabled
    FROM routes WHERE target_pool_id = ? AND target_kind = 'gateway'
    ORDER BY domain COLLATE NOCASE, id`).all(pool.id);
  const enabledRoutes = routes.filter((r) => r.enabled === 1);
  const states = members.map((m) => {
    const r = meta.get(m.peer_id) || null;
    let state = 'offline';
    if (serving.includes(m.peer_id)) state = 'active';
    else if (r && r.alive === 1) state = 'standby';
    else if (r && r.recovered_first_hb_at) state = 'recovering';
    const cooldown = maxCooldown(m.peer_id);
    return {
      peer_id: m.peer_id,
      priority: m.priority,
      name: r ? r.name : null,
      platform: r ? r.platform || null : null,
      state,
      last_seen_at: r ? r.last_seen_at || null : null,
      went_down_at: r ? r.went_down_at || null : null,
      failback_at: state === 'recovering' ? r.recovered_first_hb_at + cooldown * 1000 : null,
      reserve: reserveOf(r, enabledRoutes),
    };
  });
  const ids = members.map((m) => m.peer_id);
  const pinned = ids.length ? db.prepare(`
    SELECT r.id, r.domain, r.route_type, r.target_lan_host, r.target_lan_port, r.enabled,
           COALESCE(r.original_peer_id, r.target_peer_id) AS peer_id,
           CASE WHEN r.original_peer_id IS NOT NULL THEN 1 ELSE 0 END AS failed_over
    FROM routes r
    WHERE r.target_kind = 'gateway' AND r.target_pool_id IS NULL
      AND COALESCE(r.original_peer_id, r.target_peer_id) IN (${ids.map(() => '?').join(',')})
    ORDER BY r.domain COLLATE NOCASE, r.id`).all(...ids).map((r) => ({
    ...r, failed_over: r.failed_over === 1, peer_name: meta.get(r.peer_id) ? meta.get(r.peer_id).name : null,
  })) : [];
  const rdp = db.prepare('SELECT COUNT(*) AS n FROM rdp_routes WHERE gateway_pool_id = ?').get(pool.id).n;
  return {
    id: pool.id,
    name: pool.name,
    mode: pool.mode,
    lb_policy: pool.lb_policy,
    failback_cooldown_s: pool.failback_cooldown_s,
    outage_message: pool.outage_message,
    enabled: pool.enabled === 1,
    status: statusOf(pool, members, states),
    active_peer_ids: serving,
    members: states,
    routes,
    rdp_routes: rdp,
    pinned_routes: pinned,
    ...historyOf(db, pool.id, meta),
  };
}

/** Everything the gateways page shows about the pools (GET /api/v1/gateway-pools/state). */
function state() {
  const db = getDb();
  const meta = metaRows(db);
  const cache = new Map();
  const maxCooldown = (id) => { if (!cache.has(id)) cache.set(id, gatewayPool.getMaxCooldownForPeer(id)); return cache.get(id); };
  const pools = gatewayPool.listPools().map((p) => poolState(db, p, meta, maxCooldown));
  const total = db.prepare("SELECT COUNT(*) AS n FROM routes WHERE target_kind = 'gateway' AND enabled = 1").get().n;
  const pooled = db.prepare(`
    SELECT COUNT(*) AS n FROM routes r JOIN gateway_pools p ON p.id = r.target_pool_id
    WHERE r.target_kind = 'gateway' AND r.enabled = 1 AND p.enabled = 1
      AND (SELECT COUNT(*) FROM gateway_pool_members m WHERE m.pool_id = p.id) >= 2`).get().n;
  return { threshold_s: threshold(), routes_total: total, routes_pooled: pooled, pools };
}

/**
 * Compare who serves each pool now with the last recorded switch and record
 * a change. `cause: 'config'` marks a change an administrator made (members,
 * order, mode) — the switch is then 'change' instead of 'failback'.
 * Returns the rows written ({ pool_id, kind, from_peer_id, to_peer_id }).
 */
function recordSwitches(opts) {
  const o = opts || {};
  const db = getDb();
  const meta = metaRows(db);
  const now = o.now || Date.now();
  const pools = o.poolId != null ? [gatewayPool.getPool(o.poolId)].filter(Boolean) : gatewayPool.listPools();
  const last = db.prepare('SELECT id, kind, from_peer_id, to_peer_id FROM gateway_pool_events WHERE pool_id = ? ORDER BY id DESC LIMIT 1');
  const rebase = db.prepare('UPDATE gateway_pool_events SET at = ?, to_peer_id = ? WHERE id = ?');
  const insert = db.prepare('INSERT INTO gateway_pool_events (pool_id, at, kind, from_peer_id, to_peer_id) VALUES (?, ?, ?, ?, ?)');
  const prune = db.prepare(`DELETE FROM gateway_pool_events WHERE pool_id = ? AND id NOT IN
    (SELECT id FROM gateway_pool_events WHERE pool_id = ? ORDER BY id DESC LIMIT ?)`);
  const written = [];
  for (const pool of pools) {
    const members = gatewayPool.listMembers(pool.id);
    const serving = servingIds(pool, members, meta);
    const cur = serving.length ? serving[0] : null;
    // load balancing: only "someone serves" vs. "nobody serves" is a switch
    const key = (id) => (id == null ? 'none' : (pool.mode === 'load_balancing' ? 'any' : String(id)));
    const prev = last.get(pool.id);
    if (prev && key(prev.to_peer_id) === key(cur)) continue;
    let kind;
    if (!prev) kind = 'initial';
    else if (o.cause === 'config' && prev.kind === 'initial') {
      // still no real switch: the administrator set the pool up — a new baseline
      rebase.run(now, cur, prev.id);
      written.push({ pool_id: pool.id, kind: 'initial', from_peer_id: null, to_peer_id: cur });
      continue;
    } else if (o.cause === 'config') kind = 'change';
    else if (cur == null) kind = 'outage';
    else if (prev.to_peer_id == null) kind = 'restored';
    else {
      const before = meta.get(prev.to_peer_id);
      const stillMember = members.some((m) => m.peer_id === prev.to_peer_id);
      kind = stillMember && before && before.alive === 1 ? 'failback' : 'failover';
    }
    const from = prev ? prev.to_peer_id : null;
    insert.run(pool.id, now, kind, from, cur);
    prune.run(pool.id, pool.id, HISTORY_KEEP);
    written.push({ pool_id: pool.id, kind, from_peer_id: from, to_peer_id: cur });
  }
  return written;
}

/** recordSwitches() for callers that must never fail because of it. */
function recordSafely(opts) {
  try { return recordSwitches(opts); } catch (err) {
    logger.warn({ err: err.message }, 'recording gateway pool switches failed');
    return [];
  }
}

/**
 * Dissolve a pool: its routes (HTTP/L4, RDP) and domain zones that point at it
 * are pinned to `pinTo` — they keep working, without a reserve — then the pool
 * (members and history) is deleted. Returns the counts.
 */
function dissolve(poolId, pinTo) {
  const db = getDb();
  const pool = gatewayPool.getPool(poolId);
  if (!pool) { const e = new Error('pool_not_found'); e.status = 404; throw e; }
  const routes = db.prepare('SELECT COUNT(*) AS n FROM routes WHERE target_pool_id = ?').get(poolId).n;
  const rdp = db.prepare('SELECT COUNT(*) AS n FROM rdp_routes WHERE gateway_pool_id = ?').get(poolId).n;
  const zones = db.prepare("SELECT COUNT(*) AS n FROM domains WHERE gateway_kind = 'pool' AND gateway_pool_id = ?").get(poolId).n;
  if (routes + rdp + zones > 0) {
    if (!Number.isInteger(pinTo)) { const e = new Error('pin_to_required'); e.status = 400; throw e; }
    const gw = db.prepare("SELECT id FROM peers WHERE id = ? AND peer_type = 'gateway' AND enabled = 1").get(pinTo);
    if (!gw) { const e = new Error('pin_to_not_gateway'); e.status = 400; throw e; }
  }
  const members = gatewayPool.listMembers(poolId).map((m) => m.peer_id);
  db.transaction(() => {
    db.prepare(`UPDATE routes SET target_peer_id = ?, target_pool_id = NULL, original_peer_id = NULL, updated_at = datetime('now')
      WHERE target_pool_id = ?`).run(pinTo == null ? null : pinTo, poolId);
    db.prepare('UPDATE rdp_routes SET gateway_peer_id = ?, gateway_pool_id = NULL WHERE gateway_pool_id = ?').run(pinTo == null ? null : pinTo, poolId);
    db.prepare("UPDATE domains SET gateway_kind = 'gateway', gateway_peer_id = ?, gateway_pool_id = NULL WHERE gateway_kind = 'pool' AND gateway_pool_id = ?")
      .run(pinTo == null ? null : pinTo, poolId);
    db.prepare('DELETE FROM gateway_pool_events WHERE pool_id = ?').run(poolId);
    db.prepare('DELETE FROM gateway_pools WHERE id = ?').run(poolId);
  })();
  logger.info({ poolId, pinTo, routes, rdp, zones }, 'gateway_pool dissolved');
  return { routes, rdp, zones, members };
}

module.exports = { state, recordSwitches, recordSafely, dissolve, reserveOf, statusOf, HISTORY_KEEP };
