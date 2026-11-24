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
  it('classifyMintFailure: 404/410 (session ended) are final, 5xx/network retry', () => {
    for (const phase of ['initial', 'reconnect']) {
      assert.equal(L.classifyMintFailure({ status: 404, phase }), 'fatal');
      assert.equal(L.classifyMintFailure({ status: 410, phase }), 'fatal');
      assert.equal(L.classifyMintFailure({ status: 502, phase }), 'retry');
    }
  });
  it('classifyGuacError: any guacd error before the first picture is final', () => {
    for (const code of [0x0301, 0x0303, 0x0203, 0x0207, 0x0201, 0x0200]) {
      assert.equal(L.classifyGuacError({ code, established: false }), 'fatal');
    }
    // after a running session only logon refusals are final
    assert.equal(L.classifyGuacError({ code: 0x0301, established: true }), 'fatal');
    assert.equal(L.classifyGuacError({ code: 0x0303, established: true }), 'fatal');
    assert.equal(L.classifyGuacError({ code: 0x0207, established: true }), 'retry');
    assert.equal(L.classifyGuacError({ code: 0x0203, established: true }), 'retry');
  });
  it('guacErrorReason maps Guacamole status codes to causes', () => {
    assert.equal(L.guacErrorReason(0x0301), 'auth-rejected');
    assert.equal(L.guacErrorReason(0x0303), 'login-forbidden');
    assert.equal(L.guacErrorReason(0x0203), 'upstream-error');
    assert.equal(L.guacErrorReason(0x0202), 'unreachable');
    assert.equal(L.guacErrorReason(0x0207), 'unreachable');
    assert.equal(L.guacErrorReason(0x0208), 'unreachable');
    assert.equal(L.guacErrorReason(0x0209), 'session-conflict');
    assert.equal(L.guacErrorReason(0x020B), 'session-closed');
    assert.equal(L.guacErrorReason(0x0201), 'busy');
    assert.equal(L.guacErrorReason(0x0200), 'guac-error');
    assert.equal(L.guacErrorReason(undefined), 'guac-error');
  });
  it('gaveUpReason: "limit reached" only after a session once ran', () => {
    assert.equal(L.gaveUpReason(true), 'limit-reached');
    assert.equal(L.gaveUpReason(false), 'connect-failed');
  });
  it('errorKeyFor: detail → i18n key of the session page', () => {
    assert.equal(L.errorKeyFor({ reason: 'auth-rejected', code: 0x0301 }), 'err_auth_rejected');
    assert.equal(L.errorKeyFor({ reason: 'unreachable' }), 'err_unreachable');
    assert.equal(L.errorKeyFor({ reason: 'connect-failed', status: 502 }), 'err_connect_failed');
    assert.equal(L.errorKeyFor({ reason: 'limit-reached' }), 'limit_reached');
    assert.equal(L.errorKeyFor({ reason: 'mint-failure', status: 404 }), 'err_session_ended');
    assert.equal(L.errorKeyFor({ reason: 'mint-failure', status: 410 }), 'err_session_ended');
    assert.equal(L.errorKeyFor({ reason: 'mint-failure', status: 429 }), 'limit_reached');
    assert.equal(L.errorKeyFor({ reason: 'mint-failure', status: 403 }), 'not_authorized');
    assert.equal(L.errorKeyFor({ reason: 'mint-failure', status: 409 }), '');
    assert.equal(L.errorKeyFor(undefined), '');
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
    assert.equal(L.nextState('connected', 'fatal'), 'error');
    assert.equal(L.nextState('connecting', 'fatal'), 'error');
  });
  it('scaleFor: native stays native, default is fit (Chain1-G5)', () => {
    assert.equal(L.scaleFor('native', { protocol: 'rdp' }), 'native');
    assert.equal(L.scaleFor('fit', { protocol: 'rdp' }), 'fit');
    assert.equal(L.scaleFor(undefined, { protocol: 'ssh' }), 'fit');
  });
});

/* ── rdp-player.js against a fake Guacamole: a failed start must end in a named error ── */
describe('rdp-player: failed start', () => {
  const tick = () => new Promise((r) => setImmediate(r));

  function setup({ mint }) {
    const clients = [];
    global.GCRdpPlayerLogic = L;
    global.document = {};
    global.Guacamole = {
      WebSocketTunnel: function () {},
      Client: Object.assign(function () {
        const el = { parentNode: null };
        const c = this;
        c.getDisplay = () => ({ getElement: () => el, getScale: () => 1, scale() {}, getWidth: () => 0, getHeight: () => 0 });
        c.connect = () => {};
        c.disconnect = () => {};
        clients.push(c);
      }, { State: { CONNECTED: 3, DISCONNECTED: 5 } }),
      Mouse: Object.assign(function () {}, { State: function () {} }),
      Keyboard: function () {},
      Status: { Code: { UNSUPPORTED: 0x0100 } },
    };
    const container = { appendChild(el) { el.parentNode = { removeChild() {} }; }, clientWidth: 800, clientHeight: 600 };
    const states = [];
    delete require.cache[require.resolve('../public/js/rdp-player.js')];
    const P = require('../public/js/rdp-player.js');
    const player = P.create({ container, wsBase: 'ws://example.test', mint, onState: (s, d) => states.push([s, d]) });
    return { player, clients, states };
  }

  it('guacd logon refusal before the first frame → final error, no reconnect loop', async () => {
    let mints = 0;
    const { player, clients, states } = setup({ mint: () => { mints++; return Promise.resolve({ token: 't', wsPath: '/guac', protocol: 'rdp' }); } });
    player.connect();
    await tick();
    assert.equal(clients.length, 1);
    const c = clients[0];
    // guacd sends error 0x0301, then the client disconnects itself
    c.onerror({ code: 0x0301, message: 'Authentication failure' });
    c.onstatechange(5);
    await tick();
    assert.equal(player.getState(), 'error');
    const last = states[states.length - 1];
    assert.equal(last[0], 'error');
    assert.equal(last[1].reason, 'auth-rejected');
    assert.equal(L.errorKeyFor(last[1]), 'err_auth_rejected');
    assert.ok(!states.some(([s]) => s === 'reconnecting'), 'never shows "reconnecting"');
    assert.equal(mints, 1, 'no further token requests');
    player.disconnect();
  });

  it('ended ticket (404) on the first token request → "session ended", no retry', async () => {
    let mints = 0;
    const { player, states } = setup({ mint: () => { mints++; const e = new Error('not_found'); e.status = 404; return Promise.reject(e); } });
    player.connect();
    await tick();
    assert.equal(player.getState(), 'error');
    assert.equal(L.errorKeyFor(states[states.length - 1][1]), 'err_session_ended');
    assert.equal(mints, 1);
    player.disconnect();
  });

  it('a drop of a running session still reconnects', async () => {
    const { player, clients, states } = setup({ mint: () => Promise.resolve({ token: 't', wsPath: '/guac', protocol: 'rdp' }) });
    player.connect();
    await tick();
    clients[0].onstatechange(3); // first frame
    assert.equal(player.getState(), 'connected');
    clients[0].onerror({ code: 0x0207 }); // upstream gone: not final once the session ran
    clients[0].onstatechange(5);
    assert.equal(player.getState(), 'reconnecting');
    assert.ok(states.some(([s]) => s === 'reconnecting'));
    player.disconnect();
  });
});
