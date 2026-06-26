// tests/pihole_portal_widget_ui.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
test('portal.njk has a gated pihole widget block', () => {
  const html = fs.readFileSync(path.join(__dirname,'..','templates','portal','portal.njk'),'utf8');
  assert.ok(/\{%\s*if\s+widgets\.pihole\s*%\}/.test(html), 'no widgets.pihole gate');
  assert.ok(html.includes('pihole-widget'), 'no .pihole-widget container');
  assert.ok(html.includes('portal.pihole.title'), 'no title i18n key');
});
test('portal.js has hydratePihole wired to the endpoint + DOM guard', () => {
  const js = fs.readFileSync(path.join(__dirname,'..','public','js','portal.js'),'utf8');
  assert.ok(/function hydratePihole\(/.test(js));
  assert.ok(/\/api\/v1\/portal\/pihole/.test(js));
  assert.ok(/querySelector\(\s*['"]\.pihole-widget['"]\s*\)/.test(js), 'no DOM guard on .pihole-widget');
  assert.ok(/hydratePihole\(\);/.test(js), 'hydratePihole not called at boot');
});
test('hydratePiholeScope uses PT for i18n (not undefined I18N) and leaks no raw fields', () => {
  // TP2b refactor: the render logic that TP2a kept in hydratePihole() now lives in
  // hydratePiholeScope(scope); hydratePihole() is a thin delegator that wires the
  // segment switcher and calls hydratePiholeScope('device'). Inspect the render fn.
  const js = fs.readFileSync(path.join(__dirname,'..','public','js','portal.js'),'utf8');
  const m = js.match(/function hydratePiholeScope\([\s\S]*?\n  \}/);
  assert.ok(m, 'hydratePiholeScope not found');
  const body = m[0];
  assert.ok(/\bPT\[/.test(body), 'must use PT[key] (the real i18n object, portal.js:14)');
  assert.ok(!/\bI18N\b/.test(body), 'I18N is undefined in portal.js — use PT');
  // client-side structural leak guard (spec §6 test 3, second half): only whitelisted fields
  assert.ok(!/\.topClients\b|\.clients\b|\.ip\b/.test(body), 'hydratePiholeScope references a raw cache field');
});
