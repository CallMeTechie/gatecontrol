// tests/rdp_protocol_consumers.test.js
'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
// setup must be required before any db-using module so config/default.js is
// loaded with the temp DB path, not the production path.
const { setup, teardown } = require('./helpers/setup');

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
  it('gateway route with no port does not fall back to a hardcoded 3389', () => {
    const tgt = monitor.resolveCheckTarget({ protocol: 'vnc', host: '10.0.0.5', port: null, access_mode: 'gateway', gateway_listen_port: null });
    assert.notEqual(tgt.port, 3389);
  });
  it('keeps RDP behaviour for internal rdp routes', () => {
    const tgt = monitor.resolveCheckTarget({ protocol: 'rdp', host: '10.0.0.6', port: 3389, access_mode: 'internal' });
    assert.deepEqual(tgt, { host: '10.0.0.6', port: 3389 });
  });
});

const { describe: d3, it: it3, before, after } = require('node:test');
before(async () => { await setup(); });
after(() => teardown());

const { getDb } = require('../src/db/connection');

d3('existing RDP row is behaviourally unchanged', () => {
  it3('monitor target unchanged for rdp route', () => {
    const tgt = require('../src/services/rdpMonitor').resolveCheckTarget(
      { protocol: 'rdp', host: '10.0.0.8', port: 3389, access_mode: 'internal' });
    assert.deepEqual(tgt, { host: '10.0.0.8', port: 3389 });
  });
  it3('restoring a row without the new columns does not violate constraints', () => {
    // Simulates restoring a pre-migration-53 backup row: new columns bound NULL.
    const db = getDb();
    assert.doesNotThrow(() => {
      db.prepare(
        "INSERT INTO rdp_routes (name, host, port, protocol, browser_enabled, sftp_disable_download) VALUES ('old-backup', '10.0.0.11', 3389, NULL, NULL, NULL)"
      ).run();
    });
  });
});
