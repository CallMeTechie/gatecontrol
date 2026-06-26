'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
test('portal.njk has a scope segment switcher in the pihole card', () => {
  const html = fs.readFileSync(path.join(__dirname,'..','templates','portal','portal.njk'),'utf8');
  assert.ok(/data-scope=["']device["']/.test(html) && /data-scope=["']owner["']/.test(html) && /data-scope=["']household["']/.test(html), 'missing scope buttons');
  assert.ok(/id=["']piholeSeg["']/.test(html), 'missing #piholeSeg');
  assert.ok(html.includes('portal.pihole.scope_device') && html.includes('portal.pihole.scope_owner') && html.includes('portal.pihole.scope_household'), 'missing scope i18n');
  // cache-bust fix (Step 3e): portal.js must be versioned like portal.css, else stale cached JS leaves the card on placeholders
  assert.ok(/\/js\/portal\.js\?v=/.test(html), 'portal.js script tag missing ?v= cache-bust');
});
