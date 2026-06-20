'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildConnectionSettings, SUPPORTED_PROTOCOLS } = require('../src/services/guacSettings');

const rdp = { access_mode:'internal', host:'10.0.0.5', protocol:'rdp', port:3389, browser_clipboard:0 };

describe('guacSettings dispatch + 2a regression', () => {
  it('SUPPORTED_PROTOCOLS has all four', () => {
    assert.deepEqual([...SUPPORTED_PROTOCOLS].sort(), ['rdp','ssh','telnet','vnc']);
  });
  it('rdp output is byte-identical to 2a for a default route (no disable-audio, no sftp)', () => {
    const c = buildConnectionSettings(rdp, { username:'u', password:'p' });
    assert.equal(c.type, 'rdp');
    assert.equal(c.settings.hostname, '10.0.0.5');
    assert.equal(c.settings['disable-copy'], 'true');
    assert.equal(c.settings['ignore-cert'], 'true');
    assert.equal(c.settings['disable-audio'], undefined);   // DA-1: nothing emitted at default
    assert.equal(c.settings['enable-sftp'], undefined);
  });
  it('throws for an unknown protocol', () => {
    assert.throws(() => buildConnectionSettings({ ...rdp, protocol:'foo' }, {}));
  });
});
