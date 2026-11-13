'use strict';
// The DNS chain with more than one provider (services/dnsChain.js): exactly
// one owner of dnsmasq's upstreams, rank, takeover without a detour over the
// default upstreams, fallback to the defaults — never to another filter.
const crypto = require('crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dgram = require('node:dgram');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-dns-chain-'));
const confPath = path.join(confDir, 'dnsmasq.conf');
process.env.GC_DNSMASQ_CONF = confPath;
process.env.GC_DNSMASQ_UPSTREAMS = '1.1.1.1,8.8.8.8';
process.on('exit', () => { try { fs.rmSync(confDir, { recursive: true, force: true }); } catch { /* ignore */ } });

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createChainWatch, INTERVAL_MS, TIMEOUT_MS, DOWN_AFTER } = require('../src/services/dnsChainWatch');
const { makeChain } = require('../src/services/dnsChainConf');

const PH = { id: 'p1', label: 'Second filter', dns_ip: '10.8.0.2', dns_port: 5335 };
const VF = { id: 'vpnfilter', label: '', dns_ip: '127.0.0.1', dns_port: 5354 };

function harness() {
  const h = { want: { second: true, vpnfilter: false }, alive: { second: true, vpnfilter: true }, calls: [], events: [], changes: [] };
  const provider = (id, target) => ({
    id,
    targets: () => (h.want[id] ? [target] : []),
    probe: async () => h.alive[id],
    onChange: (state, status) => h.events.push([id, state, status.state]),
  });
  h.watch = createChainWatch({
    providers: () => [provider('vpnfilter', VF), provider('second', PH)],
    chain: { apply: (t, o) => h.calls.push(['apply', o.provider, t.join(',')]), revert: () => h.calls.push(['revert']) },
    onChange: (s) => h.changes.push([s.provider, s.state]),
    now: () => 1000,
  });
  h.ticks = async (n) => { for (let i = 0; i < n; i++) await h.watch.tick(); };
  return h;
}

test('one provider wants the chain: it owns it, the other one is simply off', async () => {
  const h = harness();
  await h.ticks(3);
  assert.deepEqual(h.calls, [['apply', 'second', '10.8.0.2#5335']]);
  assert.deepEqual(h.watch.status(), { provider: 'second', state: 'active', since: 1000, checkedAt: 1000,
    targets: [{ id: 'p1', label: 'Second filter', dns: '10.8.0.2#5335', ok: true }], displaced: [] });
  assert.equal(h.watch.statusFor('second').state, 'second');
  assert.deepEqual(h.watch.statusFor('vpnfilter'), { state: 'off', since: 1000, checkedAt: null, targets: [], displacedBy: 'second' });
});

test('takeover: the higher provider replaces the chain in one step, never via the default upstreams', async () => {
  const h = harness();
  await h.ticks(2);
  h.want.vpnfilter = true;
  await h.ticks(3);
  assert.deepEqual(h.calls, [['apply', 'second', '10.8.0.2#5335'], ['apply', 'vpnfilter', '127.0.0.1#5354']], 'no revert in between');
  assert.equal(h.watch.status().provider, 'vpnfilter');
  assert.equal(h.watch.status().state, 'active');
  assert.deepEqual(h.watch.status().displaced, ['second']);
  assert.equal(h.watch.statusFor('vpnfilter').state, 'vpnfilter');
  assert.equal(h.watch.statusFor('second').state, 'off');
  assert.equal(h.watch.statusFor('second').displacedBy, 'vpnfilter');
  assert.deepEqual(h.watch.statusFor('second').targets, []);
  assert.deepEqual(h.events, [], 'a takeover is neither an outage nor a recovery');
  assert.deepEqual(h.changes, [['second', 'active'], ['vpnfilter', 'active']]);
});

test('takeover by a provider that does not answer: default upstreams, the old chain is gone too', async () => {
  const h = harness();
  await h.ticks(1);
  h.want.vpnfilter = true;
  h.alive.vpnfilter = false;
  await h.ticks(1);
  assert.deepEqual(h.calls, [['apply', 'second', '10.8.0.2#5335'], ['revert']]);
  assert.equal(h.watch.status().provider, 'vpnfilter');
  assert.equal(h.watch.status().state, 'fallback');
  assert.deepEqual(h.events, [['vpnfilter', 'fallback', 'fallback']]);
});

test('active provider dies: fallback to the defaults — a displaced provider is not a second fallback', async () => {
  const h = harness();
  h.want.vpnfilter = true;
  await h.ticks(1);
  h.calls.length = 0;
  h.alive.vpnfilter = false;
  await h.ticks(1);
  assert.deepEqual(h.calls, [], 'one failed round is tolerated');
  await h.ticks(4);
  assert.deepEqual(h.calls, [['revert']], 'reverted once; the second one (alive and wanted) is never applied');
  assert.equal(h.watch.statusFor('vpnfilter').state, 'fallback');
  assert.equal(h.watch.statusFor('second').state, 'off');

  h.alive.vpnfilter = true;
  await h.ticks(2);
  assert.equal(h.watch.status().state, 'fallback', 'two good rounds are not enough');
  await h.ticks(1);
  assert.deepEqual(h.calls, [['revert'], ['apply', 'vpnfilter', '127.0.0.1#5354']]);
  assert.deepEqual(h.events, [['vpnfilter', 'fallback', 'fallback'], ['vpnfilter', 'vpnfilter', 'vpnfilter']]);
});

test('higher provider switched off: the displaced one gets the chain back, asked first', async () => {
  const h = harness();
  h.want.vpnfilter = true;
  await h.ticks(2);
  h.want.vpnfilter = false;
  await h.ticks(1);
  assert.deepEqual(h.calls.slice(1), [['apply', 'second', '10.8.0.2#5335']]);
  assert.equal(h.watch.statusFor('second').state, 'second');
  assert.deepEqual(h.watch.status().displaced, []);

  // … and when that one is dead at this moment, the defaults
  h.want.vpnfilter = true;
  await h.ticks(1);
  h.want.vpnfilter = false;
  h.alive.second = false;
  await h.ticks(1);
  assert.deepEqual(h.calls.at(-1), ['revert']);
  assert.equal(h.watch.statusFor('second').state, 'fallback');
  assert.deepEqual(h.events, [['second', 'fallback', 'fallback']]);
});

test('nobody wants the chain any more: defaults, state off', async () => {
  const h = harness();
  h.want.vpnfilter = true;
  await h.ticks(1);
  h.want.vpnfilter = false; h.want.second = false;
  await h.ticks(2);
  assert.deepEqual(h.calls.slice(1), [['revert']]);
  assert.deepEqual(h.watch.status(), { provider: null, state: 'off', since: 1000, checkedAt: 1000, targets: [], displaced: [] });
});

test('a provider keeps its own cadence and thresholds', async () => {
  const calls = [];
  let alive = true;
  const watch = createChainWatch({
    providers: () => [{ id: 'vpnfilter', targets: () => [VF], probe: async () => alive, downAfter: 1, upAfter: 1 }],
    chain: { apply: () => calls.push('apply'), revert: () => calls.push('revert') },
  });
  await watch.tick();
  alive = false; await watch.tick();
  alive = true; await watch.tick();
  assert.deepEqual(calls, ['apply', 'revert', 'apply']);
});

// ─── conf writer ─────────────────────────────────────────────────────────────
test('conf: the managed block names its provider; a new provider replaces the old block', () => {
  fs.writeFileSync(confPath, 'bind-dynamic\nserver=1.1.1.1\nserver=8.8.8.8\n');
  let reloads = 0;
  const chain = makeChain({ confPath, defaults: ['1.1.1.1', '8.8.8.8'], reload: () => { reloads++; } });
  chain.apply(['10.8.0.2#5335'], { provider: 'second', ecs: true });
  chain.apply(['127.0.0.1#5354'], { provider: 'vpnfilter', ecs: true });
  const c = fs.readFileSync(confPath, 'utf8');
  assert.equal(c, 'bind-dynamic\n# >>> gatecontrol-vpnfilter >>>\nadd-subnet=32,128\nserver=127.0.0.1#5354\n# <<< gatecontrol-vpnfilter <<<\n');
  assert.equal(reloads, 2);
  chain.apply(['127.0.0.1#5354'], { provider: 'vpnfilter', ecs: true });
  assert.equal(reloads, 2, 'idempotent');
  chain.revert();
  assert.equal(fs.readFileSync(confPath, 'utf8'), 'bind-dynamic\nserver=1.1.1.1\nserver=8.8.8.8\n');
  assert.equal(reloads, 3);
});

test('conf: a provider without ECS gets no add-subnet line; the provider name cannot smuggle lines in', () => {
  fs.writeFileSync(confPath, 'bind-dynamic\nadd-subnet=32,128\nserver=10.8.0.2\n');
  let reloads = 0;
  const chain = makeChain({ confPath, defaults: ['1.1.1.1'], reload: () => { reloads++; } });
  chain.apply(['10.8.0.2'], { provider: 'second', ecs: false });
  assert.doesNotMatch(fs.readFileSync(confPath, 'utf8'), /add-subnet/);
  assert.equal(reloads, 1, 'same server, but ECS has to go: rewritten');
  assert.throws(() => chain.apply(['10.8.0.2'], { provider: 'x >>>\nserver=6.6.6.6' }), /invalid provider/);
  assert.doesNotMatch(fs.readFileSync(confPath, 'utf8'), /6\.6\.6\.6/);
});

// ─── the one owner inside the server ────────────────────────────────────────
function listen(p) {
  const s = dgram.createSocket('udp4');
  s.on('message', (msg, rinfo) => {
    const hdr = Buffer.from(msg.subarray(0, 12));
    hdr[2] = 0x81; hdr[3] = 0x80;
    hdr.writeUInt16BE(1, 6); hdr.writeUInt16BE(0, 8); hdr.writeUInt16BE(0, 10);
    s.send(Buffer.concat([hdr, msg.subarray(12, 17), Buffer.from([0x00, 0, 2, 0, 1, 0, 0, 0, 60, 0, 3, 1, 0x61, 0])]), rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => s.bind(p, '127.0.0.1', () => resolve(s)));
}
const close = (s) => new Promise((resolve) => s.close(resolve));
const servers = () => fs.readFileSync(confPath, 'utf8').match(/^server=.*/gm);

test('owner: a left-over Pi-hole chain → defaults → filter service → filter dies → defaults → filter back → filter off', async () => {
  let restarts = 0;
  const dns = require('../src/services/dns');
  dns.restartDnsmasq = () => { restarts++; };
  const dnsChain = require('../src/services/dnsChain');
  let fSock = await listen(0);
  const fPort = fSock.address().port;
  const seen = [];
  const off = dnsChain.onChange((s) => seen.push(`${s.provider}:${s.state}`));
  const fEvents = [];
  try {
    // as a version with the Pi-hole integration left it: its chain baked in, no managed block
    fs.writeFileSync(confPath, 'bind-dynamic\nno-resolv\nadd-subnet=32,128\nserver=10.8.0.2#5335\n');
    dnsChain.refresh();
    await dnsChain.tick();
    assert.deepEqual(servers(), ['server=1.1.1.1', 'server=8.8.8.8'], 'nobody wants the chain: default upstreams');
    assert.doesNotMatch(fs.readFileSync(confPath, 'utf8'), /add-subnet/);
    assert.equal(dnsChain.status().provider, null);
    assert.equal(restarts, 1);

    // … and the managed block of the former provider
    fs.writeFileSync(confPath, 'bind-dynamic\n# >>> gatecontrol-pihole >>>\nadd-subnet=32,128\nserver=10.8.0.2#5335\n# <<< gatecontrol-pihole <<<\n');
    dnsChain.refresh();
    assert.deepEqual(servers(), ['server=1.1.1.1', 'server=8.8.8.8'], 'at once, before any probe round');
    await dnsChain.tick();
    assert.doesNotMatch(fs.readFileSync(confPath, 'utf8'), /add-subnet|gatecontrol-/);
    assert.equal(restarts, 2);
    dnsChain.refresh();
    await dnsChain.tick();
    assert.equal(restarts, 2, 'already on the defaults: no further restart');

    dnsChain.vpnFilter.enable({ port: fPort, onChange: (state) => fEvents.push(state) });
    await dnsChain.tick();
    assert.deepEqual(servers(), [`server=127.0.0.1#${fPort}`]);
    assert.match(fs.readFileSync(confPath, 'utf8'), /# >>> gatecontrol-vpnfilter >>>\nadd-subnet=32,128\n/);
    assert.equal(restarts, 3, 'one dnsmasq restart for the switch');
    assert.deepEqual(dnsChain.status().displaced, []);
    assert.equal(dnsChain.vpnFilter.status().state, 'vpnfilter');

    // a refresh while the filter owns the chain must not touch the conf
    dnsChain.refresh();
    await dnsChain.tick();
    assert.deepEqual(servers(), [`server=127.0.0.1#${fPort}`]);
    assert.equal(restarts, 3);

    await close(fSock);
    await dnsChain.tick(); await dnsChain.tick();
    assert.deepEqual(servers(), ['server=1.1.1.1', 'server=8.8.8.8'], 'defaults');
    assert.doesNotMatch(fs.readFileSync(confPath, 'utf8'), /add-subnet|gatecontrol-/);
    assert.equal(restarts, 4);
    assert.equal(dnsChain.vpnFilter.status().state, 'fallback');
    assert.deepEqual(fEvents, ['fallback']);

    fSock = await listen(fPort);
    await dnsChain.tick(); await dnsChain.tick(); await dnsChain.tick();
    assert.deepEqual(servers(), [`server=127.0.0.1#${fPort}`]);
    assert.equal(restarts, 5);
    assert.deepEqual(fEvents, ['fallback', 'vpnfilter']);

    dnsChain.vpnFilter.disable();
    await dnsChain.tick();
    assert.deepEqual(servers(), ['server=1.1.1.1', 'server=8.8.8.8']);
    assert.equal(restarts, 6);
    assert.deepEqual(dnsChain.status().provider, null);
    assert.deepEqual(seen, ['vpnfilter:active', 'vpnfilter:fallback', 'vpnfilter:active', 'null:off']);
  } finally {
    off();
    dnsChain.vpnFilter.disable();
    try { await close(fSock); } catch { /* already closed */ }
  }
});

test('owner: only known providers, sane filter port; the filter is noticed dead faster than the default cadence', () => {
  const dnsChain = require('../src/services/dnsChain');
  assert.deepEqual(dnsChain.RANK, ['vpnfilter']);
  assert.throws(() => dnsChain.register({ id: 'other', targets: () => [] }), /unknown provider/);
  assert.throws(() => dnsChain.register({ id: 'pihole', targets: () => [] }), /unknown provider/, 'the former provider is gone');
  assert.throws(() => dnsChain.register({ id: 'vpnfilter' }), /targets/);
  for (const port of [0, 53, 70000, '12a', null]) assert.throws(() => dnsChain.vpnFilter.enable({ port }), /invalid filter port/);
  assert.equal(dnsChain.vpnFilter.status().state, 'off');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'dnsChain.js'), 'utf8');
  const n = (name) => Number(src.match(new RegExp(`const ${name} = (\\d+);`))[1]);
  const filterWorst = n('VPNFILTER_INTERVAL_MS') + n('VPNFILTER_TIMEOUT_MS') + n('VPNFILTER_RETRY_MS') + n('VPNFILTER_TIMEOUT_MS');
  assert.ok(filterWorst <= 5000);
  assert.ok(filterWorst < INTERVAL_MS + TIMEOUT_MS + (DOWN_AFTER - 1) * (1000 + TIMEOUT_MS));
});

test('only one owner: nothing but dnsChain.js creates a chain writer or restarts dnsmasq for it', () => {
  const root = path.join(__dirname, '..', 'src');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (e.name.endsWith('.js')) files.push(path.join(dir, e.name));
    }
  })(root);
  const using = (re) => files.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f)).sort();
  assert.deepEqual(using(/\bmakeChain\(/), ['services/dnsChain.js', 'services/dnsChainConf.js']);
  // vpnNames.js restarts dnsmasq for its own block (the zone of the device
  // names: `local=` / `host-record=`), never for the upstreams.
  assert.deepEqual(using(/\brestartDnsmasq\(\)/), ['services/dns.js', 'services/dnsChain.js', 'services/vpnNames.js']);
  assert.deepEqual(using(/createChainWatch\(/), ['services/dnsChain.js', 'services/dnsChainWatch.js']);
  // the watcher runs five times a second, so a switch costs well under a second
  const wrapper = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'wg-wrapper.sh'), 'utf8');
  assert.match(wrapper, /while true; do\n {2}sleep 0\.2 &\n {2}wait \$!/);
});

test('status API: GET /api/v1/system/dns/status carries the chain', async () => {
  const { setup, teardown, getAgent } = require('./helpers/setup');
  const license = require('../src/services/license');
  await setup();
  try {
    license._overrideForTest({ internal_dns: true });
    const res = await getAgent().get('/api/v1/system/dns/status');
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body.chain).sort(), ['checkedAt', 'displaced', 'provider', 'since', 'state', 'targets']);
    assert.equal(res.body.chain.state, 'off');
    assert.equal(typeof res.body.domain, 'string', 'the rest of the status is unchanged');
  } finally {
    await teardown();
  }
});
