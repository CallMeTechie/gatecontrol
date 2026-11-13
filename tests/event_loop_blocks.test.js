'use strict';

// Ereignisschleife unter Last (Server 1.253.x, Bericht vom 8. 11.: Blockaden
// von 2–36 s, Gateways ohne Heartbeat, Weboberfläche steht):
//   * Häppchen (utils/slice.js): ein langer Job gibt die Schleife alle ~10 ms
//     frei;
//   * die Hintergrundjobs mit einem großen Drive — 20 000 Dateien in Bereichen
//     auf einem Speicherziel, 20 000 Löschaufträge, 60 000 Angebote im
//     Zwischenspeicher (Dateien und Vorschauen) — halten die Schleife nie
//     länger als 200 ms an: Arbeiter (tick), Abgleich mit dem Ziel
//     (scanArea), Cache-Räumung, Bereichsliste, Sicherung der Bereiche,
//     stündliche Bereinigung der Angebote, Vorrat eines Gateways (want) —
//     gemessen als CPU-Zeit des Haupt-Threads ohne Pause (helpers/loopLag.js),
//     nicht an der Wanduhr: ein ausgelasteter Runner verlängert eine Pause,
//     nicht die eigene Arbeit (CI, 9. 11.: 245 ms); eine Pause ab 1 s fällt
//     trotzdem auf;
//   * die Meldung „event loop was blocked“ nennt auch Anfragen (Route mit
//     maskierten IDs) und synchrone Stücke (measure);
//   * WAL-Checkpoints laufen in einem eigenen Thread; ein um 8 MB gewachsenes
//     Log sofort, nicht erst nach maxAgeMs (im Test 5 s gegen < 2,5 s);
//   * die automatische Sicherung kommt nicht mehr direkt beim Start.

const crypto = require('node:crypto');
// the WAL checkpoint worker runs in tests only on request (db/connection.js)
process.env.GC_DB_CHECKPOINT = 'worker';
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
// load-proof: the CPU time this thread spends without a break, the wall clock only as a coarse bound (helpers/loopLag.js)
const { maxLag, assertLoopFree } = require('./helpers/loopLag');

const slice = require('../src/utils/slice');
const loopStall = require('../src/utils/loopStall');
const logger = require('../src/utils/logger');

const N = 20000;
const LIMIT_MS = 200;
const PID = 'gatecontrol-drive';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (i, len = 32) => i.toString(16).padStart(len, '0');
function block(ms) { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } }

let db;
before(async () => {
  await setup();
  db = require('../src/db/connection').getDb();
});
after(() => teardown());
afterEach(() => { loopStall._resetForTest(); mock.restoreAll(); });

describe('slices (utils/slice.js)', () => {
  it('pause() yields once the slice is used up — a timer runs in between', async () => {
    const s = slice.slicer(10);
    assert.equal(await s.pause(), false, 'time left: no yield');
    let fired = false;
    setTimeout(() => { fired = true; }, 0);
    block(15);
    assert.equal(s.due(), true);
    assert.equal(await s.pause(), true);
    await s.pause();
    // a timer due when the slice ended runs before the next slice
    await sleep(0);
    assert.equal(fired, true);
    assert.equal(s.yields, 1);
  });

  it('forEachSliced visits every item in order and keeps the loop free', async (t) => {
    const list = Array.from({ length: 300 }, (_, i) => i);
    const seen = [];
    const r = await maxLag(() => slice.forEachSliced(list, (x) => { seen.push(x); block(1); }));
    assert.deepEqual(seen, list);
    assertLoopFree(r, 'forEachSliced', 60, t);
  });

  it('walkRowids covers (0, max] in ranges and stops when asked', async () => {
    const ranges = [];
    await slice.walkRowids(25, 10, (lo, hi) => { ranges.push([lo, hi]); return [lo]; }, () => false);
    assert.deepEqual(ranges, [[0, 10], [10, 20], [20, 25]]);
    const got = [];
    await slice.walkRowids(100, 10, (lo) => [lo], (rows) => { got.push(...rows); return got.length >= 3; });
    assert.deepEqual(got, [0, 10, 20]);
    let called = 0;
    await slice.walkRowids(0, 10, () => { called++; return []; }, () => false);
    assert.equal(called, 0, 'an empty table: no statement');
  });
});

describe('stall attribution (utils/loopStall.js)', () => {
  it('measure keeps a synchronous piece of MEASURE_MIN_MS or more, the outermost one only', () => {
    loopStall.measure('short', () => block(1));
    loopStall.measure(() => 'outer', () => { loopStall.measure('inner', () => block(30)); });
    const names = loopStall.tasksBetween(0, Number.MAX_SAFE_INTEGER).map((t) => t.name);
    assert.deepEqual(names, ['outer']);
    assert.equal(loopStall.measure('value', () => 42), 42);
    assert.throws(() => loopStall.measure('boom', () => { throw new Error('x'); }), /x/);
  });

  it('routeLabel masks ids, hashes and tokens, drops the query', () => {
    assert.equal(loopStall.routeLabel('GET', `/api/v1/gateway/cache/blob/${'a'.repeat(64)}?x=1`), 'GET /api/v1/gateway/cache/blob/:id');
    assert.equal(loopStall.routeLabel('POST', '/api/v1/plugins/gatecontrol-drive/api/nodes/123'), 'POST /api/v1/plugins/gatecontrol-drive/api/nodes/:id');
    assert.equal(loopStall.routeLabel('GET', '/plugin-media/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-x/preview'), 'GET /plugin-media/:id/preview');
  });

  it('a stall names the request whose handler held the thread, and the requests open then', async () => {
    const express = require('express');
    const supertest = require('supertest');
    const app = express();
    app.use(loopStall.httpMiddleware);
    app.get('/slow/:id', (req, res) => { block(400); res.json({ ok: true }); });
    app.get('/big', (req, res) => { res.json({ items: Array.from({ length: 200000 }, (_, i) => ({ i, s: 'x'.repeat(20) })) }); });
    const warn = mock.method(logger, 'warn', () => {});
    const seen = [];
    loopStall.start({ everyMs: 50, warnMs: 250, onStall: (ms, tasks, reqs) => seen.push({ ms, tasks, reqs }) });
    await sleep(80);
    await supertest(app).get('/slow/1234').expect(200);
    // the watch timer reports at its next run (later on a busy runner): wait for it, bounded
    for (let i = 0; i < 60 && !seen.length; i++) await sleep(50);
    loopStall.stop();
    assert.ok(seen.length >= 1, 'a stall was seen');
    const t = seen[0].tasks.find((x) => x.name === 'GET /slow/:id');
    assert.ok(t && t.ms >= 350, JSON.stringify(seen[0].tasks));
    assert.ok(seen[0].reqs.some((r) => r.name === 'GET /slow/:id'), JSON.stringify(seen[0].reqs));
    const line = warn.mock.calls.find((c) => c.arguments[1] === 'event loop was blocked');
    assert.match(line.arguments[0].tasks[0], /^GET \/slow\/:id: \d+ ms$/);
    assert.ok(Array.isArray(line.arguments[0].requests));
    // the answer itself (res.json of a big list) is measured too
    loopStall._resetForTest();
    await supertest(app).get('/big').expect(200);
    const big = loopStall.tasksBetween(0, Number.MAX_SAFE_INTEGER).map((x) => x.name);
    assert.ok(big.includes('GET /big (json)') || big.includes('GET /big'), JSON.stringify(big));
  });

  // Protokoll vom 12./13. 11.: 49 von 53 Blockaden „waiting“ mit wenigen ms CPU, genannt wurden nur Aufgaben mit
  // „(async)“. Eine Anweisung der Host-Datenbank läuft synchron auf dem Hauptthread (Anhängen an das
  // Schreibprotokoll, fsync seines Kopfes nach einem Checkpoint, Warten auf eine fremde Sperre) — sie steht jetzt
  // mit ihrer Zeit in `tasks`.
  it('a database statement the thread waited in is named, without its values', () => {
    const Database = require('better-sqlite3');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    assert.equal(typeof loopStall.instrumentDb, 'function');
    loopStall.instrumentDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-stalldb-'));
    const db = new Database(path.join(dir, 'a.db'));
    const other = new Database(path.join(dir, 'a.db'));
    try {
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)');
      db.function('wait_ms', (n) => { block(n); return n; });
      const names = () => loopStall.tasksBetween(0, Number.MAX_SAFE_INTEGER).map((t) => t.name);

      // The set-up above wrote to the disk (switch of the journal mode: new files and a sync, a new table). On
      // a busy disk that alone takes DB_MIN_MS or more and is then kept, as it should be — it is not what is
      // asked here (CI, 13.11.: 'db PRAGMA journal_mode = WAL' was in the list).
      loopStall._resetForTest();
      // "A fast statement is not kept" as a rule on one clock instead of a hope about the disk: the time measured
      // here, around the call, is never shorter than the one measured inside it. So a statement that took less
      // than DB_MIN_MS here must not be in the list, and whatever is in the list took DB_MIN_MS or more.
      const timed = (fn) => { const t0 = performance.now(); const value = fn(); return { value, ms: performance.now() - t0 }; };
      const quick = [
        ['db INSERT INTO t (k, v) VALUES (?, ?)', timed(() => db.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('a', '1'))],
        ['db SELECT v FROM t WHERE k = ?', timed(() => db.prepare('SELECT v FROM t WHERE k = ?').get('a'))],
      ];
      assert.equal(quick[1][1].value.v, '1');
      const kept = loopStall.tasksBetween(0, Number.MAX_SAFE_INTEGER);
      for (const k of kept) assert.ok(k.ms >= loopStall.DB_MIN_MS, `kept although it took ${k.ms} ms: ${k.name}`);
      for (const [name, t] of quick) {
        if (t.ms < loopStall.DB_MIN_MS) assert.ok(!kept.some((k) => k.name === name), `a fast statement is not kept (${name}, ${t.ms.toFixed(1)} ms)`);
      }
      assert.ok(kept.every((k) => quick.some(([name]) => name === k.name)), JSON.stringify(names()));
      loopStall._resetForTest();

      assert.equal(db.prepare("SELECT wait_ms(40) AS n WHERE 'geheim' <> 'x'").get().n, 40);
      assert.deepEqual(db.prepare('SELECT wait_ms(30) AS n').all(), [{ n: 30 }]);
      db.exec("UPDATE t SET v = 'geheim' WHERE wait_ms(30) > 0");
      assert.deepEqual(names().sort(), ['db SELECT wait_ms(?) AS n', 'db SELECT wait_ms(?) AS n WHERE ? <> ?', 'db UPDATE t SET v = ? WHERE wait_ms(?) > ?']);

      // another connection holds the write lock (a shell with an open transaction): the write waits busy_timeout,
      // fails — and is named with the time it waited
      loopStall._resetForTest();
      db.pragma('busy_timeout = 60');
      other.exec('BEGIN IMMEDIATE');
      assert.throws(() => db.prepare('UPDATE t SET v = ? WHERE k = ?').run('2', 'a'), { code: 'SQLITE_BUSY' });
      other.exec('ROLLBACK');
      const waited = loopStall.tasksBetween(0, Number.MAX_SAFE_INTEGER).find((t) => t.name === 'db UPDATE t SET v = ? WHERE k = ?');
      assert.ok(waited && waited.ms >= 50, JSON.stringify(names()));
    } finally {
      db.close(); other.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('task() marks a timer callback and logs its error instead of throwing', async () => {
    const warn = mock.method(logger, 'warn', () => {});
    loopStall.task('demo.timer', () => block(25))();
    assert.ok(loopStall.tasksBetween(0, Number.MAX_SAFE_INTEGER).some((t) => t.name === 'demo.timer'));
    loopStall.task('demo.fails', () => { throw new Error('nope'); })();
    await loopStall.task('demo.rejects', async () => { throw new Error('later'); })().catch(() => {});
    await sleep(5);
    const msgs = warn.mock.calls.filter((c) => c.arguments[1] === 'background task failed').map((c) => c.arguments[0].task);
    assert.deepEqual(msgs.sort(), ['demo.fails', 'demo.rejects']);
  });
});

describe('WAL checkpoints off the main thread (db/connection.js)', () => {
  it('the main connection does not checkpoint itself while the worker runs', async () => {
    const conn = require('../src/db/connection');
    assert.ok(conn._checkpointer(), 'worker started');
    for (let i = 0; i < 50 && db.pragma('wal_autocheckpoint', { simple: true }) !== 0; i++) await sleep(20);
    assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), 0);
    // the worker copies the log back: after a burst of writes the WAL is checkpointed
    db.exec('CREATE TABLE IF NOT EXISTS t_ckpt (x TEXT)');
    const ins = db.prepare('INSERT INTO t_ckpt (x) VALUES (?)');
    db.transaction(() => { for (let i = 0; i < 5000; i++) ins.run('x'.repeat(200)); })();
    const done = await new Promise((resolve) => {
      const w = conn._checkpointer();
      const t = setTimeout(() => resolve(false), 8000);
      w.on('message', (m) => { if (m && m.t === 'checkpoint' && m.log > 0 && m.checkpointed === m.log) { clearTimeout(t); resolve(true); } });
      w.postMessage({ t: 'now' });
    });
    assert.equal(done, true);
  });
});

describe('the checkpoint worker checkpoints a change after MAX_AGE_MS, not every tick (since 1.255.0)', () => {
  it('no checkpoint without a commit; a commit is checkpointed once it is maxAgeMs old; a grown log at once', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { Worker } = require('node:worker_threads');
    const Database = require('better-sqlite3');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-ckpt-')), 'h.db');
    const main = new Database(file);
    main.pragma('journal_mode = WAL');
    main.pragma('synchronous = NORMAL');
    main.pragma('wal_autocheckpoint = 0');
    main.exec('CREATE TABLE t (x TEXT)');
    const script = path.join(__dirname, '..', 'src', 'db', 'checkpointWorker.js');
    let seen = [];
    const startWorker = async (maxAgeMs) => {
      const mine = [];
      seen = mine; // the checkpoints of this worker only
      const worker = new Worker(script, { workerData: { file, everyMs: 20, maxAgeMs } });
      worker.on('message', (m) => { if (m && m.t === 'checkpoint') mine.push({ at: Date.now(), log: m.log }); });
      await new Promise((r) => worker.once('message', r)); // ready
      return worker;
    };
    let w = await startWorker(400);
    try {
      await sleep(500); // the log of CREATE TABLE: one checkpoint at most
      const startCount = seen.length;
      await sleep(300);
      assert.equal(seen.length, startCount, 'quiet: no checkpoint');
      const t0 = Date.now();
      for (let i = 0; i < 20; i++) { main.prepare('INSERT INTO t VALUES (?)').run('a' + i); await sleep(10); }
      for (let i = 0; i < 100 && seen.length === startCount; i++) await sleep(20);
      assert.equal(seen.length, startCount + 1, 'one checkpoint for the burst');
      assert.ok(seen[seen.length - 1].at - t0 >= 380, `after ${seen[seen.length - 1].at - t0} ms`);
      // a log that grows by more than 8 MB goes at once — with a maxAgeMs of 5 s here, so "at once" and "after
      // maxAgeMs" lie seconds apart and a busy runner (a slow transaction, a late tick, a slow fsync) cannot blur them
      await w.terminate();
      const MAX_AGE_MS = 5000;
      w = await startWorker(MAX_AGE_MS);
      // its start: the log left behind is checkpointed once (at the first tick), then it is quiet
      for (let i = 0; i < 200 && !seen.length; i++) await sleep(10);
      assert.equal(seen.length, 1, 'the log left at the start: one checkpoint');
      await sleep(100);
      const n = seen.length;
      const pageSize = main.pragma('page_size', { simple: true });
      main.transaction(() => { const ins = main.prepare('INSERT INTO t VALUES (?)'); for (let i = 0; i < 3000; i++) ins.run('y'.repeat(4000)); })();
      const t1 = Date.now(); // committed: the age of the change counts from here at the earliest
      // the checkpoint of the grown log (a tick during the COMMIT may find no frame yet: log 0, not this one)
      const grown = () => seen.slice(n).find((x) => x.log * pageSize > 8 * 1024 * 1024);
      while (!grown() && Date.now() - t1 < MAX_AGE_MS - 500) await sleep(10);
      const ckpt = grown();
      assert.ok(ckpt, `grown log: not checkpointed within ${Date.now() - t1} ms (${JSON.stringify(seen.slice(n).map((x) => x.log))} frames)`);
      assert.ok(ckpt.at - t1 < MAX_AGE_MS / 2, `grown log: checkpoint after ${ckpt.at - t1} ms, not at once (maxAgeMs ${MAX_AGE_MS})`);
    } finally {
      await w.terminate();
      main.close();
    }
  });
});

describe(`Ereignisschleife < ${LIMIT_MS} ms bei ${N} Einträgen`, () => {
  let areas;
  let homeCache;
  let tid;
  const AREAS = 10;
  const ids = [];
  const keyOf = (i) => `${PID}/area${i % AREAS}/Fotos/${2000 + (i % 25)}/${String(i % 12).padStart(2, '0')}/IMG_${i}.jpg`;
  const old = Date.now() - 3600 * 1000;

  before(() => {
    areas = require('../src/services/plugins/mediaAreas');
    homeCache = require('../src/services/homeCache');
    const media = require('../src/services/plugins/media');
    tid = Number(db.prepare("INSERT INTO storage_targets (kind, label, config_json) VALUES ('local', 'NAS', ?)").run(JSON.stringify({ path: '/nonexistent-gc-test' })).lastInsertRowid);
    const insA = db.prepare("INSERT INTO plugin_media_areas (plugin, area, label, target_id, form) VALUES (?, ?, ?, ?, 'files')");
    for (let a = 0; a < AREAS; a++) insA.run(PID, `area${a}`, `Bereich ${a}`, tid);
    const fileKey = crypto.randomBytes(32);
    const ins = db.prepare(`INSERT INTO plugin_media (id, plugin, mime, bytes, sha256, created_at, ref_count, claimed_at, key_enc,
      area, path, target_id, remote_key, want_key, stored_form, remote_size, remote_mtime, local, accessed_at)
      VALUES (?, ?, 'image/jpeg', 10, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'files', 10, ?, ?, ?)`);
    const insB = db.prepare(`INSERT INTO home_cache_blobs (sha256, size, kind, source, ref, plugin_id, media_id, priority, label, created_at, updated_at)
      VALUES (?, ?, 'photos', ?, ?, ?, ?, ?, ?, ?, ?)`);
    const iso = new Date(old).toISOString();
    db.transaction(() => {
      for (let i = 0; i < N; i++) {
        const id = hex(i + 1);
        ids.push(id);
        const k = keyOf(i);
        ins.run(id, PID, hex(i, 64), iso, iso, media._wrapKey(fileKey, id), `area${i % AREAS}`, k.slice(`${PID}/area${i % AREAS}/`.length), tid, k, k, old, i % 10 === 0 ? 1 : 0, new Date(old + i).toISOString());
        insB.run(hex(i, 64), 10, 'plugin', id, PID, id, 50, null, old, old);
        insB.run(hex(N + i, 64), 8000, 'preview', `${id}/small`, PID, id, 95, 'small', old, old + i);
        insB.run(hex(2 * N + i, 64), 40000, 'preview', `${id}/large`, PID, id, 45, 'large', old, old + i);
      }
      // 20 000 deletions not due yet (a target that failed for a while)
      db.prepare("INSERT INTO plugin_media_gone (target_id, remote_key, next_at) SELECT ?, 'gone/' || id, '2999-01-01' FROM plugin_media").run(tid);
    })();
  });

  after(() => { areas._setDriverForTest(null); });

  /** A folder target in memory: every file there as stored, renames succeed. */
  function fakeDriver() {
    const entries = ids.map((_, i) => ({ key: keyOf(i), size: 10, mtime: old }));
    return {
      kind: 'local', files: true, ranges: true,
      list: async () => entries,
      move: async () => {},
      head: async () => ({ size: 10, mtime: old }),
      put: async () => {}, get: async () => { throw new Error('not here'); }, remove: async () => {},
    };
  }

  it('the copy worker (tick) with every file in place, and with an area to move', async (t) => {
    areas._setDriverForTest(async () => fakeDriver());
    let r = await maxLag(() => areas.tick());
    assertLoopFree(r, 'all in place', LIMIT_MS, t);
    db.prepare("UPDATE plugin_media SET want_key = remote_key || '.x' WHERE area = 'area1'").run();
    r = await maxLag(() => areas.tick());
    assertLoopFree(r, 'area to move', LIMIT_MS, t);
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM plugin_media WHERE area = 'area1' AND remote_key = want_key").get().n >= 200, 'files were moved');
    db.prepare("UPDATE plugin_media SET want_key = remote_key WHERE area = 'area1'").run();
  });

  it('the look for changes on the target (scanArea), the first one after an upload', async (t) => {
    areas._setDriverForTest(async () => fakeDriver());
    db.prepare("UPDATE plugin_media SET remote_mtime = NULL WHERE area = 'area2'").run();
    const r = await maxLag(async () => { for (let a = 0; a < AREAS; a++) await areas.scanArea(PID, `area${a}`); });
    assertLoopFree(r, 'scan', LIMIT_MS, t);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM plugin_media WHERE area = 'area2' AND remote_mtime IS NULL").get().n, 0, 'times adopted');
    const st = JSON.parse(db.prepare("SELECT scan_stats FROM plugin_media_areas WHERE plugin = ? AND area = 'area3'").get(PID).scan_stats);
    assert.equal(st.files, N, 'the target lists all files of the plugin');
  });

  it('the area list (admin page, gc.media.areas.list) and the backup of the areas', async (t) => {
    let r = await maxLag(() => areas.list(PID, { admin: true }));
    assertLoopFree(r, 'list', LIMIT_MS, t);
    assert.equal(r.result.length, AREAS);
    assert.equal(r.result.reduce((a, x) => a + x.count, 0), N);
    assert.equal(r.result[0].pending.count, 0);
    r = await maxLag(() => areas.exportAreas(PID));
    assertLoopFree(r, 'export', LIMIT_MS, t);
    assert.equal(r.result.files.length, N);
  });

  it('the cache clean-up when the cache is over its limit', async (t) => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(areas.CACHE_SETTING, String(areas.CACHE_MIN));
    db.prepare('UPDATE plugin_media SET bytes = ? WHERE local = 1').run(1024 * 1024);
    const r = await maxLag(() => areas.evict());
    assertLoopFree(r, 'evict', LIMIT_MS, t);
    assert.equal(r.result, 1000, 'at most 1000 a run');
    db.prepare("DELETE FROM settings WHERE key = ?").run(areas.CACHE_SETTING);
  });

  it('the stock of a gateway (GET /cache/want): 20 000 items, the second ask from memory', async (t) => {
    const peer = Number(db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('gw-blocks', ?, '10.8.0.77/32', 1, 'gateway')").run(crypto.randomBytes(32).toString('base64')).lastInsertRowid);
    db.prepare('INSERT INTO gateway_cache (peer_id, settings) VALUES (?, ?)').run(peer, JSON.stringify({ enabled: true, maxBytes: 4096 * 1024 ** 3, kinds: { drive: true, photos: true, updates: false, vault: false } }));
    let r = await maxLag(() => homeCache.want(peer));
    assertLoopFree(r, 'want', LIMIT_MS, t);
    assert.equal(r.result.items.length, homeCache.WANT_MAX);
    assert.ok(r.result.items.slice(0, N).every((x) => x.priority === 95), 'the small previews first');
    const etag = r.result.etag;
    r = await maxLag(() => homeCache.want(peer));
    assert.equal(r.result.etag, etag);
    // a change of the stock is seen at once
    await homeCache.dropStaleOffers();
    db.prepare("DELETE FROM home_cache_blobs WHERE sha256 = ?").run(hex(N, 64));
    homeCache.withdraw(PID, ids[0], { preview: 'large' });
    r = await homeCache.want(peer);
    assert.notEqual(r.etag, etag);
  });

  it('the hourly clean-up of offers whose file is gone', async (t) => {
    db.prepare("UPDATE home_cache_blobs SET media_id = 'gone' || substr(media_id, 5) WHERE source = 'preview' AND rowid % 2 = 0").run();
    const before = db.prepare('SELECT COUNT(*) AS n FROM home_cache_blobs').get().n;
    const r = await maxLag(() => homeCache.dropStaleOffers());
    assertLoopFree(r, 'drop', LIMIT_MS, t);
    assert.ok(r.result > 1000, `dropped ${r.result}`);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM home_cache_blobs').get().n, before - r.result);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM home_cache_blobs WHERE media_id LIKE 'gone%'").get().n, 0);
  });
});

describe('automatic backup at the start', () => {
  it('is not made right at the start, only START_DELAY_MS later', async () => {
    const autobackup = require('../src/services/autobackup');
    const settings = require('../src/services/settings');
    settings.set('autobackup_enabled', 'true');
    settings.set('autobackup_last_run', new Date(Date.now() - 3 * 86400e3).toISOString());
    assert.ok(autobackup.START_DELAY_MS >= 5 * 60 * 1000);
    autobackup._startDelayMs = 300;
    try {
      autobackup.startScheduler();
      await sleep(150);
      assert.ok(Date.now() - Date.parse(settings.get('autobackup_last_run')) > 86400e3, 'nothing at the start');
      for (let i = 0; i < 100 && Date.now() - Date.parse(settings.get('autobackup_last_run')) > 86400e3; i++) await sleep(50);
      assert.ok(Date.now() - Date.parse(settings.get('autobackup_last_run')) < 60e3, 'made after the delay');
    } finally {
      autobackup.stopScheduler();
      autobackup._startDelayMs = null;
      settings.set('autobackup_enabled', 'false');
    }
  });
});
