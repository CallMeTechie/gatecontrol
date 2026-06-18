'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

// setup must be required before any service module so that config.js is
// evaluated with GC_DB_PATH / GC_ADMIN_PASSWORD already in the environment.
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

const { describe, it, describe: d2, it: it2, before, after } = require('node:test');
const assert = require('node:assert/strict');
const rdp = require('../src/services/rdp');
const rdpSvc = rdp;

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

let db;
before(async () => { await setup(); db = getDb(); });
after(() => teardown());

d2('protocol persistence', () => {
  it2('creates a vnc route with port default 5900 and security defaults', async () => {
    const created = await rdpSvc.create({ name: 'vnc-box', host: '10.0.0.5', protocol: 'vnc' });
    const row = db.prepare('SELECT * FROM rdp_routes WHERE id = ?').get(created.id);
    assert.equal(row.protocol, 'vnc');
    assert.equal(row.port, 5900);
    assert.equal(row.browser_clipboard, 0);
    assert.equal(row.sftp_disable_download, 1);
    assert.equal(row.sftp_disable_upload, 1);
  });

  it2('update() accepts boolean browser flags without bind errors', async () => {
    const created = await rdpSvc.create({ name: 'vnc-box2', host: '10.0.0.55', protocol: 'vnc' });
    await rdpSvc.update(created.id, { browser_enabled: true, browser_clipboard: true, sftp_port: 2222 });
    const row = db.prepare('SELECT browser_enabled, browser_clipboard, sftp_port FROM rdp_routes WHERE id = ?').get(created.id);
    assert.equal(row.browser_enabled, 1);
    assert.equal(row.browser_clipboard, 1);
    assert.equal(row.sftp_port, 2222);
  });
});
