(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GCRdpPlayerLogic = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function backoffMs(attempt) { return Math.min(8000, 1000 * Math.pow(2, attempt)); }
  function classifyMintFailure(o) {
    o = o || {};
    if (o.status === 403 || o.status === 409) return 'fatal';
    if (o.status === 429) return o.phase === 'reconnect' ? 'retry' : 'fatal';
    return 'retry'; // network/no-status/5xx → retry
  }
  function retryWindowMs(cfg) {
    cfg = cfg || {};
    var budget = (cfg.heartbeatMs || 15000) * (cfg.heartbeatMisses || 2);
    return Math.ceil(budget * 1.5); // margin over the half-open reclaim budget
  }
  var TRANSITIONS = {
    idle:        { connect: 'connecting' },
    connecting:  { open: 'connected', drop: 'reconnecting', fatal: 'error', user_disconnect: 'disconnected' },
    connected:   { drop: 'reconnecting', user_disconnect: 'disconnected', error: 'error' },
    reconnecting:{ open: 'connected', fatal: 'error', user_disconnect: 'disconnected' },
    disconnected:{ connect: 'connecting' },
    error:       { connect: 'connecting' },
  };
  function nextState(state, event) {
    var m = TRANSITIONS[state] || {};
    return m[event] || state;
  }
  function scaleFor(mode, opts) {
    if (mode === 'native') return 'native';
    return 'fit';
  }
  return { backoffMs: backoffMs, classifyMintFailure: classifyMintFailure,
    retryWindowMs: retryWindowMs, nextState: nextState, scaleFor: scaleFor };
}));
