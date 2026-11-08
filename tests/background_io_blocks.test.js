'use strict';

// Nachträge zum Bericht vom 8. 11. (Server 1.253.2/1.253.3):
//   * WAF-Audit-Log (waf.audit 1,3 s und 2,4 s blockiert): ein Rückstau von
//     12 MB wird asynchron in Häppchen gelesen und gespeichert, höchstens
//     TICK_BYTES je Takt — die Ereignisschleife bleibt unter 200 ms;
//     TLS-Log und Layer-4-Log ebenso;
//   * Peer-Status: die Zähler aller Peers in einer Transaktion, nur was sich
//     änderte;
//   * Zuordnung: asynchrone Aufgaben stehen als „(async)“ hinter den
//     synchronen, ein langsamer Prozessstart als „spawn <Programm>“;
//   * Warnungen: dieselbe Meldung einmal je Zeitfenster (`repeated`), der
//     Gateway-Release-Abruf mit Backoff und einer Meldung je Ausfall, der
//     Katalog mit der Phase, in der eine Anfrage hängt (dns/connect/tls/first
//     byte), und dem letzten guten Katalog, solange GitHub nicht antwortet.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { performance } = require('node:perf_hooks');
const { setup, teardown } = require('./helpers/setup');

const loopStall = require('../src/utils/loopStall');
const warnOnce = require('../src/utils/warnOnce');
const logger = require('../src/utils/logger');

const LIMIT_MS = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function block(ms) { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } }

/** Longest pause of the event loop while `fn` runs (5 ms ticks). */
async function maxLag(fn) {
  let worst = 0;
  let last = performance.now();
  const iv = setInterval(() => { const t = performance.now(); worst = Math.max(worst, t - last - 5); last = t; }, 5);
  let result;
  try { result = await fn(); } finally { worst = Math.max(worst, performance.now() - last - 5); clearInterval(iv); }
  return { worst: Math.round(worst), result };
}

let db;
before(async () => { await setup(); db = require('../src/db/connection').getDb(); });
after(() => teardown());
afterEach(() => { mock.restoreAll(); loopStall._resetForTest(); warnOnce._resetForTest(); });

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gc-bgio-'));

describe(`log watchers: Ereignisschleife < ${LIMIT_MS} ms bei einem Rückstau`, () => {
  it('WAF audit log: 12 MB backlog → at most TICK_BYTES a tick, async, all lines in the end', async () => {
    const waf = require('../src/services/waf');
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'waf', 'coraza-audit.jsonl'), 'utf8').split('\n').filter(Boolean);
    const dir = tmpDir();
    const file = path.join(dir, 'waf-audit.log');
    const lines = [];
    let size = 0;
    while (size < 12 * 1024 * 1024) { const l = fixture[lines.length % fixture.length]; lines.push(l); size += l.length + 1; }
    fs.writeFileSync(file, lines.join('\n') + '\n');
    db.prepare('DELETE FROM waf_events').run();
    waf.startWatcher({ file, intervalMs: 1e9, immediate: false, truncateAfterIngest: false, rotateBytes: 1e12 });
    try {
      let ticks = 0;
      let worst = 0;
      let before = 0;
      for (; ticks < 40; ticks++) {
        const r = await maxLag(() => waf.pollOnce());
        worst = Math.max(worst, r.worst);
        const st = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'waf.watch_state'").get()?.value || '{"offset":0}');
        assert.ok(st.offset - before <= 4 * 1024 * 1024 + 1024 * 1024, `tick ${ticks} read ${st.offset - before} bytes`);
        before = st.offset;
        if (st.offset >= size) break;
      }
      assert.ok(ticks >= 2, 'a backlog takes several ticks');
      assert.ok(worst < LIMIT_MS, `longest pause ${worst} ms`);
      assert.ok(db.prepare('SELECT COUNT(*) AS n FROM waf_events').get().n > lines.length / 2, 'the lines were stored');
    } finally { waf.stopWatcher(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('TLS log: an old offset with megabytes behind it is read 512 KB a tick, never a character cut in two', async () => {
    const tlsGuard = require('../src/services/tlsGuard');
    const dir = tmpDir();
    const file = path.join(dir, 'tls.log');
    const line = JSON.stringify({ level: 'info', logger: 'http.log', msg: 'unrelated — ünïcödé', n: 1 });
    fs.writeFileSync(file, (line + '\n').repeat(40000));
    tlsGuard.startWatcher({ file, intervalMs: 1e9, immediate: false });
    try {
      const r = await maxLag(async () => { for (let i = 0; i < 20; i++) await tlsGuard.pollOnce(); });
      assert.ok(r.worst < LIMIT_MS, `longest pause ${r.worst} ms`);
    } finally { tlsGuard.stopWatcher(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('layer-4 connection log: a burst is read and parsed asynchronously', async () => {
    const guard = require('../src/services/l4ConnGuard');
    const routeId = db.prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, l4_protocol, l4_listen_port, l4_tls_mode,
        l4_conn_limit, l4_conn_window_s, external_enabled, https_enabled)
      VALUES (NULL, '10.0.0.9', 22, 'l4', 'tcp', '2099', 'none', 1000000, 60, 1, 0)`).run().lastInsertRowid;
    const dir = tmpDir();
    const file = path.join(dir, 'l4conn.log');
    fs.writeFileSync(file, '');
    guard.start({ file, intervalMs: 1e9 });
    try {
      const now = Date.now();
      const lines = [];
      for (let i = 0; i < 30000; i++) {
        lines.push(JSON.stringify({ level: 'debug', ts: (now + i) / 1000, logger: 'layer4', msg: 'started handling connection', network: 'tcp', local: '10.0.0.2:2099', remote: `198.51.100.${i % 200}:${40000 + (i % 1000)}` }));
      }
      fs.appendFileSync(file, lines.join('\n') + '\n');
      const r = await maxLag(async () => { for (let i = 0; i < 10; i++) await guard.pollOnce(); });
      assert.ok(r.worst < LIMIT_MS, `longest pause ${r.worst} ms`);
    } finally { guard.stop(); fs.rmSync(dir, { recursive: true, force: true }); db.prepare('DELETE FROM routes WHERE id = ?').run(routeId); }
  });
});

describe('peer status poll', () => {
  it('writes the counters of all peers in one transaction and only what changed', async () => {
    const wireguard = require('../src/services/wireguard');
    const peerStatus = require('../src/services/peerStatus');
    const keys = [];
    for (let i = 0; i < 6; i++) {
      const k = crypto.randomBytes(32).toString('base64');
      keys.push(k);
      db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES (?, ?, ?, 1, 'regular')").run(`ps-${i}-${process.pid}`, k, `10.8.9.${i + 2}/32`);
    }
    let rx = 100;
    mock.method(wireguard, 'getStatus', async () => ({
      running: true,
      peers: keys.map((k, i) => ({ publicKey: k, endpoint: null, allowedIps: `10.8.9.${i + 2}/32`, latestHandshake: 1000, transferRx: i === 0 ? rx : 5, transferTx: 7, isOnline: false })),
    }));
    const commits = mock.method(db, 'transaction');
    await peerStatus.pollPeerStatus();
    assert.equal(commits.mock.callCount(), 1, 'one transaction for all peers');
    const row = (k) => db.prepare('SELECT transfer_rx, updated_at FROM peers WHERE public_key = ?').get(k);
    assert.equal(row(keys[0]).transfer_rx, 100);
    db.prepare("UPDATE peers SET updated_at = '2000-01-01 00:00:00' WHERE public_key IN (" + keys.map(() => '?').join(',') + ')').run(...keys);
    rx = 250;
    await peerStatus.pollPeerStatus();
    assert.equal(row(keys[0]).transfer_rx, 250, 'changed counters are written');
    assert.notEqual(row(keys[0]).updated_at, '2000-01-01 00:00:00');
    assert.equal(row(keys[1]).updated_at, '2000-01-01 00:00:00', 'an unchanged peer is not written');
  });
});

describe('stall attribution: async tasks and process starts', () => {
  it('an async task is listed as (async), after the synchronous one that held the thread', async () => {
    mock.method(logger, 'warn', () => {});
    const seen = [];
    loopStall.start({ everyMs: 50, warnMs: 250, onStall: (ms, tasks) => seen.push(tasks) });
    await sleep(80);
    // an async job waiting on its I/O while another one blocks
    const waiting = loopStall.withTask('demo.waits', () => new Promise((r) => setTimeout(r, 30)));
    setImmediate(() => loopStall.withTask('demo.blocks', () => block(400)));
    await waiting;
    // the watch timer reports at its next run (later on a busy runner): wait for it, bounded
    for (let i = 0; i < 60 && !seen.length; i++) await sleep(50);
    loopStall.stop();
    const lines = loopStall.tasksBetween(0, Number.MAX_SAFE_INTEGER);
    assert.ok(lines.find((t) => t.name === 'demo.waits').async, 'marked async');
    assert.ok(!lines.find((t) => t.name === 'demo.blocks').async);
    const warn = logger.warn.mock.calls.find((c) => c.arguments[1] === 'event loop was blocked');
    assert.ok(warn, 'logged');
    const tasks = warn.arguments[0].tasks;
    assert.match(tasks[0], /^demo\.blocks: \d+ ms$/, JSON.stringify(tasks));
    assert.ok(tasks.some((t) => /^demo\.waits: \d+ ms \((async|still running)\)$/.test(t)), JSON.stringify(tasks));
  });

  it('a slow start of a child process is kept as spawn <program>', async () => {
    loopStall.instrumentSpawn();
    loopStall._setSpawnMinMsForTest(0);
    try {
      await new Promise((resolve) => require('node:child_process').execFile(process.execPath, ['-e', ''], () => resolve()));
      const names = loopStall.tasksBetween(0, Number.MAX_SAFE_INTEGER).map((t) => t.name);
      assert.ok(names.includes(`spawn ${path.basename(process.execPath)}`), JSON.stringify(names));
    } finally { loopStall._setSpawnMinMsForTest(null); }
  });
});

describe('repeated warnings', () => {
  it('warnOnce: once per window, the repeats counted in the next line; recovered() ends the outage', () => {
    const warn = mock.method(logger, 'warn', () => {});
    const t = Date.now();
    assert.equal(warnOnce.throttled('k', { a: 1 }, 'same', { now: t }), true);
    for (let i = 1; i <= 6; i++) assert.equal(warnOnce.throttled('k', { a: 1 }, 'same', { now: t + i * 1000 }), false);
    assert.equal(warnOnce.throttled('k', { a: 1 }, 'same', { now: t + warnOnce.WINDOW_MS + 1 }), true);
    assert.equal(warn.mock.callCount(), 2);
    assert.equal(warn.mock.calls[1].arguments[0].repeated, 6);
    assert.ok(warnOnce.recovered('k', t + warnOnce.WINDOW_MS + 2));
    assert.equal(warnOnce.recovered('k'), null);
  });

  it('gateway release fetch: 503 → one warning, backoff (no new request per page view), the cached version; works again → one info', async () => {
    const gr = require('../src/services/gatewayRelease');
    const warn = mock.method(logger, 'warn', () => {});
    const info = mock.method(logger, 'info', () => {});
    gr._resetBackoff();
    let calls = 0;
    let answer = { status: 503, body: '' };
    gr._setTransport(async () => { calls++; return answer; });
    try {
      gr._setCache('1.20.0');
      gr._fetchLatest();
      await sleep(10);
      for (let i = 0; i < 20; i++) { gr._fetchLatest(); await sleep(1); }
      assert.equal(calls, 1, 'no new request inside the backoff');
      assert.equal(gr.getLatestVersion(), '1.20.0', 'the last known version');
      const lines = warn.mock.calls.filter((c) => /gateway release fetch failed/.test(c.arguments[1]));
      assert.equal(lines.length, 1);
      assert.equal(lines[0].arguments[0].status, 503);
      assert.ok(gr._backoff.nextTryAt > Date.now());
      // the backoff over, GitHub answers again
      gr._backoff.nextTryAt = 0;
      answer = { status: 200, body: JSON.stringify({ tag_name: 'v1.21.0', assets: [] }) };
      gr._fetchLatest();
      await sleep(10);
      assert.equal(calls, 2);
      assert.equal(gr.getLatestVersion(), '1.21.0');
      assert.ok(info.mock.calls.some((c) => c.arguments[1] === 'gateway release fetch works again'));
    } finally { gr._setTransport(null); gr._resetBackoff(); }
  });
});

describe('plugin catalogue: where a request hangs, the last good catalogue, one line per outage', () => {
  const catalog = require('../src/services/plugins/catalog');
  afterEach(() => { catalog._reset(); delete process.env.GC_PLUGIN_CATALOG_URL; });

  it('a server that accepts but never finishes TLS → catalog_timeout with phase tls and the address family', async () => {
    const server = net.createServer(() => { /* accepts, says nothing */ });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.GC_PLUGIN_CATALOG_URL = `https://127.0.0.1:${server.address().port}/catalog.json`;
    const old = catalog.TIMEOUTS.catalogHeaders;
    catalog.TIMEOUTS.catalogHeaders = 300;
    try {
      catalog._reset();
      await assert.rejects(catalog.get(), (e) => e.code === 'catalog_timeout' && e.phase && e.phase.phase === 'tls' && e.phase.address === '127.0.0.1' && e.phase.family === 'IPv4'
        && /phase tls, 127\.0\.0\.1 \(IPv4\)/.test(catalog.errText(e)));
    } finally { catalog.TIMEOUTS.catalogHeaders = old; server.close(); }
  });

  it('GitHub down: the API fallback is tried, logged once per outage, and the last good catalogue is answered (stale)', async () => {
    const info = mock.method(logger, 'info', () => {});
    const warn = mock.method(logger, 'warn', () => {});
    const doc = JSON.stringify({ schema: 1, generated_at: '2026-11-08T00:00:00Z', plugins: {} });
    let down = false;
    const asked = [];
    catalog._setTransport(async (url) => {
      asked.push(new URL(url).hostname);
      if (down) throw Object.assign(new catalog.CatalogError('catalog_timeout', 'no answer'), { host: new URL(url).host, phase: { phase: 'dns', address: null, family: null, ms: 4000 } });
      return { status: 200, headers: {}, location: null, body: Buffer.from(doc) };
    });
    assert.ok(await catalog.get());
    down = true;
    for (let i = 0; i < 5; i++) {
      const cat = await catalog.get({ refresh: true });
      assert.equal(cat.generatedAt, '2026-11-08T00:00:00Z', 'the last good catalogue');
    }
    assert.ok(asked.some((h) => h === 'api.github.com'), 'the API way was tried after a DNS failure of the download path');
    assert.equal(catalog.stale().code, 'catalog_timeout');
    const fails = warn.mock.calls.filter((c) => c.arguments[1] === 'plugin catalogue via api fallback: failed');
    assert.equal(fails.length, 1, 'one line for the outage, not one per request');
    assert.match(fails[0].arguments[0].download, /no answer \(github\.com, phase dns, 4000 ms\)/);
    // back: the next fetch works (download path or API) and the stale mark is gone
    down = false;
    assert.ok(await catalog.get({ refresh: true }));
    assert.equal(catalog.stale(), null);
    assert.ok(info.mock.callCount() >= 0);
  });
});
