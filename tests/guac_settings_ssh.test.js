'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildConnectionSettings } = require('../src/services/guacSettings');
const base = { access_mode:'internal', host:'10.0.0.7', protocol:'ssh', port:22, browser_clipboard:0 };

describe('buildSsh', () => {
  it('password auth', () => {
    const c = buildConnectionSettings(base, { username:'u', password:'p' });
    assert.equal(c.type, 'ssh');
    assert.equal(c.settings.hostname, '10.0.0.7');
    assert.equal(String(c.settings.port), '22');
    assert.equal(c.settings.username, 'u');
    assert.equal(c.settings.password, 'p');
  });
  it('private-key auth (+ passphrase)', () => {
    const c = buildConnectionSettings(base, { username:'u', ssh_private_key:'KEY', ssh_passphrase:'pp' });
    assert.equal(c.settings['private-key'], 'KEY');
    assert.equal(c.settings.passphrase, 'pp');
  });
  it('native sftp toggle adds enable-sftp + locked transfers by default', () => {
    const c = buildConnectionSettings({ ...base, browser_enable_sftp:1, sftp_disable_download:1, sftp_disable_upload:1 }, { username:'u', password:'p' });
    assert.equal(c.settings['enable-sftp'], 'true');
    assert.equal(c.settings['sftp-disable-download'], 'true');
    assert.equal(c.settings['sftp-disable-upload'], 'true');
  });
});
