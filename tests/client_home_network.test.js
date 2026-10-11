'use strict';

// GET /api/v1/client/home-network — trusted-network detection of the apps
// ("is the device in the server's own home LAN?"): the LAN list (private
// IPv4 only, no WireGuard / container interfaces, dedupe, max 8), same_lan
// for direct requests (source inside an included LAN subnet) and through the
// tunnel (the token peer's current WireGuard endpoint inside one), auth,
// no-store. A false "true" would switch the VPN off in a foreign network.

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
  wireguard.getStatus = realStatus;
  teardown();
});
beforeEach(() => {
  homeNetwork._setInterfacesForTest(HOST);
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
      assert.deepEqual(Object.keys(r.body).sort(), ['lan', 'ok', 'same_lan', 'via']);
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
    const r = await get(dev, '192.168.1.50').expect(200);
    assert.deepEqual(r.body.lan, []);
    assert.equal(r.body.same_lan, false);
  });
});

describe('same_lan — direct request (VPN down)', () => {
  it('true from inside an included LAN subnet (also IPv4-mapped IPv6)', async () => {
    const dev = H.makeDevice(anna, { name: 'hn-direct' });
    for (const ip of ['192.168.1.50', '10.20.3.4', '::ffff:192.168.1.1']) {
      const r = await get(dev, ip).expect(200);
      assert.equal(r.body.same_lan, true, ip);
      assert.equal(r.body.via, 'direct', ip);
    }
  });

  it('false from a public address, another private network, an excluded interface\'s subnet or the server itself', async () => {
    const dev = H.makeDevice(anna, { name: 'hn-direct-no' });
    for (const ip of ['203.0.113.77', '8.8.8.8', '192.168.2.5', '172.17.0.5', '172.18.4.4', '192.168.122.20', '10.64.0.9', '192.168.50.9', '192.168.1.10', '169.254.10.11', '2001:db8::1']) {
      const r = await get(dev, ip).expect(200);
      assert.equal(r.body.same_lan, false, ip);
    }
  });

  it('false from the WG subnet — also when that subnet sits on a LAN-looking interface', async () => {
    homeNetwork._setInterfacesForTest(() => ({ eth0: [v4('10.8.0.200', 16), v4('192.168.1.10', 24)] }));
    const dev = H.makeDevice(anna, { name: 'hn-wgsub' });
    const r = await get(dev, '10.8.0.99').expect(200);
    assert.deepEqual(r.body.lan, ['192.168.1.10']);
    assert.equal(r.body.same_lan, false);
    assert.equal(r.body.via, 'tunnel');
  });

  it('false when the interface subnet is wider than any RFC 1918 block (misconfigured /0)', async () => {
    homeNetwork._setInterfacesForTest(() => ({ eth0: [v4('192.168.1.10', 0)] }));
    const dev = H.makeDevice(anna, { name: 'hn-wide' });
    const r = await get(dev, '192.168.1.50').expect(200);
    assert.deepEqual(r.body.lan, []);
    assert.equal(r.body.same_lan, false);
  });
});

describe('same_lan — request through the tunnel (VPN up)', () => {
  it('true when the token peer\'s current WireGuard endpoint lies in an included LAN subnet', async () => {
    const dev = H.makeDevice(anna, { name: 'hn-tun' });
    wgPeers = [wgPeer(dev, '192.168.1.50:51820')];
    const r = await get(dev, dev.ip).expect(200);
    assert.equal(r.body.same_lan, true);
    assert.equal(r.body.via, 'tunnel');
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
});
