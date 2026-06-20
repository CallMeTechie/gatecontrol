// tests/rdp_persistence_phase2b.test.js
'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test'); const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');
const rdpSvc = require('../src/services/rdp');
let db; before(async () => { await setup(); db = getDb(); }); after(() => teardown());

describe('phase2b persistence', () => {
  it('create persists new credential + audio columns', async () => {
    const r = await rdpSvc.create({ name:'p', host:'10.0.0.7', protocol:'ssh', port:22,
      username:'u', ssh_private_key:'KEYBODY', ssh_passphrase:'pp', rdp_disable_audio:1 });
    const row = db.prepare('SELECT ssh_private_key_encrypted, ssh_passphrase_encrypted, rdp_disable_audio FROM rdp_routes WHERE id=?').get(r.id);
    assert.ok(row.ssh_private_key_encrypted, 'ssh key encrypted+stored');
    assert.ok(row.ssh_passphrase_encrypted);
    assert.equal(row.rdp_disable_audio, 1);
  });
  it('update persists sftp creds', async () => {
    const r = await rdpSvc.create({ name:'p2', host:'10.0.0.5', protocol:'rdp', port:3389 });
    await rdpSvc.update(r.id, { browser_enable_sftp:1, sftp_username:'s', sftp_password:'sp' });
    const row = db.prepare('SELECT sftp_password_encrypted, sftp_username, browser_enable_sftp FROM rdp_routes WHERE id=?').get(r.id);
    assert.ok(row.sftp_password_encrypted, 'sftp password encrypted+stored');
    assert.equal(row.sftp_username, 's');
    assert.equal(row.browser_enable_sftp, 1);
  });
});
