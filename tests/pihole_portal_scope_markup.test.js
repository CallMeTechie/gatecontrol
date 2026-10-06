'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
test('portal.njk has a scope segment switcher in the Pi-hole card', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'portal', 'portal.njk'), 'utf8');
  for (const s of ['device', 'owner', 'household']) assert.ok(new RegExp(`data-scope="${s}"`).test(html), s);
  assert.ok(html.includes('id="pt-pi-seg"') && html.includes('role="group"'), 'missing #pt-pi-seg group');
  assert.ok(html.includes('portal.pihole.scope_device') && html.includes('portal.pihole.scope_owner') && html.includes('portal.pihole.scope_household'), 'missing scope i18n');
  // cache-bust: portal.js versioned like portal.css
  assert.ok(/\/js\/portal\.js\?v=/.test(html), 'portal.js script tag missing ?v= cache-bust');
});
