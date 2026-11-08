'use strict';

// Langsame Plugin-Datenbankabfragen (Bericht vom 8. 11. nach 1.253.4: Blockaden
// von 2–5 s, in jeder ein db.query von Mail):
//   * ein Statement ab 200 ms im Worker wird gezählt; je Plugin und 5 Minuten
//     eine Zeile mit Anzahl, Schreibvorgängen, längster Zeit und den häufigsten
//     Statements ohne Werte (seit 1.255.0, vorher eine Zeile je Statement und Minute);
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
  it('a statement of 200 ms or more in the worker is counted; the window\'s line names the plugin, the statement without values, rows and times', async () => {
    // no calibration by wall-clock time (a busy runner makes it wrong): the count doubles until the worker measures
    // 200 ms or more — every run before was faster than that in the worker
    const db = storage.forPlugin('slow-log');
    const warn = mock.method(logger, 'warn', () => {});
    const slowLines = () => warn.mock.calls.filter((c) => c.arguments[1] === 'slow plugin database statements');
    let n = 100000;
    let runs = 0;
    for (; runs < 12 && !(db.slow && db.slow.n); runs++) {
      n *= 2;
      const r = await db.call('query', { sql: COUNT_SQL.replace('x < ?', `x < ${n}`), mode: 'all' }, 14000);
      assert.equal(r.rows[0].n, n);
    }
    assert.equal(slowLines().length, 0, 'nothing logged before the window ends');
    db.flushSlow();
    const lines = slowLines();
    assert.equal(lines.length, 1, JSON.stringify(warn.mock.calls.map((c) => c.arguments)));
    const f = lines[0].arguments[0];
    assert.equal(f.plugin, 'slow-log');
    assert.equal(f.slow, 1);
    assert.equal(f.writes, 0, 'a SELECT is no write');
    assert.ok(f.maxMs >= storage.SLOW_MS, `ms ${f.maxMs}`);
    assert.ok(f.waitMs >= 0 && f.waitMs < f.maxMs, `waitMs ${f.waitMs}`);
    assert.deepEqual(f.statements.map((e) => [e.op, e.sql, e.n, e.rows]),
      [['query', 'WITH RECURSIVE c(x) AS (SELECT ? UNION ALL SELECT x + ? FROM c WHERE x < ?) SELECT count(*) AS n FROM c', 1, 1]]);
    assert.ok(!JSON.stringify(f).includes(String(n)), 'no values in the log');
    // a quick statement is not counted; an empty window writes no line
    warn.mock.resetCalls();
    await db.call('kv.get', { key: 'a' });
    await db.call('query', { sql: 'SELECT 1 AS one', mode: 'get' });
    db.flushSlow();
    assert.equal(slowLines().length, 0);
  });

  it('one line per plugin and window (5 minutes): count, writes, longest time, the top statements by count', () => {
    const db = storage.forPlugin('slow-throttle');
    const warn = mock.method(logger, 'warn', () => {});
    const q = (sql, mode = 'run') => ({ op: 'query', args: { sql, mode }, sentAt: 1000 });
    const t = 1000000;
    // the protocol of 8. 11.: the same single-row UPDATE again and again, a COMMIT, kv.set — and one read
    for (let i = 0; i < 40; i++) db.noteSlow(q(`UPDATE resources SET state_json = '{"on":${i}}' WHERE id = ${i}`), { ok: true, ms: 280 + i }, t + i * 1000);
    for (let i = 0; i < 6; i++) db.noteSlow({ op: 'exec', args: { sql: 'COMMIT' }, sentAt: 1000 }, { ok: true, ms: 320 }, t + 50000 + i);
    db.noteSlow({ op: 'kv.set', args: { key: 'k' }, sentAt: 1000 }, { ok: true, ms: 6500 }, t + 60000);
    db.noteSlow(q('SELECT * FROM b', 'all'), { ok: false, ms: 250, rows: 1 }, t + 61000);
    assert.equal(warn.mock.calls.length, 0, 'no line per statement any more');
    db.flushSlow(t + 300000);
    const lines = warn.mock.calls.filter((c) => c.arguments[1] === 'slow plugin database statements').map((c) => c.arguments[0]);
    assert.equal(lines.length, 1);
    const l = lines[0];
    assert.deepEqual([l.plugin, l.slow, l.writes, l.failed, l.maxMs, l.windowS], ['slow-throttle', 48, 47, 1, 6500, 300]);
    assert.deepEqual(l.statements.map((e) => [e.op, e.sql || null, e.n, e.maxMs]), [
      ['query', 'UPDATE resources SET state_json = ? WHERE id = ?', 40, 319],
      ['exec', 'COMMIT', 6, 320],
      ['kv.set', null, 1, 6500],
      ['query', 'SELECT * FROM b', 1, 250],
    ]);
    // the window ends with its line: the next statement opens a new one (its timer: SLOW_WINDOW_MS)
    db.noteSlow(q('UPDATE x SET a = 1'), { ok: true, ms: 300 }, t + 400000);
    assert.ok(db.slowTimer, 'a new window');
    db.flushSlow(t + 400000 + storage.SLOW_WINDOW_MS);
    assert.equal(warn.mock.calls.filter((c) => c.arguments[1] === 'slow plugin database statements').length, 2);
    assert.equal(storage.SLOW_WINDOW_MS, 5 * 60 * 1000);
  });

  it('at most SLOW_TOP statements in the line, the rest as `others`; closing the storage writes the open window', async () => {
    const db = storage.forPlugin('slow-many');
    const warn = mock.method(logger, 'warn', () => {});
    for (let i = 0; i < 9; i++) db.noteSlow({ op: 'query', args: { sql: `UPDATE t${i} SET a = 1`, mode: 'run' }, sentAt: 1 }, { ok: true, ms: 210 }, 1000 + i);
    await storage.close('slow-many');
    const lines = warn.mock.calls.filter((c) => c.arguments[1] === 'slow plugin database statements').map((c) => c.arguments[0]);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].statements.length, storage.SLOW_TOP);
    assert.equal(lines[0].others, 9 - storage.SLOW_TOP);
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
