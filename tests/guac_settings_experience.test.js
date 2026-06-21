'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildConnectionSettings } = require('../src/services/guacSettings');

// minimal rdp route with experience columns
function rdpRoute(over = {}) {
  return Object.assign({
    access_mode: 'internal', host: '10.0.0.5', protocol: 'rdp', port: 3389,
    browser_clipboard: 0, color_depth: 32,
    disable_wallpaper: 0, disable_themes: 0, disable_animations: 0,
    network_profile: 'auto', nla_enabled: 1,
    redirect_printers: 0, resolution_mode: 'fullscreen',
  }, over);
}

describe('rdp display settings', () => {
  it('color-depth comes from route.color_depth', () => {
    const c = buildConnectionSettings(rdpRoute({ color_depth: 24 }), {});
    assert.equal(c.settings['color-depth'], '24');
  });
  it('color-depth defaults to 32 when null', () => {
    const c = buildConnectionSettings(rdpRoute({ color_depth: null }), {});
    assert.equal(c.settings['color-depth'], '32');
  });
  it('wallpaper ON when disable_wallpaper=0 (fixes black background)', () => {
    const c = buildConnectionSettings(rdpRoute({ disable_wallpaper: 0 }), {});
    assert.equal(c.settings['enable-wallpaper'], 'true');
  });
  it('wallpaper OFF when disable_wallpaper=1', () => {
    const c = buildConnectionSettings(rdpRoute({ disable_wallpaper: 1 }), {});
    assert.equal(c.settings['enable-wallpaper'], 'false');
  });
  it('theming + menu-animations follow the inverse of their disable_* flags', () => {
    const c = buildConnectionSettings(rdpRoute({ disable_themes: 1, disable_animations: 0 }), {});
    assert.equal(c.settings['enable-theming'], 'false');
    assert.equal(c.settings['enable-menu-animations'], 'true');
  });
});

describe('rdp network_profile → experience flags', () => {
  it('lan/auto enable font-smoothing + full-window-drag + desktop-composition', () => {
    for (const p of ['lan', 'auto']) {
      const c = buildConnectionSettings(rdpRoute({ network_profile: p }), {});
      assert.equal(c.settings['enable-font-smoothing'], 'true');
      assert.equal(c.settings['enable-full-window-drag'], 'true');
      assert.equal(c.settings['enable-desktop-composition'], 'true');
    }
  });
  it('broadband keeps font-smoothing but drops drag + composition', () => {
    const c = buildConnectionSettings(rdpRoute({ network_profile: 'broadband' }), {});
    assert.equal(c.settings['enable-font-smoothing'], 'true');
    assert.equal(c.settings['enable-full-window-drag'], 'false');
    assert.equal(c.settings['enable-desktop-composition'], 'false');
  });
  it('modem disables all three experience extras', () => {
    const c = buildConnectionSettings(rdpRoute({ network_profile: 'modem' }), {});
    assert.equal(c.settings['enable-font-smoothing'], 'false');
    assert.equal(c.settings['enable-full-window-drag'], 'false');
    assert.equal(c.settings['enable-desktop-composition'], 'false');
  });
  it('does not force-disable bitmap caching on any profile', () => {
    const c = buildConnectionSettings(rdpRoute({ network_profile: 'modem' }), {});
    assert.equal(c.settings['disable-bitmap-caching'], undefined);
  });
});

describe('rdp security + domain', () => {
  it('nla_enabled=1 → security any (negotiate, preserves working behaviour)', () => {
    const c = buildConnectionSettings(rdpRoute({ nla_enabled: 1 }), {});
    assert.equal(c.settings.security, 'any');
  });
  it('nla_enabled=0 → security rdp (user explicitly disabled NLA)', () => {
    const c = buildConnectionSettings(rdpRoute({ nla_enabled: 0 }), {});
    assert.equal(c.settings.security, 'rdp');
  });
  it('domain is passed when set, omitted when empty', () => {
    assert.equal(buildConnectionSettings(rdpRoute({ domain: 'CORP' }), {}).settings.domain, 'CORP');
    assert.equal(buildConnectionSettings(rdpRoute({ domain: '' }), {}).settings.domain, undefined);
    assert.equal(buildConnectionSettings(rdpRoute({ domain: null }), {}).settings.domain, undefined);
  });
  it('ignore-cert stays true', () => {
    assert.equal(buildConnectionSettings(rdpRoute(), {}).settings['ignore-cert'], 'true');
  });
});

describe('rdp redirects (browser-mappable only)', () => {
  it('enable-printing follows redirect_printers', () => {
    assert.equal(buildConnectionSettings(rdpRoute({ redirect_printers: 1 }), {}).settings['enable-printing'], 'true');
    assert.equal(buildConnectionSettings(rdpRoute({ redirect_printers: 0 }), {}).settings['enable-printing'], undefined);
  });
  it('native-only redirects are NOT mapped to guacd (no enable-drive / usb / smartcard)', () => {
    const c = buildConnectionSettings(rdpRoute({ redirect_drives: 1, redirect_usb: 1, redirect_smartcard: 1, multi_monitor: 1 }), {});
    assert.equal(c.settings['enable-drive'], undefined);
    assert.equal(c.settings['enable-printing'], undefined);
  });
});
