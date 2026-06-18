// tests/rdp_protocol_consumers.test.js
'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../src/services/rdpMonitor');

describe('rdpMonitor protocol-aware target', () => {
  it('probes the configured VNC port for an internal route', () => {
    const tgt = monitor.resolveCheckTarget({ protocol: 'vnc', host: '10.0.0.5', port: 5900, access_mode: 'internal' });
    assert.deepEqual(tgt, { host: '10.0.0.5', port: 5900 });
  });
  it('gateway VNC route probes its own port, never a hardcoded 3389', () => {
    const tgt = monitor.resolveCheckTarget({ protocol: 'vnc', host: '10.0.0.5', port: 5900, access_mode: 'gateway', gateway_listen_port: null });
    assert.equal(tgt.port, 5900);
  });
  it('keeps RDP behaviour for internal rdp routes', () => {
    const tgt = monitor.resolveCheckTarget({ protocol: 'rdp', host: '10.0.0.6', port: 3389, access_mode: 'internal' });
    assert.deepEqual(tgt, { host: '10.0.0.6', port: 3389 });
  });
});
