'use strict';

// Internet access of plugins (docs/plugins.md "Netzwerk"): the allowlist of
// plugin.json, public addresses only after DNS (rebinding/SSRF protection),
// redirects, request bodies, Set-Cookie — and the UDP primitive.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dgram = require('node:dgram');
const ipaddr = require('ipaddr.js');
const N = require('../src/services/plugins/netPolicy');

const look = (...ips) => async () => ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
const reserved = ['10.8.0.0/24', '172.17.0.0/16', '203.0.113.7/32'].map((s) => ipaddr.parseCIDR(s));
const check = (internet, host, port, ...ips) => N.checkInternet(N.compile({ network: { internet } }), host, port, { lookup: look(...ips), reserved });

describe('allowlist entries', () => {
  it('parses hosts, wildcards, IPs and port lists; refuses the rest', () => {
    assert.equal(N.parseEntry('*.example.com').type, 'wildcard');
    assert.deepEqual(N.parseEntry('api.example.com:443,8443').ports, [[443, 443], [8443, 8443]]);
    for (const bad of ['*.com', '*', 'http://x', 'a..b', '3232235777', 'h:0', 'h:70000']) assert.throws(() => N.parseEntry(bad), bad);
  });
  it('an array is the internet list (short form)', () => {
    assert.equal(N.compile({ network: ['a.example'] }).entries.length, 1);
  });
});

describe('internet targets: declared hosts, public addresses only', () => {
  const skoda = ['identity.vwgroup.io', 'mysmob.api.connect.skoda-auto.cz', '*.cloud.example', 'api.example.com:443'];
  it('exact and wildcard hosts with their ports', async () => {
    assert.equal((await check(skoda, 'identity.vwgroup.io', 443, '20.1.2.3')).ok, true);
    assert.equal((await check(skoda, 'a.b.cloud.example', 443, '20.1.2.3')).ok, true);
    assert.equal((await check(skoda, 'cloud.example', 443, '20.1.2.3')).reason, 'not_allowed', 'wildcard = sub-domains only');
    assert.equal((await check(skoda, 'api.example.com', 8443, '20.1.2.3')).reason, 'not_allowed', 'port');
    assert.equal((await check(skoda, 'evil.example', 443, '20.1.2.3')).reason, 'not_allowed');
  });
  it('a declared host resolving to a VPN, private, Docker, own or loopback address is refused (DNS rebinding)', async () => {
    assert.equal((await check(skoda, 'identity.vwgroup.io', 443, '10.8.0.5')).reason, 'not_public', 'WireGuard peer');
    assert.equal((await check(skoda, 'identity.vwgroup.io', 443, '192.168.1.20')).reason, 'not_public', 'home network');
    assert.equal((await check(skoda, 'identity.vwgroup.io', 443, '100.64.0.1')).reason, 'not_public', 'CGNAT');
    assert.equal((await check(skoda, 'identity.vwgroup.io', 443, 'fd00::1')).reason, 'not_public', 'ULA');
    assert.equal((await check(skoda, 'identity.vwgroup.io', 443, '203.0.113.7')).reason, 'blocked_address', 'reserved range');
    assert.equal((await check(skoda, 'identity.vwgroup.io', 443, '127.0.0.1')).reason, 'blocked_address');
    assert.equal((await check(skoda, 'identity.vwgroup.io', 443, '169.254.169.254')).reason, 'blocked_address');
    assert.equal((await check(skoda, 'identity.vwgroup.io', 443, '::ffff:127.0.0.1')).reason, 'blocked_address');
    assert.equal((await check(skoda, 'identity.vwgroup.io', 443, '20.1.2.3', '10.0.0.1')).reason, 'not_public', 'every address counts');
  });
  it('a public address of this server (own interface) is refused too', async () => {
    const own = [ipaddr.parseCIDR('20.9.9.9/32')];
    const r = await N.checkInternet(N.compile({ network: ['self.example'] }), 'self.example', 443, { lookup: look('20.9.9.9'), reserved: own });
    assert.equal(r.reason, 'not_public');
  });
  it('plugin.json cannot list private ranges as internet', () => {
    const m = require('../src/services/plugins/manifest');
    const r = m.validate({ id: 'x-y', name: 'x', version: '1.0.0', publisher: 'p', gatecontrol: '*', entry: 'a.js', permissions: { network: { internet: ['192.168.1.0/24'] } } });
    assert.ok(r.errors.includes('permissions.network.internet: invalid'), r.errors.join());
  });
  it('human summary for the install dialog', () => {
    const d = N.describe({ network: { internet: ['identity.vwgroup.io'], homeTargets: [{ id: 'gateway', label: { de: 'Gateway', en: 'Gateway' }, protocols: ['http'] }], localDiscovery: { udp: ['6445', '20086'] } } }, 'de');
    assert.deepEqual(d, { internet: ['identity.vwgroup.io'], homeTargets: [{ id: 'gateway', label: 'Gateway', protocols: ['http'], multiple: false }], discovery: { udp: ['6445', '20086'] } });
  });
});

describe('HTTP client (loopback test server stands in for a public host)', () => {
  let server, port, udp, udpPort;
  before(async () => {
    N._setTestPrivateForTest({ '127.0.0.1': 'public' });
    N._setReservedForTest(['10.8.0.0/24']);
    server = http.createServer((req, res) => {
      if (req.url === '/login') { res.writeHead(302, { location: '/step2', 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] }); return res.end(); }
      if (req.url === '/step2') { res.writeHead(302, { location: 'myskoda://redirect/login?code=abc' }); return res.end(); }
      if (req.url === '/offsite') { res.writeHead(302, { location: 'http://evil.example/' }); return res.end(); }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ url: req.url, method: req.method, type: req.headers['content-type'] || null, body })); });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    udp = dgram.createSocket('udp4');
    udp.on('message', (msg, rinfo) => udp.send(Buffer.from('pong:' + msg), rinfo.port, rinfo.address));
    await new Promise((r) => udp.bind(0, '127.0.0.1', r));
    udpPort = udp.address().port;
  });
  after(() => { N._setTestPrivateForTest(null); N._setReservedForTest(null); server.close(); udp.close(); });

  const policy = () => N.compile({ network: ['127.0.0.1'] });
  it('manual redirects expose Location and every Set-Cookie', async () => {
    const r = await N.fetchWithPolicy(policy(), `http://127.0.0.1:${port}/login`, {});
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/step2');
    assert.deepEqual(r.headers['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);
  });
  it('follow stops at a custom-scheme redirect (OAuth app scheme) and returns it', async () => {
    const r = await N.fetchWithPolicy(policy(), `http://127.0.0.1:${port}/login`, { redirect: 'follow' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, 'myskoda://redirect/login?code=abc');
    assert.deepEqual(r.redirects, [`http://127.0.0.1:${port}/step2`]);
  });
  it('follow re-checks every hop against the allowlist', async () => {
    await assert.rejects(N.fetchWithPolicy(policy(), `http://127.0.0.1:${port}/offsite`, { redirect: 'follow', lookup: look('93.184.216.34') }), (e) => e.code === 'ERR_NET_DENIED');
  });
  it('request bodies arrive as sent', async () => {
    const r = await N.fetchWithPolicy(policy(), `http://127.0.0.1:${port}/x`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=2' });
    assert.deepEqual(JSON.parse(r.body), { url: '/x', method: 'POST', type: 'application/x-www-form-urlencoded', body: 'a=1&b=2' });
  });
  it('UDP exchange: declared ports only, answers with their source address', async () => {
    const found = await N.udpExchange([[udpPort, udpPort]], { ports: [udpPort], data: Buffer.from('probe'), timeoutMs: 400, targets: ['127.0.0.1'], acceptFrom: () => true });
    assert.deepEqual(found.map((f) => [f.address, f.data.toString()]), [['127.0.0.1', 'pong:probe']]);
    await assert.rejects(N.udpExchange([[9, 9]], { ports: [udpPort], data: Buffer.from('x') }), (e) => e.code === 'ERR_NET_DENIED');
  });
});
