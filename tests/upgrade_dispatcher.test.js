'use strict';

// The shared WebSocket upgrade dispatcher (src/tunnel/upgrade.js): one `upgrade` listener per HTTP
// server, exact paths, unchanged behaviour for the guacamole tunnel (old path and the path of gc.remote)
// and the edge channel of the gateways; a path nobody registered is left untouched.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { setup, teardown } = require('./helpers/setup');

let server, port;
const conns = new Set();

function upgradeStatus(path, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    });
    let buf = '';
    const timer = setTimeout(() => { s.destroy(); resolve('no answer'); }, timeoutMs);
    s.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/^HTTP\/1\.1 (\d{3})/);
      if (m) { clearTimeout(timer); s.destroy(); resolve(Number(m[1])); }
    });
    s.on('error', () => { clearTimeout(timer); resolve('error'); });
    s.on('close', () => { clearTimeout(timer); resolve(buf ? buf.slice(0, 12) : 'closed'); });
  });
}

before(async () => {
  await setup();
  server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  server.on('connection', (c) => { conns.add(c); c.on('close', () => conns.delete(c)); });
  require('../src/tunnel/guacTunnel').attachGuacTunnel(server);
  require('../src/services/edge/hub').attach(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(async () => {
  // an upgrade nobody answered keeps its socket (unchanged behaviour): close them ourselves
  for (const c of conns) c.destroy();
  await new Promise((r) => server.close(r));
  teardown();
});

describe('upgrade dispatcher', () => {
  it('one listener for all three paths', () => {
    const upgrade = require('../src/tunnel/upgrade');
    assert.equal(server.listenerCount('upgrade'), 1);
    assert.deepEqual(upgrade.paths(server).sort(), ['/api/v1/client/rdp/guac-tunnel', '/api/v1/gateway/edge/ws', '/api/v1/remote/guac-tunnel']);
  });
  it('a second registration of a path replaces the first (no double answer)', () => {
    const upgrade = require('../src/tunnel/upgrade');
    const s = http.createServer();
    let a = 0, b = 0;
    upgrade.register(s, '/x', () => { a++; });
    upgrade.register(s, '/x', () => { b++; });
    s.emit('upgrade', { url: '/x?y=1' }, { destroy() {} }, Buffer.alloc(0));
    s.emit('upgrade', { url: '/other' }, { destroy() {} }, Buffer.alloc(0));
    assert.deepEqual([a, b, s.listenerCount('upgrade')], [0, 1, 1]);
  });
  it('a throwing handler gets its socket destroyed', () => {
    const upgrade = require('../src/tunnel/upgrade');
    const s = http.createServer();
    let destroyed = false;
    upgrade.register(s, '/boom', () => { throw new Error('boom'); });
    s.emit('upgrade', { url: '/boom' }, { destroy() { destroyed = true; } }, Buffer.alloc(0));
    assert.equal(destroyed, true);
  });
  it('guacamole tunnel: invalid tokens get 401 on both paths', async () => {
    assert.equal(await upgradeStatus('/api/v1/client/rdp/guac-tunnel?token=bad'), 401);
    assert.equal(await upgradeStatus('/api/v1/remote/guac-tunnel?token=bad'), 401);
  });
  it('a gc.remote token does not open the old path; an old token does not open the remote path', async () => {
    const guacToken = require('../src/services/guacToken');
    const remote = guacToken.mint({ type: 'rdp', settings: {}, remoteRef: 'A'.repeat(43), remotePlugin: 'gatecontrol-remote' }).token;
    assert.equal(await upgradeStatus('/api/v1/client/rdp/guac-tunnel?token=' + encodeURIComponent(remote)), 401);
    const old = guacToken.mint({ type: 'rdp', settings: {}, rdpRouteId: 1 }).token;
    assert.equal(await upgradeStatus('/api/v1/remote/guac-tunnel?token=' + encodeURIComponent(old)), 401);
    // a remote token of no live ticket: refused at the right path as well
    const gone = guacToken.mint({ type: 'rdp', settings: {}, remoteRef: 'B'.repeat(43), remotePlugin: 'gatecontrol-remote' }).token;
    assert.equal(await upgradeStatus('/api/v1/remote/guac-tunnel?token=' + encodeURIComponent(gone)), 401);
  });
  it('edge channel: still refuses without gateway credentials', async () => {
    const s = await upgradeStatus('/api/v1/gateway/edge/ws');
    assert.ok(s >= 400 && s < 500, String(s));
  });
  it('an unknown path is left untouched (as before)', async () => {
    assert.equal(await upgradeStatus('/api/v1/nothing-here', { timeoutMs: 400 }), 'no answer');
  });
});
