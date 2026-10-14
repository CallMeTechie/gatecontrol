'use strict';

// GET /api/v1/client/home-network — trusted-network detection of the apps
// ("is the device in the server's own home LAN?"): the LAN list (private
// IPv4 only, no WireGuard / container interfaces, dedupe, max 8), same_lan
// only through the tunnel (the token peer's current WireGuard endpoint inside
// an included LAN subnet, not a default gateway; route table unreadable →
// false), never for direct requests, auth, no-store. A false "true" would
// switch the VPN off in a foreign network. The gateway-site rule (server
// outside the home) is covered in client_home_network_gateway_site.test.js.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');
const H = require('./helpers/notify');
const config = require('../config/default');

const PATH = '/api/v1/client/home-network';

const v4 = (address, cidrBits, extra = {}) => ({
  address, family: 'IPv4', internal: false, mac: '00:00:00:00:00:00',
  netmask: maskOf(cidrBits), cidr: `${address}/${cidrBits}`, ...extra,
});
function maskOf(bits) {
  const n = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}

// A host with a real LAN (eth0, wlan0), WireGuard, Docker and other virtual
// interfaces, a public address and an address inside the WG subnet.
const HOST = () => ({
  lo: [v4('127.0.0.1', 8, { internal: true }), { address: '::1', family: 'IPv6', internal: true, netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', cidr: '::1/128' }],
  wlan0: [v4('10.20.0.5', 16)],
  eth0: [
    v4('192.168.1.10', 24),
    { address: 'fe80::1', family: 'IPv6', internal: false, netmask: 'ffff:ffff:ffff:ffff::', cidr: 'fe80::1/64', scopeid: 2 },
    v4('203.0.113.5', 24),
    v4('169.254.10.10', 16),
  ],
  eth1: [v4('10.8.0.200', 24)], // inside the WG subnet on a non-WG interface
  eth2: [v4('192.168.1.10', 24)], // duplicate address
  [config.wireguard.interface]: [v4('10.8.0.1', 24)],
  docker0: [v4('172.17.0.1', 16)],
  'br-0a1b2c3d4e5f': [v4('172.18.0.1', 16)],
  veth12ab: [v4('192.168.50.1', 24)],
  virbr0: [v4('192.168.122.1', 24)],
  tailscale0: [v4('10.64.0.1', 10)],
  zt0: [v4('10.147.17.1', 24)],
  tun0: [v4('10.99.0.1', 24)],
  podman1: [v4('10.88.0.1', 16)],
  cni0: [v4('10.42.0.1', 24)],
  wg1: [v4('10.66.0.1', 24)],
});

// /proc/net/route of that host: default routes via 192.168.1.1 (eth0) and
// 10.20.0.1 (wlan0, higher metric), plus the connected LAN routes.
const ROUTES = [
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
  'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
  'wlan0\t00000000\t0100140A\t0003\t0\t0\t600\t00000000\t0\t0\t0',
  'eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0',
  'wlan0\t0000140A\t00000000\t0001\t0\t0\t600\t0000FFFF\t0\t0\t0',
  '',
].join('\n');

let app, agent, homeNetwork, wireguard, realStatus, anna, adminId;
let wgPeers = [];

before(async () => {
  ({ app, agent } = await setup());
  homeNetwork = require('../src/services/homeNetwork');
  wireguard = require('../src/services/wireguard');
  realStatus = wireguard.getStatus;
  homeNetwork._setInterfacesForTest(HOST);
  anna = H.makeUser('hn-anna');
  adminId = H.db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
});
after(() => {
  homeNetwork._setInterfacesForTest(null);
  homeNetwork._setRouteTableForTest(null);
  wireguard.getStatus = realStatus;
  teardown();
});
beforeEach(() => {
  homeNetwork._setInterfacesForTest(HOST);
  homeNetwork._setRouteTableForTest(() => ROUTES);
  wgPeers = [];
  wireguard.getStatus = async () => ({ running: true, interface: null, peers: wgPeers });
});

const get = (dev, xff) => {
  const r = supertest(app).get(PATH).set('X-API-Token', dev.raw).set('X-Client-Platform', 'android');
  return xff ? r.set('X-Forwarded-For', xff) : r;
};
const keyOf = (dev) => H.db().prepare('SELECT public_key FROM peers WHERE id = ?').get(dev.peerId).public_key;
const wgPeer = (dev, endpoint, online = true) => ({ publicKey: keyOf(dev), endpoint, isOnline: online, latestHandshake: Math.floor(Date.now() / 1000) });

describe('GET /api/v1/client/home-network — access', () => {
  it('401 without a token, 403 for a session and for tokens without the client scope', async () => {
    await supertest(app).get(PATH).expect(401);
    const s = await agent.get(PATH).expect(403);
    assert.equal(s.body.error, 'token_required');
    // read-only may GET almost anything — but not this (admin owner: user-role tokens never carry read-only)
    const ro = H.makeDevice(adminId, { name: 'hn-ro', scopes: ['read-only'] });
    const r = await supertest(app).get(PATH).set('X-API-Token', ro.raw).expect(403);
    assert.equal(r.body.error, 'scope_required');
    const peersOnly = H.makeDevice(anna, { name: 'hn-peers', scopes: ['peers'] });
    await supertest(app).get(PATH).set('X-API-Token', peersOnly.raw).expect(403);
  });

  it('client and full-access tokens: 200 with Cache-Control: no-store and the fixed shape', async () => {
    for (const [owner, scopes] of [[() => anna, ['client']], [() => adminId, ['full-access']]]) {
      const dev = H.makeDevice(owner(), { name: 'hn-ok', scopes });
      const r = await get(dev).expect(200);
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.deepEqual(Object.keys(r.body).sort(), ['lan', 'ok', 'same_lan', 'site', 'via']);
      assert.equal(r.body.site, null);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.same_lan, false, 'loopback (no proxy header) is not the LAN');
      assert.equal(r.body.via, 'direct');
    }
  });
});

describe('lan — the server\'s own LAN addresses', () => {
  it('RFC 1918 IPv4 only; WireGuard, WG subnet, container/virtual interfaces, loopback, public and link-local excluded; deduplicated', async () => {
    const dev = H.makeDevice(anna, { name: 'hn-lan' });
    const r = await get(dev).expect(200);
    assert.deepEqual(r.body.lan, ['192.168.1.10', '10.20.0.5']);
  });

  it('at most 8, stable order (interface name, then address)', async () => {
    const many = [];
    for (let i = 12; i >= 1; i -= 1) many.push(v4(`192.168.${i}.2`, 24));
    homeNetwork._setInterfacesForTest(() => ({ ens3: many, ens2: [v4('10.1.0.2', 24), v4('172.31.255.1', 24)] }));
    const dev = H.makeDevice(anna, { name: 'hn-max' });
    const a = (await get(dev).expect(200)).body.lan;
    assert.equal(a.length, 8);
    assert.deepEqual(a, ['10.1.0.2', '172.31.255.1', '192.168.1.2', '192.168.2.2', '192.168.3.2', '192.168.4.2', '192.168.5.2', '192.168.6.2']);
    assert.deepEqual((await get(dev).expect(200)).body.lan, a);
  });

  it('172.16/12 boundary: 172.32.x and 172.15.x are not private', async () => {
    homeNetwork._setInterfacesForTest(() => ({ eth0: [v4('172.15.0.2', 24), v4('172.32.0.2', 24), v4('172.16.0.2', 24), v4('100.64.0.2', 10)] }));
    const dev = H.makeDevice(anna, { name: 'hn-172' });
    assert.deepEqual((await get(dev).expect(200)).body.lan, ['172.16.0.2']);
  });

  it('a failing interface scan yields an empty list and same_lan false', async () => {
    homeNetwork._setInterfacesForTest(() => { throw new Error('boom'); });
    const dev = H.makeDevice(anna, { name: 'hn-boom' });
    wgPeers = [wgPeer(dev, '192.168.1.50:51820')];
    const r = await get(dev, dev.ip).expect(200);
    assert.deepEqual(r.body.lan, []);
    assert.equal(r.body.same_lan, false);
  });
});

describe('same_lan — direct request (never trusted)', () => {
  it('false even from inside an included LAN subnet: a LAN reverse proxy or an SNAT-ing router makes internet clients look like LAN sources', async () => {
    const dev = H.makeDevice(anna, { name: 'hn-direct' });
    wgPeers = [wgPeer(dev, '192.168.1.50:51820')]; // even with a LAN endpoint
    for (const ip of ['192.168.1.50', '10.20.3.4', '::ffff:192.168.1.1', '192.168.1.1', '203.0.113.77', '8.8.8.8', '172.17.0.5', '192.168.1.10', '2001:db8::1']) {
      const r = await get(dev, ip).expect(200);
      assert.equal(r.body.same_lan, false, ip);
      assert.equal(r.body.via, 'direct', ip);
    }
    const r = await get(dev).expect(200); // loopback, no proxy header
    assert.deepEqual([r.body.same_lan, r.body.via], [false, 'direct']);
  });

  it('a WG-subnet address on a LAN-looking interface is not part of the LAN', async () => {
    homeNetwork._setInterfacesForTest(() => ({ eth0: [v4('10.8.0.200', 16), v4('192.168.1.10', 24)] }));
    const dev = H.makeDevice(anna, { name: 'hn-wgsub' });
    wgPeers = [wgPeer(dev, '10.8.0.150:51820')];
    const r = await get(dev, dev.ip).expect(200);
    assert.deepEqual(r.body.lan, ['192.168.1.10']);
    assert.equal(r.body.same_lan, false, 'endpoint inside the WG subnet');
    assert.equal(r.body.via, 'tunnel');
  });
});

describe('same_lan — request through the tunnel (VPN up)', () => {
  it('true when the token peer\'s current WireGuard endpoint lies in an included LAN subnet', async () => {
    const dev = H.makeDevice(anna, { name: 'hn-tun' });
    wgPeers = [wgPeer(dev, '192.168.1.50:51820')];
    const r = await get(dev, dev.ip).expect(200);
    assert.equal(r.body.same_lan, true);
    assert.equal(r.body.via, 'tunnel');
    assert.deepEqual(r.body.site, { type: 'server' });
    wgPeers = [wgPeer(dev, '[::ffff:10.20.9.9]:4500')];
    assert.equal((await get(dev, dev.ip).expect(200)).body.same_lan, true, 'IPv4-mapped endpoint (hairpin via router)');
  });

  it('false: public endpoint, excluded-interface or own-address endpoint, offline peer, no endpoint, no wg peer, wg error', async () => {
    const dev = H.makeDevice(anna, { name: 'hn-tun-no' });
    const cases = [
      [[wgPeer(dev, '203.0.113.7:51820')], 'public endpoint'],
      [[wgPeer(dev, '[2001:db8::7]:51820')], 'IPv6 endpoint'],
      [[wgPeer(dev, '172.17.0.5:51820')], 'docker subnet endpoint'],
      [[wgPeer(dev, '192.168.1.10:51820')], 'server own address'],
      [[wgPeer(dev, '192.168.2.5:51820')], 'other private network'],
      [[wgPeer(dev, '192.168.122.20:51820')], 'virbr subnet endpoint'],
      [[wgPeer(dev, '192.168.1.50:51820', false)], 'offline'],
      [[wgPeer(dev, null)], 'no endpoint'],
      [[], 'not in wg show'],
    ];
    for (const [peersNow, label] of cases) {
      wgPeers = peersNow;
      const r = await get(dev, dev.ip).expect(200);
      assert.equal(r.body.same_lan, false, label);
      assert.equal(r.body.via, 'tunnel', label);
    }
    wireguard.getStatus = async () => { throw new Error('wg missing'); };
    assert.equal((await get(dev, dev.ip).expect(200)).body.same_lan, false, 'wg error');
    wireguard.getStatus = async () => ({ running: false, interface: null, peers: [] });
    assert.equal((await get(dev, dev.ip).expect(200)).body.same_lan, false, 'wg down');
  });

  it('false when only another peer\'s endpoint is in the LAN', async () => {
    const dev = H.makeDevice(anna, { name: 'hn-tun-me' });
    const other = H.makeDevice(anna, { name: 'hn-tun-other' });
    wgPeers = [wgPeer(other, '192.168.1.50:51820'), wgPeer(dev, '203.0.113.7:51820')];
    assert.equal((await get(dev, dev.ip).expect(200)).body.same_lan, false);
    wgPeers = [wgPeer(other, '192.168.1.50:51820')];
    assert.equal((await get(dev, dev.ip).expect(200)).body.same_lan, false);
  });

  it('false from a WG address that is not the token peer\'s own, or without a matching endpoint', async () => {
    const dev = H.makeDevice(anna, { name: 'hn-tun-addr' });
    wgPeers = [wgPeer(dev, '192.168.1.50:51820')];
    const r = await get(dev, '10.8.0.254').expect(200);
    assert.equal(r.body.same_lan, false, 'another tunnel address');
    assert.equal(r.body.via, 'tunnel');
    wgPeers = [];
    assert.equal((await get(dev, dev.ip).expect(200)).body.same_lan, false, 'no matching endpoint');
  });

  it('false for a disabled peer and for a token without a peer', async () => {
    const dev = H.makeDevice(anna, { name: 'hn-tun-dis' });
    wgPeers = [wgPeer(dev, '192.168.1.50:51820')];
    H.db().prepare('UPDATE peers SET enabled = 0 WHERE id = ?').run(dev.peerId);
    try {
      assert.equal((await get(dev, dev.ip).expect(200)).body.same_lan, false);
    } finally { H.db().prepare('UPDATE peers SET enabled = 1 WHERE id = ?').run(dev.peerId); }
    assert.equal((await get(dev, dev.ip).expect(200)).body.same_lan, true, 'enabled again');

    const t = require('../src/services/tokens').create({ name: H.uniq('hn-nopeer'), scopes: ['client'], userId: anna, peerId: null }, '127.0.0.1');
    const r = await supertest(app).get(PATH).set('X-API-Token', t.rawToken).set('X-Forwarded-For', dev.ip).expect(200);
    assert.equal(r.body.same_lan, false);
  });

  it('false when the endpoint is a default gateway of the host (router SNATs inbound forwards)', async () => {
    const dev = H.makeDevice(anna, { name: 'hn-gw' });
    for (const ep of ['192.168.1.1:51820', '[::ffff:192.168.1.1]:51820', '10.20.0.1:4500']) {
      wgPeers = [wgPeer(dev, ep)];
      assert.equal((await get(dev, dev.ip).expect(200)).body.same_lan, false, ep);
    }
    wgPeers = [wgPeer(dev, '192.168.1.2:51820')];
    assert.equal((await get(dev, dev.ip).expect(200)).body.same_lan, true, 'the host next to the gateway');
  });

  it('fails closed when the route table cannot be read or parsed', async () => {
    const dev = H.makeDevice(anna, { name: 'hn-noroute' });
    wgPeers = [wgPeer(dev, '192.168.1.50:51820')];
    for (const [table, label] of [
      [() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }, 'unreadable'],
      [() => '', 'empty'],
      [() => 'garbage without a header\n', 'no header'],
      [() => ROUTES.replace('0101A8C0', 'XYZ'), 'malformed gateway'],
    ]) {
      homeNetwork._setRouteTableForTest(table);
      const r = await get(dev, dev.ip).expect(200);
      assert.equal(r.body.same_lan, false, label);
      assert.equal(r.body.via, 'tunnel', label);
    }
    homeNetwork._setRouteTableForTest(() => ROUTES.split('\n').filter((l) => !/^\S+\t00000000\t/.test(l)).join('\n'));
    assert.equal((await get(dev, dev.ip).expect(200)).body.same_lan, true, 'readable table without a default route');
  });

  it('false when the interface subnet is wider than any RFC 1918 block (misconfigured /0)', async () => {
    homeNetwork._setInterfacesForTest(() => ({ eth0: [v4('192.168.1.10', 0)] }));
    const dev = H.makeDevice(anna, { name: 'hn-wide' });
    wgPeers = [wgPeer(dev, '192.168.1.50:51820')];
    const r = await get(dev, dev.ip).expect(200);
    assert.deepEqual(r.body.lan, []);
    assert.equal(r.body.same_lan, false);
  });
});
