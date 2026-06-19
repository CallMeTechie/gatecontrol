'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveGuacTarget } = require('../src/services/guacTarget');

describe('resolveGuacTarget', () => {
  it('internal → host:port', () => {
    assert.deepEqual(resolveGuacTarget({ access_mode: 'internal', host: '10.0.0.5', port: 5900 }),
      { host: '10.0.0.5', port: 5900 });
  });
  it('external → external_hostname:external_port', () => {
    assert.deepEqual(resolveGuacTarget({ access_mode: 'external', host: '10.0.0.5', port: 3389, external_hostname: 'rdp.example.com', external_port: 13389 }),
      { host: 'rdp.example.com', port: 13389 });
  });
  it('gateway → WG hub IP : gateway_listen_port, never 127.0.0.1', () => {
    const t = resolveGuacTarget({ access_mode: 'gateway', host: '10.0.0.5', port: 5900, gateway_listen_port: 25900 });
    assert.notEqual(t.host, '127.0.0.1');
    assert.equal(t.port, 25900);
  });
});
