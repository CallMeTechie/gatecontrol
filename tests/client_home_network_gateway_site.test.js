'use strict';

// GET /api/v1/client/home-network — gateway sites: the server runs outside
// the home (VPS), the home LAN is reached through a gateway peer that reports
// its LAN subnets. same_lan / site.type 'gateway' only when the device shares
// the public address of an enabled, online gateway (IPv4 exact, IPv6 same
// /64, never across families) AND one of its `local` addresses lies in a LAN
// subnet that gateway reports. Tunnel and direct requests. A false "home"
// switches the VPN off in a foreign network — every doubt is "no".

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');
const H = require('./helpers/notify');
const config = require('../config/default');

const PATH = '/api/v1/client/home-network';

const v4 = (address, bits, extra = {}) => ({
  address, family: 'IPv4', internal: false, mac: '00:00:00:00:00:00', netmask: '255.255.255.0', cidr: `${address}/${bits}`, ...extra,
});

// A VPS: only a public address and the WireGuard interface → lan: [].
const VPS = () => ({
  lo: [v4('127.0.0.1', 8, { internal: true })],
  eth0: [v4('85.10.1.2', 24)],
  [config.wireguard.interface]: [v4('10.8.0.1', 24)],
});
// A host in its own LAN 192.168.1.0/24 (server rule possible).
const LANHOST = () => ({
  eth0: [v4('192.168.1.10', 24)],
  [config.wireguard.interface]: [v4('10.8.0.1', 24)],
});
const ROUTES = [
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
  'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
  'eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0',
  '',
].join('\n');

const HOME4 = '84.17.20.30';          // public IPv4 of the home router
const HOME6 = '2a01:4f8:c0c:1a2b';    // the home's IPv6 /64
const HOME_LAN = '192.168.27.0/24';

let app, homeNetwork, wireguard, realStatus, anna;
let wgPeers = [];
let gwSeq = 0;

before(async () => {
  ({ app } = await setup());
  homeNetwork = require('../src/services/homeNetwork');
  wireguard = require('../src/services/wireguard');
  realStatus = wireguard.getStatus;
  anna = H.makeUser('hs-anna');
});
after(() => {
  homeNetwork._setInterfacesForTest(null);
  homeNetwork._setRouteTableForTest(null);
  wireguard.getStatus = realStatus;
  teardown();
});
beforeEach(() => {
  // Earlier tests' gateways must not answer for later ones.
  H.db().prepare("UPDATE peers SET enabled = 0 WHERE peer_type = 'gateway'").run();
  homeNetwork._setInterfacesForTest(VPS);
  homeNetwork._setRouteTableForTest(() => ROUTES);
  wgPeers = [];
  wireguard.getStatus = async () => ({ running: true, interface: null, peers: wgPeers });
});

/** Gateway peer + gateway_meta with the reported LAN subnets. */
function makeGateway(name, subnets = [HOME_LAN], { enabled = 1, health } = {}) {
  gwSeq += 1;
  const key = crypto.randomBytes(16).toString('base64');
  const id = Number(H.db().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES (?, ?, ?, ?, 'gateway')")
    .run(name, key, `10.8.0.${200 + (gwSeq % 50)}/32`, enabled).lastInsertRowid);
  const lastHealth = health !== undefined ? health
    : JSON.stringify({ telemetry: { lan_subnets: subnets.map((cidr, i) => ({ iface: 'eth0', cidr, primary: i === 0 })) } });
  H.db().prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, last_health)
    VALUES (?, 9876, ?, 'e', ?, ?)`).run(id, `h-${id}-${gwSeq}`, Date.now(), lastHealth);
  return { id, key, name };
}

const now = () => Math.floor(Date.now() / 1000);
const wgEntry = (publicKey, endpoint, { online = true, age = 5 } = {}) => ({
  publicKey, endpoint, isOnline: online, latestHandshake: now() - age,
});
const keyOf = (dev) => H.db().prepare('SELECT public_key FROM peers WHERE id = ?').get(dev.peerId).public_key;

function get(dev, { xff, local, rawQuery } = {}) {
  let r = supertest(app).get(PATH);
  if (local !== undefined) r = r.query({ local });
  if (rawQuery !== undefined) r = r.query(rawQuery);
  r = r.set('X-API-Token', dev.raw).set('X-Client-Platform', 'android');
  return xff ? r.set('X-Forwarded-For', xff) : r;
}
const device = (label) => H.makeDevice(anna, { name: label });

describe('gateway site — direct request (VPN off)', () => {
  it('IPv4: same public address + local address in the gateway\'s LAN → home, site gateway', async () => {
    const gw = makeGateway('DS218+');
    wgPeers = [wgEntry(gw.key, `${HOME4}:41641`)];
    const dev = device('hs-d4');
    const r = await get(dev, { xff: HOME4, local: '192.168.27.55' }).expect(200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(r.body).sort(), ['lan', 'ok', 'same_lan', 'site', 'via']);
    assert.equal(r.body.same_lan, true);
    assert.equal(r.body.via, 'direct');
    assert.deepEqual(r.body.lan, []);
    assert.deepEqual(r.body.site, { type: 'gateway', gatewayId: gw.id, name: 'DS218+' });
    // IPv4-mapped source, several local addresses (one of them matching)
    const m = await get(dev, { xff: `::ffff:${HOME4}`, local: '10.0.0.5,192.168.27.55' }).expect(200);
    assert.equal(m.body.same_lan, true);
  });

  it('IPv4: a different public address → no', async () => {
    const gw = makeGateway('gw-other-ip');
    wgPeers = [wgEntry(gw.key, `${HOME4}:41641`)];
    const r = await get(device('hs-d4-no'), { xff: '84.17.20.31', local: '192.168.27.55' }).expect(200);
    assert.deepEqual([r.body.same_lan, r.body.site], [false, null]);
  });

  it('only Caddy\'s hop counts: an X-Forwarded-For chain is judged by its last (proxy-added) address', async () => {
    const gw = makeGateway('gw-xff');
    wgPeers = [wgEntry(gw.key, `${HOME4}:41641`)];
    const dev = device('hs-xff');
    const r = await get(dev, { xff: `${HOME4}, 9.9.9.9`, local: '192.168.27.55' }).expect(200);
    assert.equal(r.body.same_lan, false, 'client-supplied first entry ignored');
    const ok = await get(dev, { xff: `9.9.9.9, ${HOME4}`, local: '192.168.27.55' }).expect(200);
    assert.equal(ok.body.same_lan, true);
    const raw = await get(dev, { local: '192.168.27.55' }).expect(200); // loopback, no header
    assert.equal(raw.body.same_lan, false);
  });

  it('IPv6: same /64 → home; another /64 → no', async () => {
    const gw = makeGateway('gw-v6');
    wgPeers = [wgEntry(gw.key, `[${HOME6}::8]:51820`)];
    const dev = device('hs-d6');
    const r = await get(dev, { xff: `${HOME6}:abcd:1234:5678:9abc`, local: '192.168.27.55' }).expect(200);
    assert.equal(r.body.same_lan, true);
    assert.equal(r.body.site.type, 'gateway');
    const no = await get(dev, { xff: '2a01:4f8:c0c:1a2c::8', local: '192.168.27.55' }).expect(200);
    assert.equal(no.body.same_lan, false);
  });

  it('mixed families never match', async () => {
    const gw4 = makeGateway('gw-mixed-4');
    wgPeers = [wgEntry(gw4.key, `${HOME4}:41641`)];
    const dev = device('hs-mixed');
    assert.equal((await get(dev, { xff: `${HOME6}::77`, local: '192.168.27.55' }).expect(200)).body.same_lan, false, 'v6 device, v4 gateway');
    wgPeers = [wgEntry(gw4.key, `[${HOME6}::8]:41641`)];
    assert.equal((await get(dev, { xff: HOME4, local: '192.168.27.55' }).expect(200)).body.same_lan, false, 'v4 device, v6 gateway');
  });

  it('non-public "public" addresses never match (LAN proxy / SNAT router / CGNAT / reserved)', async () => {
    const gw = makeGateway('gw-private-ep');
    const dev = device('hs-private');
    for (const addr of ['192.168.1.1', '10.1.2.3', '100.64.7.8', '127.0.0.1', '203.0.113.9']) {
      wgPeers = [wgEntry(gw.key, `${addr}:41641`)];
      const r = await get(dev, { xff: addr, local: '192.168.27.55' }).expect(200);
      assert.equal(r.body.same_lan, false, addr);
    }
    for (const addr of ['fd00::1', 'fe80::1']) {
      wgPeers = [wgEntry(gw.key, `[${addr}]:41641`)];
      const r = await get(dev, { xff: addr, local: '192.168.27.55' }).expect(200);
      assert.equal(r.body.same_lan, false, addr);
    }
  });
});

describe('gateway site — request through the tunnel (VPN on)', () => {
  it('IPv4: the token peer\'s current endpoint equals the gateway\'s → home', async () => {
    const gw = makeGateway('gw-tun');
    const dev = device('hs-t4');
    wgPeers = [wgEntry(gw.key, `${HOME4}:41641`), wgEntry(keyOf(dev), `${HOME4}:60123`)];
    const r = await get(dev, { xff: dev.ip, local: '192.168.27.55' }).expect(200);
    assert.equal(r.body.same_lan, true);
    assert.equal(r.body.via, 'tunnel');
    assert.deepEqual(r.body.site, { type: 'gateway', gatewayId: gw.id, name: 'gw-tun' });
  });

  it('IPv6: same /64 → home; other /64 or mixed family → no', async () => {
    const gw = makeGateway('gw-tun6');
    const dev = device('hs-t6');
    wgPeers = [wgEntry(gw.key, `[${HOME6}::8]:51820`), wgEntry(keyOf(dev), `[${HOME6}:1::99]:60123`)];
    assert.equal((await get(dev, { xff: dev.ip, local: '192.168.27.55' }).expect(200)).body.same_lan, true);
    wgPeers = [wgEntry(gw.key, `[${HOME6}::8]:51820`), wgEntry(keyOf(dev), '[2a01:4f8:c0c:9999::99]:60123')];
    assert.equal((await get(dev, { xff: dev.ip, local: '192.168.27.55' }).expect(200)).body.same_lan, false, 'other /64');
    wgPeers = [wgEntry(gw.key, `[${HOME6}::8]:51820`), wgEntry(keyOf(dev), `${HOME4}:60123`)];
    assert.equal((await get(dev, { xff: dev.ip, local: '192.168.27.55' }).expect(200)).body.same_lan, false, 'mixed');
  });

  it('no: another tunnel address, token peer offline / stale / without endpoint / disabled, token without peer', async () => {
    const gw = makeGateway('gw-tun-no');
    const dev = device('hs-tno');
    const q = { local: '192.168.27.55' };
    wgPeers = [wgEntry(gw.key, `${HOME4}:41641`), wgEntry(keyOf(dev), `${HOME4}:60123`)];
    assert.equal((await get(dev, { ...q, xff: '10.8.0.254' }).expect(200)).body.same_lan, false, 'not the token peer\'s address');
    // via tunnel: the request's own X-Forwarded-For (the WG address) is the device — no fallback to anything else
    for (const [entry, label] of [
      [wgEntry(keyOf(dev), `${HOME4}:60123`, { online: false }), 'offline'],
      [wgEntry(keyOf(dev), `${HOME4}:60123`, { age: 200 }), 'stale handshake'],
      [wgEntry(keyOf(dev), null), 'no endpoint'],
    ]) {
      wgPeers = [wgEntry(gw.key, `${HOME4}:41641`), entry];
      assert.equal((await get(dev, { ...q, xff: dev.ip }).expect(200)).body.same_lan, false, label);
    }
    wgPeers = [wgEntry(gw.key, `${HOME4}:41641`)];
    assert.equal((await get(dev, { ...q, xff: dev.ip }).expect(200)).body.same_lan, false, 'not in wg show');
    wgPeers = [wgEntry(gw.key, `${HOME4}:41641`), wgEntry(keyOf(dev), `${HOME4}:60123`)];
    H.db().prepare('UPDATE peers SET enabled = 0 WHERE id = ?').run(dev.peerId);
    try {
      assert.equal((await get(dev, { ...q, xff: dev.ip }).expect(200)).body.same_lan, false, 'disabled token peer');
    } finally { H.db().prepare('UPDATE peers SET enabled = 1 WHERE id = ?').run(dev.peerId); }
    assert.equal((await get(dev, { ...q, xff: dev.ip }).expect(200)).body.same_lan, true, 'enabled again');

    const t = require('../src/services/tokens').create({ name: H.uniq('hs-nopeer'), scopes: ['client'], userId: anna, peerId: null }, '127.0.0.1');
    const r = await supertest(app).get(PATH).query(q).set('X-API-Token', t.rawToken).set('X-Forwarded-For', dev.ip).expect(200);
    assert.equal(r.body.same_lan, false, 'tunnel request with a peer-less token');
  });
});

describe('gateway site — gateway state', () => {
  it('stale handshake, offline, no endpoint, not in wg show → no', async () => {
    const gw = makeGateway('gw-stale');
    const dev = device('hs-stale');
    for (const [entries, label] of [
      [[wgEntry(gw.key, `${HOME4}:41641`, { age: 181 })], 'handshake older than 3 min'],
      [[wgEntry(gw.key, `${HOME4}:41641`, { age: 1000 })], 'long stale'],
      [[wgEntry(gw.key, `${HOME4}:41641`, { online: false })], 'offline'],
      [[{ publicKey: gw.key, endpoint: `${HOME4}:41641`, isOnline: true, latestHandshake: 0 }], 'never'],
      [[wgEntry(gw.key, null)], 'no endpoint'],
      [[wgEntry(gw.key, 'garbage')], 'unparsable endpoint'],
      [[], 'not in wg show'],
    ]) {
      wgPeers = entries;
      const r = await get(dev, { xff: HOME4, local: '192.168.27.55' }).expect(200);
      assert.deepEqual([r.body.same_lan, r.body.site], [false, null], label);
    }
    wgPeers = [wgEntry(gw.key, `${HOME4}:41641`, { age: 170 })];
    assert.equal((await get(dev, { xff: HOME4, local: '192.168.27.55' }).expect(200)).body.same_lan, true, 'fresh enough');
  });

  it('wg error or WireGuard down → no', async () => {
    const gw = makeGateway('gw-wgerr');
    const dev = device('hs-wgerr');
    wireguard.getStatus = async () => { throw new Error('wg missing'); };
    assert.equal((await get(dev, { xff: HOME4, local: '192.168.27.55' }).expect(200)).body.same_lan, false);
    wireguard.getStatus = async () => ({ running: false, interface: null, peers: [wgEntry(gw.key, `${HOME4}:41641`)] });
    assert.equal((await get(dev, { xff: HOME4, local: '192.168.27.55' }).expect(200)).body.same_lan, false);
  });

  it('disabled gateway → no', async () => {
    const gw = makeGateway('gw-disabled', [HOME_LAN], { enabled: 0 });
    wgPeers = [wgEntry(gw.key, `${HOME4}:41641`)];
    const r = await get(device('hs-dis'), { xff: HOME4, local: '192.168.27.55' }).expect(200);
    assert.equal(r.body.same_lan, false);
  });

  it('a regular peer is no gateway, even with gateway_meta-like data elsewhere', async () => {
    const other = device('hs-regular');
    wgPeers = [wgEntry(keyOf(other), `${HOME4}:41641`)];
    const r = await get(device('hs-reg-ask'), { xff: HOME4, local: '192.168.27.55' }).expect(200);
    assert.equal(r.body.same_lan, false);
  });

  it('unusable reported subnets are ignored (public, wider than an RFC 1918 block, WG overlap, garbage)', async () => {
    const dev = device('hs-subnets');
    for (const [subnets, local, label] of [
      [['0.0.0.0/0'], '192.168.27.55', '/0'],
      [['10.0.0.0/7'], '10.1.2.3', '/7 across 10/8'],
      [['172.0.0.0/8'], '172.16.1.2', '172/8'],
      [['192.0.0.0/8'], '192.168.27.55', '192/8'],
      [['84.17.20.0/24'], '192.168.27.55', 'public subnet'],
      [['10.8.0.0/16'], '10.8.5.5', 'contains the WG subnet'],
      [['192.168.27.55'], '192.168.27.55', 'no prefix'],
      [['fd00::/64'], '192.168.27.55', 'IPv6'],
      [['nonsense'], '192.168.27.55', 'garbage'],
    ]) {
      const gw = makeGateway(`gw-sub-${label}`, subnets);
      wgPeers = [wgEntry(gw.key, `${HOME4}:41641`)];
      const r = await get(dev, { xff: HOME4, local }).expect(200);
      assert.equal(r.body.same_lan, false, label);
      H.db().prepare('UPDATE peers SET enabled = 0 WHERE id = ?').run(gw.id);
    }
    for (const [health, label] of [[null, 'no health'], ['{', 'broken JSON'], ['{"telemetry":{}}', 'no lan_subnets'], ['{"telemetry":{"lan_subnets":"x"}}', 'not a list']]) {
      const gw = makeGateway(`gw-h-${label}`, [], { health });
      wgPeers = [wgEntry(gw.key, `${HOME4}:41641`)];
      assert.equal((await get(dev, { xff: HOME4, local: '192.168.27.55' }).expect(200)).body.same_lan, false, label);
      H.db().prepare('UPDATE peers SET enabled = 0 WHERE id = ?').run(gw.id);
    }
  });

  it('several gateways: the one at the device\'s public address answers; with two matches the lowest id', async () => {
    const a = makeGateway('gw-a', ['192.168.10.0/24']);
    const b = makeGateway('gw-b', [HOME_LAN, '10.10.0.0/16']);
    const dev = device('hs-multi');
    wgPeers = [wgEntry(a.key, '91.1.1.1:41641'), wgEntry(b.key, `${HOME4}:41641`)];
    let r = await get(dev, { xff: HOME4, local: '10.10.3.4' }).expect(200);
    assert.deepEqual(r.body.site, { type: 'gateway', gatewayId: b.id, name: 'gw-b' }, 'second reported subnet');
    r = await get(dev, { xff: HOME4, local: '192.168.10.5' }).expect(200);
    assert.equal(r.body.same_lan, false, 'subnet of gateway a, public address of gateway b');
    r = await get(dev, { xff: '91.1.1.1', local: '192.168.10.5' }).expect(200);
    assert.equal(r.body.site.gatewayId, a.id);
    const c = makeGateway('gw-c', [HOME_LAN]);
    wgPeers = [wgEntry(a.key, '91.1.1.1:41641'), wgEntry(c.key, `${HOME4}:5000`), wgEntry(b.key, `${HOME4}:41641`)];
    r = await get(dev, { xff: HOME4, local: '192.168.27.55' }).expect(200);
    assert.equal(r.body.site.gatewayId, b.id, 'b and c both match → lowest id');
  });
});

describe('gateway site — the device\'s local addresses', () => {
  it('missing or invalid `local` → no (CGNAT defence: the public address alone never decides)', async () => {
    const gw = makeGateway('gw-local');
    wgPeers = [wgEntry(gw.key, `${HOME4}:41641`)];
    const dev = device('hs-local');
    assert.equal((await get(dev, { xff: HOME4 }).expect(200)).body.same_lan, false, 'no local');
    for (const local of [
      '', ',', 'abc', '192.168.27', '192.168.27.555', '192.168.027.55', '192.168.27.55/24', ' 192.168.27.0x37',
      '8.8.8.8', '100.64.1.1', '169.254.1.1', '10.8.0.9', `${HOME6}::5`, '::ffff:192.168.27.55',
      `${'1'.repeat(130)},192.168.27.55`,
    ]) {
      const r = await get(dev, { xff: HOME4, local }).expect(200);
      assert.equal(r.body.same_lan, false, JSON.stringify(local));
    }
    // a repeated parameter (array) is ignored as a whole
    const arr = await get(dev, { xff: HOME4, rawQuery: 'local=192.168.27.55&local=192.168.27.56' }).expect(200);
    assert.equal(arr.body.same_lan, false, 'repeated parameter');
  });

  it('local address outside every gateway subnet → no; at most the first four entries count', async () => {
    const gw = makeGateway('gw-local2');
    wgPeers = [wgEntry(gw.key, `${HOME4}:41641`)];
    const dev = device('hs-local2');
    assert.equal((await get(dev, { xff: HOME4, local: '192.168.28.5,10.0.0.2' }).expect(200)).body.same_lan, false);
    assert.equal((await get(dev, { xff: HOME4, local: '10.0.0.1,10.0.0.2,10.0.0.3,10.0.0.4,192.168.27.55' }).expect(200)).body.same_lan, false, '5th');
    assert.equal((await get(dev, { xff: HOME4, local: 'junk,10.0.0.2,10.0.0.3,192.168.27.55' }).expect(200)).body.same_lan, true, '4th');
    assert.equal((await get(dev, { xff: HOME4, local: ' 192.168.27.55 ' }).expect(200)).body.same_lan, true, 'trimmed');
  });

  it('CGNAT: same public address, different private subnet → no', async () => {
    // Two households behind one carrier address: the gateway's home uses
    // 192.168.27.0/24, the neighbour's phone sits in 192.168.178.0/24.
    const gw = makeGateway('gw-cgnat', [HOME_LAN]);
    const dev = device('hs-cgnat');
    wgPeers = [wgEntry(gw.key, `${HOME4}:41641`), wgEntry(keyOf(dev), `${HOME4}:33333`)];
    assert.equal((await get(dev, { xff: HOME4, local: '192.168.178.20' }).expect(200)).body.same_lan, false, 'direct');
    assert.equal((await get(dev, { xff: dev.ip, local: '192.168.178.20' }).expect(200)).body.same_lan, false, 'tunnel');
  });
});

describe('server rule and gateway rule together', () => {
  it('server rule: site { type: "server" }; it wins when both match', async () => {
    homeNetwork._setInterfacesForTest(LANHOST);
    const gw = makeGateway('gw-both', ['192.168.1.0/24']);
    const dev = device('hs-both');
    wgPeers = [wgEntry(keyOf(dev), '192.168.1.50:51820')];
    let r = await get(dev, { xff: dev.ip }).expect(200);
    assert.deepEqual([r.body.same_lan, r.body.site], [true, { type: 'server' }]);
    wgPeers = [wgEntry(keyOf(dev), '192.168.1.50:51820'), wgEntry(gw.key, `${HOME4}:41641`)];
    r = await get(dev, { xff: dev.ip, local: '192.168.1.50' }).expect(200);
    assert.deepEqual(r.body.site, { type: 'server' });
    // server rule stays tunnel-only: a direct LAN source is neither rule
    r = await get(dev, { xff: '192.168.1.50', local: '192.168.1.50' }).expect(200);
    assert.deepEqual([r.body.same_lan, r.body.site, r.body.via], [false, null, 'direct']);
  });

  it('never logs the device\'s addresses above debug level', async () => {
    const logger = require('../src/utils/logger');
    const gw = makeGateway('gw-log');
    wgPeers = [wgEntry(gw.key, `${HOME4}:41641`)];
    const seen = [];
    const orig = {};
    for (const lvl of ['info', 'warn', 'error']) {
      orig[lvl] = logger[lvl];
      logger[lvl] = (...args) => { seen.push(JSON.stringify(args)); };
    }
    try {
      const dev = device('hs-log');
      await get(dev, { xff: HOME4, local: '192.168.27.55' }).expect(200);
      await get(dev, { xff: HOME4, local: '192.168.99.1' }).expect(200);
    } finally { for (const lvl of Object.keys(orig)) logger[lvl] = orig[lvl]; }
    assert.ok(!seen.some((s) => s.includes('192.168.27.55') || s.includes('192.168.99.1') || s.includes(HOME4)), seen.join('\n'));
  });
});
