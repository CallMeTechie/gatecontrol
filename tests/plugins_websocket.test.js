'use strict';

// gc.http.websocket (docs/plugins.md "Network"): the host holds the real
// WebSocket, checked like http.fetch — internet hosts of plugin.json, public
// addresses only, pinned to the checked address — and relays messages to the
// plugin process. A loopback server stands in for a public host.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { HELLO, helloPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let agent, csrf, runtime, plugins, hostApi, netPolicy, wss, port;
const API = '/api/v1/plugins';
const seen = [];
const call = (body) => agent.post(`${API}/hello/api/ws`).set('X-CSRF-Token', csrf).send(body);

before(async () => {
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  port = wss.address().port;
  wss.on('connection', (sock, req) => {
    seen.push({ url: req.url, auth: req.headers.authorization || null, key: req.headers['sec-websocket-key'], protocol: sock.protocol });
    sock.on('message', (data, isBinary) => {
      const text = isBinary ? null : data.toString();
      if (text === 'flood') { for (let i = 0; i < 400; i++) sock.send('x' + i); return; }
      if (text === 'big') { sock.send('y'.repeat(1024 * 1024 + 10)); return; }
      if (text === 'bye') { sock.close(4001, 'server says bye'); return; }
      sock.send(data, { binary: isBinary });
    });
  });

  ({ agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  hostApi = require('../src/services/plugins/hostApi');
  netPolicy = require('../src/services/plugins/netPolicy');
  netPolicy._setTestPrivateForTest({ '127.0.0.1': 'public' });
  netPolicy._setReservedForTest(['10.8.0.0/24']);
  hostApi._lookup = async (h) => (h === 'ws.example' ? [{ address: '127.0.0.1', family: 4 }] : []);
  const raw = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
  const permissions = { ...raw.permissions, network: { ...raw.permissions.network, internet: [...raw.permissions.network.internet, 'ws.example'] } };
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream')
    .send(helloPackage({ overrides: { permissions } })).expect(200);
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  assert.equal(await runtime.waitRunning('hello'), true);
});
after(async () => {
  hostApi._lookup = null;
  netPolicy._setTestPrivateForTest(null); netPolicy._setReservedForTest(null);
  await plugins.stop();
  teardown();
  await new Promise((r) => wss.close(r));
});

describe('gc.http.websocket through a plugin process', () => {
  it('text and binary messages travel both ways; headers and sub-protocol reach the server', async () => {
    const r = await call({
      url: `ws://ws.example:${port}/socket?token=abc`,
      opts: { headers: { authorization: 'Bearer t', 'sec-websocket-key': 'forged' }, protocols: ['chat'] },
      send: ['hello', { b64: Buffer.from([1, 2, 3]).toString('base64') }],
      expect: 2,
    }).expect(200);
    assert.equal(r.body.protocol, 'chat');
    assert.deepEqual(r.body.got, ['hello', { b64: 'AQID' }]);
    const s = seen[seen.length - 1];
    assert.equal(s.url, '/socket?token=abc');
    assert.equal(s.auth, 'Bearer t');
    assert.notEqual(s.key, 'forged', 'the plugin cannot set the handshake headers');
  });

  it('a close from the server reaches the plugin with code and reason', async () => {
    const r = await call({ url: `ws://ws.example:${port}/`, send: ['bye'], waitClose: true }).expect(200);
    assert.deepEqual(r.body.closed, { code: 4001, reason: 'server says bye' });
  });

  it('a host that is not in plugin.json is refused', async () => {
    const r = await call({ url: `ws://other.example:${port}/` }).expect(502);
    assert.equal(r.body.code, 'ERR_NET_DENIED');
    assert.match(r.body.error, /not_allowed/);
  });

  it('only ws: and wss: URLs', async () => {
    const r = await call({ url: `http://ws.example:${port}/` }).expect(502);
    assert.equal(r.body.code, 'ERR_NET_DENIED');
    assert.match(r.body.error, /protocol/);
  });

  it('a home-network address behind an allowed name is refused', async () => {
    hostApi._lookup = async () => [{ address: '192.168.1.20', family: 4 }];
    try {
      const r = await call({ url: `ws://ws.example:${port}/` }).expect(502);
      assert.equal(r.body.code, 'ERR_NET_DENIED');
      assert.match(r.body.error, /not_public/);
    } finally {
      hostApi._lookup = async (h) => (h === 'ws.example' ? [{ address: '127.0.0.1', family: 4 }] : []);
    }
  });

  it('a server that floods the plugin is cut off (policy violation)', async () => {
    const r = await call({ url: `ws://ws.example:${port}/`, send: ['flood'], waitClose: true }).expect(200);
    assert.ok(r.body.got.length <= 200, `relayed ${r.body.got.length}`);
    assert.equal(r.body.closed && r.body.closed.code, 1008);
  });

  it('a message over 1 MiB is never relayed; the connection ends', async () => {
    const r = await call({ url: `ws://ws.example:${port}/`, send: ['big'], waitClose: true }).expect(200);
    assert.deepEqual(r.body.got, []);
    assert.ok(r.body.closed && [1006, 1009].includes(r.body.closed.code), JSON.stringify(r.body.closed));
  });
});

describe('host side limits', () => {
  const plugin = { id: 'ws-limits', manifest: { permissions: { network: { internet: ['ws.example'] } } } };
  const events = [];
  const ctx = { emit: (m) => events.push(m) };
  const connect = () => hostApi.handle(plugin, 'ws.connect', { url: `ws://ws.example:${port}/` }, ctx);

  it('at most 8 open WebSockets per plugin; closeSockets ends them all', async () => {
    const opened = [];
    for (let i = 0; i < 8; i++) opened.push(await connect());
    await assert.rejects(connect(), (e) => e.code === 'ERR_BUSY');
    hostApi.closeSockets(plugin.id);
    await new Promise((r) => setTimeout(r, 100));
    const closed = events.filter((m) => m.t === 'ws' && m.ev === 'close').map((m) => m.id);
    for (const o of opened) assert.ok(closed.includes(o.id), `socket ${o.id} closed`);
    await assert.rejects(hostApi.handle(plugin, 'ws.send', { id: opened[0].id, text: 'x' }, ctx), (e) => e.code === 'ERR_INVALID');
  });

  it('send: text or binary only, at most 256 KiB', async () => {
    const { id } = await connect();
    try {
      await assert.rejects(hostApi.handle(plugin, 'ws.send', { id }, ctx), (e) => e.code === 'ERR_INVALID');
      await assert.rejects(hostApi.handle(plugin, 'ws.send', { id, text: 'z'.repeat(256 * 1024 + 1) }, ctx), (e) => e.code === 'ERR_INVALID');
      assert.equal(await hostApi.handle(plugin, 'ws.send', { id, text: 'ping' }, ctx), null);
    } finally { hostApi.closeSockets(plugin.id); }
  });

  it('invalid sub-protocols are refused before connecting', async () => {
    await assert.rejects(hostApi.handle(plugin, 'ws.connect', { url: `ws://ws.example:${port}/`, opts: { protocols: ['a b'] } }, ctx), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(hostApi.handle(plugin, 'ws.connect', { url: `ws://ws.example:${port}/`, opts: { protocols: ['a', 'a'] } }, ctx), (e) => e.code === 'ERR_INVALID');
  });

  it('a plugin without internet permission gets nothing', async () => {
    const none = { id: 'ws-none', manifest: { permissions: {} } };
    await assert.rejects(hostApi.handle(none, 'ws.connect', { url: `ws://ws.example:${port}/` }, ctx), (e) => e.code === 'ERR_NET_DENIED');
  });
});
