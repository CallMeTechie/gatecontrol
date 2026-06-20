'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildConnectionSettings } = require('../src/services/guacSettings');

const base = { access_mode: 'internal', host: '10.0.0.5', protocol: 'rdp', port: 3389,
  browser_clipboard: 0, sftp_disable_download: 1, sftp_disable_upload: 1, browser_enable_sftp: 0 };

describe('buildConnectionSettings', () => {
  it('builds rdp settings with target + credentials', () => {
    const c = buildConnectionSettings(base, { username: 'u', password: 'p' });
    assert.equal(c.type, 'rdp');
    assert.equal(c.settings.hostname, '10.0.0.5');
    assert.equal(String(c.settings.port), '3389');
    assert.equal(c.settings.username, 'u');
    assert.equal(c.settings.password, 'p');
  });
  it('disables clipboard copy/paste when browser_clipboard=0 (default)', () => {
    const c = buildConnectionSettings(base, {});
    assert.equal(c.settings['disable-copy'], 'true');
    assert.equal(c.settings['disable-paste'], 'true');
  });
  it('enables clipboard when browser_clipboard=1', () => {
    const c = buildConnectionSettings({ ...base, browser_clipboard: 1 }, {});
    assert.equal(c.settings['disable-copy'], 'false');
    assert.equal(c.settings['disable-paste'], 'false');
  });
  it('vnc uses port and type vnc', () => {
    const c = buildConnectionSettings({ ...base, protocol: 'vnc', port: 5900 }, {});
    assert.equal(c.type, 'vnc');
    assert.equal(String(c.settings.port), '5900');
    assert.equal(c.settings.security, undefined);
    assert.equal(c.settings['ignore-cert'], undefined);
  });
  it('throws for an unknown protocol', () => {
    assert.throws(() => buildConnectionSettings({ ...base, protocol: 'foo' }, {}));
  });
});
