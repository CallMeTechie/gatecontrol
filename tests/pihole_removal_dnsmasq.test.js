'use strict';

// After the update that removed the Pi-hole integration, behind a REAL
// dnsmasq: a dnsmasq.conf that still routes to Pi-hole — the managed block
// `gatecontrol-pihole` or the form older versions baked in at boot (no block)
// — is put on the default upstreams by the first refresh of the DNS chain
// (server.js at every start), or on the filter service when the DNS
// protection is on. A VPN device is never left without name resolution.
//
// The real modules: services/dnsChain.js (with dnsChainConf / dnsChainWatch).
// Stand-ins: the default upstream, "Pi-hole" and the filter service are small
// resolvers on 127.0.0.1, each answering with its own address.
//
// Needs dnsmasq. Without it the file is skipped — unless
// GC_TEST_DNSMASQ=required (CI).

require('./helpers/test-env');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
const { spawn, spawnSync } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-pihole-gone-'));
const confPath = path.join(dir, 'dnsmasq.conf');
// before services/dnsChain.js is loaded: it reads both when it first acts
process.env.GC_DNSMASQ_CONF = confPath;

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { wire } = require('../src/services/vpnDnsFilter/dnsfilter-core');

const DEFAULT_IP = '198.51.100.7';
const PIHOLE_IP = '198.51.100.53';
const FILTER_IP = '198.51.100.99';
const REQUIRED = process.env.GC_TEST_DNSMASQ === 'required';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/** A resolver that answers every A question with `ip` and notes what it was asked (name, client subnet). */
async function startResolver(port, ip) {
  const seen = [];
  const answer = (msg) => {
    const q = wire.parseQuery(msg);
    if (!q || !q.question) return null;
    seen.push({ name: q.name, ecs: q.edns && q.edns.ecs ? q.edns.ecs.address : null });
    const answers = q.qtype === wire.TYPE.A ? [{ name: q.name, type: wire.TYPE.A, ttl: 0, rdata: Buffer.from(ip.split('.').map(Number)) }] : [];
    return wire.buildResponse(q, { answers });
  };
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, r) => { const out = answer(msg); if (out) udp.send(out, r.port, r.address, () => {}); });
  const tcp = net.createServer((c) => {
    c.on('error', () => {});
    c.on('data', (d) => {
      const out = answer(d.subarray(2));
      if (!out) return;
      const l = Buffer.alloc(2);
      l.writeUInt16BE(out.length, 0);
      c.end(Buffer.concat([l, out]));
    });
  });
  await new Promise((r) => udp.bind(port, '127.0.0.1', r));
  await new Promise((r) => tcp.listen(port, '127.0.0.1', r));
  return { seen, close: () => new Promise((r) => { udp.close(() => tcp.close(() => r())); }) };
}

/** One A query to dnsmasq: the address it answered with, null for an error answer, 'timeout' for none. */
function askOnce(port, name, timeoutMs) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const id = Math.floor(Math.random() * 65536);
    const t = setTimeout(() => { s.close(); resolve('timeout'); }, timeoutMs);
    s.on('error', () => { clearTimeout(t); s.close(); resolve('timeout'); });
    s.on('message', (m) => {
      if (m.readUInt16BE(0) !== id) return;
      clearTimeout(t); s.close();
      const meta = wire.parseResponse(m);
      const a = meta ? meta.answers.filter((x) => x.type === wire.TYPE.A).map((x) => [...x.rdata].join('.')) : [];
      resolve((m.readUInt16BE(2) & 0xf) === 0 && a.length ? a[0] : null);
    });
    s.bind(0, '127.0.0.1', () => s.send(wire.buildQuery({ id, name, qtype: wire.TYPE.A, edns: { do: false } }), port, '127.0.0.1'));
  });
}

describe('Pi-hole integration removed: dnsmasq goes back to upstreams that answer (real dnsmasq)', () => {
  if (spawnSync('dnsmasq', ['--version']).status !== 0) {
    if (REQUIRED) it('has what it needs', () => assert.fail('GC_TEST_DNSMASQ=required but dnsmasq is not installed'));
    else it('skipped: needs dnsmasq', { skip: true }, () => {});
    return;
  }

  let ports; let def; let pihole; let filter; let dnsmasq; let dnsChain; let n = 0;
  let stopping = false;
  let restarts = 0;

  // as entrypoint.sh writes the conf — only port and interface differ; `upstreams` are the lines in question
  const conf = (upstreams) => [
    `port=${ports.dnsmasq}`, 'bind-interfaces', 'interface=lo', 'no-resolv', 'no-hosts', 'cache-size=1000',
    'local=/gc.internal/', 'domain=gc.internal', 'domain-needed', 'bogus-priv', 'host-record=gateway.gc.internal,10.8.0.1',
    ...upstreams, 'host-record=gc.example.com,10.8.0.1', '',
  ].join('\n');

  function startDnsmasq() {
    dnsmasq = spawn('dnsmasq', ['--keep-in-foreground', `--user=${os.userInfo().username}`, '--pid-file=', `--conf-file=${confPath}`], { stdio: 'ignore' });
    // supervised like in the image (scripts/wg-wrapper.sh): whoever ends dnsmasq, it comes back with the conf as it is now
    dnsmasq.on('exit', () => { dnsmasq = null; if (!stopping) startDnsmasq(); });
  }
  function restartDnsmasq() {
    restarts += 1;
    const old = dnsmasq;
    if (old) { old.removeAllListeners('exit'); old.kill('SIGKILL'); }
    startDnsmasq();
  }

  /** Like a device: asks again when nothing comes back (dnsmasq is just restarting). A fresh name every time: no cache. */
  async function ask({ tries = 20, timeoutMs = 400 } = {}) {
    const name = `q${++n}.example.org`;
    let last = 'timeout';
    for (let i = 0; i < tries; i++) {
      last = await askOnce(ports.dnsmasq, name, timeoutMs);
      if (last !== 'timeout' && last !== null) return last;
      await sleep(100);
    }
    return last;
  }
  const servers = () => fs.readFileSync(confPath, 'utf8').match(/^server=.*/gm);

  /** dnsmasq runs with exactly this conf, as it did under the version with the Pi-hole integration. */
  async function oldInstallation(upstreams) {
    fs.writeFileSync(confPath, conf(upstreams));
    restartDnsmasq();
    restarts = 0;
    await sleep(300);
  }

  before(async () => {
    fs.chmodSync(dir, 0o755);
    ports = { dnsmasq: await freePort(), def: await freePort(), pihole: await freePort(), dead: await freePort(), filter: await freePort() };
    process.env.GC_DNSMASQ_UPSTREAMS = `127.0.0.1#${ports.def}`;
    def = await startResolver(ports.def, DEFAULT_IP);
    pihole = await startResolver(ports.pihole, PIHOLE_IP);
    // the server restarts dnsmasq through services/dns.js — here: ours
    require('../src/services/dns').restartDnsmasq = restartDnsmasq;
    dnsChain = require('../src/services/dnsChain');
  });

  after(async () => {
    stopping = true;
    try { dnsChain.vpnFilter.disable(); dnsChain.stop(); } catch { /* not started */ }
    if (dnsmasq) dnsmasq.kill('SIGKILL');
    for (const r of [def, pihole, filter]) { if (r) await r.close(); }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the chain baked in at boot (no managed block), Pi-hole no longer reachable: names resolve again after the first refresh', async () => {
    await oldInstallation(['add-subnet=32,128', `server=127.0.0.1#${ports.dead}`]);
    assert.ok([null, 'timeout'].includes(await ask({ tries: 3 })), 'before: nothing resolves — the only upstream is dead');

    dnsChain.refresh(); // what server.js does at every start
    assert.equal(await ask(), DEFAULT_IP);
    assert.deepEqual(servers(), [`server=127.0.0.1#${ports.def}`]);
    const text = fs.readFileSync(confPath, 'utf8');
    assert.doesNotMatch(text, /add-subnet/, 'no client addresses to the public resolvers');
    assert.match(text, /^host-record=gc\.example\.com,10\.8\.0\.1$/m, 'the rest of the conf is kept');
    assert.equal(restarts, 1, 'one dnsmasq restart');
    assert.equal(def.seen[def.seen.length - 1].ecs, null);
    assert.equal(await askOnce(ports.dnsmasq, 'gateway.gc.internal', 1000), '10.8.0.1', 'internal names as before');

    dnsChain.refresh();
    await dnsChain.tick();
    assert.equal(restarts, 1, 'the next start finds the defaults: no further restart');
  });

  it('the managed block gatecontrol-pihole, Pi-hole still running: the devices no longer go through it', async () => {
    await oldInstallation(['# >>> gatecontrol-pihole >>>', 'add-subnet=32,128', `server=127.0.0.1#${ports.pihole}`, '# <<< gatecontrol-pihole <<<']);
    assert.equal(await ask(), PIHOLE_IP, 'before: through Pi-hole');

    dnsChain.refresh();
    assert.equal(await ask(), DEFAULT_IP);
    assert.doesNotMatch(fs.readFileSync(confPath, 'utf8'), /gatecontrol-pihole|add-subnet/);
    assert.deepEqual(servers(), [`server=127.0.0.1#${ports.def}`]);
    assert.equal(restarts, 1);
    const asked = pihole.seen.length;
    for (let i = 0; i < 5; i++) assert.equal(await ask(), DEFAULT_IP);
    assert.equal(pihole.seen.length, asked, 'Pi-hole is not asked any more');
  });

  it('with the DNS protection on: default upstreams first, the filter service once it answers — never a moment without resolution', async () => {
    await oldInstallation(['add-subnet=32,128', `server=127.0.0.1#${ports.dead}`]);
    // the filter service is not up yet when the server starts
    const states = [];
    dnsChain.vpnFilter.enable({ port: ports.filter, onChange: (s) => states.push(s) }); // vpnDns.start()
    dnsChain.refresh(); // server.js
    await dnsChain.tick();
    assert.equal(await ask(), DEFAULT_IP, 'the filter does not answer yet: default upstreams, not the dead Pi-hole');
    assert.deepEqual(servers(), [`server=127.0.0.1#${ports.def}`]);

    // devices keep asking while the filter service comes up and takes the chain
    const answers = [];
    let asking = true;
    const loop = (async () => { while (asking) { answers.push(await ask()); await sleep(20); } })();
    filter = await startResolver(ports.filter, FILTER_IP);
    for (let i = 0; i < 40 && dnsChain.vpnFilter.status().state !== 'vpnfilter'; i++) { await dnsChain.tick(); await sleep(50); }
    assert.equal(dnsChain.vpnFilter.status().state, 'vpnfilter');
    await sleep(400);
    asking = false;
    await loop;

    assert.equal(await ask(), FILTER_IP);
    assert.deepEqual(servers(), [`server=127.0.0.1#${ports.filter}`]);
    assert.match(fs.readFileSync(confPath, 'utf8'), /# >>> gatecontrol-vpnfilter >>>\nadd-subnet=32,128\n/);
    assert.equal(filter.seen[filter.seen.length - 1].ecs, '127.0.0.1', 'the filter learns who asks');
    assert.ok(answers.length > 3);
    assert.deepEqual(answers.filter((a) => a !== DEFAULT_IP && a !== FILTER_IP), [], 'every query of a device was answered, by the defaults or by the filter');

    // and the quick fallback of the filter is what it was: the service dies → defaults
    await filter.close();
    filter = null;
    for (let i = 0; i < 40 && dnsChain.vpnFilter.status().state !== 'fallback'; i++) { await dnsChain.tick(); await sleep(50); }
    assert.equal(dnsChain.vpnFilter.status().state, 'fallback');
    assert.equal(await ask(), DEFAULT_IP);
    assert.equal(states[states.length - 1], 'fallback');
    dnsChain.vpnFilter.disable();
  });

  it('entrypoint.sh no longer reads Pi-hole settings: the conf of a fresh start holds GC_DNSMASQ_UPSTREAMS only', () => {
    const sh = fs.readFileSync(path.join(__dirname, '..', 'entrypoint.sh'), 'utf8');
    assert.doesNotMatch(sh, /pihole_config|PIHOLE_UPSTREAMS|add-subnet/);
    assert.match(sh, /echo "\$GC_DNSMASQ_UPSTREAMS" \| tr ',' '\\n' \| while IFS= read -r upstream; do/);
  });
});
