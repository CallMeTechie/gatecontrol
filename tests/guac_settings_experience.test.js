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
