'use strict';

// Langsame Plugin-Datenbankabfragen (Bericht vom 8. 11. nach 1.253.4: Blockaden
// von 2–5 s, in jeder ein db.query von Mail):
//   * ein Statement ab 200 ms im Worker wird mit Plugin, Statement ohne Werte,
//     Zeilen und Zeiten protokolliert — einmal je Minute und Statement;
//   * die Blockade-Meldung nennt das Statement eines offenen db.query und sagt,
//     ob der Haupt-Thread rechnete oder wartete;
//   * ein schweres Statement (Summe über große Zeilen, Sekunden im Worker) und
//     eine große Antwort halten die Ereignisschleife des Hosts nicht an
//     (< 200 ms); eine Antwort ist höchstens ~16 MB groß.

require('./helpers/test-env');
const { describe, it, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const storage = require('../src/services/plugins/storage');
const { fingerprint } = require('../src/services/plugins/sqlGuard');
const loopStall = require('../src/utils/loopStall');
const logger = require('../src/utils/logger');

const LIMIT_MS = 200;

/** Longest pause of the event loop while `fn` runs (5 ms ticks). */
async function maxLag(fn) {
  let worst = 0;
  let last = performance.now();
  const iv = setInterval(() => {
    const t = performance.now();
    worst = Math.max(worst, t - last - 5);
    last = t;
  }, 5);
  let result;
  try { result = await fn(); } finally {
    worst = Math.max(worst, performance.now() - last - 5);
    clearInterval(iv);
  }
  return { worst: Math.round(worst), result };
}

const COUNT_SQL = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c';

/** A count that runs about `ms` in the worker of `db`. */
async function countFor(db, ms) {
  await db.call('query', { sql: COUNT_SQL, params: [200000], mode: 'get' }, 10000); // warm
  const t0 = performance.now();
  await db.call('query', { sql: COUNT_SQL, params: [400000], mode: 'get' }, 10000);
  return Math.floor(400000 * ms / Math.max(1, performance.now() - t0));
}

after(() => storage.closeAll());
afterEach(() => { mock.restoreAll(); loopStall._resetForTest(); });

describe('fingerprint of a statement (sqlGuard.fingerprint)', () => {
  it('drops the values, one ?,… for a list, one blank for white space, at most 160 characters', () => {
    assert.equal(fingerprint("SELECT  a FROM t\n  WHERE b = 'geheim@example.com' AND c IN (?, ?, ?,?) AND d > 12.5 AND t2.e = 'it''s' LIMIT 50"),
      'SELECT a FROM t WHERE b = ? AND c IN (?,…) AND d > ? AND t2.e = ? LIMIT ?');
    assert.equal(fingerprint('SELECT 1'), 'SELECT ?');
    assert.equal(fingerprint("SELECT 'unterminated"), 'SELECT ?');
    const long = fingerprint('SELECT ' + 'x, '.repeat(500) + 'y FROM t');
    assert.equal(long.length, 161);
    assert.ok(long.endsWith('…'));
    assert.equal(fingerprint('SELECT a FROM t', 5), 'SELEC…');
    assert.equal(fingerprint(null), '');
  });

  it('a host call is named with its statement in a stall (runtime callLabel)', () => {
    const { _callLabel } = require('../src/services/plugins/runtime');
    assert.equal(_callLabel({ api: 'db.query', args: { sql: "SELECT * FROM messages WHERE id = 7 AND x = 'y'", params: [1] } }),
      'db.query SELECT * FROM messages WHERE id = ? AND x = ?');
    assert.equal(_callLabel({ api: 'db.exec', args: { sql: 'BEGIN' } }), 'db.exec BEGIN');
    assert.equal(_callLabel({ api: 'settings.get', args: { key: 'a' } }), 'settings.get');
    assert.equal(_callLabel({ api: 'db.query', args: {} }), 'db.query');
  });
});

describe('slow plugin database statements', () => {
  it('a statement of 200 ms or more in the worker is logged with the plugin, the statement without values, rows and times', async () => {
    // no calibration by wall-clock time (a busy runner makes it wrong, and a calibration run of 200 ms or more would
    // itself be the logged one — the next would wait a minute): the count doubles until the worker measures 200 ms or
    // more. Every run before was faster than that in the worker — the first slow one of a statement is always logged.
    const db = storage.forPlugin('slow-log');
    const warn = mock.method(logger, 'warn', () => {});
    const slowLines = () => warn.mock.calls.filter((c) => c.arguments[1] === 'slow plugin database statement');
    let n = 100000;
    let runs = 0;
    for (; runs < 12 && !slowLines().length; runs++) {
      n *= 2;
      const r = await db.call('query', { sql: COUNT_SQL.replace('x < ?', `x < ${n}`), mode: 'all' }, 14000);
      assert.equal(r.rows[0].n, n);
    }
    const lines = slowLines();
    assert.equal(lines.length, 1, JSON.stringify(warn.mock.calls.map((c) => c.arguments)));
    const f = lines[0].arguments[0];
    assert.equal(f.plugin, 'slow-log');
    assert.equal(f.op, 'query');
    assert.equal(f.mode, 'all');
    assert.equal(f.rows, 1);
    assert.ok(f.ms >= storage.SLOW_MS, `ms ${f.ms}`);
    assert.ok(f.waitMs >= 0 && f.waitMs < f.ms, `waitMs ${f.waitMs}`);
    assert.equal(f.sql, 'WITH RECURSIVE c(x) AS (SELECT ? UNION ALL SELECT x + ? FROM c WHERE x < ?) SELECT count(*) AS n FROM c');
    assert.ok(!f.sql.includes(String(n)), 'no values in the log');
    // a quick statement is not logged
    warn.mock.resetCalls();
    await db.call('kv.get', { key: 'a' });
    await db.call('query', { sql: 'SELECT 1 AS one', mode: 'get' });
    assert.equal(warn.mock.calls.filter((c) => c.arguments[1] === 'slow plugin database statement').length, 0);
  });

  it('once a minute per statement; the next line counts the repeats', () => {
    const db = storage.forPlugin('slow-throttle');
    const warn = mock.method(logger, 'warn', () => {});
    const p = (sql) => ({ op: 'query', args: { sql, mode: 'all' }, sentAt: 1000 });
    const t = 1000000;
    db.noteSlow(p('SELECT * FROM a WHERE x = 1'), { ok: true, ms: 300, rows: 5 }, t);
    db.noteSlow(p('SELECT * FROM a WHERE x = 2'), { ok: true, ms: 900, rows: 5 }, t + 1000); // the same statement
    db.noteSlow(p('SELECT * FROM b'), { ok: true, ms: 250, rows: 1 }, t + 2000); // another one
    db.noteSlow(p('SELECT * FROM a WHERE x = 3'), { ok: false, ms: 400 }, t + storage.SLOW_EVERY_MS + 1);
    const lines = warn.mock.calls.filter((c) => c.arguments[1] === 'slow plugin database statement').map((c) => c.arguments[0]);
    assert.deepEqual(lines.map((l) => [l.sql, l.times || 1, l.maxMs || l.ms]), [
      ['SELECT * FROM a WHERE x = ?', 1, 300],
      ['SELECT * FROM b', 1, 250],
      ['SELECT * FROM a WHERE x = ?', 2, 900],
    ]);
    assert.equal(lines[2].failed, true);
  });
});

describe(`Ereignisschleife < ${LIMIT_MS} ms bei schweren Plugin-Abfragen`, () => {
  it('a sum over 3000 rows of 16 KB (overflow pages, like Mail\'s old usage) and a 1.5 s statement run in the worker only', async (t) => {
    const db = storage.forPlugin('slow-heavy');
    await db.call('exec', { sql: 'CREATE TABLE bodies (message_id INTEGER PRIMARY KEY, html TEXT, text TEXT, bytes INTEGER NOT NULL)' });
    const kb16 = 16 * 1024;
    await db.call('exec', { sql: `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000)
      INSERT INTO bodies (html, text, bytes) SELECT printf('%.${kb16}c', 'x'), 'text ' || x, ${kb16} FROM c` });
    const sum = await maxLag(() => db.call('query', { sql: 'SELECT SUM(bytes) AS n FROM bodies', mode: 'get' }));
    assert.equal(sum.result.row.n, 3000 * kb16);
    assert.ok(sum.worst < LIMIT_MS, `event loop paused ${sum.worst} ms`);
    const n = await countFor(db, 1500);
    const long = await maxLag(() => db.call('query', { sql: COUNT_SQL, params: [n], mode: 'get' }, 10000));
    assert.equal(long.result.row.n, n);
    assert.ok(long.worst < LIMIT_MS, `event loop paused ${long.worst} ms during a long statement`);
    t.diagnostic(`longest pause: sum over the bodies ${sum.worst} ms, 1.5 s statement ${long.worst} ms`);
  });

  it('a list answer stops at ~16 MB (truncated) — copying it to the main thread and serialising it stays under the limit', async (t) => {
    const db = storage.forPlugin('slow-big');
    await db.call('exec', { sql: 'CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT NOT NULL)' });
    await db.call('exec', { sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 4000) INSERT INTO big (v) SELECT printf('%.8192c', 'a') FROM c" });
    let rows = null;
    const got = await maxLag(async () => {
      const r = await db.call('query', { sql: 'SELECT id, v FROM big ORDER BY id', mode: 'all' });
      rows = r;
      // the host serialises the answer for the plugin process (child.send, JSON) on its main thread
      return JSON.stringify({ t: 'hostResult', id: 1, ok: true, value: r }).length;
    });
    assert.equal(rows.truncated, true, 'past ~16 MB');
    assert.ok(rows.rows.length > 1500 && rows.rows.length < 2100, `rows ${rows.rows.length}`);
    assert.ok(got.result < 17.5 * 1024 * 1024, `answer ${got.result} bytes`);
    assert.ok(got.worst < LIMIT_MS, `event loop paused ${got.worst} ms`);
    t.diagnostic(`longest pause: ${rows.rows.length} rows, ${got.result} bytes → ${got.worst} ms`);
    // small rows: the row limit as before
    const few = await db.call('query', { sql: 'SELECT id FROM big ORDER BY id', mode: 'all' });
    assert.deepEqual([few.rows.length, few.truncated], [4000, false]);
  });
});

describe('the stall log says whether the main thread computed or waited', () => {
  it('usageFields: main-thread CPU near the blocked time → cpu, far below → waiting', () => {
    const f = loopStall._usageFieldsForTest;
    const a = { main: 1000, proc: 5000, faults: 10, reads: 100 };
    assert.deepEqual(f(a, { main: 3900, proc: 9000, faults: 10, reads: 108 }, 3000),
      { processCpuMs: 4000, majorFaults: 0, diskReads: 8, mainCpuMs: 2900, blockedBy: 'cpu' });
    assert.deepEqual(f(a, { main: 1100, proc: 5200, faults: 900, reads: 50100 }, 3000),
      { processCpuMs: 200, majorFaults: 890, diskReads: 50000, mainCpuMs: 100, blockedBy: 'waiting' });
    assert.deepEqual(f({ ...a, main: null }, { main: null, proc: 5100, faults: 10, reads: 100 }, 3000), { processCpuMs: 100, majorFaults: 0, diskReads: 0 });
    assert.deepEqual(f(null, a, 3000), {});
  });

  it('a busy main thread is cpu, a sleeping one (synchronous wait) is waiting', { skip: typeof process.threadCpuUsage !== 'function' && 'no process.threadCpuUsage' }, async () => {
    const warn = mock.method(logger, 'warn', () => {});
    const seen = [];
    loopStall.start({ everyMs: 50, warnMs: 300, onStall: () => seen.push(1) });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(80);
    // spin for 500 ms of this thread's CPU time (not wall time: a busy runner may take the core away meanwhile)
    const cpu = () => { const t = process.threadCpuUsage(); return (t.user + t.system) / 1000; };
    const spin = (ms) => { const end = cpu() + ms; while (cpu() < end) { /* busy */ } };
    await new Promise((r) => setImmediate(() => { spin(500); r(); }));
    for (let i = 0; i < 60 && seen.length < 1; i++) await sleep(50);
    await sleep(80);
    await new Promise((r) => setImmediate(() => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); r(); }));
    for (let i = 0; i < 60 && seen.length < 2; i++) await sleep(50);
    loopStall.stop();
    const lines = warn.mock.calls.filter((c) => c.arguments[1] === 'event loop was blocked').map((c) => c.arguments[0]);
    assert.equal(lines.length, 2, JSON.stringify(lines));
    assert.ok(lines[0].mainCpuMs >= 450, JSON.stringify(lines[0]));
    // cpu unless the runner took the core away for most of the stall (then it did wait — the rule of usageFields)
    assert.equal(lines[0].blockedBy, lines[0].mainCpuMs >= lines[0].blockedMs * 0.6 ? 'cpu' : 'waiting', JSON.stringify(lines[0]));
    assert.ok(lines[0].mainCpuMs >= lines[0].blockedMs * 0.6 || lines[0].blockedMs > 750, `a stall of ${lines[0].blockedMs} ms with ${lines[0].mainCpuMs} ms CPU is cpu`);
    assert.equal(lines[1].blockedBy, 'waiting', JSON.stringify(lines[1]));
    assert.ok(lines[1].mainCpuMs < 150);
  });
});
