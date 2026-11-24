'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const nonce = require('../src/services/guacNonceStore');
const guacToken = require('../src/services/guacToken');
const { evaluateConnection, isStale } = require('../src/tunnel/guacTunnel');

describe('isStale', () => {
  it('treats a session with no recent heartbeat as stale', () => {
    // last_heartbeat far in the past (SQLite UTC string) → stale.
    assert.equal(isStale({ last_heartbeat: '2000-01-01 00:00:00' }), true);
  });
  it('treats a fresh heartbeat as not stale', () => {
    const nowUtc = new Date().toISOString().replace('T', ' ').slice(0, 19);
    assert.equal(isStale({ last_heartbeat: nowUtc }), false);
  });
  it('treats a session with no heartbeat (null) as not stale', () => {
    assert.equal(isStale({ last_heartbeat: null }), false);
  });
});

describe('guac tunnel connection evaluation', () => {
  beforeEach(() => nonce._clear());
  it('accepts a valid token and returns connection settings', () => {
    const { token } = guacToken.mint({ type: 'rdp', settings: { hostname: 'h', port: '3389' } });
    const out = evaluateConnection(token, { admit: () => ({ ok: true }) });
    assert.equal(out.ok, true);
    assert.equal(out.connection.type, 'rdp');
  });
  it('rejects a replayed token', () => {
    const { token } = guacToken.mint({ type: 'rdp', settings: { hostname: 'h', port: '3389' } });
    evaluateConnection(token, { admit: () => ({ ok: true }) });
    const out = evaluateConnection(token, { admit: () => ({ ok: true }) });
    assert.equal(out.ok, false);
  });
  it('rejects when admission fails (cap)', () => {
    const { token } = guacToken.mint({ type: 'rdp', settings: { hostname: 'h', port: '3389' } });
    const out = evaluateConnection(token, { admit: () => ({ ok: false, reason: 'route_limit' }) });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'route_limit');
  });
});

describe('guac tunnel tuning', () => {
  const { EventEmitter } = require('node:events');
  const { tuneConnection, IMAGE_TYPES } = require('../src/tunnel/guacTunnel');

  function fakeConnection() {
    const guacdClient = new EventEmitter();
    let noDelay = null;
    guacdClient.guacdConnection = { setNoDelay: (v) => { noDelay = v; } };
    const sent = [];
    const cc = { guacdClient, send: (m) => sent.push(m) };
    guacdClient.on('data', (d) => cc.send(d)); // guacamole-lite's own listener: one message per instruction
    return { cc, guacdClient, sent, noDelay: () => noDelay };
  }

  it('announces webp besides png and jpeg', () => {
    assert.deepEqual([...IMAGE_TYPES], ['image/png', 'image/jpeg', 'image/webp']);
  });
  it('the guacamole-lite server announces them for rdp and keeps its other defaults', () => {
    const http = require('node:http');
    const { attachGuacTunnel } = require('../src/tunnel/guacTunnel');
    const guac = attachGuacTunnel(http.createServer());
    const rdp = guac.clientOptions.connectionDefaultSettings.rdp;
    assert.deepEqual(rdp.image, ['image/png', 'image/jpeg', 'image/webp']);
    assert.equal(rdp.port, '3389');
    assert.deepEqual(rdp.audio, ['audio/L16']);
    assert.deepEqual(guac.clientOptions.connectionDefaultSettings.vnc.image, ['image/png', 'image/jpeg', 'image/webp']);
  });
  it('switches Nagle off on the socket to guacd', () => {
    const f = fakeConnection();
    tuneConnection(f.cc);
    assert.equal(f.noDelay(), true);
  });
  it('sends the instructions of one read from guacd as one WebSocket message, in order', async () => {
    const f = fakeConnection();
    tuneConnection(f.cc);
    f.guacdClient.emit('data', '3.img,1.1;');
    f.guacdClient.emit('data', '4.blob,1.1,4.AAAA;');
    f.guacdClient.emit('data', '4.sync,3.123;');
    assert.deepEqual(f.sent, [], 'nothing until the read is done');
    await Promise.resolve();
    assert.deepEqual(f.sent, ['3.img,1.1;4.blob,1.1,4.AAAA;4.sync,3.123;']);
    f.guacdClient.emit('data', '4.sync,3.124;');
    await Promise.resolve();
    assert.deepEqual(f.sent, ['3.img,1.1;4.blob,1.1,4.AAAA;4.sync,3.123;', '4.sync,3.124;']);
  });
  it('leaves a connection without a guacd client alone', () => {
    assert.doesNotThrow(() => tuneConnection({}));
    assert.doesNotThrow(() => tuneConnection(null));
  });
});
