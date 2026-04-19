'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { StateMachine } = require('../src/services/gatewayHealth');

describe('Gateway Health StateMachine (sliding window)', () => {
  let sm;
  beforeEach(() => { sm = new StateMachine({ windowSize: 5, offlineThreshold: 3, onlineThreshold: 4, cooldownMs: 300000 }); });

  it('starts in state unknown', () => {
    assert.equal(sm.status, 'unknown');
  });

  it('transitions to online after 4 consecutive successes', () => {
    for (let i = 0; i < 4; i++) sm.recordHeartbeat(true);
    assert.equal(sm.status, 'online');
  });

  it('stays unknown after only 3 successes', () => {
    for (let i = 0; i < 3; i++) sm.recordHeartbeat(true);
    assert.equal(sm.status, 'unknown');
  });

  it('transitions to offline after 3 failures in a 5-slot window', () => {
    // Bring to online first
    for (let i = 0; i < 5; i++) sm.recordHeartbeat(true);
    assert.equal(sm.status, 'online');
    // Now 3 failures
    sm.recordHeartbeat(false);
    sm.recordHeartbeat(false);
    sm.recordHeartbeat(false);
    // Cooldown-Trick: fake lastTransitionAt 10 min ago
    sm._lastTransitionAt = Date.now() - 10 * 60 * 1000;
    sm._evaluate();
    assert.equal(sm.status, 'offline');
  });

  it('respects cooldown — no transition before 5min has passed', () => {
    for (let i = 0; i < 5; i++) sm.recordHeartbeat(true);
    assert.equal(sm.status, 'online');
    // Force transition to offline
    sm._lastTransitionAt = Date.now();
    sm.recordHeartbeat(false);
    sm.recordHeartbeat(false);
    sm.recordHeartbeat(false);
    assert.equal(sm.status, 'online', 'should not flip within cooldown');
  });

  it('counts flaps in last hour', () => {
    // 1st transition: unknown → online (no cooldown check for first transition)
    for (let i = 0; i < 5; i++) sm.recordHeartbeat(true);
    assert.equal(sm.status, 'online');

    // Fake cooldown elapsed so next Offline-Transition is allowed by _evaluate (called from recordHeartbeat)
    sm._lastTransitionAt = Date.now() - 10 * 60 * 1000;
    sm.recordHeartbeat(false); sm.recordHeartbeat(false); sm.recordHeartbeat(false);
    assert.equal(sm.status, 'offline');

    // Fake cooldown elapsed again for the Online-Transition
    sm._lastTransitionAt = Date.now() - 10 * 60 * 1000;
    sm.recordHeartbeat(true); sm.recordHeartbeat(true); sm.recordHeartbeat(true); sm.recordHeartbeat(true);
    assert.equal(sm.status, 'online');

    // 2 transitions total: online-offline + offline-online
    assert.equal(sm.flapCountLastHour(), 2);
  });
});
