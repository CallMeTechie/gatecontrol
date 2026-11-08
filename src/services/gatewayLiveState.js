'use strict';

// Live state of a gateway — the one answer every place that shows a gateway
// online or offline uses (gateways page: fleet cards, head, KPIs; pool page;
// dashboard; /api/v1/gateways for the apps).
//
// Reachable is not the same as "serves its routes again". gateway_meta.alive
// is the ROUTING flag of gatewayHealth: after an outage it stays 0 for the
// pool's failback cooldown, so routes do not flap back to a gateway that has
// just come up. Right for the routes — but no reason to show the gateway as
// offline: it answers again. Here, reachable = a heartbeat within
// gateway_down_threshold_s, computed at read time (no watchdog tick between a
// heartbeat and the display), and the failback wait is a hint of its own
// (failback_at). Failover and failback stay exactly as gatewayHealth does them.
//
// States:
//   online      heartbeat within the threshold. failback_at: when it takes its
//               routes back (still in the failback cooldown of its pool),
//               failback_takes_routes: whether it then serves routes again
//               (or only stands by as a reserve).
//   updating    no heartbeat, but an update GateControl asked for is under way
//               (or the gateway said it stops for an update) — until the
//               gateway is back or expected_back_by has passed.
//   restarting  no heartbeat since the gateway said it stops (graceful stop,
//               POST /api/v1/gateway/going-down) — for RESTART_GRACE_MS.
//   offline     no heartbeat within the threshold. offline_since: its last
//               sign of life.
//   unknown     never heard of.
//
// Alarms: an expected restart (restartExpected — an update GateControl asked
// for) holds the down alarms back (gatewayHealth / gateways legacy path) and
// releaseHeldAlarms() sends them late when the gateway does not come back in
// time. A plain "going down" notice (docker restart, host reboot) only changes
// the display: nobody asked for that restart, so its alarm stays on time.

const { getDb } = require('../db/connection');
const logger = require('../utils/logger');

// How long a gateway may stay away after it said it stops, or after it went
// silent during an update, before it counts as plainly offline.
const RESTART_GRACE_MS = Number(process.env.GC_GATEWAY_RESTART_GRACE_MS || 10 * 60 * 1000);
// Display tick: publishes state changes (online → offline at the threshold,
// updating → offline at the timeout, end of the failback wait) as SSE
// 'gateway' events, so open pages redraw without waiting for their poll.
const TICK_MS = 10_000;

const STATES = ['online', 'updating', 'restarting', 'offline', 'unknown'];
const NOTICE_REASONS = ['update', 'restart'];

function num(v) { const n = Number(v); return v == null || !Number.isFinite(n) ? null : n; }

function thresholdMs() {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = 'gateway_down_threshold_s'").get();
    const n = parseInt(row && row.value, 10);
    return (Number.isFinite(n) && n > 0 ? n : 90) * 1000;
  } catch { return 90_000; }
}

function updateTimeoutMs() {
  try { return require('./gateways').UPDATE_TIMEOUT_MS; } catch { return 15 * 60 * 1000; }
}

/** The "going down" notice when it is still the newest word of the gateway (no heartbeat since). */
function noticeOf(row, now) {
  const at = num(row && row.going_down_at);
  if (at == null) return null;
  const seen = num(row.last_seen_at);
  if (seen != null && seen > at) return null; // a heartbeat came after it: back
  if (now - at >= RESTART_GRACE_MS) return null;
  return { at, reason: NOTICE_REASONS.includes(row.going_down_reason) ? row.going_down_reason : 'restart' };
}

/**
 * End of the window in which an update GateControl asked for may keep the
 * gateway away, or null. The request counts while its tracking is open
 * (update_state 'updating', or 'unknown' after the tracking timeout); a
 * gateway that went silent during that window gets RESTART_GRACE_MS from its
 * last heartbeat on top, so a slow image pull does not end in "offline".
 */
function updateWindowEnd(row, now, updateState, timeoutMs) {
  if (!row || !row.update_request_id) return null;
  if (updateState !== 'updating' && updateState !== 'unknown') return null; // done / failed: it reported back
  const req = num(row.update_requested_at);
  if (req == null) return null;
  const tmo = timeoutMs == null ? updateTimeoutMs() : timeoutMs;
  let until = req + tmo;
  const seen = num(row.last_seen_at);
  if (seen != null && seen <= req + tmo) until = Math.max(until, seen + RESTART_GRACE_MS);
  return now < until ? until : null;
}

/**
 * Is a restart expected that should hold the down alarms back?
 * → { kind: 'update', until } | null. Only an update counts (GateControl asked
 * for it, or the gateway said it stops for one) — see the header.
 */
function restartExpected(row, ctx) {
  const c = ctx || {};
  const now = c.now == null ? Date.now() : c.now;
  const upd = updateWindowEnd(row, now, c.updateState, c.updateTimeoutMs);
  const notice = noticeOf(row, now);
  const noticeUntil = notice && notice.reason === 'update' ? notice.at + RESTART_GRACE_MS : null;
  if (upd == null && noticeUntil == null) return null;
  return { kind: 'update', until: Math.max(upd || 0, noticeUntil || 0) };
}

/**
 * Pure: the live state of one gateway.
 * row: gateway_meta columns (alive, last_seen_at, went_down_at,
 *      recovered_first_hb_at, going_down_at, going_down_reason,
 *      update_request_id, update_requested_at).
 * ctx: { now, thresholdMs, cooldownS (failback cooldown of its pools),
 *        takesRoutes (it serves routes again after the failback),
 *        updateState (gateways._deriveUpdateState), updateTimeoutMs }
 */
function derive(row, ctx) {
  const c = ctx || {};
  const now = c.now == null ? Date.now() : c.now;
  const thr = c.thresholdMs == null ? 90_000 : c.thresholdMs;
  const r = row || {};
  const seen = num(r.last_seen_at);
  const out = {
    state: 'unknown',
    reachable: false,
    alive: r.alive == null ? null : Number(r.alive) === 1,
    last_seen_at: seen,
    offline_since: null,
    failback_at: null,
    failback_takes_routes: false,
    expected_back_by: null,
    restart_reason: null,
  };
  const notice = noticeOf(r, now);
  if (seen == null && !notice) return out;

  if (seen != null && !notice && now - seen <= thr) {
    out.state = 'online';
    out.reachable = true;
    // back after an outage, but the routes wait for the failback cooldown
    const cooldownS = Number(c.cooldownS) || 0;
    if (out.alive === false && r.went_down_at != null && cooldownS > 0) {
      const at = (num(r.recovered_first_hb_at) == null ? seen : num(r.recovered_first_hb_at)) + cooldownS * 1000;
      if (at > now) {
        out.failback_at = at;
        out.failback_takes_routes = !!c.takesRoutes;
      }
    }
    return out;
  }

  const upd = updateWindowEnd(r, now, c.updateState, c.updateTimeoutMs);
  const noticeUntil = notice ? notice.at + RESTART_GRACE_MS : null;
  if (upd != null || (notice && notice.reason === 'update')) {
    out.state = 'updating';
    out.restart_reason = 'update';
    out.expected_back_by = Math.max(upd || 0, noticeUntil || 0);
  } else if (notice) {
    out.state = 'restarting';
    out.restart_reason = 'restart';
    out.expected_back_by = noticeUntil;
  } else {
    out.state = 'offline';
  }
  out.offline_since = notice ? notice.at : seen;
  return out;
}

/**
 * The old `status` field of the APIs (online | offline | unknown), now from
 * the live state: reachable → online, except a gateway the sliding window has
 * put offline because its own heartbeat reports a failure (listener_failed) —
 * that one stays 'offline' as before. Never seen → 'unknown'.
 */
function legacyStatus(live, smStatus, lastHealthy) {
  if (!live || live.state === 'unknown') return 'unknown';
  if (!live.reachable) return 'offline';
  if (smStatus === 'offline' && lastHealthy === false) return 'offline';
  return 'online';
}

// ─── DB-backed ───────────────────────────────────────────────────────────

const ROW_SQL = `
  SELECT gm.peer_id, gm.alive, gm.last_seen_at, gm.went_down_at, gm.recovered_first_hb_at,
         gm.going_down_at, gm.going_down_reason, gm.down_alarm_held_at, gm.offline_alarm_held_at,
         gm.update_request_id, gm.update_requested_at, gm.update_target_version, gm.last_health
  FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id
  WHERE p.peer_type = 'gateway'`;

function telemetryOf(row) {
  try { return (row && row.last_health ? JSON.parse(row.last_health).telemetry : null) || {}; } catch { return {}; }
}

function updateStateOf(row) {
  if (!row || !row.update_request_id) return 'idle';
  try { return require('./gateways')._deriveUpdateState(row, telemetryOf(row)).state; } catch { return 'idle'; }
}

/** Failback cooldown of its pools and whether it serves routes again afterwards. */
function poolContext(db, peerId) {
  let cooldownS = 0;
  let takesRoutes = false;
  try {
    const gatewayPool = require('./gatewayPool');
    cooldownS = gatewayPool.getMaxCooldownForPeer(peerId) || 0;
    if (cooldownS <= 0) return { cooldownS: 0, takesRoutes: false };
    // routes parked on a sibling while it was away go back to it
    if (db.prepare('SELECT 1 FROM routes WHERE original_peer_id = ? LIMIT 1').get(peerId)) takesRoutes = true;
    if (!takesRoutes) {
      for (const pool of gatewayPool.listPoolsForPeer(peerId)) {
        if (!pool.enabled) continue;
        if (pool.mode === 'load_balancing') { takesRoutes = true; break; }
        // failover: it serves again when no member before it is alive
        // (listMembers is in priority order — the order resolveActivePeer walks)
        const members = gatewayPool.listMembers(pool.id);
        const idx = members.findIndex((m) => m.peer_id === peerId);
        const ahead = idx < 0 ? [] : members.slice(0, idx);
        const aliveAhead = ahead.some((m) => {
          const r = db.prepare('SELECT alive FROM gateway_meta WHERE peer_id = ?').get(m.peer_id);
          return r && r.alive === 1;
        });
        if (!aliveAhead) { takesRoutes = true; break; }
      }
    }
  } catch (err) {
    logger.debug({ err: err.message, peerId }, 'gateway live state: pool context unavailable');
  }
  return { cooldownS, takesRoutes };
}

function deriveRow(db, row, now, thr) {
  const needsPool = row.alive === 0 && row.went_down_at != null;
  const pc = needsPool ? poolContext(db, row.peer_id) : { cooldownS: 0, takesRoutes: false };
  return derive(row, { now, thresholdMs: thr, cooldownS: pc.cooldownS, takesRoutes: pc.takesRoutes, updateState: updateStateOf(row) });
}

/** Live state of one gateway peer (null when it has no gateway_meta). */
function forPeer(peerId, opts) {
  const db = getDb();
  const row = db.prepare(ROW_SQL + ' AND gm.peer_id = ?').get(peerId);
  if (!row) return null;
  return deriveRow(db, row, (opts && opts.now) || Date.now(), thresholdMs());
}

/** Live state of every gateway peer: Map peer_id → state. */
function all(opts) {
  const db = getDb();
  const now = (opts && opts.now) || Date.now();
  const thr = thresholdMs();
  const out = new Map();
  for (const row of db.prepare(ROW_SQL).all()) out.set(row.peer_id, deriveRow(db, row, now, thr));
  return out;
}

/** restartExpected() for a peer from the DB. */
function restartExpectedFor(peerId, opts) {
  const row = getDb().prepare(ROW_SQL + ' AND gm.peer_id = ?').get(peerId);
  if (!row) return null;
  return restartExpected(row, { now: (opts && opts.now) || Date.now(), updateState: updateStateOf(row) });
}

/** The gateway says it stops now (reason 'update' | 'restart'). */
function recordGoingDown(peerId, reason, opts) {
  const r = NOTICE_REASONS.includes(reason) ? reason : 'restart';
  const at = (opts && opts.now) || Date.now();
  getDb().prepare('UPDATE gateway_meta SET going_down_at = ?, going_down_reason = ? WHERE peer_id = ?').run(at, r, peerId);
  return { at, reason: r };
}

// ─── Held alarms (expected restart) ──────────────────────────────────────

/** Mark the alarm of a path ('health' | 'legacy') as held. */
function holdAlarm(peerId, path, at) {
  const col = path === 'legacy' ? 'offline_alarm_held_at' : 'down_alarm_held_at';
  getDb().prepare(`UPDATE gateway_meta SET ${col} = COALESCE(${col}, ?) WHERE peer_id = ?`).run(at || Date.now(), peerId);
}

/** Was the alarm of the path held? Clears it (the "back online" alarm is then dropped too). */
function takeHeldAlarm(peerId, path) {
  const col = path === 'legacy' ? 'offline_alarm_held_at' : 'down_alarm_held_at';
  const db = getDb();
  const row = db.prepare(`SELECT ${col} AS held FROM gateway_meta WHERE peer_id = ?`).get(peerId);
  if (!row || row.held == null) return null;
  db.prepare(`UPDATE gateway_meta SET ${col} = NULL WHERE peer_id = ?`).run(peerId);
  return row.held;
}

/**
 * Held alarms of gateways whose expected restart is over without them coming
 * back: hand them to `send(peerId, path, heldAt)` (gatewayHealth sends its
 * gateway_down, gateways its legacy offline alarm) and clear them.
 */
function releaseHeldAlarms(send, opts) {
  const db = getDb();
  const now = (opts && opts.now) || Date.now();
  const thr = thresholdMs();
  const rows = db.prepare(ROW_SQL + ' AND (gm.down_alarm_held_at IS NOT NULL OR gm.offline_alarm_held_at IS NOT NULL)').all();
  const released = [];
  for (const row of rows) {
    const seen = num(row.last_seen_at);
    if (seen != null && now - seen <= thr && !noticeOf(row, now)) continue; // back: its recovery clears the hold
    if (restartExpected(row, { now, updateState: updateStateOf(row) })) continue; // still expected
    for (const path of ['health', 'legacy']) {
      const heldAt = takeHeldAlarm(row.peer_id, path);
      if (heldAt == null) continue;
      released.push({ peerId: row.peer_id, path });
      try { send(row.peer_id, path, heldAt); } catch (err) { logger.warn({ err: err.message, peerId: row.peer_id, path }, 'releasing a held gateway alarm failed'); }
    }
  }
  return released;
}

// ─── Change events ───────────────────────────────────────────────────────

const _last = new Map(); // peer_id → signature of the last published state

function signature(live) { return live.state + (live.failback_at ? '|failback' : ''); }

/**
 * Publish a 'gateway' SSE event for every gateway whose live state changed
 * since the last look (the first look of a gateway is only remembered).
 * `peerIds` limits the look (heartbeat, notice); without, every gateway.
 */
function publishChanges(peerIds, opts) {
  const eventBus = require('./eventBus');
  const states = all(opts);
  const ids = peerIds ? [].concat(peerIds) : [...states.keys()];
  const changed = [];
  for (const id of ids) {
    const live = states.get(id);
    if (!live) { _last.delete(id); continue; }
    const sig = signature(live);
    const prev = _last.get(id);
    _last.set(id, sig);
    if (prev === undefined || prev === sig) continue;
    changed.push(id);
    eventBus.publish('gateway', { peerId: id, state: live.state, reachable: live.reachable, transition: 'live_state' });
  }
  return changed;
}

function _resetForTest() { _last.clear(); }

let _tick = null;
function startTicker(onTick) {
  if (_tick) return;
  _tick = setInterval(() => {
    try { require('../utils/loopStall').withTask('gateways.live', publishChanges); } catch (err) { logger.warn({ err: err.message }, 'gateway live state tick failed'); }
    if (onTick) Promise.resolve().then(onTick).catch((err) => logger.warn({ err: err && err.message }, 'gateway live state tick hook failed'));
  }, TICK_MS);
  if (typeof _tick.unref === 'function') _tick.unref();
}
function stopTicker() { if (_tick) { clearInterval(_tick); _tick = null; } }

module.exports = {
  STATES,
  RESTART_GRACE_MS,
  TICK_MS,
  derive,
  legacyStatus,
  restartExpected,
  forPeer,
  all,
  restartExpectedFor,
  recordGoingDown,
  holdAlarm,
  takeHeldAlarm,
  releaseHeldAlarms,
  publishChanges,
  startTicker,
  stopTicker,
  _resetForTest,
  _updateWindowEnd: updateWindowEnd,
};
