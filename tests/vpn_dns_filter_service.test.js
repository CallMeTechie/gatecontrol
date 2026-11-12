'use strict';

// The filter service of the DNS protection (src/services/vpnDnsFilter/service.js)
// on its own: what a damaged config does, fail-open, the TC rule, the limits —
// and, as its own process with lists of the size of the default lists, what it
// costs (memory, time to load) and that the server's event loop does not
// notice a list being loaded.

require('./helpers/test-env');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const CORE = path.join(__dirname, '..', 'src', 'services', 'vpnDnsFilter', 'dnsfilter-core');
const { wire } = require(CORE);
const { FilterService, sanitize, plainTarget, running, MAX_LOG_QUEUE } = require('../src/services/vpnDnsFilter/service');

const UP_IP = '93.184.216.34';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startUpstream(port) {
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, r) => {
    const q = wire.parseQuery(msg);
    udp.send(wire.buildResponse(q, { answers: q.qtype === wire.TYPE.A ? [{ name: q.name, type: wire.TYPE.A, ttl: 30, rdata: Buffer.from(UP_IP.split('.').map(Number)) }] : [] }), r.port, r.address);
  });
  await new Promise((r) => udp.bind(port, '127.0.0.1', r));
  return { close: () => udp.close() };
}

function query(name, ip, qtype = wire.TYPE.A) {
  return wire.buildQuery({ id: 7, name, qtype, edns: { do: false, ...(ip ? { ecs: { address: ip, sourcePrefix: 32 } } : {}) } });
}

function read(buf) {
  const flags = buf.readUInt16BE(2);
  const meta = wire.parseResponse(buf);
  return { rcode: flags & 0xf, tc: !!(flags & 0x0200), a: meta ? meta.answers.filter((x) => x.type === wire.TYPE.A).map((x) => [...x.rdata].join('.')) : [] };
}

function baseConfig(ports, extra = {}) {
  return {
    v: 1, rev: 1, enabled: true, port: ports.filter, logQueries: false, upstream: { provider: 'system' }, plain: [`127.0.0.1#${ports.up}`],
    internal: [],
    policy: {
      alwaysAllow: [], lists: {}, categories: { social: ['tiktok.com'] },
      profiles: [
        { id: 'default', lists: [], allow: [], deny: ['ads.example'], safeSearch: false, clients: ['peer:1'], schedules: [] },
        { id: 'kids', lists: [], allow: [], deny: ['ads.example', 'games.example'], safeSearch: false, clients: ['peer:2'],
          schedules: [{ days: [1, 2, 3, 4, 5, 6, 7], from: 0, to: 1440, block: 'categories', categories: ['social'], allowAlways: [] }] },
        { id: 'empty', lists: [], allow: [], deny: ['nobody.example'], safeSearch: true, clients: [], schedules: [] },
      ],
    },
    clients: { '10.8.0.11': 'peer:1', '10.8.0.12': 'peer:2' },
    suspended: { all: null, keys: {} },
    ...extra,
  };
}

function writeConfig(dir, cfg) {
  const tmp = path.join(dir, 'config.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(cfg));
  fs.renameSync(tmp, path.join(dir, 'config.json'));
}

describe('the mirrored engine', () => {
  it('is self-contained: only node: modules and its own files', () => {
    const files = fs.readdirSync(CORE).filter((f) => f.endsWith('.js'));
    assert.ok(files.length >= 13);
    for (const f of files) {
      const src = fs.readFileSync(path.join(CORE, f), 'utf8');
      for (const m of src.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
        assert.ok(m[2].startsWith('node:') || (m[2].startsWith('./') && fs.existsSync(path.join(CORE, m[2] + '.js'))), `${f}: require('${m[2]}')`);
      }
    }
    assert.match(fs.readFileSync(path.join(CORE, '..', 'VENDORED.md'), 'utf8'), /^- tag: v\d+\.\d+\.\d+$/m);
  });
});

describe('config', () => {
  it('sanitize: whatever the file holds, the engine gets arrays and objects', () => {
    for (const raw of [null, 'x', [], { policy: 'no' }, { policy: { profiles: [null, { id: '' }, { id: 7 }] }, clients: [], suspended: 5 }]) {
      const c = sanitize(raw);
      assert.equal(c.enabled, false);
      assert.deepEqual(c.policy.profiles, []);
      assert.equal(c.clients.size, 0);
      assert.equal(c.port, 5354);
      assert.deepEqual(c.suspended, { all: null, keys: new Map() });
    }
    const c = sanitize({ enabled: true, port: 53, policy: { profiles: [{ id: 'a', lists: 'ads', clients: ['peer:1', 5], schedules: [{ days: [1, 9], from: 60, to: 120 }, { days: [1] }] }] },
      clients: { '10.8.0.5': 'peer:1', 'not-an-ip': 'peer:2', '10.8.0.6': '' }, suspended: { all: 0, keys: { 'peer:1': -5, 'peer:2': 99 } }, plain: ['1.1.1.1', 'bad', '9.9.9.9#5300'] });
    assert.equal(c.port, 5354, 'never port 53 — that is dnsmasq');
    assert.deepEqual(c.policy.profiles[0], { id: 'a', lists: [], allow: [], deny: [], safeSearch: false, clients: ['peer:1'],
      schedules: [{ days: [1], from: 60, to: 120, block: 'categories', categories: [], allowAlways: [] }] });
    assert.deepEqual([...c.clients], [['10.8.0.5', 'peer:1']]);
    assert.deepEqual([c.suspended.all, [...c.suspended.keys]], [0, [['peer:2', 99]]]);
    assert.deepEqual(c.plain, [{ ip: '1.1.1.1', port: 53 }, { ip: '9.9.9.9', port: 5300 }]);
    assert.equal(plainTarget('1.1.1.1#0'), null);
    assert.equal(plainTarget('example.com'), null);
  });

  it('running(): until a time, or 0 = until switched on again', () => {
    assert.equal(running(null, 100), false);
    assert.equal(running(undefined, 100), false);
    assert.equal(running(0, 100), true);
    assert.equal(running(101, 100), true);
    assert.equal(running(100, 100), false);
  });
});

describe('the service (in this process)', () => {
  let dir; let ports; let up; let svc;
  const ask = async (name, ip, { udp = true, qtype } = {}) => read(await svc.handle(query(name, ip, qtype), { ip: '127.0.0.1', udp }));

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-dnssvc-'));
    ports = { filter: await freePort(), up: await freePort() };
    up = await startUpstream(ports.up);
    writeConfig(dir, baseConfig(ports));
    svc = new FilterService({ stateDir: dir, watchMs: 50 });
    await svc.start();
  });
  after(() => { svc.stop(); up.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('listens on 127.0.0.1 only, UDP and TCP', async () => {
    const st = svc.status();
    assert.deepEqual([st.listen.state, st.listen.listen, st.listen.port], ['running', ['127.0.0.1'], ports.filter]);
    await new Promise((resolve, reject) => { const c = net.connect(ports.filter, '127.0.0.1', () => { c.destroy(); resolve(); }); c.on('error', reject); });
    assert.equal(fs.statSync(path.join(dir, 'control.sock')).mode & 0o077, 0, 'the control socket is the owner’s only');
  });

  it('the TC rule: truncated only when the answer depends on who asks', async () => {
    // blocked for the asker: the answer goes out as it is
    assert.deepEqual(await ask('ads.example', '10.8.0.11'), { rcode: 0, tc: false, a: ['0.0.0.0'] });
    // allowed for everybody who can ask: plain
    assert.deepEqual(await ask('fine.example', '10.8.0.11'), { rcode: 0, tc: false, a: [UP_IP] });
    // a profile without devices decides nothing
    assert.equal((await ask('nobody.example', '10.8.0.11')).tc, false);
    assert.equal((await ask('www.google.com', '10.8.0.11')).tc, false);
    // allowed for the asker, blocked for the children (own entry / the time that runs now)
    assert.deepEqual(await ask('games.example', '10.8.0.11'), { rcode: 0, tc: true, a: [] });
    assert.deepEqual(await ask('www.tiktok.com', '10.8.0.11'), { rcode: 0, tc: true, a: [] });
    assert.deepEqual(await ask('games.example', '10.8.0.11', { udp: false }), { rcode: 0, tc: false, a: [UP_IP] });
    assert.deepEqual(await ask('games.example', '10.8.0.12'), { rcode: 0, tc: false, a: ['0.0.0.0'] });
    // the unfiltered (the server itself, an address nobody has) ask for a name that is blocked for somebody
    assert.equal((await ask('ads.example', null)).tc, true);
    assert.equal((await ask('ads.example', '10.8.0.99')).tc, true);
    assert.deepEqual(await ask('ads.example', null, { udp: false }), { rcode: 0, tc: false, a: [UP_IP] });
    // ECS from a sender that is not loopback is not believed
    assert.deepEqual(read(await svc.handle(query('ads.example', '10.8.0.11'), { ip: '192.0.2.9', udp: false })).a, [UP_IP]);
    assert.ok(svc.status().counters.tc >= 4);
  });

  it('the probe of the chain is answered without the upstream; the canary of Firefox is NXDOMAIN', async () => {
    const before = svc.status().counters.probes;
    assert.deepEqual(await ask('', null, { qtype: wire.TYPE.NS }), { rcode: 0, tc: false, a: [] });
    assert.equal(svc.status().counters.probes, before + 1);
    assert.equal((await ask('use-application-dns.net', '10.8.0.11')).rcode, 3);
  });

  it('settings change without a restart; a damaged file keeps the settings in force', async () => {
    const pid = svc.status().pid;
    writeConfig(dir, baseConfig(ports, { rev: 2, suspended: { all: 0, keys: {} } }));
    for (let i = 0; i < 40 && svc.status().rev !== 2; i++) await sleep(25);
    assert.equal(svc.status().rev, 2, 'the changed file was noticed');
    assert.deepEqual((await ask('ads.example', '10.8.0.11', { udp: false })).a, [UP_IP], 'suspended for everybody');
    const before = svc.status().totals.queries;
    await ask('ads.example', '10.8.0.11', { udp: false });
    assert.equal(svc.status().totals.queries, before, 'nothing is counted while it is suspended for everybody');

    fs.writeFileSync(path.join(dir, 'config.json'), '{ "enabled": tru');
    for (let i = 0; i < 40 && svc.status().counters.configErrors === 0; i++) await sleep(25);
    assert.equal(svc.status().counters.configErrors, 1);
    assert.equal(svc.status().rev, 2);
    assert.equal(svc.status().listen.state, 'running');

    writeConfig(dir, baseConfig(ports, { rev: 3 }));
    for (let i = 0; i < 40 && svc.status().rev !== 3; i++) await sleep(25);
    assert.deepEqual((await ask('ads.example', '10.8.0.11')).a, ['0.0.0.0']);
    assert.equal(svc.status().pid, pid);
  });

  it('fail-open: an error inside ends in "forwarded", never in silence', async () => {
    const real = svc.policy;
    svc.policy = { decide() { throw new Error('boom'); }, profiles: new Map() };
    try {
      assert.deepEqual(await ask('ads.example', '10.8.0.11'), { rcode: 0, tc: false, a: [UP_IP] });
      assert.equal(svc.status().counters.failOpen, 1);
    } finally { svc.policy = real; }
    // a profile the engine cannot build: nothing is filtered, everything resolves
    await svc.apply({ ...sanitize(baseConfig(ports, { rev: 4 })), policy: { alwaysAllow: [], lists: {}, categories: null, profiles: [{ id: 'x' }], defaultProfile: null, pauses: [], extensions: [] } });
    assert.deepEqual(await ask('ads.example', '10.8.0.11'), { rcode: 0, tc: false, a: [UP_IP] });
    await svc.apply(sanitize(baseConfig(ports, { rev: 5 })));
    assert.deepEqual((await ask('ads.example', '10.8.0.11')).a, ['0.0.0.0']);
    // the upstream is gone: SERVFAIL (the chain's probe still gets its answer)
    await svc.apply(sanitize(baseConfig(ports, { rev: 6, plain: ['127.0.0.1#1'] })));
    assert.equal((await ask('gone.example', '10.8.0.11')).rcode, 2);
    assert.equal((await ask('', null, { qtype: wire.TYPE.NS })).rcode, 0);
    await svc.apply(sanitize(baseConfig(ports, { rev: 7 })));
  });

  it('the query log is bounded and only kept while it is on', async () => {
    await ask('ads.example', '10.8.0.11');
    assert.deepEqual(svc.take().log, [], 'off: nothing per device');
    await svc.apply(sanitize(baseConfig(ports, { rev: 8, logQueries: true })));
    for (let i = 0; i < MAX_LOG_QUEUE + 25; i++) svc._note('peer:1', false, { name: `n${i}.example`, qtype: 1 }, { action: 'allow', reason: 'default', profileId: 'default' }, 1);
    assert.equal(svc.logQueue.length, MAX_LOG_QUEUE);
    const t = svc.take();
    assert.equal(t.log.length, MAX_LOG_QUEUE);
    assert.equal(t.logDropped, 25);
    assert.deepEqual(t.clients, { 'peer:1': { queries: MAX_LOG_QUEUE + 25, blocked: 0 } });
    assert.equal(svc.take().log.length, 0);
    await svc.apply(sanitize(baseConfig(ports, { rev: 9 })));
  });

  it('switched off in the config: the port is closed', async () => {
    await svc.apply(sanitize({ ...baseConfig(ports, { rev: 10 }), enabled: false }));
    assert.equal(svc.status().listen.state, 'off');
    await assert.rejects(new Promise((resolve, reject) => { const c = net.connect(ports.filter, '127.0.0.1', resolve); c.on('error', reject); }));
  });
});

describe('measured: the service as its own process with lists the size of the default lists', () => {
  let dir; let ports; let up; let child;
  after(() => { if (child) child.kill('SIGKILL'); if (up) up.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  function control(req) {
    return new Promise((resolve, reject) => {
      const c = net.connect(path.join(dir, 'control.sock'));
      let buf = '';
      c.setEncoding('utf8');
      c.on('connect', () => c.write(JSON.stringify(req) + '\n'));
      c.on('data', (d) => { buf += d; });
      c.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
      c.on('error', reject);
    });
  }

  function udp(name, ip) {
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket('udp4');
      const t0 = process.hrtime.bigint();
      const t = setTimeout(() => { s.close(); reject(new Error('timeout')); }, 3000);
      s.on('message', (m) => { clearTimeout(t); s.close(); resolve({ ...read(m), ms: Number(process.hrtime.bigint() - t0) / 1e6 }); });
      s.send(query(name, ip), ports.filter, '127.0.0.1');
    });
  }

  it('273 000 entries: memory, time to load, answers while loading — and the server’s event loop stays free', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-dnsmem-'));
    ports = { filter: await freePort(), up: await freePort() };
    up = await startUpstream(ports.up);
    // the last good version of two lists on disk, as after a download: ads 78 000, malware 195 000 entries
    const lists = { ads: { url: 'https://lists.invalid/ads.txt', format: 'adblock', n: 78000 }, malware: { url: 'https://lists.invalid/malware.txt', format: 'adblock', n: 195000 } };
    fs.mkdirSync(path.join(dir, 'dns-lists'));
    const meta = { v: 1, lists: {} };
    for (const [id, l] of Object.entries(lists)) {
      const lines = [];
      for (let i = 0; i < l.n; i++) lines.push(`||${id}-${i}.blocked-domain-${i % 977}.example^`);
      fs.writeFileSync(path.join(dir, 'dns-lists', `${id}.txt`), lines.join('\n') + '\n');
      meta.lists[id] = { url: l.url, format: l.format, etag: null, lastModified: null, sha256: null, entries: l.n, bytes: 1, updatedAt: Date.now(), checkedAt: Date.now(), nextAt: Date.now() + 86400000, error: null };
    }
    fs.writeFileSync(path.join(dir, 'dns-lists', 'meta.json'), JSON.stringify(meta));
    const cfg = baseConfig(ports);
    cfg.policy.lists = Object.fromEntries(Object.entries(lists).map(([id, l]) => [id, { url: l.url, format: l.format, sha256: null }]));
    cfg.policy.profiles[0].lists = ['ads', 'malware'];
    // start without the lists, then switch them on: the load happens while the service answers
    const first = JSON.parse(JSON.stringify(cfg));
    first.policy.profiles[0].lists = [];
    writeConfig(dir, first);

    child = spawn(process.execPath, ['--max-old-space-size=192', path.join(__dirname, '..', 'src', 'services', 'vpnDnsFilter', 'service.js')],
      { env: { ...process.env, GC_VPNDNS_DIR: dir }, stdio: 'ignore' });
    let st;
    for (let i = 0; i < 200; i++) {
      try { st = await control({ op: 'status' }); if (st.ready) break; } catch { /* not up yet */ }
      await sleep(50);
    }
    assert.equal(st && st.ready, true, 'the service came up');
    const idleRss = st.memory.rss;

    // what the server does meanwhile: ask the service for its status (services/vpnDns.js tick) — measured on THIS event loop
    const loop = monitorEventLoopDelay({ resolution: 5 });
    loop.enable();
    const t0 = Date.now();
    writeConfig(dir, { ...cfg, rev: 2 });
    const during = [];
    let loaded = null;
    while (Date.now() - t0 < 20000) {
      const [s, a] = await Promise.all([control({ op: 'status' }), udp('fine.example', '10.8.0.11')]);
      during.push(a.ms);
      if (s.listsEntries === 273000) { loaded = Date.now() - t0; st = s; break; }
      await sleep(5);
    }
    loop.disable();
    assert.ok(loaded !== null, 'both lists loaded');
    assert.deepEqual((await udp('ads-5.blocked-domain-5.example', '10.8.0.11')).a, ['0.0.0.0']);
    assert.deepEqual((await udp('sub.malware-77.blocked-domain-77.example', '10.8.0.11')).a, ['0.0.0.0'], 'adblock entries hold for subdomains');
    assert.deepEqual((await udp('fine.example', '10.8.0.11')).a, [UP_IP]);
    const after = await control({ op: 'status' });
    const mb = (n) => (n / 1048576).toFixed(1);
    const worst = Math.max(...during);
    console.log(`# dnsfilter with 273000 entries: lists ${mb(after.listsBytes)} MB, rss ${mb(after.memory.rss)} MB (idle without lists ${mb(idleRss)} MB), heap ${mb(after.memory.heapUsed)} MB; `
      + `loaded in ${loaded} ms; slowest answer while loading ${worst.toFixed(1)} ms (${during.length} asked); `
      + `event loop of the asking process (the server's part): max ${(loop.max / 1e6).toFixed(1)} ms, mean ${(loop.mean / 1e6).toFixed(2)} ms`);
    assert.equal(after.listsBytes, 273000 * 8);
    assert.ok(after.memory.rss < 200 * 1048576, `rss ${mb(after.memory.rss)} MB`);
    assert.ok(worst < 1000, `an answer took ${worst} ms while the lists were loading`);
    assert.ok(loop.max / 1e6 < 250, `the asking process was blocked for ${loop.max / 1e6} ms`);
  });
});
