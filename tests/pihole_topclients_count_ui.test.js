'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
test('top_clients_count field in all 3 theme settings pages', () => {
  for (const theme of ['aurora','default','pro']) {
    const html = fs.readFileSync(path.join(__dirname,'..','templates',theme,'pages','settings.njk'),'utf8');
    assert.ok(html.includes('pihole-top-clients-count'), `${theme}: field id`);
    assert.ok(html.includes('pihole.cfg.top_clients_count'), `${theme}: i18n key`);
  }
});
test('settings.js wires top_clients_count (populate + save + valuesById)', () => {
  const js = fs.readFileSync(path.join(__dirname,'..','public','js','settings.js'),'utf8');
  assert.ok(/pihole-top-clients-count/.test(js));
  assert.ok(/top_clients_count/.test(js));
});
