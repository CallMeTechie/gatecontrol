(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GCRdpPlayerLogic = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function backoffMs(attempt) { return Math.min(8000, 1000 * Math.pow(2, attempt)); }
  function classifyMintFailure(o) {
    o = o || {};
    if (o.status === 403 || o.status === 409) return 'fatal';
    // 404/410: the session ticket/route is gone (the plugin ends a ticket after a
    // failed start) — asking again only yields the same answer.
    if (o.status === 404 || o.status === 410) return 'fatal';
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
    connected:   { drop: 'reconnecting', user_disconnect: 'disconnected', error: 'error', fatal: 'error' },
    reconnecting:{ open: 'connected', fatal: 'error', user_disconnect: 'disconnected' },
    disconnected:{ connect: 'connecting' },
    error:       { connect: 'connecting' },
  };
  function nextState(state, event) {
    var m = TRANSITIONS[state] || {};
    return m[event] || state;
  }
  /* Guacamole status codes (guacd 'error' instruction) → a cause the page can name. */
  var GUAC_REASON = {
    769: 'auth-rejected',      // 0x0301 CLIENT_UNAUTHORIZED — Windows refused the logon (often NLA without credentials)
    771: 'login-forbidden',    // 0x0303 CLIENT_FORBIDDEN — account disabled/expired/locked, no remote logon right
    515: 'upstream-error',     // 0x0203 UPSTREAM_ERROR — e.g. security negotiation failed
    514: 'unreachable',        // 0x0202 UPSTREAM_TIMEOUT
    519: 'unreachable',        // 0x0207 UPSTREAM_NOT_FOUND
    520: 'unreachable',        // 0x0208 UPSTREAM_UNAVAILABLE
    521: 'session-conflict',   // 0x0209 SESSION_CONFLICT — another logon took the session
    518: 'session-closed',     // 0x0206 RESOURCE_CLOSED
    522: 'session-closed',     // 0x020A SESSION_TIMEOUT
    523: 'session-closed',     // 0x020B SESSION_CLOSED
    513: 'busy',               // 0x0201 SERVER_BUSY
    797: 'busy',               // 0x031D CLIENT_TOO_MANY
  };
  var own = Object.prototype.hasOwnProperty;
  function lookup(map, key) { return own.call(map, key) ? map[key] : undefined; } // eslint-disable-line security/detect-object-injection -- own keys of a constant map only
  function guacErrorReason(code) {
    return lookup(GUAC_REASON, code) || 'guac-error';
  }
  /* A guacd error before the session ever showed a picture ends it for good (the start
   * itself failed — retrying repeats the failure and burns the one-shot ticket). Once a
   * session ran, only logon refusals are final; anything else is worth a reconnect. */
  function classifyGuacError(o) {
    o = o || {};
    if (!o.established) return 'fatal';
    var r = guacErrorReason(o.code);
    return (r === 'auth-rejected' || r === 'login-forbidden') ? 'fatal' : 'retry';
  }
  /* reconnect gave up: only a session that once ran ran into the retry limit */
  function gaveUpReason(established) {
    return established ? 'limit-reached' : 'connect-failed';
  }
  /* error detail → i18n key of the page (rdp.session.err.* / limit_reached / not_authorized) */
  var REASON_KEY = {
    'auth-rejected': 'err_auth_rejected', 'login-forbidden': 'err_login_forbidden',
    'upstream-error': 'err_upstream', 'unreachable': 'err_unreachable',
    'session-conflict': 'err_session_conflict', 'session-closed': 'err_session_closed',
    'busy': 'err_busy', 'guac-error': 'err_guac', 'connect-failed': 'err_connect_failed',
    'limit-reached': 'limit_reached',
  };
  function errorKeyFor(detail) {
    detail = detail || {};
    var key = lookup(REASON_KEY, detail.reason);
    if (key) return key;
    if (detail.status === 404 || detail.status === 410) return 'err_session_ended';
    if (detail.status === 429) return 'limit_reached';
    if (detail.status === 403) return 'not_authorized';
    return '';
  }
  function scaleFor(mode, opts) {
    if (mode === 'native') return 'native';
    return 'fit';
  }
  return { backoffMs: backoffMs, classifyMintFailure: classifyMintFailure,
    retryWindowMs: retryWindowMs, nextState: nextState, scaleFor: scaleFor,
    guacErrorReason: guacErrorReason, classifyGuacError: classifyGuacError,
    gaveUpReason: gaveUpReason, errorKeyFor: errorKeyFor };
}));
