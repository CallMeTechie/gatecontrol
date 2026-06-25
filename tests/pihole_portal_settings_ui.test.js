// tests/pihole_portal_settings_ui.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
test('pihole widget toggle present in all 3 theme settings pages', () => {
  for (const theme of ['aurora','default','pro']) {
    const html = fs.readFileSync(path.join(__dirname,'..','templates',theme,'pages','settings.njk'),'utf8');
    assert.ok(html.includes('portal-widget-pihole'), `${theme}: toggle id missing`);
    assert.ok(html.includes('settings.portal.widget_pihole'), `${theme}: i18n key missing`);
  }
});
test('settings.js wires pihole toggle into the portal cluster + PUT', () => {
  const js = fs.readFileSync(path.join(__dirname,'..','public','js','settings.js'),'utf8');
  assert.ok(/portal-widget-pihole/.test(js));
  assert.ok(/pihole:\s*widgetPihole/.test(js));
});
