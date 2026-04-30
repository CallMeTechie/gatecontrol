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

async function _onTransition(peerId, transition) {
  const peer = getDb().prepare('SELECT id, name FROM peers WHERE id = ?').get(peerId);
  const peerLabel = peer?.name || `peer #${peerId}`;
  const gatewayPool = require('./gatewayPool');

  switch (transition) {
    case 'alive_to_down':
      activity.log('gateway_down', `Gateway ${peerLabel} is offline`, {
        source: 'system', severity: 'warn', details: { peerId },
      });
      webhook.notify('gateway_state_change', `Gateway ${peerLabel} offline`, { peer_id: peerId, alive: false }).catch(() => {});
      for (const pool of gatewayPool.listPoolsForPeer(peerId)) {
        const aliveMembers = gatewayPool.resolveActivePeers(pool.id, _snapshot);
        if (aliveMembers.length === 0) {
          activity.log('pool_outage_started', `Pool ${pool.name}: all gateways offline`, {
            source: 'system', severity: 'error', details: { poolId: pool.id, poolName: pool.name },
          });
        }
      }
      break;

    case 'cooldown_reset':
      if (!_hasRecoveryInterruptBeenLogged(peerId)) {
        activity.log('gateway_recovery_interrupted', `Gateway ${peerLabel} recovery interrupted by heartbeat gap`, {
          source: 'system', severity: 'warn', details: { peerId },
        });
        _markRecoveryInterruptLogged(peerId);
      }
      break;

    case 'cooldown_to_alive':
    case 'first_alive':
      activity.log('gateway_alive', `Gateway ${peerLabel} is online`, {
        source: 'system', severity: 'info', details: { peerId },
      });
      webhook.notify('gateway_state_change', `Gateway ${peerLabel} online`, { peer_id: peerId, alive: true }).catch(() => {});
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

  if (['alive_to_down', 'cooldown_to_alive', 'first_alive'].includes(transition)) {
    if (gatewayPool.isPeerInAnyPool(peerId)) {
      try {
        await require('./caddyConfig').syncToCaddy();
      } catch (err) {
        require('../utils/logger').error({ err: err.message, peerId }, 'caddy re-render failed after gateway state change');
      }
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
  watchdogTick,
  startWatchdog,
  stopWatchdog,
  onHeartbeatReceived,
};
