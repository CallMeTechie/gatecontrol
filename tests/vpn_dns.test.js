'use strict';

// DNS protection of the VPN devices (docs/plugins.md "DNS protection"):
// permissions.vpnDns, gc.vpnDns in a real plugin process, services/vpnDns.js
// with a real filter service (in this process, on its real control socket and
// DNS port) and the real DNS chain — only dnsmasq's restart and the upstream
// resolver are stand-ins. Behind a real dnsmasq: vpn_dns_filter_dnsmasq.test.js.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const dgram = require('node:dgram');
const supertest = require('supertest');

// before anything of the server loads: where the filter service lives and what it forwards to
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-vpndns-'));
process.env.GC_VPNDNS_DIR = STATE;

const { dnsPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');
const { fakeIptables } = require('./helpers/fakeIptables');
const { wire } = require('../src/services/vpnDnsFilter/dnsfilter-core');
const { FilterService } = require('../src/services/vpnDnsFilter/service');

const P = 'dns-demo';
const UP_IP = '93.184.216.34';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let app, agent, csrf, db, runtime, plugins, vpnDns, dnsChain, hostApi, personContext;
let adminId, anna, lea, boss, annaPhone, annaLaptop, leaPhone, bossPhone, guestTab, ownDnsPc, gateway, office, family;
let upstream, svc, restarts = 0, confPath, ipt, fw;

function freePort() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function installPkg(buf) {
  const r = await agent.post('/api/v1/plugins/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const res = await agent.post('/api/v1/plugins/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return r.body;
}

/** gc.vpnDns.<op>(...args) inside a changing request of the signed-in administrator. */
async function call(op, ...args) {
  const r = await agent.post(`/api/v1/plugins/${P}/api/call`).set('X-CSRF-Token', csrf).send({ op, args });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function ok(op, ...args) {
  const r = await call(op, ...args);
  assert.equal(r.ok, true, `${op}: ${JSON.stringify(r)}`);
  return r.result;
}

/** The host API as inside a changing request of `userId` to the plugin. */
function as(userId, api, args) {
  return personContext.run(P, userId, true, () => hostApi.handle(plugins.get(P), api, args));
}

/**
 * One round of the DNS chain that started after this call. dnsChain.tick()
 * alone hands out the round that is under way (the chain's own timer starts
 * one every 2 s) — and that one may have looked at the world before the test
 * changed it.
 */
async function freshRound() {
  await dnsChain.tick();
  return dnsChain.tick();
}

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(40);
  }
}

/** One query to the filter service the way dnsmasq sends it: from loopback, the device as ECS /32. */
function askFilter(name, ip, { tcp = false, qtype = wire.TYPE.A } = {}) {
  const q = wire.buildQuery({ id: 4711, name, qtype, edns: { do: false, ...(ip ? { ecs: { address: ip, sourcePrefix: 32 } } : {}) } });
  const read = (buf) => {
    const flags = buf.readUInt16BE(2);
    const meta = wire.parseResponse(buf);
    return { rcode: flags & 0xf, tc: !!(flags & 0x0200), a: meta ? meta.answers.filter((x) => x.type === wire.TYPE.A).map((x) => [...x.rdata].join('.')) : [] };
  };
  const port = vpnDns.filterPort();
  if (tcp) {
    return new Promise((resolve, reject) => {
      const c = net.connect({ host: '127.0.0.1', port });
      const l = Buffer.alloc(2);
      l.writeUInt16BE(q.length, 0);
      let buf = Buffer.alloc(0);
      c.on('connect', () => c.write(Buffer.concat([l, q])));
      c.on('data', (d) => { buf = Buffer.concat([buf, d]); if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) { c.destroy(); resolve(read(buf.subarray(2))); } });
      c.on('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const t = setTimeout(() => { s.close(); reject(new Error('timeout')); }, 2000);
    s.on('message', (m) => { clearTimeout(t); s.close(); resolve(read(m)); });
    s.send(q, port, '127.0.0.1');
  });
}

async function startUpstream(port) {
  const seen = [];
  const answer = (msg) => {
    const q = wire.parseQuery(msg);
    seen.push(q.name);
    return wire.buildResponse(q, { answers: q.qtype === wire.TYPE.A ? [{ name: q.name, type: wire.TYPE.A, ttl: 30, rdata: Buffer.from(UP_IP.split('.').map(Number)) }] : [] });
  };
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, r) => udp.send(answer(msg), r.port, r.address));
  await new Promise((r) => udp.bind(port, '127.0.0.1', r));
  return { seen, close: () => udp.close() };
}

// a list "server": the catalogue's lists, three entries each
function fakeFetch(url, dest) {
  const body = url.includes('light') ? '||ads.example^\n||doubleclick.net^\n' : (url.includes('tif') ? '||malware.example^\n' : '||adult.example^\n');
  fs.writeFileSync(dest, body);
  return Promise.resolve({ status: 200, bytes: body.length, sha256: 'x', etag: null, lastModified: null });
}

function startService() {
  svc = new FilterService({ stateDir: STATE, fetch: fakeFetch, watchMs: 100, onExit: () => { svc.exited = true; svc.stop(); } });
  return svc.start();
}

function peer(name, userId, { groupId = null, type = 'regular', dns = null, ip }) {
  return Number(db.prepare('INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type, user_id, group_id, dns) VALUES (?, ?, ?, 1, ?, ?, ?, ?)')
    .run(name, 'k-' + name, ip + '/32', type, userId, groupId, dns).lastInsertRowid);
}

before(async () => {
  process.env.GC_VPNDNS_PORT = String(await freePort());
  const upPort = await freePort();
  process.env.GC_DNSMASQ_UPSTREAMS = `127.0.0.1#${upPort}`;
  upstream = await startUpstream(upPort);
  ({ app, agent } = await setup());
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  vpnDns = require('../src/services/vpnDns');
  dnsChain = require('../src/services/dnsChain');
  hostApi = require('../src/services/plugins/hostApi');
  personContext = require('../src/services/plugins/personContext');
  // dnsmasq's restart is `pkill dnsmasq` — never in a test
  require('../src/services/dns').restartDnsmasq = () => { restarts++; };
  confPath = process.env.GC_DNSMASQ_CONF;
  fs.mkdirSync(path.dirname(confPath), { recursive: true });
  fs.writeFileSync(confPath, 'port=53\nno-resolv\nserver=127.0.0.1#' + upPort + '\n');
  fs.mkdirSync(path.dirname(process.env.GC_DNS_HOSTS_FILE), { recursive: true });
  fs.writeFileSync(process.env.GC_DNS_HOSTS_FILE, '# test\n10.8.0.5\tlaptop.gc.internal\tlaptop\n10.8.0.1\tapp.example.com\n');

  adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  anna = H.makeUser('Anna');
  lea = H.makeUser('Lea');
  boss = H.makeUser('Boss', { role: 'admin' });
  office = H.makeGroup('Buero');
  annaPhone = peer('Annas Handy', anna, { ip: '10.8.0.12' });
  annaLaptop = peer('Annas Laptop', anna, { ip: '10.8.0.13', groupId: office });
  leaPhone = peer('Leas Handy', lea, { ip: '10.8.0.21' });
  bossPhone = peer('Chef-Handy', boss, { ip: '10.8.0.30' });
  guestTab = peer('Gast-Tablet', null, { ip: '10.8.0.40', groupId: office });
  ownDnsPc = peer('Dienst-Laptop', anna, { ip: '10.8.0.31', dns: '1.1.1.1' });
  gateway = peer('Pi Keller', null, { ip: '10.8.0.2', type: 'gateway' });
  const groups = require('../src/services/groups');
  family = groups.create({ name: 'Familie-' + process.pid, kind: 'team' }).id;
  groups.setMember(family, lea, 'member');
  groups.setMember(family, anna, 'member');
});

after(async () => {
  if (svc) svc.stop();
  if (fw) fw._resetForTest();
  if (upstream) upstream.close();
  vpnDns.stop();
  dnsChain.stop();
  await plugins.stop();
  teardown();
  fs.rmSync(STATE, { recursive: true, force: true });
});

describe('without a plugin with permissions.vpnDns nothing runs', () => {
  it('no service, no chain entry, no file', async () => {
    const conf = fs.readFileSync(confPath, 'utf8');
    assert.equal(vpnDns.available(), false);
    assert.equal(vpnDns.start(), false);
    assert.equal(vpnDns.reconcile(), false);
    await vpnDns.tick();
    assert.deepEqual(fs.readdirSync(STATE), [], 'nothing is written for a server without the DNS protection');
    assert.equal(dnsChain.vpnFilter.status().state, 'off');
    assert.equal(restarts, 0);
    assert.equal(fs.readFileSync(confPath, 'utf8'), conf);
    assert.equal(vpnDns.notice(), null);
    assert.equal(vpnDns.clientInfo(), null);
    assert.equal(vpnDns.status().available, false);
    assert.equal(vpnDns.status().state, 'off');
    const r = await agent.get('/api/v1/system/dns/protection').expect(200);
    assert.deepEqual(r.body, { ok: true, notice: null });
    const sec = require('../src/services/dashboardSecurity');
    sec._resetCacheForTest();
    assert.equal((await agent.get('/api/v1/dashboard/security-summary').expect(200)).body.vpnDns, null);
  });

  it('no plugin: nothing is installed, the apps get no plugin; the old Pi-hole page leads to the dashboard', async () => {
    assert.equal((await agent.get('/pihole').expect(302)).headers.location, '/dashboard');
    assert.equal(vpnDns.installedPlugin(), null);
    assert.equal(vpnDns.clientPlugin(), null);
  });

  it('settings alone do not start it either (a plugin was removed, its settings stay)', () => {
    db.prepare('INSERT INTO vpn_dns (id, settings, updated_at) VALUES (1, ?, ?)').run(JSON.stringify({ enabled: true }), Date.now());
    assert.equal(vpnDns.reconcile(), false);
    assert.equal(fs.existsSync(path.join(STATE, 'enabled')), false);
    db.prepare('DELETE FROM vpn_dns').run();
  });

  it('the host API is closed without the permission', async () => {
    const fake = { id: 'nope', manifest: { permissions: {} } };
    for (const api of ['vpnDns.status', 'vpnDns.set', 'vpnDns.pause', 'vpnDns.log']) {
      await assert.rejects(hostApi.handle(fake, api, {}), (e) => e.code === 'ERR_VPN_DNS_DENIED', api);
    }
  });
});

describe('manifest: permissions.vpnDns', () => {
  it('a boolean, shown first and as sensitive in the install dialog', async () => {
    const manifest = require('../src/services/plugins/manifest');
    const base = { id: 'x-y', name: 'X', version: '1.0.0', publisher: 'T', description: 'd', gatecontrol: '>=1.0.0', entry: 'server/index.js' };
    assert.equal(manifest.validate({ ...base, permissions: { vpnDns: true } }).manifest.permissions.vpnDns, true);
    assert.equal(manifest.validate({ ...base }).manifest.permissions.vpnDns, false);
    const bad = manifest.validate({ ...base, permissions: { vpnDns: 'yes' } });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.includes('vpnDns')));

    const inspect = await installPkg(dnsPackage());
    assert.equal(inspect.plugin.permissions.vpnDns, true);
    assert.equal(await runtime.waitRunning(P), true);

    const ui = require('../public/js/plugins-ui');
    const t = (k) => k;
    assert.equal(ui.permRows(inspect.plugin.permissions, t)[0].label, 'plugins.perm.vpn_dns');
    assert.equal(ui.sensitivePerms(inspect.plugin.permissions)[0], 'plugins.perm.vpn_dns');
    for (const lang of ['de', 'en']) {
      const s = require(`../src/i18n/${lang}.json`);
      for (const k of ['plugins.perm.vpn_dns', 'plugins.perm.vpn_dns_on', 'dashboard.pihole_removed.title', 'dashboard.vpndns.down_title', 'dashboard.vpndns.paused_title', 'dashboard.vpndns.resume']) {
        assert.ok(s[k], `${lang}: ${k}`);
      }
    }
  });

  it('gc.vpnDns exists with the permission; installed but switched off, still nothing runs', async () => {
    const r = await agent.get(`/api/v1/plugins/${P}/api/has`).expect(200);
    assert.equal(r.body.vpnDns, true);
    assert.equal(r.body.version, 4);
    assert.deepEqual(r.body.methods, ['catalog', 'clearLog', 'devices', 'get', 'homes', 'lists', 'log', 'on', 'pause', 'pauses', 'refreshLists', 'releasePihole',
      'restart', 'resume', 'set', 'stats', 'status', 'test', 'version']);
    const st = await ok('status');
    assert.equal(st.available, true);
    assert.equal(st.enabled, false);
    assert.equal(st.state, 'off');
    assert.equal(st.chain, 'default');
    assert.deepEqual(st.service, { running: false });
    assert.deepEqual(fs.readdirSync(STATE), []);
  });

  it('the apps: "the plugin is there, the protection is off" is not "no plugin" — `vpnDns` stays null as before', async () => {
    const dev = H.makeDevice(anna, { name: 'vpndns-off-phone' });
    const perm = await supertest(app).get('/api/v1/client/permissions').set('X-API-Token', dev.raw).expect(200);
    assert.equal(perm.body.vpnDns, null);
    // the Pi-hole integration is gone: the flags stay in the answer, always false (older apps hide their view)
    assert.deepEqual([perm.body.permissions.pihole, perm.body.permissions.piholeControl], [false, false]);
    assert.deepEqual(perm.body.dnsProtection, { plugin: P, enabled: false, state: 'off' });
    assert.deepEqual(vpnDns.installedPlugin(), { id: P, usable: true });
    require('../src/services/tokens').revoke(dev.tokenId, '127.0.0.1');
    db.prepare('DELETE FROM peers WHERE id = ?').run(dev.peerId);
  });
});

describe('settings and who gets which profile', () => {
  it('catalog: the lists, categories and providers of the gateways’ DNS filter', async () => {
    const c = await ok('catalog');
    assert.deepEqual(c.lists.map((l) => l.id), ['ads', 'malware', 'adult', 'gambling', 'ads_stevenblack']);
    assert.deepEqual(c.categories.map((x) => x.id), ['social', 'games', 'video']);
    assert.deepEqual(c.providers.map((x) => x.id), ['quad9', 'cloudflare', 'custom', 'system']);
  });

  it('defaults: off, the default profile with the default lists, the query log off', async () => {
    const s = await ok('get');
    assert.equal(s.enabled, false);
    assert.deepEqual(s.log, { enabled: false, retentionDays: 7 });
    assert.equal(s.profiles.length, 1);
    assert.equal(s.profiles[0].id, 'default');
    assert.deepEqual(s.profiles[0].lists, ['ads', 'malware']);
  });

  it('changes need a changing request of an administrator', async () => {
    const get = await agent.get(`/api/v1/plugins/${P}/api/call`).query({ op: 'restart' }).expect(200);
    assert.equal(get.body.code, 'ERR_NOT_PERSON', 'a GET is no changing request');
    await assert.rejects(as(anna, 'vpnDns.set', { patch: { enabled: true } }), (e) => e.code === 'ERR_NOT_ADMIN');
    await assert.rejects(as(anna, 'vpnDns.clearLog', {}), (e) => e.code === 'ERR_NOT_ADMIN');
    await assert.rejects(hostApi.handle(plugins.get(P), 'vpnDns.set', { patch: { enabled: true } }), (e) => e.code === 'ERR_NOT_PERSON');
    // two people at once: the plugin has to say who acts
    await personContext.run(P, anna, true, async () => {
      await assert.rejects(as(adminId, 'vpnDns.set', { patch: { allow: [] } }), (e) => e.code === 'ERR_NOT_PERSON' && /actor/.test(e.message));
      const s = await as(adminId, 'vpnDns.set', { patch: { allow: ['paypal.com'] }, actor: adminId });
      assert.deepEqual(s.allow, ['paypal.com']);
    });
    assert.equal(vpnDns.get().enabled, false);
  });

  it('validation: ERR_INVALID names the field', async () => {
    const bad = async (patch, re) => {
      const r = await call('set', patch);
      assert.equal(r.code, 'ERR_INVALID', JSON.stringify(r));
      assert.match(r.error, re);
    };
    await bad({ nope: 1 }, /nope: unknown/);
    await bad({ allow: ['http://x/y'] }, /allow/);
    await bad({ upstream: { provider: 'custom' } }, /upstream\.url/);
    await bad({ log: { retentionDays: 0 } }, /log\.retentionDays/);
    await bad({ excluded: [999999] }, /excluded: unknown device/);
    await bad({ profiles: [] }, /profiles: 1/);
    await bad({ profiles: [{ id: 'default', users: [anna] }] }, /default profile has no members/);
    await bad({ profiles: [{}, { name: 'Kinder', peers: [gateway] }] }, /profiles\[1\]\.peers/);
    await bad({ profiles: [{}, { name: 'Kinder', users: [424242] }] }, /profiles\[1\]\.users/);
    await bad({ profiles: [{}, { name: 'A' }, { name: 'a' }] }, /a profile with this name exists/);
    await bad({ profiles: [{}, { name: 'Z', schedules: [{ days: [1], from: '08:00', to: '08:00', block: 'all' }] }] }, /schedules\[0\]/);
  });

  it('profiles: device beats person beats peer group beats person group beats default', async () => {
    const s = await ok('set', {
      allow: ['paypal.com'], deny: ['temu.com'],
      excluded: [],
      profiles: [
        { lists: ['ads'] },
        { name: 'Kinder', lists: ['ads', 'adult'], safeSearch: true, deny: ['roblox.com'], users: [lea],
          schedules: [{ days: [1, 2, 3, 4, 5], from: '21:00', to: '07:00', block: 'categories', categories: ['social'] }, { days: [6, 7], from: '00:00', to: '24:00', block: 'all' }] },
        { name: 'Büro', lists: ['malware'], peerGroups: [office] },
        { name: 'Familie', groups: [family] },
        { name: 'Gerät', peers: [annaLaptop] },
      ],
    });
    const [def, kids, buero, fam, dev] = s.profiles;
    assert.equal(def.id, 'default');
    assert.match(kids.id, /^p[0-9a-f]{8}$/);
    const by = new Map((await ok('devices')).map((d) => [d.peerId, d]));
    const eff = (id) => [by.get(id).profile && by.get(id).profile.name, by.get(id).via, by.get(id).state];
    assert.deepEqual(eff(annaLaptop), ['Gerät', 'peer', 'filtered'], 'device beats person, peer group and group');
    assert.deepEqual(eff(leaPhone), ['Kinder', 'user', 'filtered'], 'person beats the person group');
    assert.deepEqual(eff(guestTab), ['Büro', 'peerGroup', 'filtered']);
    assert.deepEqual(eff(annaPhone), ['Familie', 'group', 'filtered']);
    assert.deepEqual(eff(bossPhone), [def.name, 'default', 'filtered']);
    assert.deepEqual(eff(ownDnsPc), ['Familie', 'group', 'ownDns']);
    assert.equal(by.get(ownDnsPc).ownDns, '1.1.1.1');
    assert.deepEqual(eff(gateway), [null, null, 'gateway']);
    assert.deepEqual(by.get(leaPhone).user, { id: lea, name: 'Lea', role: 'user' });
    assert.equal(by.get(bossPhone).user.role, 'admin');
    assert.equal(by.get(leaPhone).ip, '10.8.0.21');
    assert.equal(by.get(leaPhone).today, null, 'no counters per device without the query log');

    // a profile keeps what a patch does not name; one that is missing is gone
    const s2 = await ok('set', { profiles: [{}, { id: kids.id, safeSearch: false }, { id: buero.id }, { id: fam.id }, { id: dev.id }] });
    assert.equal(s2.profiles[1].safeSearch, false);
    assert.deepEqual(s2.profiles[1].users, [lea]);
    assert.deepEqual(s2.profiles[1].deny, ['roblox.com']);
    await ok('set', { profiles: [{}, { id: kids.id, safeSearch: true }, { id: buero.id }, { id: fam.id }, { id: dev.id }], excluded: [guestTab] });
    assert.equal((await ok('devices')).find((d) => d.peerId === guestTab).state, 'excluded');
    await ok('set', { excluded: [] });
  });

  it('the filter service’s config: keys per device, times in minutes, own entries in every profile, internal names', () => {
    const c = vpnDns.filterConfig();
    assert.equal(c.clients['10.8.0.21'], `peer:${leaPhone}`);
    assert.equal(c.clients['10.8.0.2'], undefined, 'a gateway is never filtered');
    assert.equal(c.clients['10.8.0.31'], `peer:${ownDnsPc}`, 'a device with its own DNS is filtered when it does ask');
    const kids = c.policy.profiles[1];
    assert.deepEqual(kids.clients, [`peer:${leaPhone}`]);
    assert.deepEqual(kids.schedules.map((x) => [x.from, x.to, x.block]), [[1260, 420, 'categories'], [0, 1440, 'all']]);
    assert.deepEqual(kids.allow, ['paypal.com']);
    assert.deepEqual(kids.deny, ['roblox.com', 'temu.com']);
    assert.deepEqual(Object.keys(c.policy.lists).sort(), ['ads', 'adult', 'malware']);
    const internal = new Set(c.internal);
    assert.ok(internal.has('app.example.com') && internal.has('laptop.gc.internal'));
    assert.deepEqual(c.plain, [process.env.GC_DNSMASQ_UPSTREAMS]);
    assert.deepEqual(c.suspended, { all: null, keys: {} });
    assert.deepEqual([c.policy.globalAllow, c.policy.globalDeny], [['paypal.com'], ['temu.com']], 'the entries for everybody, also apart');
  });
});

describe('switched on: the service, the chain, the filter', () => {
  it('enabled → the service is wanted; the chain is only claimed once it is ready', async () => {
    await ok('set', { enabled: true, upstream: { provider: 'system' } });
    assert.ok(fs.existsSync(path.join(STATE, 'enabled')), 'the wrapper starts the service when this file exists');
    assert.equal(JSON.parse(fs.readFileSync(path.join(STATE, 'config.json'), 'utf8')).enabled, true);
    await vpnDns.tick();
    assert.equal((await ok('status')).state, 'starting');
    assert.equal(dnsChain.vpnFilter.status().state, 'off', 'not in the chain before the service answers');
    assert.equal(restarts, 0);

    await startService(); // what scripts/dnsfilter-wrapper.sh does
    await waitFor(async () => { await vpnDns.tick(); return dnsChain.vpnFilter.status().state === 'vpnfilter'; });
    const st = await ok('status');
    assert.equal(st.state, 'filtering');
    assert.equal(st.chain, 'filter');
    assert.equal(st.service.running, true);
    assert.equal(st.service.ready, true);
    assert.equal(st.service.port, vpnDns.filterPort());
    assert.equal(restarts, 1, 'one dnsmasq restart');
    assert.match(fs.readFileSync(confPath, 'utf8'), new RegExp(`gatecontrol-vpnfilter >>>\\nadd-subnet=32,128\\nserver=127\\.0\\.0\\.1#${vpnDns.filterPort()}\\n`));
    assert.deepEqual(st.peers, { filtered: 5, ownDns: 1, excluded: 0, gateways: 1, suspended: 0 });
    assert.deepEqual(st.lists.map((l) => [l.id, l.loaded, l.entries]), [['ads', true, 2], ['malware', true, 1], ['adult', true, 1]]);
    assert.deepEqual(vpnDns.clientInfo(), { plugin: P, state: 'filtering' });
    assert.deepEqual(vpnDns.notice().kind, null);
  });

  it('filters per profile; the server itself and unknown addresses are never filtered', async () => {
    assert.deepEqual((await askFilter('ads.example', '10.8.0.30')).a, ['0.0.0.0'], 'default profile: ads');
    assert.deepEqual((await askFilter('adult.example', '10.8.0.21')).a, ['0.0.0.0'], 'Kinder: adult');
    // allowed for the asker, blocked for the children: truncated over UDP, the answer over TCP
    assert.equal((await askFilter('adult.example', '10.8.0.30')).tc, true);
    assert.deepEqual((await askFilter('adult.example', '10.8.0.30', { tcp: true })).a, [UP_IP]);
    assert.deepEqual((await askFilter('temu.com', '10.8.0.40')).a, ['0.0.0.0'], '"Immer gesperrt" holds in every profile');
    assert.deepEqual((await askFilter('www.paypal.com', '10.8.0.21')).a, [UP_IP], '"Immer erlaubt" holds in every profile');
    assert.deepEqual((await askFilter('ads.example', null, { tcp: true })).a, [UP_IP], 'no ECS: the server itself');
    assert.deepEqual((await askFilter('ads.example', '10.8.0.2', { tcp: true })).a, [UP_IP], 'a gateway');
    assert.deepEqual((await askFilter('ads.example', '10.8.0.222', { tcp: true })).a, [UP_IP], 'an address no peer has');
    // a name dnsmasq answers itself is never blocked, whatever the lists say
    await ok('set', { deny: ['temu.com', 'app.example.com'] });
    await waitFor(() => new Set(svc.cfg.policy.profiles[0].deny).has('app.example.com'));
    assert.equal((await askFilter('app.example.com', '10.8.0.30', { qtype: wire.TYPE.AAAA })).rcode, 0);
    assert.equal(new Set(upstream.seen).has('app.example.com'), true, 'forwarded, not blocked');
    // the chain's probe is answered without the upstream
    const before = upstream.seen.length;
    assert.equal((await askFilter('', null, { qtype: wire.TYPE.NS })).rcode, 0);
    assert.equal(upstream.seen.length, before);
  });

  it('test(): asked from the service, for a device, a person or a profile', async () => {
    const kids = vpnDns.get().profiles[1];
    let r = await ok('test', 'ADULT.example.', { peerId: leaPhone });
    assert.deepEqual([r.domain, r.action, r.reason, r.list, r.profile.name, r.device.name], ['adult.example', 'block', 'list', 'adult', 'Kinder', 'Leas Handy']);
    assert.deepEqual([r.match, r.scope], [{ entry: 'adult.example', kind: 'domain' }, null]);
    // the entry of the list that hit — "Treffer adult.example mit allen Unterseiten"
    r = await ok('test', 'cdn.img.adult.example', { peerId: leaPhone });
    assert.deepEqual([r.list, r.match], ['adult', { entry: 'adult.example', kind: 'domain' }]);
    // "Immer gesperrt" for everybody is not "Immer gesperrt" in the profile
    r = await ok('test', 'shop.temu.com', { peerId: leaPhone });
    assert.deepEqual([r.action, r.reason, r.scope, r.match], ['block', 'profile_deny', 'all', { entry: 'temu.com', kind: 'domain' }]);
    r = await ok('test', 'www.roblox.com', { peerId: leaPhone });
    assert.deepEqual([r.action, r.reason, r.scope, r.match], ['block', 'profile_deny', 'profile', { entry: 'roblox.com', kind: 'domain' }]);
    r = await ok('test', 'www.paypal.com', { peerId: leaPhone });
    assert.deepEqual([r.action, r.reason, r.scope, r.match], ['allow', 'profile_allow', 'all', { entry: 'paypal.com', kind: 'domain' }]);
    r = await ok('test', 'ok.example', { peerId: leaPhone });
    assert.deepEqual([r.reason, r.scope, r.match], ['default', null, null]);
    r = await ok('test', 'adult.example', { peerId: bossPhone });
    assert.deepEqual([r.action, r.reason], ['allow', 'default']);
    r = await ok('test', 'roblox.com', { userId: lea });
    assert.deepEqual([r.action, r.reason, r.profile.id], ['block', 'profile_deny', kids.id]);
    r = await ok('test', 'www.google.com', { profileId: kids.id });
    assert.equal(r.safeSearch, 'forcesafesearch.google.com');
    r = await ok('test', 'ads.example', { peerId: gateway });
    assert.deepEqual([r.action, r.reason, r.filtered], ['allow', 'no_profile', false]);
    r = await ok('test', 'ads.example');
    assert.deepEqual([r.action, r.profile.id], ['block', 'default']);
    assert.equal((await call('test', 'not a domain')).code, 'ERR_INVALID');
    assert.equal((await call('test', 'x.example', { peerId: 987654 })).code, 'ERR_NOT_FOUND');
  });

  it('counters without the query log: totals and top domains, nothing per device', async () => {
    vpnDns._run.takeAt = 0;
    await vpnDns.tick();
    const s = await ok('stats', { days: 7 });
    assert.ok(s.today.queries >= 8, JSON.stringify(s.today));
    assert.ok(s.today.blocked >= 3);
    assert.ok(s.today.top.some((x) => x.domain === 'ads.example'));
    assert.equal(s.perPeer, null);
    assert.equal(s.perPeerToday, null);
    // blocked by what: a list, "Immer gesperrt" for everybody (temu.com) — nothing of a profile's own entries yet
    assert.deepEqual(Object.keys(s.today.blockedBy), ['list', 'denyAll', 'denyProfile', 'schedule', 'pause', 'other']);
    assert.ok(s.today.blockedBy.list >= 2 && s.today.blockedBy.denyAll >= 1, JSON.stringify(s.today.blockedBy));
    assert.equal(s.today.blockedBy.denyProfile, 0);
    assert.equal(Object.values(s.today.blockedBy).reduce((a, b) => a + b, 0), s.today.blocked, 'every blocked query has one kind');
    assert.deepEqual([s.blockedBy, s.days[s.days.length - 1].blockedBy], [s.today.blockedBy, s.today.blockedBy]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vpn_dns_log').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vpn_dns_peer_day').get().n, 0);
    assert.equal((await call('log', {})).code, 'ERR_LOG_OFF');
    const st = await ok('status');
    assert.equal(st.today.queries, s.today.queries);
    assert.deepEqual(st.today.blockedBy, s.today.blockedBy);
    // the dashboard's security card
    require('../src/services/dashboardSecurity')._resetCacheForTest();
    const sec = (await agent.get('/api/v1/dashboard/security-summary').expect(200)).body.vpnDns;
    assert.deepEqual([sec.total, sec.blocked], [s.today.queries, s.today.blocked]);
    assert.ok(sec.percent > 0 && sec.percent <= 100);
  });

  it('with the query log on: per device, searchable; switching it off deletes it', async () => {
    await ok('set', { log: { enabled: true, retentionDays: 3 } });
    await waitFor(() => svc.cfg.logQueries === true);
    await askFilter('ads.example', '10.8.0.21');
    await askFilter('ok.example', '10.8.0.21');
    await askFilter('ads.example', '10.8.0.30');
    vpnDns._run.takeAt = 0;
    await vpnDns.tick();
    {
      // own entries in the log and the counters: for everybody or in the profile
      const before = (await ok('stats')).today.blockedBy;
      await askFilter('roblox.com', '10.8.0.21');
      await askFilter('temu.com', '10.8.0.30');
      vpnDns._run.takeAt = 0;
      await vpnDns.tick();
      const after = (await ok('stats')).today.blockedBy;
      assert.deepEqual([after.denyProfile - before.denyProfile, after.denyAll - before.denyAll, after.list - before.list], [1, 1, 0]);
      const own = (await ok('log', { blockedOnly: true, limit: 2 })).entries.map((e) => [e.name, e.reason, e.scope]);
      assert.deepEqual(own, [['temu.com', 'profile_deny', 'all'], ['roblox.com', 'profile_deny', 'profile']]);
      assert.deepEqual((await ok('log', { scope: 'profile' })).entries.map((e) => e.name), ['roblox.com']);
      db.prepare("DELETE FROM vpn_dns_log WHERE name IN ('roblox.com', 'temu.com')").run();
      db.prepare('UPDATE vpn_dns_peer_day SET queries = queries - 1, blocked = blocked - 1 WHERE peer_id IN (?, ?)').run(leaPhone, bossPhone);
    }
    const lp = (await ok('devices')).find((d) => d.peerId === leaPhone);
    assert.deepEqual(lp.today, { queries: 2, blocked: 1 });
    const s = await ok('stats');
    assert.deepEqual(s.perPeerToday.find((x) => x.peerId === leaPhone), { peerId: leaPhone, queries: 2, blocked: 1 });
    let l = await ok('log', { userId: lea });
    assert.deepEqual(l.entries.map((e) => [e.name, e.action, e.reason, e.list, e.peerId, e.scope]), [['ok.example', 'allow', 'default', null, leaPhone, null], ['ads.example', 'block', 'list', 'ads', leaPhone, null]]);
    l = await ok('log', { blockedOnly: true, search: 'ADS', limit: 1 });
    assert.equal(l.entries.length, 1);
    assert.ok(l.next > 0);
    assert.equal((await ok('log', { before: l.next, blockedOnly: true })).entries.length, 1);
    // retention
    db.prepare('UPDATE vpn_dns_log SET at = ? WHERE name = ?').run(Date.now() - 4 * 86400000, 'ok.example');
    await vpnDns.retention();
    assert.equal((await ok('log', { search: 'ok.example' })).entries.length, 0);

    await ok('set', { log: { enabled: false } });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vpn_dns_log').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vpn_dns_peer_day').get().n, 0);
    await waitFor(() => svc.cfg.logQueries === false);
  });

  it('lists: what is loaded; "Jetzt aktualisieren"', async () => {
    await vpnDns.tick();
    const l = await ok('lists');
    assert.deepEqual(l.lists.map((x) => [x.id, x.used, x.loaded, x.estimated]), [['ads', true, true, false], ['malware', true, true, false], ['adult', true, true, false],
      ['gambling', false, false, true], ['ads_stevenblack', false, false, true]]);
    assert.equal(l.entries, 4);
    assert.equal(l.memoryBytes, 32);
    assert.deepEqual(await ok('refreshLists'), { started: true });
  });
});

describe('suspending ("Unterbrechen")', () => {
  it('everybody for their own devices; for all devices and for an administrator’s only an administrator', async () => {
    await assert.rejects(as(anna, 'vpnDns.pause', { target: { scope: 'all', minutes: 5 } }), (e) => e.code === 'ERR_FORBIDDEN');
    await assert.rejects(as(anna, 'vpnDns.pause', { target: { scope: 'peer', id: bossPhone, minutes: 5 } }), (e) => e.code === 'ERR_FORBIDDEN');
    await assert.rejects(as(anna, 'vpnDns.pause', { target: { scope: 'user', id: boss, minutes: 5 } }), (e) => e.code === 'ERR_FORBIDDEN');
    await assert.rejects(as(anna, 'vpnDns.pause', { target: { scope: 'peer', id: gateway, minutes: 5 } }), (e) => e.code === 'ERR_NOT_FOUND');
    await assert.rejects(as(anna, 'vpnDns.pause', { target: { scope: 'peer', id: annaPhone } }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(as(anna, 'vpnDns.pause', { target: { scope: 'peer', id: annaPhone, minutes: 99999 } }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(hostApi.handle(plugins.get(P), 'vpnDns.pause', { target: { scope: 'peer', id: annaPhone, minutes: 5 } }), (e) => e.code === 'ERR_NOT_PERSON');

    const p = await as(anna, 'vpnDns.pause', { target: { scope: 'peer', id: annaPhone, minutes: 30 } });
    assert.equal(p.scope, 'peer');
    assert.equal(p.openEnd, false);
    assert.ok(Date.parse(p.until) > Date.now() + 29 * 60000);
    assert.deepEqual(p.by, { userId: anna, name: 'Anna' });
    await waitFor(() => svc.cfg.suspended.keys.has(`peer:${annaPhone}`));
    assert.deepEqual((await askFilter('ads.example', '10.8.0.12', { tcp: true })).a, [UP_IP], 'suspended means unfiltered');
    assert.deepEqual((await askFilter('temu.com', '10.8.0.12', { tcp: true })).a, [UP_IP]);
    assert.deepEqual((await askFilter('temu.com', '10.8.0.13')).a, ['0.0.0.0'], 'her laptop is still filtered');
    const d = (await ok('devices')).find((x) => x.peerId === annaPhone);
    assert.deepEqual([d.suspended, d.suspendedBy, d.suspendedUntil], [true, 'peer', p.until]);
    assert.equal((await ok('status')).peers.suspended, 1);
    const a = db.prepare("SELECT message, details, source FROM activity_log WHERE event_type = 'vpn_dns_paused' ORDER BY id DESC").get();
    assert.match(a.message, /suspended for device "Annas Handy" until/);
    assert.equal(JSON.parse(a.details).actor, 'Anna');

    // a parent for a child: the plugin decides and names the actor; the host only keeps its two rules
    const forLea = await hostApi.handle(plugins.get(P), 'vpnDns.pause', { target: { scope: 'user', id: lea, forever: true }, actor: anna });
    assert.deepEqual([forLea.openEnd, forLea.until, forLea.automated], [true, null, true]);
    assert.equal((await ok('pauses')).length, 2);
    assert.equal(await as(anna, 'vpnDns.resume', { target: { scope: 'user', id: lea } }), true);
    assert.equal(await as(anna, 'vpnDns.resume', { target: { scope: 'user', id: lea } }), false);
    assert.equal(await as(anna, 'vpnDns.resume', { target: { scope: 'peer', id: annaPhone } }), true);
  });

  it('for all devices: nothing is blocked, the dashboard says so, it ends by itself — and the plugin hears all of it', async () => {
    const p = await ok('pause', { scope: 'all', minutes: 10 });
    assert.equal(p.scope, 'all');
    await waitFor(() => svc.cfg.suspended.all !== null);
    assert.deepEqual((await askFilter('ads.example', '10.8.0.30', { tcp: true })).a, [UP_IP]);
    const st = await ok('status');
    assert.equal(st.state, 'filtering');
    assert.equal(st.pause.until, p.until);
    const adminName = db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(adminId);
    const admin = adminName.display_name || adminName.username;
    assert.equal(st.pause.by.name, admin);
    assert.equal(st.peers.suspended, 5);
    const n = (await agent.get('/api/v1/system/dns/protection').expect(200)).body.notice;
    assert.deepEqual([n.kind, n.until, n.by, n.plugin], ['paused', p.until, admin, P]);

    // "+30 Min.": a new suspension replaces the running one
    const p2 = await ok('pause', { scope: 'all', until: new Date(Date.parse(p.until) + 30 * 60000).toISOString() });
    assert.equal(Date.parse(p2.until) - Date.parse(p.until), 30 * 60000);
    assert.equal((await ok('pauses')).length, 1);

    // the dashboard's "Wieder einschalten"
    const r = await agent.post('/api/v1/system/dns/protection/resume').set('X-CSRF-Token', csrf).send({}).expect(200);
    assert.equal(r.body.notice.kind, null);
    await waitFor(() => svc.cfg.suspended.all === null);
    assert.deepEqual((await askFilter('ads.example', '10.8.0.30')).a, ['0.0.0.0']);

    // one that runs out
    await ok('pause', { scope: 'peer', id: leaPhone, minutes: 1 });
    assert.equal(vpnDns.sweepPauses(Date.now() + 61000), 1);
    assert.equal((await ok('pauses')).length, 0);

    const ev = await waitFor(async () => {
      const e = (await agent.get(`/api/v1/plugins/${P}/api/events`).expect(200)).body.events;
      return e.filter((x) => x.type === 'resumed').length >= 4 ? e : null;
    });
    assert.ok(ev, 'the hook vpnDns reached the plugin');
    assert.deepEqual(ev.filter((x) => x.scope === 'all').map((x) => [x.type, x.reason || null]), [['paused', null], ['paused', null], ['resumed', 'manual']]);
    const expired = ev.at(-1);
    assert.deepEqual([expired.type, expired.scope, expired.id, expired.reason, expired.by], ['resumed', 'peer', leaPhone, 'expired', null]);
    assert.ok(Date.parse(expired.at) > 0);
  });
});

describe('the apps', () => {
  it('permissions name the plugin; its client API gets the asking device as a peer', async () => {
    const dev = H.makeDevice(anna, { name: 'vpndns-phone' });
    const perm = await supertest(app).get('/api/v1/client/permissions').set('X-API-Token', dev.raw).expect(200);
    assert.deepEqual(perm.body.vpnDns, { plugin: P, state: 'filtering' });
    assert.deepEqual(perm.body.dnsProtection, { plugin: P, enabled: true, state: 'filtering' });
    // the dashboard's notice opens the plugin's settings page as well
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8'), /encodeURIComponent\(n\.plugin\) \+ '\?tab=settings'/);
    const me = await supertest(app).get(`/api/v1/client/plugins/${P}/api/me`).set('X-API-Token', dev.raw).expect(200);
    assert.equal(me.body.user.id, anna);
    assert.equal(me.body.user.peerId, dev.peerId);
    assert.equal(me.body.user.role, 'user');
    // "Unterbrechen" from the app: the person's own changing request is the actor
    const r = await supertest(app).post(`/api/v1/client/plugins/${P}/api/call`).set('X-API-Token', dev.raw)
      .send({ op: 'pause', args: [{ scope: 'peer', id: dev.peerId, minutes: 5 }] }).expect(200);
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.deepEqual(r.body.result.by, { userId: anna, name: 'Anna' });
    const no = await supertest(app).post(`/api/v1/client/plugins/${P}/api/call`).set('X-API-Token', dev.raw)
      .send({ op: 'pause', args: [{ scope: 'all', minutes: 5 }] }).expect(200);
    assert.equal(no.body.code, 'ERR_FORBIDDEN');
    const set = await supertest(app).post(`/api/v1/client/plugins/${P}/api/call`).set('X-API-Token', dev.raw).send({ op: 'set', args: [{ enabled: false }] }).expect(200);
    assert.equal(set.body.code, 'ERR_NOT_ADMIN');
    assert.equal(await as(anna, 'vpnDns.resume', { target: { scope: 'peer', id: dev.peerId } }), true);
  });
});

describe('foreign DNS and DoT ("Umgehung erschweren")', () => {
  // the firewall of this machine is never touched: iptables is a stand-in that keeps the rules
  // (the exact rules: vpn_dns_firewall.test.js; against the real netfilter: vpn_dns_firewall_live.test.js)
  const sources = (chain) => [...new Set(((chain === 'nat' ? ipt.tables.nat.GC_VPNDNS_NAT : ipt.tables.filter.GC_VPNDNS_FWD) || [])
    .map((r) => /-s (\S+)\/32/.exec(r)).filter(Boolean).map((m) => m[1]))].sort();
  const hooked = () => ipt.tables.nat.PREROUTING.length + ipt.tables.filter.FORWARD.filter((r) => r.includes('GC_VPNDNS')).length;
  const filteredIps = async () => (await ok('devices')).filter((d) => d.state === 'filtered').map((d) => d.ip).sort();

  it('off by default: not one firewall command, whatever happens', async () => {
    fw = require('../src/services/vpnDnsFirewall');
    ipt = fakeIptables();
    fw._setExecForTest(ipt.exec);
    assert.equal(vpnDns.get().blockForeignDns, false);
    assert.deepEqual((await ok('status')).foreignDns, { enabled: false, active: false, devices: 0, since: null, error: null });
    await vpnDns.tick();
    await vpnDns.syncFirewall({ check: true });
    assert.deepEqual(ipt.calls, []);
    assert.equal(fs.existsSync(path.join(STATE, fw.MARKER)), false);
    assert.equal((await call('set', { blockForeignDns: 'yes' })).code, 'ERR_INVALID');
  });

  it('switched on: rules for exactly the devices that are filtered — not own DNS, not excluded, not a gateway', async () => {
    const s = await ok('set', { blockForeignDns: true });
    assert.equal(s.blockForeignDns, true);
    await vpnDns.syncFirewall();
    const want = await filteredIps();
    assert.ok(want.includes('10.8.0.12') && want.includes('10.8.0.21') && want.includes('10.8.0.30'));
    assert.deepEqual(sources('nat'), want);
    assert.deepEqual(sources('filter'), want);
    assert.ok(!want.includes('10.8.0.31') && !want.includes('10.8.0.2'), 'own DNS and gateway are not filtered');
    assert.equal(ipt.tables.nat.GC_VPNDNS_NAT[0], '-d 10.8.0.1/32 -j RETURN');
    assert.ok(ipt.tables.nat.GC_VPNDNS_NAT.includes('-s 10.8.0.21/32 -p udp -m udp --dport 53 -j DNAT --to-destination 10.8.0.1:53'));
    assert.ok(ipt.tables.filter.GC_VPNDNS_FWD.includes('-s 10.8.0.21/32 -p tcp -m tcp --dport 853 -j REJECT --reject-with tcp-reset'));
    assert.equal(ipt.tables.filter.FORWARD[0], '-i wg0 -p tcp -m tcp --dport 853 -j GC_VPNDNS_FWD', 'before wg-quick’s ACCEPT');
    assert.equal(hooked(), 4);
    const st = (await ok('status')).foreignDns;
    assert.deepEqual([st.enabled, st.active, st.devices, st.error], [true, true, want.length, null]);
    const by = new Map((await ok('devices')).map((d) => [d.peerId, d.foreignDnsBlocked]));
    assert.deepEqual([by.get(leaPhone), by.get(ownDnsPc), by.get(gateway)], [true, false, false]);
    // excluded: out of the rules at once
    await ok('set', { excluded: [guestTab] });
    await vpnDns.syncFirewall();
    assert.ok(!sources('nat').includes('10.8.0.40'));
    await ok('set', { excluded: [] });
    await vpnDns.syncFirewall();
    assert.ok(sources('nat').includes('10.8.0.40'));
  });

  it('suspended means "as without the protection": the device’s rules go, and come back by themselves', async () => {
    await as(anna, 'vpnDns.pause', { target: { scope: 'peer', id: annaPhone, minutes: 5 } });
    await vpnDns.syncFirewall();
    assert.ok(!sources('nat').includes('10.8.0.12') && !sources('filter').includes('10.8.0.12'));
    assert.ok(sources('nat').includes('10.8.0.13'), 'her laptop keeps its rules');
    assert.equal((await ok('devices')).find((d) => d.peerId === annaPhone).foreignDnsBlocked, false);
    // it runs out: the next round of the server puts the rules back (nobody has to do anything)
    db.prepare("UPDATE vpn_dns_pauses SET until_at = ? WHERE scope = 'peer' AND target_id = ?").run(Date.now() - 1000, annaPhone);
    await vpnDns.tick();
    assert.ok(sources('nat').includes('10.8.0.12'));
    // for all devices: no rule and no jump at all
    await ok('pause', { scope: 'all', minutes: 5 });
    await vpnDns.syncFirewall();
    assert.deepEqual([ipt.tables.nat.GC_VPNDNS_NAT, ipt.tables.filter.GC_VPNDNS_FWD, hooked()], [undefined, undefined, 0]);
    assert.deepEqual(ipt.tables.filter.FORWARD, ['-i wg0 -j ACCEPT', '-i eth0 -o wg0 -m state --state RELATED,ESTABLISHED -j ACCEPT']);
    assert.equal((await ok('status')).foreignDns.active, false);
    await ok('resume', { scope: 'all' });
    await vpnDns.syncFirewall();
    assert.deepEqual(sources('nat'), await filteredIps());
    assert.equal(hooked(), 4);
  });

  it('WireGuard restarted: the jumps go back above its ACCEPT', async () => {
    ipt.tables.filter.FORWARD = ['-i wg0 -j ACCEPT', ...ipt.tables.filter.FORWARD.filter((r) => r !== '-i wg0 -j ACCEPT')];
    await vpnDns.networkChanged();
    assert.match(ipt.tables.filter.FORWARD[0], /GC_VPNDNS_FWD/);
    assert.equal(ipt.tables.filter.FORWARD.filter((r) => r.includes('GC_VPNDNS')).length, 2);
  });

  it('iptables refuses: said in the status, name resolution is not touched', async () => {
    const real = ipt.exec;
    fw._setExecForTest(async () => ({ code: 4, stdout: '', stderr: 'iptables v1.8.10: Permission denied (you must be root)' }));
    await ok('set', { excluded: [guestTab] }); // another set of devices → applied again
    await vpnDns.syncFirewall();
    const st = (await ok('status')).foreignDns;
    assert.deepEqual([st.enabled, st.active], [true, false]);
    assert.match(st.error, /Permission denied/);
    assert.equal((await ok('status')).state, 'filtering');
    assert.deepEqual((await askFilter('ads.example', '10.8.0.30')).a, ['0.0.0.0']);
    fw._setExecForTest(real);
    await ok('set', { excluded: [] });
    await vpnDns.syncFirewall();
    assert.deepEqual([(await ok('status')).foreignDns.active, (await ok('status')).foreignDns.error], [true, null]);
  });
});

describe('"Internet pausieren" of a person (family plugin) reaches their VPN devices', () => {
  const who = () => ({ pluginId: 'gatecontrol-familie', actors: [anna] });
  const keyLea = () => `peer:${leaPhone}`;

  it('paused: only what is always allowed answers — for the person’s devices, for nobody else', async () => {
    const hi = require('../src/services/homeInternet');
    assert.equal(vpnDns.get().homeInternet, true);
    hi.pause(lea, 30, who());
    await waitFor(() => svc.cfg.policy.pauses.length === 1);
    assert.deepEqual(svc.cfg.policy.pauses[0].clients, [keyLea()]);
    assert.deepEqual((await askFilter('ok.example', '10.8.0.21')).a, ['0.0.0.0'], 'internet off');
    assert.deepEqual((await askFilter('www.paypal.com', '10.8.0.21', { tcp: true })).a, [UP_IP], '"Immer erlaubt" still answers');
    assert.equal((await askFilter('app.example.com', '10.8.0.21', { qtype: wire.TYPE.AAAA })).rcode, 0, 'the server’s own names too');
    assert.deepEqual((await askFilter('ok.example', '10.8.0.12', { tcp: true })).a, [UP_IP], 'Anna is not paused');
    const r = await ok('test', 'ok.example', { peerId: leaPhone });
    assert.deepEqual([r.action, r.reason], ['block', 'paused']);
    const d = (await ok('devices')).find((x) => x.peerId === leaPhone);
    assert.ok(Date.parse(d.internetPaused) > Date.now());
    assert.equal((await ok('devices')).find((x) => x.peerId === annaPhone).internetPaused, null);
  });

  it('suspending the protection ("Unterbrechen") does not switch the internet back on, nor does it lift the firewall rules', async () => {
    await as(lea, 'vpnDns.pause', { target: { scope: 'peer', id: leaPhone, minutes: 5 } });
    await waitFor(() => svc.cfg.suspended.keys.has(keyLea()));
    assert.deepEqual((await askFilter('ok.example', '10.8.0.21')).a, ['0.0.0.0']);
    assert.equal((await ok('test', 'ok.example', { peerId: leaPhone })).reason, 'paused');
    await vpnDns.syncFirewall();
    assert.ok(ipt.tables.nat.GC_VPNDNS_NAT.some((x) => x.includes('-s 10.8.0.21/32')), 'no way round over a foreign DNS server');
    // … also not when an administrator suspends for all devices: only the paused devices keep their rules
    await ok('pause', { scope: 'all', minutes: 5 });
    await vpnDns.syncFirewall();
    assert.deepEqual([...new Set(ipt.tables.nat.GC_VPNDNS_NAT.map((x) => /-s (\S+)\/32/.exec(x)).filter(Boolean).map((m) => m[1]))], ['10.8.0.21']);
    assert.deepEqual((await askFilter('ok.example', '10.8.0.21')).a, ['0.0.0.0']);
    await ok('resume', { scope: 'all' });
  });

  it('ended by the parent: the internet is back (and the suspension is what it was); counted as its own kind', async () => {
    const hi = require('../src/services/homeInternet');
    hi.resume(lea, who());
    await waitFor(() => svc.cfg.policy.pauses.length === 0);
    assert.deepEqual((await askFilter('ok.example', '10.8.0.21', { tcp: true })).a, [UP_IP]);
    assert.deepEqual((await askFilter('adult.example', '10.8.0.21', { tcp: true })).a, [UP_IP], 'still suspended: unfiltered');
    assert.equal(await as(lea, 'vpnDns.resume', { target: { scope: 'peer', id: leaPhone } }), true);
    await waitFor(() => !svc.cfg.suspended.keys.has(keyLea()));
    vpnDns._run.takeAt = 0;
    await vpnDns.tick();
    assert.ok((await ok('stats')).today.blockedBy.pause >= 2);
    assert.equal((await ok('devices')).find((x) => x.peerId === leaPhone).internetPaused, null);
  });

  it('"Zeit verlängern" suspends the times of the profile on the VPN devices as well; the setting switches both off', async () => {
    const hi = require('../src/services/homeInternet');
    hi.extend(lea, 30, who());
    await waitFor(() => svc.cfg.policy.extensions.length === 1);
    assert.deepEqual(svc.cfg.policy.extensions[0].clients, [keyLea()]);
    assert.ok(Date.parse((await ok('devices')).find((x) => x.peerId === leaPhone).timesSuspended) > Date.now());
    hi.pause(lea, 30, who());
    await waitFor(() => svc.cfg.policy.pauses.length === 1);
    const s = await ok('set', { homeInternet: false });
    assert.equal(s.homeInternet, false);
    await waitFor(() => svc.cfg.policy.pauses.length === 0 && svc.cfg.policy.extensions.length === 0);
    assert.deepEqual((await askFilter('ok.example', '10.8.0.21', { tcp: true })).a, [UP_IP], 'at home only');
    assert.equal((await ok('devices')).find((x) => x.peerId === leaPhone).internetPaused, null);
    await ok('set', { homeInternet: true });
    hi.resume(lea, who());
    hi.extend(lea, 0, who());
    await waitFor(() => svc.cfg.policy.pauses.length === 0 && svc.cfg.policy.extensions.length === 0);
    assert.equal((await call('set', { homeInternet: 1 })).code, 'ERR_INVALID');
  });
});

describe('a profile shared with a home network ("gilt zu Hause und unterwegs")', () => {
  let hd, homeKids, kidsId;
  const vpnKids = async () => (await ok('get')).profiles.find((p) => p.id === kidsId);
  const homeProfile = () => hd.get(gateway).profiles.find((p) => p.id === homeKids);
  const ids = async () => (await ok('get')).profiles.map((p) => ({ id: p.id }));
  // exactly this entry in what the filter service has for the profile (the patterns are whole entries, never parts of a name)
  const filterDenies = (entry) => new Set(svc.cfg.policy.profiles.find((x) => x.id === kidsId).deny).has(entry);
  const patchKids = async (patch) => ok('set', { profiles: (await ids()).map((p) => (p.id === kidsId ? { ...p, ...patch } : p)) });

  it('homes(): the home networks and their profiles', async () => {
    hd = require('../src/services/homeDns');
    db.prepare('INSERT OR IGNORE INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at) VALUES (?, 9876, ?, ?, ?)').run(gateway, 'h-' + gateway, 'x', Date.now());
    kidsId = vpnDns.get().profiles[1].id;
    assert.deepEqual(await ok('homes'), [{
      gateway: { peerId: gateway, name: 'Pi Keller' }, gateways: [{ peerId: gateway, name: 'Pi Keller' }], configured: false, enabled: false,
      profiles: [{ id: 'default', name: hd.get(gateway).profiles[0].name, lists: ['ads', 'malware'], safeSearch: false, allow: [], deny: [], schedules: [], users: [], devices: 0, linkedTo: null }],
    }]);
    hd.setGeneral(gateway, { enabled: true });
    homeKids = hd.createProfile(gateway, { name: 'Kinder zu Hause', lists: ['ads', 'gambling'], safeSearch: false, deny: ['fortnite.com'], users: [lea],
      schedules: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '22:00', to: '06:00', block: 'all' }] }).id;
    const h = (await ok('homes'))[0];
    assert.deepEqual([h.configured, h.enabled, h.profiles.map((p) => [p.name, p.linkedTo])], [true, true, [[h.profiles[0].name, null], ['Kinder zu Hause', null]]]);
  });

  it('taking the home’s profile over: its lists, entries, times and people hold here — the members of the VPN stay', async () => {
    const before = await vpnKids();
    assert.deepEqual([before.home, before.lists, before.deny], [null, ['ads', 'adult'], ['roblox.com']]);
    await patchKids({ home: { gateway, profile: homeKids } });
    const p = await vpnKids();
    assert.deepEqual(p.home, { gateway, profile: homeKids, gatewayName: 'Pi Keller', name: 'Kinder zu Hause' });
    assert.deepEqual([p.name, p.lists, p.safeSearch, p.deny, p.users], ['Kinder', ['ads', 'gambling'], false, ['fortnite.com'], [lea]]);
    assert.deepEqual(p.schedules.map((x) => [x.from, x.to, x.block]), [['22:00', '06:00', 'all']]);
    assert.equal((await ok('homes'))[0].profiles[1].linkedTo, kidsId);
    // the filter gets the home's content
    await waitFor(() => filterDenies('fortnite.com'));
    assert.deepEqual((await askFilter('fortnite.com', '10.8.0.21')).a, ['0.0.0.0']);
    // checks: unknown gateway / profile, default only with default, one home profile only once
    const bad = async (home, i = 1) => (await call('set', { profiles: (await ids()).map((x, j) => (j === i ? { ...x, home } : x)) }));
    assert.match((await bad({ gateway: 99999, profile: homeKids })).error, /profiles\[1\]\.home\.gateway/);
    assert.match((await bad({ gateway, profile: 'nope' })).error, /profiles\[1\]\.home\.profile/);
    assert.match((await bad({ gateway, profile: 'default' })).error, /default profile/);
    assert.match((await bad({ gateway, profile: homeKids }, 0)).error, /default profile/);
    assert.match((await bad({ gateway, profile: homeKids }, 2)).error, /shared already/);
  });

  it('a change here is written to the home (and told to its gateways); a change at home holds here', async () => {
    await patchKids({ deny: ['fortnite.com', 'roblox.com'], safeSearch: true, users: [lea, anna] });
    assert.deepEqual([homeProfile().deny, homeProfile().safeSearch, homeProfile().users], [['fortnite.com', 'roblox.com'], true, [anna, lea].sort((a, b) => a - b)]);
    assert.equal(homeProfile().name, 'Kinder zu Hause', 'each side keeps its name');
    assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE event_type = 'gateway_dns_profile_changed' AND details LIKE '%safeSearch%'").get());
    // a setting that has nothing to do with it writes nothing to the home
    const at = db.prepare('SELECT updated_at FROM gateway_dns WHERE peer_id = ?').get(gateway).updated_at;
    const logged = db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'vpn_dns_changed'").get().n;
    await ok('set', { blockResponse: 'zero' });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'vpn_dns_changed'").get().n, logged, 'nothing changed: nothing saved');
    assert.equal(db.prepare('SELECT updated_at FROM gateway_dns WHERE peer_id = ?').get(gateway).updated_at, at);
    // at home (the gateway page): the VPN devices follow without anybody touching the protection
    hd.updateProfile(gateway, homeKids, { deny: ['minecraft.net'], users: [lea] });
    assert.deepEqual([(await vpnKids()).deny, (await vpnKids()).users], [['minecraft.net'], [lea]]);
    await waitFor(() => filterDenies('minecraft.net'));
    assert.deepEqual((await askFilter('minecraft.net', '10.8.0.21')).a, ['0.0.0.0']);
    assert.deepEqual(vpnDns.stored().profiles.find((x) => x.id === kidsId).deny, ['minecraft.net'], 'the copy kept here is up to date');
    // what the home refuses is refused here, and nothing is half-written
    const r = await call('set', { profiles: (await ids()).map((x) => (x.id === kidsId ? { ...x, users: [lea], lists: ['ads'], home: { gateway, profile: homeKids } } : x)), blockResponse: 'nxdomain' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(homeProfile().lists, ['ads']);
    await ok('set', { blockResponse: 'zero' });
  });

  it('the profile is deleted at home → the link is dropped, the profile here keeps its content', async () => {
    hd.deleteProfile(gateway, homeKids);
    const p = await vpnKids();
    assert.deepEqual([p.home, p.deny, p.lists, p.users], [null, ['minecraft.net'], ['ads'], [lea]]);
    assert.equal(vpnDns.stored().profiles.find((x) => x.id === kidsId).home, null);
    assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE event_type = 'vpn_dns_home_unlinked'").get());
    assert.deepEqual((await askFilter('minecraft.net', '10.8.0.21')).a, ['0.0.0.0']);
  });

  it('the other way round: the home gets a profile of the protection; unlinked again both keep what they have', async () => {
    await patchKids({ home: { gateway, create: true } });
    const p = await vpnKids();
    assert.match(p.home.profile, /^p[0-9a-f]{8}$/);
    homeKids = p.home.profile;
    assert.deepEqual([homeProfile().name, homeProfile().deny, homeProfile().lists, homeProfile().users], ['Kinder', ['minecraft.net'], ['ads'], [lea]]);
    // the default profiles go with each other
    await ok('set', { profiles: (await ids()).map((x, i) => (i === 0 ? { ...x, home: { gateway, profile: 'default' } } : x)) });
    assert.deepEqual((await ok('get')).profiles[0].lists, ['ads', 'malware']);
    assert.equal((await ok('get')).profiles[0].home.profile, 'default');
    await ok('set', { profiles: (await ids()).map((x, i) => (i === 0 ? { ...x, home: null, lists: ['ads'] } : x)) });
    assert.deepEqual(hd.get(gateway).profiles[0].lists, ['ads', 'malware'], 'no longer shared: the home keeps its own');
    // a name the home has already: said with the field, nothing is saved
    hd.createProfile(gateway, { name: 'Büro' });
    const dup = await call('set', { profiles: (await ids()).map((x, i) => (i === 2 ? { ...x, home: { gateway, create: true } } : x)) });
    assert.equal(dup.code, 'ERR_INVALID');
    assert.match(dup.error, /profiles\[2\]\.home: .*name/);
    assert.equal((await ok('get')).profiles[2].home, null);
    // put back what the other tests expect
    await patchKids({ home: null });
    await patchKids({ lists: ['ads', 'adult'], safeSearch: true, deny: ['roblox.com'], users: [lea],
      schedules: [{ days: [1, 2, 3, 4, 5], from: '21:00', to: '07:00', block: 'categories', categories: ['social'] }, { days: [6, 7], from: '00:00', to: '24:00', block: 'all' }] });
    assert.deepEqual(homeProfile().deny, ['minecraft.net'], 'unlinked: the home is not written any more');
    await waitFor(() => filterDenies('roblox.com'));
  });
});

describe('outage', () => {
  it('plugins written for servers with Pi-hole: status().pihole says "none", releasePihole() does nothing', async () => {
    await freshRound();
    assert.equal(dnsChain.status().provider, 'vpnfilter');
    assert.deepEqual(dnsChain.status().displaced, []);
    const none = { configured: false, wantsChain: false, chain: 'off', targets: [] };
    const conf = fs.readFileSync(confPath, 'utf8');
    const before = restarts;
    assert.deepEqual((await ok('status')).pihole, none);
    assert.deepEqual(await ok('releasePihole'), none);
    assert.equal(fs.readFileSync(confPath, 'utf8'), conf, 'the chain is not touched');
    assert.equal(restarts, before);
    assert.equal(dnsChain.status().provider, 'vpnfilter');
    // … also when the protection does not filter and without an acting person (it used to refuse then)
    assert.deepEqual(vpnDns.releasePihole(), none);
    assert.deepEqual(await hostApi.handle({ id: P, manifest: { permissions: { vpnDns: true } } }, 'vpnDns.releasePihole', {}), none);
  });

  it('the service dies → fallback with notice, activity and event; it comes back → restored', async () => {
    const before = restarts;
    svc.stop();
    await freshRound();
    await dnsChain.tick();
    assert.equal(dnsChain.vpnFilter.status().state, 'fallback');
    assert.equal(restarts, before + 1);
    assert.doesNotMatch(fs.readFileSync(confPath, 'utf8'), /add-subnet|vpnfilter/);
    await vpnDns.tick();
    const st = await ok('status');
    assert.deepEqual([st.state, st.chain, st.service.running], ['fallback', 'default', false]);
    // fallen back: nothing is filtered, so nothing is rewritten or refused either — the rules are gone
    await vpnDns.syncFirewall();
    assert.deepEqual([st.foreignDns.enabled, (await ok('status')).foreignDns.active], [true, false]);
    assert.deepEqual([ipt.tables.nat.GC_VPNDNS_NAT, ipt.tables.filter.GC_VPNDNS_FWD, ipt.tables.nat.PREROUTING], [undefined, undefined, []]);
    const n = (await agent.get('/api/v1/system/dns/protection').expect(200)).body.notice;
    assert.equal(n.kind, 'fallback');
    assert.ok(Date.parse(n.since) > 0);
    assert.deepEqual(vpnDns.clientInfo(), { plugin: P, state: 'fallback' });
    const a = db.prepare("SELECT severity FROM activity_log WHERE event_type = 'vpn_dns_fallback'").all();
    assert.deepEqual(a, [{ severity: 'warning' }]);
    assert.equal((await call('restart')).ok, true, 'restart is possible while it is down');

    await startService();
    await freshRound();
    for (let i = 0; i < 2; i++) await dnsChain.tick();
    assert.equal(dnsChain.vpnFilter.status().state, 'vpnfilter');
    assert.equal((await ok('status')).state, 'filtering');
    await vpnDns.syncFirewall();
    assert.equal((await ok('status')).foreignDns.active, true, 'the filter answers again: the rules are back');
    assert.ok(ipt.tables.nat.GC_VPNDNS_NAT.length > 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'vpn_dns_restored'").get().n, 1);
    const ev = await waitFor(async () => {
      const e = (await agent.get(`/api/v1/plugins/${P}/api/events`).expect(200)).body.events.map((x) => x.type);
      return e.includes('restored') ? e : null;
    });
    assert.deepEqual(ev.slice(-2), ['fallback', 'restored']);
  });

  it('"Filter-Dienst neu starten": the service is told to leave (its wrapper starts it again)', async () => {
    await vpnDns.tick();
    const r = await ok('restart');
    assert.deepEqual(r, { restarting: true, how: 'asked' });
    await waitFor(() => svc.exited === true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'vpn_dns_service_restart'").get().n, 2);
    await startService();
  });
});

describe('switched off again', () => {
  it('the plugin is disabled → the service leaves, the chain is released, dnsmasq is back on its defaults', async () => {
    await freshRound();
    for (let i = 0; i < 2; i++) await dnsChain.tick();
    assert.equal(dnsChain.vpnFilter.status().state, 'vpnfilter');
    await agent.post(`/api/v1/plugins/${P}/disable`).set('X-CSRF-Token', csrf).send({}).expect(200);
    await waitFor(() => vpnDns._run.wanted === false);
    assert.equal(vpnDns.available(), false);
    assert.equal(fs.existsSync(path.join(STATE, 'enabled')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(STATE, 'config.json'), 'utf8')).enabled, false);
    await waitFor(() => svc.exited === true);
    await freshRound();
    assert.equal(dnsChain.vpnFilter.status().state, 'off');
    assert.equal(dnsChain.status().provider, null);
    assert.doesNotMatch(fs.readFileSync(confPath, 'utf8'), /add-subnet|vpnfilter/);
    assert.equal(vpnDns.notice(), null);
    // the plugin is gone: so are the firewall rules, to the last one
    await vpnDns.syncFirewall();
    assert.deepEqual(ipt.tables, {
      nat: { PREROUTING: [], POSTROUTING: ['-s 10.8.0.0/24 -o eth0 -j MASQUERADE'] },
      filter: { INPUT: [], FORWARD: ['-i wg0 -j ACCEPT', '-i eth0 -o wg0 -m state --state RELATED,ESTABLISHED -j ACCEPT'] },
    });
    assert.equal(fs.existsSync(path.join(STATE, fw.MARKER)), false);
    assert.equal(vpnDns.clientInfo(), null);
    assert.equal(vpnDns.clientPlugin(), null, 'a plugin that may not run does not serve the apps');
    assert.deepEqual(vpnDns.installedPlugin(), { id: P, usable: false });
    assert.equal(vpnDns.get().enabled, true, 'the settings stay for when the plugin comes back');

    // enabled again: back on without touching the settings
    await agent.post(`/api/v1/plugins/${P}/enable`).set('X-CSRF-Token', csrf).send({}).expect(200);
    await waitFor(() => vpnDns._run.wanted === true);
    assert.ok(fs.existsSync(path.join(STATE, 'enabled')));
    assert.equal(await runtime.waitRunning(P), true);
    // back on (the service of this test is gone, so the filter does not filter yet): still no rule
    await vpnDns.syncFirewall();
    assert.equal(ipt.tables.nat.GC_VPNDNS_NAT, undefined);
    await ok('pause', { scope: 'all', forever: true });
    await ok('set', { enabled: false });
    assert.equal(vpnDns._run.wanted, false);
    assert.equal(fs.existsSync(path.join(STATE, 'enabled')), false);
    assert.deepEqual(vpnDns.pauses(), [], 'switched off: no suspension waits for the next time');
  });

  it('the plugin is uninstalled while the protection is on → off, the settings stay', async () => {
    await ok('set', { enabled: true });
    assert.equal(vpnDns._run.wanted, true);
    await agent.post(`/api/v1/plugins/${P}/uninstall`).set('X-CSRF-Token', csrf).send({ mode: 'keep' }).expect(200);
    assert.equal(vpnDns._run.wanted, false);
    assert.equal(vpnDns.available(), false);
    assert.equal(fs.existsSync(path.join(STATE, 'enabled')), false);
    assert.equal(dnsChain.vpnFilter.status().state, 'off');
    assert.equal(vpnDns.get().enabled, true);
    assert.equal(vpnDns.status().state, 'off');
    assert.equal(vpnDns.clientPlugin(), null);
    assert.equal(vpnDns.installedPlugin(), null);
  });
});
