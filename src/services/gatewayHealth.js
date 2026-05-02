'use strict';

/**
 * Sliding-window hysteresis state machine for Gateway health.
 * Symmetrischer Cooldown in BEIDE Richtungen.
 * Default: window=5, offline=3/5 fail, online=4/5 success, cooldown=5min.
 */
class StateMachine {
  constructor(opts = {}) {
    this.windowSize = opts.windowSize || 5;
    this.offlineThreshold = opts.offlineThreshold || 3;
    this.onlineThreshold = opts.onlineThreshold || 4;
    this.cooldownMs = opts.cooldownMs || 5 * 60 * 1000;
    this._window = []; // array of booleans
    this.status = 'unknown';
    this._lastTransitionAt = 0;
    this._transitions = []; // [{at, from, to}]
  }

  recordHeartbeat(success) {
    this._window.push(!!success);
    if (this._window.length > this.windowSize) this._window.shift();
    this._evaluate();
  }

  _evaluate() {
    const now = Date.now();
    const fails = this._window.filter(x => !x).length;
    const successes = this._window.length - fails;

    let next = this.status;
    if (this._window.length >= this.onlineThreshold && successes >= this.onlineThreshold) {
      next = 'online';
    } else if (fails >= this.offlineThreshold) {
      next = 'offline';
    }

    if (next !== this.status) {
      if (this.status !== 'unknown' && (now - this._lastTransitionAt) < this.cooldownMs) {
        return; // Cooldown blocks transition
      }
      this._transitions.push({ at: now, from: this.status, to: next });
      // Prune entries older than 24h to keep the array bounded. The
      // flap counter only looks back 1h so anything older is dead
      // weight that would otherwise grow unbounded over months.
      const dayCutoff = now - 24 * 60 * 60 * 1000;
      while (this._transitions.length > 0 && this._transitions[0].at < dayCutoff) {
        this._transitions.shift();
      }
      this.status = next;
      this._lastTransitionAt = now;
    }
  }

  flapCountLastHour() {
    const cutoff = Date.now() - 60 * 60 * 1000;
    // Count only "flaps" — transitions between stable states (online↔offline),
    // not the initial unknown→online / unknown→offline warmup.
    return this._transitions.filter(t => t.at >= cutoff && t.from !== 'unknown').length;
  }
}

const { getDb } = require('../db/connection');

let _snapshot = {};
let _recoveryInterruptLogged = new Set();
let _stateChainTail = Promise.resolve();

function _resetSnapshotCache() {
  _snapshot = {};
  _recoveryInterruptLogged = new Set();
  _stateChainTail = Promise.resolve();
}

function getSnapshot() { return _snapshot; }

function _getDownThresholdSeconds() {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'gateway_down_threshold_s'").get();
  return parseInt(row?.value ?? '90', 10);
}

function evaluatePeer(peerId) {
  const db = getDb();
  const gw = db.prepare('SELECT peer_id, alive, last_seen_at, went_down_at, recovered_first_hb_at FROM gateway_meta WHERE peer_id = ?').get(peerId);
  if (!gw) return { transition: null };

  const thresholdMs = _getDownThresholdSeconds() * 1000;
  const now = Date.now();
  const isStale = gw.last_seen_at == null ? true : (now - gw.last_seen_at) > thresholdMs;

  let transition = null;

  if (gw.alive === 1) {
    if (isStale) {
      db.prepare(`UPDATE gateway_meta SET alive = 0, went_down_at = COALESCE(went_down_at, ?) WHERE peer_id = ?`).run(now, peerId);
      transition = 'alive_to_down';
      _recoveryInterruptLogged.delete(peerId);
    }
  } else {
    if (isStale) {
      if (gw.recovered_first_hb_at) {
        db.prepare('UPDATE gateway_meta SET recovered_first_hb_at = NULL WHERE peer_id = ?').run(peerId);
        transition = 'cooldown_reset';
      }
    } else if (gw.last_seen_at != null) {
      if (gw.went_down_at == null) {
        db.prepare(`UPDATE gateway_meta SET alive = 1 WHERE peer_id = ?`).run(peerId);
        transition = 'first_alive';
      } else if (gw.recovered_first_hb_at == null) {
        db.prepare(`UPDATE gateway_meta SET recovered_first_hb_at = ? WHERE peer_id = ?`).run(now, peerId);
        transition = 'down_to_cooldown';
      } else {
        const gatewayPool = require('./gatewayPool');
        const maxCooldownS = gatewayPool.getMaxCooldownForPeer(peerId);
        if ((now - gw.recovered_first_hb_at) >= maxCooldownS * 1000) {
          db.prepare(`UPDATE gateway_meta SET alive = 1, went_down_at = NULL, recovered_first_hb_at = NULL WHERE peer_id = ?`).run(peerId);
          transition = 'cooldown_to_alive';
          _recoveryInterruptLogged.delete(peerId);
        }
      }
    }
  }

  const updated = db.prepare('SELECT alive, last_seen_at, went_down_at, recovered_first_hb_at FROM gateway_meta WHERE peer_id = ?').get(peerId);
  _snapshot[peerId] = {
    alive: updated.alive === 1,
    last_seen_at: updated.last_seen_at,
    went_down_at: updated.went_down_at,
    recovered_first_hb_at: updated.recovered_first_hb_at,
  };

  return { transition };
}

function _markRecoveryInterruptLogged(peerId) { _recoveryInterruptLogged.add(peerId); }
function _hasRecoveryInterruptBeenLogged(peerId) { return _recoveryInterruptLogged.has(peerId); }

function serializeStateChange(fn) {
  const next = _stateChainTail.then(() => fn()).catch(err => {
    require('../utils/logger').error({ err: err.message }, 'gateway state change failed');
  });
  _stateChainTail = next;
  return next;
}

const activity = require('./activity');
const webhook = require('./webhook');

// Pivot routes that target `fromPeerId` over to `toPeerId` (or back to their
// `original_peer_id` when `toPeerId` is undefined). Returns the set of peers
// whose companion config was affected so callers can notify them.
function _pivotRoutes({ fromPeerId, toPeerId, restore }) {
  const db = getDb();
  const affected = new Set();
  if (restore) {
    // Recovery: every route currently parked because of fromPeerId moves
    // back to its original target. Snapshot affected peers BEFORE the
    // update so we can notify both ends (current target + restored
    // target).
    const rows = db.prepare(
      'SELECT id, target_peer_id, original_peer_id FROM routes WHERE original_peer_id = ?',
    ).all(fromPeerId);
    if (rows.length === 0) return affected;
    for (const r of rows) {
      if (r.target_peer_id != null) affected.add(r.target_peer_id);
      if (r.original_peer_id != null) affected.add(r.original_peer_id);
    }
    db.prepare(`
      UPDATE routes
      SET target_peer_id = original_peer_id,
          original_peer_id = NULL,
          updated_at = datetime('now')
      WHERE original_peer_id = ?
    `).run(fromPeerId);
    return affected;
  }
  // Failover: routes pinned to fromPeerId that haven't already been
  // pivoted (original_peer_id IS NULL) move to toPeerId. We DON'T touch
  // routes that already carry an original_peer_id — those are mid-failover
  // already; their original target is what we want to restore them to.
  if (!Number.isInteger(toPeerId)) return affected;
  const rows = db.prepare(
    'SELECT id FROM routes WHERE target_peer_id = ? AND original_peer_id IS NULL AND target_kind = \'gateway\'',
  ).all(fromPeerId);
  if (rows.length === 0) return affected;
  affected.add(fromPeerId);
  affected.add(toPeerId);
  db.prepare(`
    UPDATE routes
    SET original_peer_id = target_peer_id,
        target_peer_id = ?,
        updated_at = datetime('now')
    WHERE target_peer_id = ? AND original_peer_id IS NULL AND target_kind = 'gateway'
  `).run(toPeerId, fromPeerId);
  return affected;
}

async function _notifyAffected(affectedPeerIds) {
  if (affectedPeerIds.size === 0) return;
  const gateways = require('./gateways');
  for (const id of affectedPeerIds) {
    gateways.notifyConfigChanged(id).catch(() => {});
  }
}

// Reconcile failover state with current DB at boot. Transitions only fire on
// state CHANGES; if a peer was already offline when the server started, no
// alive_to_down event will ever fire, so without this its routes would stay
// stuck on the dead peer forever. Idempotent — re-running doesn't change a
// converged state.
async function reconcileFailoverState() {
  const db = getDb();
  const gatewayPool = require('./gatewayPool');
  const affected = new Set();
  let dirty = false;

  // 1. Park routes whose target is currently offline in a pool with an alive sibling.
  const offline = db.prepare(`
    SELECT DISTINCT m.peer_id, m.pool_id
    FROM gateway_pool_members m
    JOIN gateway_meta gm ON gm.peer_id = m.peer_id
    JOIN gateway_pools p ON p.id = m.pool_id
    WHERE gm.alive = 0 AND p.enabled = 1
  `).all();
  for (const o of offline) {
    const sibling = db.prepare(`
      SELECT m.peer_id FROM gateway_pool_members m
      JOIN gateway_meta gm ON gm.peer_id = m.peer_id
      WHERE m.pool_id = ? AND gm.alive = 1
      ORDER BY m.priority ASC LIMIT 1
    `).get(o.pool_id);
    if (!sibling) continue;
    const aff = _pivotRoutes({ fromPeerId: o.peer_id, toPeerId: sibling.peer_id });
    if (aff.size > 0) {
      dirty = true;
      for (const id of aff) affected.add(id);
      activity.log('pool_failover_activated',
        `Boot reconcile: routes from peer #${o.peer_id} parked on peer #${sibling.peer_id}`,
        { source: 'system', severity: 'info', details: { fromPeerId: o.peer_id, toPeerId: sibling.peer_id, viaPoolId: o.pool_id } });
    }
  }

  // 2. Restore routes whose original_peer_id is now alive (covers cases where
  //    a peer recovered while the server was down).
  const aliveOriginals = db.prepare(`
    SELECT DISTINCT r.original_peer_id AS peer_id
    FROM routes r
    JOIN gateway_meta gm ON gm.peer_id = r.original_peer_id
    WHERE r.original_peer_id IS NOT NULL AND gm.alive = 1
  `).all();
  for (const a of aliveOriginals) {
    const aff = _pivotRoutes({ fromPeerId: a.peer_id, restore: true });
    if (aff.size > 0) {
      dirty = true;
      for (const id of aff) affected.add(id);
      activity.log('pool_failover_restored',
        `Boot reconcile: routes restored to recovered peer #${a.peer_id}`,
        { source: 'system', severity: 'info', details: { peerId: a.peer_id } });
    }
  }

  if (dirty) {
    try {
      await require('./caddyConfig').syncToCaddy();
    } catch (err) {
      require('../utils/logger').error({ err: err.message }, 'caddy resync after boot reconcile failed');
    }
    if (affected.size > 0) await _notifyAffected(affected);
  }
}

async function _onTransition(peerId, transition) {
  const peer = getDb().prepare('SELECT id, name FROM peers WHERE id = ?').get(peerId);
  const peerLabel = peer?.name || `peer #${peerId}`;
  const gatewayPool = require('./gatewayPool');
  let routesPivoted = false;
  let affectedPeers = new Set();

  switch (transition) {
    case 'alive_to_down': {
      activity.log('gateway_down', `Gateway ${peerLabel} is offline`, {
        source: 'system', severity: 'warn', details: { peerId },
      });
      webhook.notify('gateway_state_change', `Gateway ${peerLabel} offline`, { peer_id: peerId, alive: false }).catch(() => {});

      // Pivot routes pinned to this peer onto the highest-priority alive
      // sibling in each pool the peer belongs to. If multiple pools, each
      // pool independently picks its own failover target — but a route
      // only has one target_peer_id, so the FIRST pool with a viable
      // sibling wins and subsequent passes find nothing to pivot.
      for (const pool of gatewayPool.listPoolsForPeer(peerId)) {
        if (!pool.enabled) continue;
        const aliveSibling = gatewayPool.resolveActivePeer(pool.id, _snapshot);
        if (aliveSibling && aliveSibling !== peerId) {
          const aff = _pivotRoutes({ fromPeerId: peerId, toPeerId: aliveSibling });
          if (aff.size > 0) {
            routesPivoted = true;
            for (const id of aff) affectedPeers.add(id);
            activity.log('pool_failover_activated',
              `Pool ${pool.name}: ${peerLabel} → routes moved to peer #${aliveSibling}`,
              { source: 'system', severity: 'info', details: { poolId: pool.id, fromPeerId: peerId, toPeerId: aliveSibling } });
            break; // route already pivoted, no need to check other pools
          }
        }
      }

      // Pool-outage record (no alive siblings anywhere)
      for (const pool of gatewayPool.listPoolsForPeer(peerId)) {
        const aliveMembers = gatewayPool.resolveActivePeers(pool.id, _snapshot);
        if (aliveMembers.length === 0) {
          activity.log('pool_outage_started', `Pool ${pool.name}: all gateways offline`, {
            source: 'system', severity: 'error', details: { poolId: pool.id, poolName: pool.name },
          });
        }
      }
      break;
    }

    case 'cooldown_reset':
      if (!_hasRecoveryInterruptBeenLogged(peerId)) {
        activity.log('gateway_recovery_interrupted', `Gateway ${peerLabel} recovery interrupted by heartbeat gap`, {
          source: 'system', severity: 'warn', details: { peerId },
        });
        _markRecoveryInterruptLogged(peerId);
      }
      break;

    case 'cooldown_to_alive':
    case 'first_alive': {
      activity.log('gateway_alive', `Gateway ${peerLabel} is online`, {
        source: 'system', severity: 'info', details: { peerId },
      });
      webhook.notify('gateway_state_change', `Gateway ${peerLabel} online`, { peer_id: peerId, alive: true }).catch(() => {});

      // Restore routes that were pivoted away from this peer while it was
      // down. Idempotent — does nothing if no routes are parked.
      const aff = _pivotRoutes({ fromPeerId: peerId, restore: true });
      if (aff.size > 0) {
        routesPivoted = true;
        for (const id of aff) affectedPeers.add(id);
        activity.log('pool_failover_restored',
          `Routes restored to ${peerLabel} after recovery`,
          { source: 'system', severity: 'info', details: { peerId } });
      }

      for (const pool of gatewayPool.listPoolsForPeer(peerId)) {
        const aliveMembers = gatewayPool.resolveActivePeers(pool.id, _snapshot);
        if (aliveMembers.length === 1 && aliveMembers[0] === peerId) {
          activity.log('pool_outage_resolved', `Pool ${pool.name}: at least one gateway back online`, {
            source: 'system', severity: 'info', details: { poolId: pool.id, poolName: pool.name },
          });
        }
      }
      break;
    }
  }

  // Sync caddy on ANY state-change for a pool member (the upstream changes
  // when target_peer_id is pivoted, so caddy needs the new wiring). Also
  // covers the no-pivot case where a peer recovered with no failover to
  // restore — caddy still needs to know the upstream is healthy again.
  if (['alive_to_down', 'cooldown_to_alive', 'first_alive'].includes(transition)) {
    if (routesPivoted || gatewayPool.isPeerInAnyPool(peerId)) {
      try {
        await require('./caddyConfig').syncToCaddy();
      } catch (err) {
        require('../utils/logger').error({ err: err.message, peerId }, 'caddy re-render failed after gateway state change');
      }
    }
    // Notify companions whose config_hash just changed because of the pivot.
    if (affectedPeers.size > 0) {
      await _notifyAffected(affectedPeers);
    }
  }
}

async function watchdogTick() {
  const peers = getDb().prepare("SELECT id FROM peers WHERE peer_type = 'gateway' AND enabled = 1").all();
  for (const p of peers) {
    const { transition } = evaluatePeer(p.id);
    if (transition) {
      await serializeStateChange(() => _onTransition(p.id, transition));
    }
  }
}

let _watchdogInterval = null;
function startWatchdog() {
  if (_watchdogInterval) return;
  _watchdogInterval = setInterval(() => {
    watchdogTick().catch(err => {
      require('../utils/logger').error({ err: err.message }, 'watchdog tick failed');
    });
  }, 30_000);
}

function stopWatchdog() {
  if (_watchdogInterval) clearInterval(_watchdogInterval);
  _watchdogInterval = null;
}

async function onHeartbeatReceived(peerId) {
  const { transition } = evaluatePeer(peerId);
  if (transition) {
    await serializeStateChange(() => _onTransition(peerId, transition));
  }
}

module.exports = {
  StateMachine,
  evaluatePeer,
  getSnapshot,
  serializeStateChange,
  _resetSnapshotCache,
  _markRecoveryInterruptLogged,
  _hasRecoveryInterruptBeenLogged,
  _onTransition,
  reconcileFailoverState,
  watchdogTick,
  startWatchdog,
  stopWatchdog,
  onHeartbeatReceived,
};
