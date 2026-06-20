process.env.GC_SECRET = 'test-secret-value-for-unit-tests';
process.env.GC_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { buildConnectionSettings } = require('../src/services/guacSettings');
const { describe, it } = require('node:test'); const assert = require('node:assert/strict');
const rdp = { access_mode:'internal', host:'h', protocol:'rdp', port:3389, browser_clipboard:0 };
const vnc = { access_mode:'internal', host:'h', protocol:'vnc', port:5900, browser_clipboard:0 };
describe('applyAudio', () => {
  it('rdp: nothing at default (NULL) — byte-identical', () => {
    assert.equal(buildConnectionSettings({ ...rdp, rdp_disable_audio:null }, {}).settings['disable-audio'], undefined);
  });
  it('rdp: disable-audio when rdp_disable_audio=1', () => {
    assert.equal(buildConnectionSettings({ ...rdp, rdp_disable_audio:1 }, {}).settings['disable-audio'], 'true');
  });
  it('vnc internal: enable-audio + servername when browser_enable_audio=1', () => {
    const c = buildConnectionSettings({ ...vnc, browser_enable_audio:1, audio_servername:'10.0.0.9' }, {});
    assert.equal(c.settings['enable-audio'], 'true');
    assert.equal(c.settings['audio-servername'], '10.0.0.9');
  });
  it('vnc gateway: audio skipped (unreachable secondary target — DA-2)', () => {
    const c = buildConnectionSettings({ ...vnc, access_mode:'gateway', gateway_listen_port:25900, browser_enable_audio:1, audio_servername:'10.0.0.9' }, {});
    assert.equal(c.settings['enable-audio'], undefined);
  });
});
