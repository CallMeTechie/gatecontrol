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

module.exports = { StateMachine };
