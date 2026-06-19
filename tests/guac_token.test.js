// tests/guac_token.test.js
'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const token = require('../src/services/guacToken');
const nonce = require('../src/services/guacNonceStore');

describe('guac token', () => {
  beforeEach(() => nonce._clear());

  it('mints and verifies a token round-trip exactly once', () => {
    const { token: t } = token.mint({ type: 'rdp', settings: { hostname: '10.0.0.5', port: '3389' } });
    const out = token.verifyAndConsume(t);
    assert.ok(out, 'should verify');
    assert.equal(out.connection.type, 'rdp');
    assert.equal(out.connection.settings.hostname, '10.0.0.5');
    assert.equal(token.verifyAndConsume(t), null, 'replay must be rejected');
  });

  it('rejects a tampered ciphertext (integrity backstop, C5)', () => {
    const { token: t } = token.mint({ type: 'vnc', settings: { hostname: '10.0.0.6', port: '5900' } });
    const obj = JSON.parse(Buffer.from(t, 'base64').toString('utf8'));
    const buf = Buffer.from(obj.value, 'base64');
    buf[buf.length - 1] ^= 0xff;                 // flip a byte in the ciphertext
    obj.value = buf.toString('base64');
    const tampered = Buffer.from(JSON.stringify(obj)).toString('base64');
    assert.equal(token.verifyAndConsume(tampered), null, 'tampered token must be rejected');
  });

  it('rejects an expired token', () => {
    const { token: t, jti } = token.mint({ type: 'rdp', settings: { hostname: 'h', port: '3389' } }, { ttlMs: -1 });
    // exp already in the past; even though jti registered, exp check fails
    assert.equal(token.verifyAndConsume(t), null);
  });

  it('derives a key distinct from the raw GC_ENCRYPTION_KEY', () => {
    const k = token.deriveKey();
    assert.equal(k.length, 32);
    assert.notEqual(k.toString('hex'), process.env.GC_ENCRYPTION_KEY);
  });

  // --- HMAC hardening tests ---

  it('minted token envelope contains a mac string field', () => {
    const { token: t } = token.mint({ type: 'rdp', settings: { hostname: '10.0.0.5', port: '3389' } });
    const obj = JSON.parse(Buffer.from(t, 'base64').toString('utf8'));
    assert.equal(typeof obj.mac, 'string', 'outer envelope must contain a mac string');
    assert.ok(obj.mac.length > 0, 'mac must be non-empty');
  });

  it('rejects a token with a tampered mac field', () => {
    const { token: t } = token.mint({ type: 'rdp', settings: { hostname: '10.0.0.5', port: '3389' } });
    const obj = JSON.parse(Buffer.from(t, 'base64').toString('utf8'));
    const macBuf = Buffer.from(obj.mac, 'base64');
    macBuf[0] ^= 0xff;                            // flip a byte in the mac
    obj.mac = macBuf.toString('base64');
    const tampered = Buffer.from(JSON.stringify(obj)).toString('base64');
    assert.equal(token.verifyAndConsume(tampered), null, 'tampered mac must be rejected');
  });

  it('rejects a token with a tampered iv field (HMAC covers iv)', () => {
    const { token: t } = token.mint({ type: 'rdp', settings: { hostname: '10.0.0.5', port: '3389' } });
    const obj = JSON.parse(Buffer.from(t, 'base64').toString('utf8'));
    const ivBuf = Buffer.from(obj.iv, 'base64');
    ivBuf[0] ^= 0xff;                             // flip a byte in the iv
    obj.iv = ivBuf.toString('base64');
    const tampered = Buffer.from(JSON.stringify(obj)).toString('base64');
    assert.equal(token.verifyAndConsume(tampered), null, 'tampered iv must be rejected by HMAC');
  });

  it('rejects a token with the mac field removed', () => {
    const { token: t } = token.mint({ type: 'rdp', settings: { hostname: '10.0.0.5', port: '3389' } });
    const obj = JSON.parse(Buffer.from(t, 'base64').toString('utf8'));
    delete obj.mac;
    const noMac = Buffer.from(JSON.stringify(obj)).toString('base64');
    assert.equal(token.verifyAndConsume(noMac), null, 'token without mac must be rejected');
  });
});
