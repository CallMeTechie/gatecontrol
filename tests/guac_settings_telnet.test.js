'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

// tests/guac_settings_telnet.test.js — env header as usual
const { buildConnectionSettings } = require('../src/services/guacSettings');
const base = { access_mode:'internal', host:'10.0.0.8', protocol:'telnet', port:23, browser_clipboard:0 };
const { describe, it } = require('node:test'); const assert = require('node:assert/strict');
describe('buildTelnet', () => {
  it('builds telnet with port + optional creds + terminal defaults', () => {
    const c = buildConnectionSettings(base, { username:'u', password:'p' });
    assert.equal(c.type, 'telnet');
    assert.equal(String(c.settings.port), '23');
    assert.equal(c.settings.username, 'u');
    assert.equal(c.settings['color-scheme'] !== undefined, true);
    assert.equal(c.settings['enable-sftp'], undefined);  // no sftp for telnet
    assert.equal(c.settings['host-key'], undefined);     // no host-key for telnet
  });
});
