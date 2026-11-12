'use strict';

// "Fremden DNS und DoT sperren" against the REAL netfilter of this machine's
// kernel — in three network namespaces of its own, so no rule of the machine
// is touched:
//
//   devices (10.8.0.12 filtered, 10.8.0.31 own DNS, 192.168.50.7 behind a gateway)
//        │ veth, on the server side named like the WireGuard interface
//   server  10.8.0.1 — its DNS on port 53, forwards and masquerades
//        │ veth
//   internet 203.0.113.8 — a foreign DNS server (53) and a DoT server (853)
//
// The rules are set by src/services/vpnDnsFirewall.js itself (run inside the
// server namespace), next to rules as wg-quick sets them. Needs root, `ip`
// and `iptables`; skipped otherwise — unless GC_TEST_NETFILTER=required (CI),
// then a missing piece fails the test.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const REQUIRED = process.env.GC_TEST_NETFILTER === 'required';
const TAG = `gcfw${process.pid % 100000}`;
const NS = { srv: `${TAG}s`, dev: `${TAG}d`, net: `${TAG}n` };
const WG = 'wg0';
const SERVER = '10.8.0.1';
const FOREIGN = '203.0.113.8';
const FW = path.join(__dirname, '..', 'src', 'services', 'vpnDnsFirewall.js');
const CLEAR = path.join(__dirname, '..', 'scripts', 'vpndns-firewall-clear.sh');

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, ...opts });
}
function has(cmd) { try { sh('sh', ['-c', `command -v ${cmd}`]); return true; } catch { return false; } }

function missing() {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) return 'not root';
  for (const c of ['ip', 'iptables', 'iptables-restore']) if (!has(c)) return `no ${c}`;
  try {
    sh('ip', ['netns', 'add', `${TAG}probe`]);
    try { sh('ip', ['netns', 'exec', `${TAG}probe`, 'iptables', '-w', '5', '-t', 'nat', '-S']); } finally { sh('ip', ['netns', 'del', `${TAG}probe`]); }
  } catch (e) { return `network namespaces or netfilter not usable (${String(e.stderr || e.message).trim().split('\n')[0].slice(0, 120)})`; }
  return null;
}

const why = missing();
if (why && REQUIRED) throw new Error(`GC_TEST_NETFILTER=required, but: ${why}`);

const inNs = (ns, cmd, args, opts) => sh('ip', ['netns', 'exec', ns, cmd, ...args], opts);
const ip = (...args) => sh('ip', args);

// One small program for both ends: answers on UDP/TCP ports with a name of its own, or asks and prints what it got.
const HELPER = `
const net = require('node:net'); const dgram = require('node:dgram');
const [mode, ...a] = process.argv.slice(2);
if (mode === 'serve') {
  const [name, bind, ...ports] = a; let n = 0; const up = () => { if (++n === ports.length * 2) console.log('ready'); };
  for (const p of ports) {
    const u = dgram.createSocket('udp4'); u.on('message', (m, r) => u.send(name + ':' + p, r.port, r.address)); u.bind(Number(p), bind, up);
    net.createServer((c) => { c.on('error', () => {}); c.end(name + ':' + p); }).listen(Number(p), bind, up);
  }
} else if (mode === 'udp') {
  const [src, dst, port] = a; const u = dgram.createSocket('udp4');
  const t = setTimeout(() => { console.log('timeout'); process.exit(0); }, 1500);
  u.on('error', (e) => { clearTimeout(t); console.log('error:' + e.code); process.exit(0); });
  u.on('message', (m, r) => { clearTimeout(t); console.log(m.toString() + ' from ' + r.address); process.exit(0); });
  u.bind(0, src, () => u.connect(Number(port), dst, () => u.send('q')));
} else {
  const [src, dst, port] = a; const c = net.connect({ host: dst, port: Number(port), localAddress: src });
  const t0 = Date.now(); let buf = '';
  c.setTimeout(1500, () => { console.log('timeout'); process.exit(0); });
  c.on('data', (d) => { buf += d; });
  c.on('end', () => { console.log(buf); process.exit(0); });
  c.on('error', (e) => { console.log('error:' + e.code + ' after ' + (Date.now() - t0 < 500 ? 'fast' : 'slow')); process.exit(0); });
}`;

describe('foreign DNS and DoT blocked — real netfilter', { skip: why ? `needs root, ip and iptables with network namespaces: ${why}` : false }, () => {
  let dir; let helper; const servers = [];

  const ask = (proto, src, dst, port) => inNs(NS.dev, process.execPath, [helper, proto, src, dst, String(port)]).trim();
  /** Run the firewall module inside the server namespace: sync(want) → its status. */
  const fwSync = (want, opts = {}) => JSON.parse(inNs(NS.srv, process.execPath, ['-e', `
    const fw = require(${JSON.stringify(FW)});
    fw.sync(${JSON.stringify(want)}, { dir: ${JSON.stringify(dir)}, iface: ${JSON.stringify(WG)}, ...${JSON.stringify(opts)} }).then(() => { console.log(JSON.stringify(fw.status())); });
  `], { env: { ...process.env, NODE_ENV: 'test' } }).trim().split('\n').pop());
  const rules = (table) => inNs(NS.srv, 'iptables', ['-w', '5', '-t', table, '-S']);
  const serve = (ns, name, bind, ports) => new Promise((resolve, reject) => {
    const c = spawn('ip', ['netns', 'exec', ns, process.execPath, helper, 'serve', name, bind, ...ports.map(String)], { stdio: ['ignore', 'pipe', 'inherit'] });
    servers.push(c);
    c.stdout.once('data', () => resolve());
    c.once('exit', (code) => reject(new Error(`${name} server exited ${code}`)));
  });

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-fwlive-'));
    helper = path.join(dir, 'helper.js');
    fs.writeFileSync(helper, HELPER);
    for (const ns of Object.values(NS)) ip('netns', 'add', ns);
    ip('link', 'add', WG, 'netns', NS.srv, 'type', 'veth', 'peer', 'name', 'eth0', 'netns', NS.dev);
    ip('link', 'add', 'ens0', 'netns', NS.srv, 'type', 'veth', 'peer', 'name', 'eth0', 'netns', NS.net);
    for (const ns of Object.values(NS)) ip('-n', ns, 'link', 'set', 'lo', 'up');
    ip('-n', NS.srv, 'addr', 'add', `${SERVER}/24`, 'dev', WG);
    ip('-n', NS.srv, 'addr', 'add', '203.0.113.1/24', 'dev', 'ens0');
    ip('-n', NS.srv, 'link', 'set', WG, 'up');
    ip('-n', NS.srv, 'link', 'set', 'ens0', 'up');
    // the network behind a gateway: reached through the tunnel like on a real server
    ip('-n', NS.srv, 'route', 'add', '192.168.50.0/24', 'dev', WG);
    for (const a of ['10.8.0.12/24', '10.8.0.31/24', '192.168.50.7/32']) ip('-n', NS.dev, 'addr', 'add', a, 'dev', 'eth0');
    ip('-n', NS.dev, 'link', 'set', 'eth0', 'up');
    ip('-n', NS.dev, 'route', 'add', 'default', 'via', SERVER);
    ip('-n', NS.net, 'addr', 'add', `${FOREIGN}/24`, 'dev', 'eth0');
    ip('-n', NS.net, 'link', 'set', 'eth0', 'up');
    inNs(NS.srv, 'sysctl', ['-qw', 'net.ipv4.ip_forward=1']);
    // what entrypoint.sh and wg-quick's PostUp set on a real server
    inNs(NS.srv, 'iptables', ['-w', '5', '-I', 'FORWARD', '1', '-i', WG, '-j', 'ACCEPT']);
    inNs(NS.srv, 'iptables', ['-w', '5', '-I', 'FORWARD', '2', '-i', 'ens0', '-o', WG, '-m', 'state', '--state', 'RELATED,ESTABLISHED', '-j', 'ACCEPT']);
    inNs(NS.srv, 'iptables', ['-w', '5', '-P', 'FORWARD', 'DROP']);
    inNs(NS.srv, 'iptables', ['-w', '5', '-t', 'nat', '-A', 'POSTROUTING', '-s', '10.8.0.0/24', '-o', 'ens0', '-j', 'MASQUERADE']);
    inNs(NS.srv, 'iptables', ['-w', '5', '-t', 'nat', '-A', 'POSTROUTING', '-s', '192.168.50.0/24', '-o', 'ens0', '-j', 'MASQUERADE']);
    await serve(NS.srv, 'server-dns', SERVER, [53]);
    await serve(NS.net, 'foreign', FOREIGN, [53, 853, 443]);
  });

  after(() => {
    for (const c of servers) { c.removeAllListeners('exit'); c.kill('SIGKILL'); }
    for (const ns of Object.values(NS)) { try { ip('netns', 'del', ns); } catch { /* never made */ } }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('before: every device reaches the foreign DNS server and DoT', () => {
    assert.equal(ask('udp', '10.8.0.12', FOREIGN, 53), `foreign:53 from ${FOREIGN}`);
    assert.equal(ask('tcp', '10.8.0.12', FOREIGN, 853), 'foreign:853');
    assert.equal(ask('udp', '10.8.0.12', SERVER, 53), `server-dns:53 from ${SERVER}`);
  });

  it('switched on for one device: its port 53 ends at the server’s DNS, its port 853 is refused at once', () => {
    const st = fwSync({ iface: WG, serverIp: SERVER, peers: ['10.8.0.12'] });
    assert.deepEqual([st.active, st.devices, st.error], [true, 1, null]);
    // the device asked 203.0.113.8 and believes it was answered from there — the answer is the server's
    assert.equal(ask('udp', '10.8.0.12', FOREIGN, 53), `server-dns:53 from ${FOREIGN}`);
    assert.equal(ask('tcp', '10.8.0.12', FOREIGN, 53), 'server-dns:53');
    assert.equal(ask('tcp', '10.8.0.12', FOREIGN, 853), 'error:ECONNREFUSED after fast', 'refused, not left hanging');
    assert.equal(ask('udp', '10.8.0.12', FOREIGN, 853), 'error:ECONNREFUSED', 'DNS over QUIC: port unreachable');
    // the server's own DNS and everything else go on as before
    assert.equal(ask('udp', '10.8.0.12', SERVER, 53), `server-dns:53 from ${SERVER}`);
    assert.equal(ask('tcp', '10.8.0.12', FOREIGN, 443), 'foreign:443');
  });

  it('a device with its own DNS and a network behind a gateway are not touched', () => {
    assert.equal(ask('udp', '10.8.0.31', FOREIGN, 53), `foreign:53 from ${FOREIGN}`);
    assert.equal(ask('tcp', '10.8.0.31', FOREIGN, 853), 'foreign:853');
    assert.equal(ask('udp', '192.168.50.7', FOREIGN, 53), `foreign:53 from ${FOREIGN}`);
    assert.equal(ask('tcp', '192.168.50.7', FOREIGN, 853), 'foreign:853');
  });

  it('the server’s own traffic is never rewritten', () => {
    const out = inNs(NS.srv, process.execPath, [helper, 'udp', '203.0.113.1', FOREIGN, '53']).trim();
    assert.equal(out, `foreign:53 from ${FOREIGN}`);
    assert.equal(inNs(NS.srv, process.execPath, [helper, 'tcp', '203.0.113.1', FOREIGN, '853']).trim(), 'foreign:853');
  });

  it('another set of devices replaces the rules in one go — no rule twice, no jump twice', () => {
    fwSync({ iface: WG, serverIp: SERVER, peers: ['10.8.0.31'] });
    assert.equal(ask('udp', '10.8.0.31', FOREIGN, 53), `server-dns:53 from ${FOREIGN}`);
    assert.equal(ask('tcp', '10.8.0.12', FOREIGN, 853), 'foreign:853', 'no longer in the set');
    fwSync({ iface: WG, serverIp: SERVER, peers: ['10.8.0.12'] });
    fwSync({ iface: WG, serverIp: SERVER, peers: ['10.8.0.12'] });
    const nat = rules('nat');
    const filter = rules('filter');
    assert.equal(nat.split('\n').filter((l) => l.startsWith('-A GC_VPNDNS_NAT')).length, 3);
    assert.equal(filter.split('\n').filter((l) => l.startsWith('-A GC_VPNDNS_FWD')).length, 2);
    assert.equal(nat.split('\n').filter((l) => l.includes('-j GC_VPNDNS_NAT')).length, 2);
    assert.equal(filter.split('\n').filter((l) => l.includes('-j GC_VPNDNS_FWD')).length, 2);
    // the kernel prints the rules exactly as the module writes them — that is what the position check compares
    const fw = require(FW);
    const p = fw.plan({ iface: WG, serverIp: SERVER, peers: ['10.8.0.12'] });
    for (const line of p.restore.split('\n').filter((l) => l.startsWith('-A '))) assert.ok((nat + filter).split('\n').includes(line), line);
    for (const h of p.hooks) assert.ok((nat + filter).split('\n').includes(`-A ${h.chain} ${h.rule.join(' ')}`), h.rule.join(' '));
  });

  it('WireGuard restarted (its ACCEPT is first again): DoT slips through until the check puts the jump back', () => {
    inNs(NS.srv, 'iptables', ['-w', '5', '-D', 'FORWARD', '-i', WG, '-j', 'ACCEPT']);
    inNs(NS.srv, 'iptables', ['-w', '5', '-I', 'FORWARD', '1', '-i', WG, '-j', 'ACCEPT']);
    assert.equal(ask('tcp', '10.8.0.12', FOREIGN, 853), 'foreign:853');
    // a new server process (as after a restart) with the same devices: applies and checks
    fwSync({ iface: WG, serverIp: SERVER, peers: ['10.8.0.12'] }, { check: true });
    assert.equal(ask('tcp', '10.8.0.12', FOREIGN, 853), 'error:ECONNREFUSED after fast');
    assert.match(rules('filter').split('\n').filter((l) => l.startsWith('-A FORWARD'))[0], /GC_VPNDNS_FWD/);
  });

  it('switched off: everything is as before, and of the rules nothing is left', () => {
    const before = { nat: rules('nat'), filter: rules('filter') };
    const st = fwSync(null);
    assert.deepEqual([st.active, st.devices, st.error], [false, 0, null]);
    assert.equal(ask('udp', '10.8.0.12', FOREIGN, 53), `foreign:53 from ${FOREIGN}`);
    assert.equal(ask('tcp', '10.8.0.12', FOREIGN, 853), 'foreign:853');
    const left = rules('nat') + rules('filter');
    assert.doesNotMatch(left, /GC_VPNDNS/);
    // exactly the rules that were there before the option was switched on
    const strip = (s) => s.split('\n').filter((l) => !l.includes('GC_VPNDNS')).join('\n');
    assert.equal(rules('nat'), strip(before.nat));
    assert.equal(rules('filter'), strip(before.filter));
  });

  it('the clear script of container start and stop takes the rules away as well', () => {
    fwSync({ iface: WG, serverIp: SERVER, peers: ['10.8.0.12', '10.8.0.31'] });
    assert.match(rules('nat') + rules('filter'), /GC_VPNDNS/);
    inNs(NS.srv, 'sh', [CLEAR], { env: { ...process.env, GC_WG_INTERFACE: WG } });
    assert.doesNotMatch(rules('nat') + rules('filter'), /GC_VPNDNS/);
    assert.equal(ask('tcp', '10.8.0.12', FOREIGN, 853), 'foreign:853');
    inNs(NS.srv, 'sh', [CLEAR], { env: { ...process.env, GC_WG_INTERFACE: WG } }); // nothing there: no error
  });
});
