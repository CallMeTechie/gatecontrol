// tests/pihole_portal_settings_ui.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
test('pihole widget toggle present in the Portal section', () => {
  const html = fs.readFileSync(path.join(__dirname,'..','templates','aurora','pages','settings.njk'),'utf8');
  assert.ok(html.includes("switchRow('st-w-pihole', 'w-pihole'"), 'toggle row missing');
  assert.ok(html.includes('settings.portal.widget_pihole'), 'i18n key missing');
});
test('settings.js saves the pihole widget with the portal widgets (PUT widgets.pihole)', () => {
  const js = fs.readFileSync(path.join(__dirname,'..','public','js','settings.js'),'utf8');
  assert.match(js, /pihole: 'w-pihole'/);
  assert.match(js, /body\.widgets = widgets/);
  assert.match(js, /api\.put\('\/api\/v1\/settings\/portal', body\)/);
});
