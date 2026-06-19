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
