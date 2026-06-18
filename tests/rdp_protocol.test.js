'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const rdp = require('../src/services/rdp');

describe('protocol validation', () => {
  it('rejects unknown protocol', () => {
    const errors = rdp.validateRdpRoute({ name: 'x', host: 'h', protocol: 'mainframe' }) || {};
    assert.ok(errors.protocol);
  });
  it('accepts the four supported protocols', () => {
    for (const p of ['rdp', 'vnc', 'ssh', 'telnet']) {
      const errors = rdp.validateRdpRoute({ name: 'x', host: 'h', protocol: p, username: 'u' }) || {};
      assert.equal(errors.protocol, undefined, `protocol ${p} should be valid`);
    }
  });
  it('requires username for ssh', () => {
    const errors = rdp.validateRdpRoute({ name: 'x', host: 'h', protocol: 'ssh' }) || {};
    assert.ok(errors.username);
  });
  it('defaults port per protocol', () => {
    assert.equal(rdp.defaultPortForProtocol('vnc'), 5900);
    assert.equal(rdp.defaultPortForProtocol('ssh'), 22);
    assert.equal(rdp.defaultPortForProtocol('telnet'), 23);
    assert.equal(rdp.defaultPortForProtocol('rdp'), 3389);
  });
});
