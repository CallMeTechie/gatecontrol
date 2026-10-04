'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
test('top_clients_count field in the Pi-hole section (1–5000)', () => {
  const html = fs.readFileSync(path.join(__dirname,'..','templates','aurora','pages','settings.njk'),'utf8');
  assert.ok(html.includes("numRow('st-ph-top', 'ph-top'"), 'field');
  assert.ok(/numRow\('st-ph-top'.*, 1, 5000\) \}\}/.test(html), 'range');
  assert.ok(html.includes('pihole.cfg.top_clients_count'), 'i18n key');
});
test('settings.js wires top_clients_count (populate + save)', () => {
  const js = fs.readFileSync(path.join(__dirname,'..','public','js','settings.js'),'utf8');
  assert.match(js, /'ph-top': c\.top_clients_count/);
  assert.match(js, /top_clients_count: int\(vals\['ph-top'\]\)/);
});
