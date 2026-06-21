// tests/rdp_player_logic.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../public/js/rdp-player-logic.js');

describe('rdp-player-logic', () => {
  it('backoff is exponential and capped', () => {
    assert.equal(L.backoffMs(0), 1000);
    assert.equal(L.backoffMs(1), 2000);
    assert.equal(L.backoffMs(2), 4000);
    assert.ok(L.backoffMs(10) <= 8000);
  });
  it('classifyMintFailure: 429 fatal on initial, retry on reconnect (DA-B)', () => {
    assert.equal(L.classifyMintFailure({ status: 429, phase: 'initial' }), 'fatal');
    assert.equal(L.classifyMintFailure({ status: 429, phase: 'reconnect' }), 'retry');
    assert.equal(L.classifyMintFailure({ status: 403, phase: 'reconnect' }), 'fatal');
    assert.equal(L.classifyMintFailure({ status: 409, phase: 'initial' }), 'fatal');
    assert.equal(L.classifyMintFailure({ status: undefined, phase: 'reconnect' }), 'retry');
    assert.equal(L.classifyMintFailure({ status: 403, phase: 'initial' }), 'fatal');
    assert.equal(L.classifyMintFailure({ status: 409, phase: 'reconnect' }), 'fatal');
  });
  it('retryWindow outlasts the reclaim budget (DA2-#2)', () => {
    const cfg = { heartbeatMs: 15000, heartbeatMisses: 2 }; // 30s
    assert.ok(L.retryWindowMs(cfg) >= cfg.heartbeatMs * cfg.heartbeatMisses);
    assert.ok(L.retryWindowMs({}) >= 15000 * 2);
  });
  it('state machine: connecting→connected, connected→reconnecting on drop', () => {
    assert.equal(L.nextState('connecting', 'open'), 'connected');
    assert.equal(L.nextState('connected', 'drop'), 'reconnecting');
    assert.equal(L.nextState('reconnecting', 'open'), 'connected');
    assert.equal(L.nextState('connected', 'user_disconnect'), 'disconnected');
    assert.equal(L.nextState('reconnecting', 'fatal'), 'error');
    assert.equal(L.nextState('connected', 'bogus_event'), 'connected');
  });
  it('scaleFor: native stays native, default is fit (Chain1-G5)', () => {
    assert.equal(L.scaleFor('native', { protocol: 'rdp' }), 'native');
    assert.equal(L.scaleFor('fit', { protocol: 'rdp' }), 'fit');
    assert.equal(L.scaleFor(undefined, { protocol: 'ssh' }), 'fit');
  });
});
