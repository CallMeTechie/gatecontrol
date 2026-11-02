'use strict';

// Plugin-Speicher (services/plugins/storage.js): die Zeitgrenze gilt der
// Laufzeit EINES Statements im Worker — nicht einem blockierten Haupt-Thread
// des Hosts, nicht dem Warten hinter anderen Statements und nicht dem Öffnen
// der Datenbank (Kaltstart).

require('./helpers/test-env');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const storage = require('../src/services/plugins/storage');
const { TIMEOUTS } = require('../src/services/plugins/constants');

/** Den Haupt-Thread `ms` lang synchron blockieren (wie ein langes fsyncSync / eine große synchrone Abfrage). */
function block(ms) { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } }

describe('plugin storage timeout', () => {
  after(() => storage.closeAll());

  it('a blocked host main thread is no storage timeout: the answer that arrived counts', async () => {
    const db = storage.forPlugin('timeout-lag');
    await db.call('kv.set', { key: 'a', value: 1 });
    const worker = db.worker;
    const p = db.call('kv.get', { key: 'a' }, 200);
    // the main thread blocked after the poll phase (like a request handler in synchronous I/O); the worker
    // answers within milliseconds meanwhile, but the next loop turn runs the expired timer first
    setImmediate(() => block(600));
    assert.deepEqual(await p, { value: 1 });
    assert.equal(db.worker, worker, 'the worker is kept');
  });

  it('a call queued behind a slow statement gets its own time', async () => {
    const db = storage.forPlugin('timeout-queue');
    await db.call('kv.set', { key: 'a', value: 1 });
    // ~80 ms in the worker each; six of them in a row (~480 ms) with 400 ms each
    const slow = { sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c', params: [0], mode: 'get' };
    await db.call('query', { ...slow, params: [300000] }, 5000); // warm
    const t0 = Date.now();
    await db.call('query', { ...slow, params: [600000] }, 5000);
    const n = Math.floor(600000 * 80 / Math.max(1, Date.now() - t0));
    const calls = [1, 2, 3, 4, 5, 6].map(() => db.call('query', { ...slow, params: [n] }, 400));
    for (const r of await Promise.all(calls)) assert.equal(r.row.n, n);
  });

  it('a statement that really runs too long still ends with storage timeout, and the next call works', async () => {
    const db = storage.forPlugin('timeout-hang');
    await db.call('kv.set', { key: 'a', value: 1 });
    // ~1.5 s in the worker with a limit of 300 ms (finite: a worker ends only when SQLite gives control back)
    const sql = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c';
    let t0 = Date.now();
    await db.call('query', { sql, params: [300000], mode: 'get' }, 5000);
    const n = Math.floor(300000 * 1500 / Math.max(1, Date.now() - t0));
    t0 = Date.now();
    const slow = db.call('query', { sql, params: [n], mode: 'get' }, 300);
    const waiting = db.call('kv.get', { key: 'a' }, 5000); // behind it: ends with it
    await assert.rejects(slow, /storage timeout/);
    await assert.rejects(waiting, /storage timeout/);
    assert.ok(Date.now() - t0 < 1200, 'ends near its limit');
    assert.deepEqual(await db.call('kv.get', { key: 'a' }), { value: 1 });
  });

  it('opening the database (cold start) is not counted as statement time', async () => {
    const db = storage.forPlugin('timeout-cold');
    // a limit shorter than starting a worker and opening the file; reading takes far less
    assert.deepEqual(await db.call('kv.get', { key: 'a' }, 5), { value: null });
  });
});

describe('plugin start timeout', () => {
  it('grows with the plugins starting at the same moment, up to a limit', () => {
    const { startTimeout } = require('../src/services/plugins/runtime');
    assert.equal(startTimeout(0), TIMEOUTS.start);
    assert.equal(startTimeout(2), TIMEOUTS.start + 2 * TIMEOUTS.startPerPeer);
    assert.equal(startTimeout(100), TIMEOUTS.startMax);
  });
});

describe('event loop stall log', () => {
  it('reports a blocked main thread with its length', async () => {
    const loopStall = require('../src/utils/loopStall');
    const seen = [];
    loopStall.start({ everyMs: 50, warnMs: 300, onStall: (ms) => seen.push(ms) });
    try {
      await new Promise((r) => setTimeout(r, 120));
      block(500);
      await new Promise((r) => setTimeout(r, 150));
    } finally { loopStall.stop(); }
    assert.equal(seen.length, 1);
    assert.ok(seen[0] >= 300 && seen[0] < 2000, String(seen[0]));
  });
});
