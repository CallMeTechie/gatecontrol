// tests/pihole_portal_widget_ui.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
test('portal.njk has a gated Pi-hole card (tab "Netzwerk" + start donut)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'portal', 'portal.njk'), 'utf8');
  assert.ok(/\{%\s*if\s+tabs\.pihole\s*%\}/.test(html), 'no tabs.pihole gate');
  assert.ok(html.includes('data-area="pihole"'), 'no pihole area');
  assert.ok(html.includes('portal.pihole.title'), 'no title i18n key');
});
test('the route gates the Pi-hole area on widget + licence', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'portal.js'), 'utf8');
  assert.match(src, /pihole: identified && w\.pihole && license\.hasFeature\('pihole_integration'\)/);
});
test('portal.js loads the Pi-hole data at boot, only when the area exists', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'portal.js'), 'utf8');
  assert.ok(/function loadPihole\(scope, first\) \{\n\s+if \(!TABS\.pihole\) return;/.test(js), 'no guard');
  assert.ok(/loadPihole\('device', true\);/.test(js), 'not called at boot');
});
