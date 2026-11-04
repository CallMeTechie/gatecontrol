'use strict';

// Blockaden des Haupt-Threads (utils/loopStall.js) und was daran hängt:
//   * die Meldung „event loop was blocked“ nennt die markierten Aufgaben
//     (withTask), die in der blockierten Zeit liefen;
//   * blockedSince() sagt dem Plugin-Watchdog, wie lange der Host selbst
//     stand — nach einer Host-Blockade von einer Minute werden gesunde
//     Plugins nicht mehr per SIGKILL neu gestartet (services/plugins/runtime.js);
//   * ein abgelaufenes CSRF-Token (Login-Seite von gestern) ist eine Warnung
//     ohne Stacktrace, kein „Unhandled error“.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

const loopStall = require('../src/utils/loopStall');
const logger = require('../src/utils/logger');

/** Den Haupt-Thread `ms` lang synchron blockieren. */
function block(ms) { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let app;
before(async () => { ({ app } = await setup()); });
after(() => teardown());
afterEach(() => { loopStall._resetForTest(); mock.restoreAll(); });

describe('task markers', () => {
  it('a stall names the marked task that ran in it, with its time', async () => {
    const warn = mock.method(logger, 'warn', () => {});
    const seen = [];
    loopStall.start({ everyMs: 50, warnMs: 300, onStall: (ms, tasks) => seen.push({ ms, tasks }) });
    await sleep(80);
    loopStall.withTask('demo.light', () => 1);
    await sleep(80);
    setImmediate(() => loopStall.withTask('demo.heavy', () => block(500)));
    await sleep(200);
    loopStall.stop();
    assert.equal(seen.length, 1);
    const heavy = seen[0].tasks.find((t) => t.name === 'demo.heavy');
    assert.ok(heavy && heavy.ms >= 450, JSON.stringify(seen[0].tasks));
    assert.ok(!seen[0].tasks.some((t) => t.name === 'demo.light'), 'a task before the stall is not named');
    const line = warn.mock.calls.find((c) => c.arguments[1] === 'event loop was blocked');
    assert.ok(line, 'logged');
    assert.ok(line.arguments[0].blockedMs >= 300);
    assert.match(line.arguments[0].tasks[0], /^demo\.heavy: \d+ ms$/);
  });

  it('withTask passes values and errors through, sync and async', async () => {
    assert.equal(loopStall.withTask('t.sync', () => 7), 7);
    assert.equal(await loopStall.withTask('t.async', async () => 8), 8);
    assert.throws(() => loopStall.withTask('t.throw', () => { throw new Error('boom'); }), /boom/);
    await assert.rejects(loopStall.withTask('t.reject', async () => { throw new Error('nope'); }), /nope/);
    const names = loopStall.tasksBetween(0, Number.MAX_SAFE_INTEGER).map((t) => t.name).sort();
    assert.deepEqual(names, ['t.async', 't.reject', 't.sync', 't.throw'], 'every task ended, none left open');
    assert.ok(loopStall.tasksBetween(0, Number.MAX_SAFE_INTEGER).every((t) => !t.running));
  });
});

describe('blockedSince', () => {
  it('counts the stalls seen after a time, and one going on right now', async () => {
    mock.method(logger, 'warn', () => {});
    const now = Date.now();
    loopStall._noteStallForTest(64000, now - 10000);
    loopStall._noteStallForTest(3000, now - 200000);
    assert.equal(loopStall.blockedSince(now - 80000, now), 64000);
    assert.equal(loopStall.blockedSince(now - 30000, now), 20000, 'only the part after `since`');
    assert.equal(loopStall.blockedSince(now, now), 0);
    loopStall._resetForTest();
    loopStall.start({ everyMs: 50, warnMs: 300 });
    await sleep(80);
    const since = Date.now();
    let during = 0;
    await new Promise((resolve) => setImmediate(() => { block(700); during = loopStall.blockedSince(since); resolve(); }));
    assert.ok(during >= 500, `seen while the timer has not run yet: ${during}`);
    await sleep(120);
    assert.ok(loopStall.blockedSince(since) >= 500, 'recorded afterwards');
  });
});

describe('plugin watchdog', () => {
  const runtime = require('../src/services/plugins/runtime');

  function proc() {
    const p = new runtime._PluginProcess({ id: 'gatecontrol-demo', version: '1.0.0', manifest: { entry: 'index.js', permissions: {} } });
    p.state = 'running';
    p.child = { kill: mock.fn(), send: mock.fn() };
    p.log = mock.fn();
    return p;
  }

  it('a plugin that stopped answering while the host ran is restarted', () => {
    const p = proc();
    const now = Date.now();
    p.lastPong = now - runtime.PING_DEAD_MS - 5000;
    p.lastPingTick = now - runtime.PING_EVERY_MS;
    p.pingTick(now);
    assert.equal(p.child.kill.mock.callCount(), 1);
    assert.equal(p.child.kill.mock.calls[0].arguments[0], 'SIGKILL');
    assert.deepEqual(p.log.mock.calls[0].arguments, ['error', 'plugin stopped answering — restarting']);
  });

  it('a host stall of a minute (this timer fired late) is no silence of the plugin', () => {
    const p = proc();
    const now = Date.now();
    // the case of the report: pong 79 s ago, the host blocked for 64 s, the ping timer 64 s late
    p.lastPong = now - 79000;
    p.lastPingTick = now - runtime.PING_EVERY_MS - 64000;
    p.pingTick(now);
    assert.equal(p.child.kill.mock.callCount(), 0);
    assert.equal(p.child.send.mock.callCount(), 1, 'pinged again instead');
    assert.equal(p.child.send.mock.calls[0].arguments[0].t, 'ping');
    // the pong waiting in the pipe arrives: all is well
    p.onMessage({ t: 'pong' });
    assert.equal(p.hostLateMs, 0);
    p.pingTick(Date.now() + runtime.PING_EVERY_MS);
    assert.equal(p.child.kill.mock.callCount(), 0);
  });

  it('a host stall seen by loopStall counts too (the ping timer itself on time)', () => {
    const p = proc();
    const now = Date.now();
    p.lastPong = now - 79000;
    p.lastPingTick = now - runtime.PING_EVERY_MS;
    loopStall._noteStallForTest(64000, now - 20000);
    p.pingTick(now);
    assert.equal(p.child.kill.mock.callCount(), 0);
  });

  it('a plugin that really hangs is still ended — after PING_DEAD_MS of time the host ran', () => {
    const p = proc();
    let now = Date.now();
    p.lastPong = now - 79000;
    p.lastPingTick = now - runtime.PING_EVERY_MS - 64000;
    p.pingTick(now);
    assert.equal(p.child.kill.mock.callCount(), 0);
    // no pong: the next rounds count only the time the host ran (79 s − 64 s = 15 s so far)
    let rounds = 0;
    while (p.child.kill.mock.callCount() === 0 && rounds < 10) {
      now += runtime.PING_EVERY_MS;
      p.pingTick(now);
      rounds++;
    }
    assert.equal(p.child.kill.mock.callCount(), 1);
    // 15 s + rounds × 30 s must exceed 75 s
    assert.equal(rounds, 3);
  });
});

describe('invalid csrf token', () => {
  it('is a warning without a stack, the answer stays 403', async () => {
    const supertest = require('supertest');
    const warn = mock.method(logger, 'warn', () => {});
    const error = mock.method(logger, 'error', () => {});
    const res = await supertest(app).post('/login').type('form').send({ username: 'admin', password: 'x', _csrf: 'expired-token' });
    assert.equal(res.status, 403);
    assert.ok(!error.mock.calls.some((c) => c.arguments[1] === 'Unhandled error'), 'no "Unhandled error"');
    const w = warn.mock.calls.find((c) => c.arguments[1] === 'invalid csrf token');
    assert.ok(w, 'logged as a warning');
    assert.deepEqual(w.arguments[0], { path: '/login', method: 'POST' });
  });
});
