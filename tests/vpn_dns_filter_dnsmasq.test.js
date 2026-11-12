'use strict';

// The filter service of the DNS protection behind a REAL dnsmasq:
//
//   device (198.18.53.2 / .3) → dnsmasq (add-subnet=32,128) → filter service
//                                (its own process) → mock upstream
//
// with the conf writer and the watch of the DNS chain (dnsChainConf.js,
// dnsChainWatch.js — the cadence of the provider 'vpnfilter'). Only the two
// upstream resolvers are stand-ins.
//
// Needs dnsmasq and two extra local addresses (a device must not be a
// loopback address: those are "the server itself" and never filtered):
//   sudo ip addr add 198.18.53.2/32 dev lo && sudo ip addr add 198.18.53.3/32 dev lo
// Without them the file is skipped — unless GC_TEST_DNSMASQ=required (CI).

require('./helpers/test-env');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
const { spawn, spawnSync } = require('node:child_process');

const { wire } = require('../src/services/vpnDnsFilter/dnsfilter-core');
const { makeChain } = require('../src/services/dnsChainConf');
const { createChainWatch } = require('../src/services/dnsChainWatch');

const DEV_A = '198.18.53.2'; // profile "kids": blocked.test + SafeSearch
const DEV_B = '198.18.53.3'; // profile "default": nothing blocked
const UP_IP = '93.184.216.34';
const DEFAULT_IP = '198.51.100.7';
const REQUIRED = process.env.GC_TEST_DNSMASQ === 'required';

function canBind(ip) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => { s.close(); resolve(false); });
    s.bind(0, ip, () => { s.close(); resolve(true); });
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A resolver that answers every A question with `ip` (after `delay()` ms) and notes what it was asked. */
async function startUpstream(port, ip, delay = () => 0) {
  const seen = [];
  const answer = (msg, transport) => {
    const q = wire.parseQuery(msg);
    if (!q || !q.question) return null;
    seen.push({ transport, name: q.name, type: q.qtype, ecs: q.edns && q.edns.ecs ? q.edns.ecs.address : null });
    const answers = q.qtype === wire.TYPE.A ? [{ name: q.name, type: wire.TYPE.A, ttl: 30, rdata: Buffer.from(ip.split('.').map(Number)) }] : [];
    return wire.buildResponse(q, { answers });
  };
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, r) => {
    const out = answer(msg, 'udp');
    if (out) setTimeout(() => udp.send(out, r.port, r.address, () => {}), delay());
  });
  const tcp = net.createServer((c) => {
    c.on('error', () => {});
    c.on('data', (d) => {
      const out = answer(d.subarray(2), 'tcp');
      if (!out) return;
      const l = Buffer.alloc(2);
      l.writeUInt16BE(out.length, 0);
      setTimeout(() => { if (!c.destroyed) c.end(Buffer.concat([l, out])); }, delay());
    });
  });
  await new Promise((r) => udp.bind(port, '127.0.0.1', r));
  await new Promise((r) => tcp.listen(port, '127.0.0.1', r));
  return { seen, close: () => { udp.close(); tcp.close(); } };
}

function parse(buf) {
  const flags = buf.readUInt16BE(2);
  const meta = wire.parseResponse(buf);
  return {
    rcode: flags & 0xf,
    tc: !!(flags & 0x0200),
    a: meta ? meta.answers.filter((x) => x.type === wire.TYPE.A).map((x) => [...x.rdata].join('.')) : [],
    cname: meta ? meta.answers.filter((x) => x.type === wire.TYPE.CNAME).map((x) => x.target) : [],
  };
}

function udpAsk(src, port, name, qtype, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const id = Math.floor(Math.random() * 65536);
    const t = setTimeout(() => { s.close(); reject(new Error('timeout')); }, timeoutMs);
    s.on('error', (e) => { clearTimeout(t); s.close(); reject(e); });
    s.on('message', (m) => { if (m.readUInt16BE(0) !== id) return; clearTimeout(t); s.close(); resolve(m); });
    s.bind(0, src, () => s.send(wire.buildQuery({ id, name, qtype, edns: { do: false } }), port, '127.0.0.1'));
  });
}

function tcpAsk(src, port, name, qtype, timeoutMs) {
  return new Promise((resolve, reject) => {
    const q = wire.buildQuery({ id: Math.floor(Math.random() * 65536), name, qtype, edns: { do: false } });
    const l = Buffer.alloc(2);
    l.writeUInt16BE(q.length, 0);
    const c = net.connect({ host: '127.0.0.1', port, localAddress: src });
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => { c.destroy(); reject(new Error('timeout')); }, timeoutMs);
    c.on('connect', () => c.write(Buffer.concat([l, q])));
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) { clearTimeout(t); c.destroy(); resolve(buf.subarray(2, 2 + buf.readUInt16BE(0))); }
    });
    c.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Like a device: UDP, and over TCP again when the answer comes back
 * truncated — and, like a device, asked again when nothing comes back
 * (`tries`): another test file of the suite restarts every dnsmasq of the
 * machine (`pkill dnsmasq`), ours is back at once.
 */
async function ask(src, port, name, { qtype = wire.TYPE.A, timeoutMs = 1500, tries = 4 } = {}) {
  for (let i = 1; ; i++) {
    try {
      const t0 = process.hrtime.bigint();
      let r = parse(await udpAsk(src, port, name, qtype, timeoutMs));
      let tcp = false;
      if (r.tc) { tcp = true; r = parse(await tcpAsk(src, port, name, qtype, timeoutMs)); }
      return { ...r, tcp, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
    } catch (err) {
      if (i >= tries) throw err;
      await sleep(150);
    }
  }
}

function controlCall(dir, req) {
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

function median(v) { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

describe('DNS protection: filter service behind a real dnsmasq', async () => {
  const hasDnsmasq = spawnSync('dnsmasq', ['--version']).status === 0;
  const hasAddrs = (await canBind(DEV_A)) && (await canBind(DEV_B));
  if (!hasDnsmasq || !hasAddrs) {
    if (REQUIRED) {
      it('has what it needs', () => assert.fail(`GC_TEST_DNSMASQ=required but ${hasDnsmasq ? `${DEV_A} / ${DEV_B} are not local addresses` : 'dnsmasq is not installed'}`));
    } else {
      it('skipped: needs dnsmasq and the local addresses 198.18.53.2 / 198.18.53.3', { skip: true }, () => {});
    }
    return;
  }

  let dir; let confPath; let ports; let up; let def; let filter; let dnsmasq; let chain; let watch;
  let upDelay = 0;
  let stopping = false;
  let viaFilter = null; // median of a query nobody has cached, through the filter
  const states = [];

  function writeConfig(extra = {}) {
    const cfg = {
      v: 1, rev: Date.now(), enabled: true, port: ports.filter, logQueries: true,
      upstream: { provider: 'system' }, plain: [`127.0.0.1#${ports.up}`],
      internal: ['app.example.com'],
      policy: {
        alwaysAllow: [], lists: {}, categories: { social: ['tiktok.com'] },
        profiles: [
          { id: 'kids', lists: [], allow: [], deny: ['blocked.test', 'app.example.com'], safeSearch: true, clients: ['peer:1'], schedules: [] },
          { id: 'default', lists: [], allow: [], deny: [], safeSearch: false, clients: ['peer:2'], schedules: [] },
        ],
      },
      clients: { [DEV_A]: 'peer:1', [DEV_B]: 'peer:2' },
      suspended: { all: null, keys: {} },
      ...extra,
    };
    const tmp = path.join(dir, 'config.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(cfg));
    fs.renameSync(tmp, path.join(dir, 'config.json'));
  }

  function startDnsmasq() {
    dnsmasq = spawn('dnsmasq', ['--keep-in-foreground', `--user=${os.userInfo().username}`, '--pid-file=', `--conf-file=${confPath}`], { stdio: 'ignore' });
    // supervised like in the image: whoever ends dnsmasq, it comes back with the conf as it is now
    dnsmasq.on('exit', () => { dnsmasq = null; if (!stopping) startDnsmasq(); });
  }

  // What scripts/wg-wrapper.sh does: dnsmasq only re-reads `server=` lines on a restart.
  function restartDnsmasq() {
    const old = dnsmasq;
    if (old) { old.removeAllListeners('exit'); old.kill('SIGKILL'); }
    startDnsmasq();
  }

  function startFilter() {
    filter = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'services', 'vpnDnsFilter', 'service.js')], {
      env: { ...process.env, GC_VPNDNS_DIR: dir }, stdio: 'ignore',
    });
  }

  async function until(fn, ms, what) {
    const end = Date.now() + ms;
    for (;;) {
      try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
      if (Date.now() > end) throw new Error(`timeout: ${what}`);
      await sleep(50);
    }
  }

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-dnsfilter-'));
    fs.chmodSync(dir, 0o755);
    ports = { dnsmasq: await freePort(), filter: await freePort(), up: await freePort(), def: await freePort() };
    up = await startUpstream(ports.up, UP_IP, () => upDelay);
    def = await startUpstream(ports.def, DEFAULT_IP);
    fs.writeFileSync(path.join(dir, 'peers.hosts'), '10.8.0.5\tlaptop.gc.internal\tlaptop\n10.8.0.1\tapp.example.com\n');
    confPath = path.join(dir, 'dnsmasq.conf');
    // as entrypoint.sh writes it — only port and interface differ
    fs.writeFileSync(confPath, [
      `port=${ports.dnsmasq}`, 'bind-interfaces', 'interface=lo', 'no-resolv', 'no-hosts', 'cache-size=1000',
      'local=/gc.internal/', 'domain=gc.internal', 'domain-needed', 'bogus-priv',
      `addn-hosts=${path.join(dir, 'peers.hosts')}`, 'host-record=gateway.gc.internal,10.8.0.1',
      `server=127.0.0.1#${ports.def}`, '',
    ].join('\n'));
    writeConfig();
    startFilter();
    startDnsmasq();
    await until(async () => (await controlCall(dir, { op: 'status' })).ready, 10000, 'filter service ready');

    chain = makeChain({ confPath, defaults: [`127.0.0.1#${ports.def}`], reload: restartDnsmasq });
    // the provider 'vpnfilter' of services/dnsChain.js, with its cadence
    const provider = {
      id: 'vpnfilter', label: 'filter service', ecs: true,
      targets: () => [{ id: 'vpnfilter', label: '', dns_ip: '127.0.0.1', dns_port: ports.filter }],
      intervalMs: 2000, retryMs: 500, timeoutMs: 1000,
      onChange: (state) => states.push({ state, at: Date.now() }),
    };
    watch = createChainWatch({ providers: () => [provider], chain });
    watch.start();
    await until(() => watch.status().state === 'active', 5000, 'chain active');
    await until(async () => (await ask(DEV_B, ports.dnsmasq, 'warmup.test')).a[0] === UP_IP, 5000, 'dnsmasq forwards to the filter');
  });

  after(() => {
    stopping = true;
    if (watch) watch.stop();
    if (dnsmasq) { dnsmasq.removeAllListeners('exit'); dnsmasq.kill('SIGKILL'); }
    if (filter) filter.kill('SIGKILL');
    if (up) up.close();
    if (def) def.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the chain made the filter the only upstream, with the client address', () => {
    const conf = fs.readFileSync(confPath, 'utf8');
    assert.match(conf, /# >>> gatecontrol-vpnfilter >>>\nadd-subnet=32,128\nserver=127\.0\.0\.1#\d+\n# <<< gatecontrol-vpnfilter <<</);
    assert.equal((conf.match(/^server=/gm) || []).length, 1);
  });

  it('two devices with different profiles get different answers', async () => {
    const a = await ask(DEV_A, ports.dnsmasq, 'blocked.test');
    const b = await ask(DEV_B, ports.dnsmasq, 'blocked.test');
    assert.deepEqual(a.a, ['0.0.0.0']);
    assert.deepEqual(b.a, [UP_IP]);
    assert.equal(a.tcp, false, 'a blocked answer goes out over UDP');
    assert.equal(b.tcp, true, 'the allowed answer depends on the asker: truncated, repeated over TCP');
  });

  it('a name everybody is treated alike for stays plain UDP', async () => {
    const a = await ask(DEV_A, ports.dnsmasq, 'same-for-all.test');
    const b = await ask(DEV_B, ports.dnsmasq, 'same-for-all.test');
    assert.deepEqual([a.a, b.a], [[UP_IP], [UP_IP]]);
    assert.deepEqual([a.tcp, b.tcp], [false, false]);
  });

  it('the upstream never sees the address of a device (ECS stays on loopback)', () => {
    assert.ok(up.seen.length > 0);
    assert.ok(up.seen.every((s) => s.ecs === null), 'ECS reached the upstream');
  });

  it('queries under way at the same time keep their own answers (A1b)', async () => {
    upDelay = 300; // the window dnsmasq 2.91 merges identical UDP queries in
    try {
      for (let round = 0; round < 3; round++) {
        const name = `race${round}.blocked.test`;
        // the allowed device first: without the TC rule its answer would go to both
        const pb = ask(DEV_B, ports.dnsmasq, name);
        await sleep(40);
        const pa = ask(DEV_A, ports.dnsmasq, name);
        const [a, b] = await Promise.all([pa, pb]);
        assert.deepEqual(a.a, ['0.0.0.0'], `round ${round}: the strict device got the allowed answer`);
        assert.deepEqual(b.a, [UP_IP], `round ${round}`);
      }
      // SafeSearch is an answer that depends on the asker as well
      const [a, b] = await Promise.all([ask(DEV_A, ports.dnsmasq, 'www.google.com'), ask(DEV_B, ports.dnsmasq, 'www.google.com')]);
      assert.deepEqual(a.cname, ['forcesafesearch.google.com']);
      assert.deepEqual(b.cname, []);
    } finally { upDelay = 0; }
  });

  it('internal names are untouched: dnsmasq answers them, the filter never blocks their other types', async () => {
    const before = up.seen.length;
    assert.deepEqual((await ask(DEV_A, ports.dnsmasq, 'laptop.gc.internal')).a, ['10.8.0.5']);
    assert.deepEqual((await ask(DEV_A, ports.dnsmasq, 'gateway.gc.internal')).a, ['10.8.0.1']);
    assert.equal((await ask(DEV_A, ports.dnsmasq, 'nope.gc.internal')).rcode, wire.RCODE.NXDOMAIN);
    // the route domain is on the kids' deny list — its A record comes from dnsmasq all the same
    assert.deepEqual((await ask(DEV_A, ports.dnsmasq, 'app.example.com')).a, ['10.8.0.1']);
    assert.equal(up.seen.length, before, 'an internal A question reached the upstream');
    // AAAA of the route domain does reach the filter (measured) — and is forwarded, not blocked
    const aaaa = await ask(DEV_A, ports.dnsmasq, 'app.example.com', { qtype: wire.TYPE.AAAA });
    assert.equal(aaaa.rcode, wire.RCODE.NOERROR);
    assert.ok(up.seen.slice(before).some((s) => s.name === 'app.example.com' && s.type === wire.TYPE.AAAA), 'AAAA of an internal name was not forwarded');
  });

  it('suspending a device takes effect without a restart, and ends by itself', async () => {
    const pid = (await controlCall(dir, { op: 'status' })).pid;
    writeConfig({ suspended: { all: null, keys: { 'peer:1': Date.now() + 1500 } } });
    await controlCall(dir, { op: 'reload' });
    assert.deepEqual((await ask(DEV_A, ports.dnsmasq, 'blocked.test')).a, [UP_IP]);
    await sleep(1600);
    assert.deepEqual((await ask(DEV_A, ports.dnsmasq, 'blocked.test')).a, ['0.0.0.0']);
    assert.equal((await controlCall(dir, { op: 'status' })).pid, pid);
  });

  it('counts, and with the query log on knows which device asked what', async () => {
    const t = await controlCall(dir, { op: 'take' });
    assert.ok(t.stats.queries > 0 && t.stats.blocked > 0);
    assert.ok(t.clients['peer:1'].blocked > 0);
    assert.equal(t.clients['peer:2'].blocked, 0);
    assert.ok(t.log.some((e) => e.key === 'peer:1' && e.name === 'blocked.test' && e.action === 'block' && e.reason === 'profile_deny'));
    assert.ok(t.log.some((e) => e.key === 'peer:1' && e.reason === 'suspended' && e.action === 'allow'));
  });

  it('measured: what the filter adds to a query', async () => {
    const N = 60;
    for (let i = 0; i < 5; i++) await ask(DEV_B, ports.dnsmasq, 'cached.test');
    const cached = [];
    for (let i = 0; i < N; i++) cached.push((await ask(DEV_B, ports.dnsmasq, 'cached.test')).ms);
    const blocked = [];
    for (let i = 0; i < N; i++) blocked.push((await ask(DEV_A, ports.dnsmasq, 'blocked.test')).ms);
    const fresh = [];
    for (let i = 0; i < N; i++) fresh.push((await ask(DEV_B, ports.dnsmasq, `fresh-${i}.test`)).ms);
    viaFilter = median(fresh);
    const st = await controlCall(dir, { op: 'status' });
    console.log(`# dnsfilter latency through dnsmasq (device → dnsmasq → filter): answer from the filter's cache median ${median(cached).toFixed(2)} ms, blocked answer median ${median(blocked).toFixed(2)} ms, `
      + `new name (→ upstream on loopback) median ${viaFilter.toFixed(2)} ms; filter rss ${(st.memory.rss / 1048576).toFixed(1)} MB`);
    assert.ok(median(cached) < 50 && median(blocked) < 50 && viaFilter < 50);
  });

  it('a dead filter: back on the default upstreams within about 5 seconds, and back again by itself', async () => {
    const t0 = Date.now();
    filter.kill('SIGKILL');
    // a device keeps asking new names (nothing cached anywhere)
    let n = 0;
    const got = await until(async () => {
      const r = await ask(DEV_A, ports.dnsmasq, `after-kill-${n++}.test`, { timeoutMs: 400, tries: 1 }).catch(() => null);
      return r && r.a[0] === DEFAULT_IP ? Date.now() : null;
    }, 8000, 'fallback to the default upstreams');
    const fallbackMs = got - t0;
    console.log(`# dnsfilter fallback after the filter died: ${fallbackMs} ms`);
    assert.ok(fallbackMs <= 5500, `fallback took ${fallbackMs} ms`);
    assert.equal(watch.status().state, 'fallback');
    assert.equal(states.at(-1).state, 'fallback');
    const conf = fs.readFileSync(confPath, 'utf8');
    assert.doesNotMatch(conf, /add-subnet|gatecontrol-vpnfilter/);
    // the default upstream must not learn the address of a device
    assert.ok(def.seen.every((s) => s.ecs === null));
    // the same question without the filter in between: what the extra hop costs
    const direct = [];
    for (let i = 0; i < 60; i++) direct.push((await ask(DEV_B, ports.dnsmasq, `direct-${i}.test`)).ms);
    console.log(`# dnsfilter extra latency per new name: ${(viaFilter - median(direct)).toFixed(2)} ms (through the filter ${viaFilter.toFixed(2)} ms, dnsmasq → upstream directly ${median(direct).toFixed(2)} ms)`);

    // the wrapper starts the service again; the chain takes it back after 3 good rounds
    startFilter();
    await until(() => watch.status().state === 'active', 12000, 'chain active again');
    assert.equal(states.at(-1).state, 'vpnfilter');
    await until(async () => (await ask(DEV_A, ports.dnsmasq, 'blocked.test')).a[0] === '0.0.0.0', 5000, 'filtering again');
  });
});
