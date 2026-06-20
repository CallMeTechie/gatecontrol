process.env.GC_SECRET = 'test-secret-value-for-unit-tests';
process.env.GC_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { buildConnectionSettings } = require('../src/services/guacSettings');
const { describe, it } = require('node:test'); const assert = require('node:assert/strict');
const rdp = { access_mode:'internal', host:'10.0.0.5', protocol:'rdp', port:3389, browser_clipboard:0,
  browser_enable_sftp:1, sftp_host:'10.0.0.6', sftp_port:22, sftp_username:'s',
  sftp_disable_download:1, sftp_disable_upload:1 };
describe('applySftp (rdp/vnc secondary)', () => {
  it('internal: enable-sftp + sftp-hostname/username + auth + locked transfers', () => {
    const c = buildConnectionSettings(rdp, { sftp_password:'sp' });
    assert.equal(c.settings['enable-sftp'], 'true');
    assert.equal(c.settings['sftp-hostname'], '10.0.0.6');
    assert.equal(String(c.settings['sftp-port']), '22');
    assert.equal(c.settings['sftp-username'], 's');
    assert.equal(c.settings['sftp-password'], 'sp');
    assert.equal(c.settings['sftp-disable-download'], 'true');
    assert.equal(c.settings['sftp-disable-upload'], 'true');
  });
  it('gateway route: sftp skipped (unreachable secondary — DA-2)', () => {
    const c = buildConnectionSettings({ ...rdp, access_mode:'gateway', gateway_listen_port:23389 }, { sftp_password:'sp' });
    assert.equal(c.settings['enable-sftp'], undefined);
  });
});
