'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
test('trust toggle + help present in all 3 theme settings pages', () => {
  for (const theme of ['aurora','default','pro']) {
    const html = fs.readFileSync(path.join(__dirname,'..','templates',theme,'pages','settings.njk'),'utf8');
    assert.ok(html.includes('portal-trust-owner-mapping'), `${theme}: toggle id`);
    assert.ok(html.includes('settings.portal.trust_owner_mapping'), `${theme}: label key`);
    assert.ok(html.includes('settings.portal.trust_owner_mapping_help'), `${theme}: help key`);
  }
});
test('settings.js wires trust toggle into portal cluster + PUT', () => {
  const js = fs.readFileSync(path.join(__dirname,'..','public','js','settings.js'),'utf8');
  assert.ok(/portal-trust-owner-mapping/.test(js));
  assert.ok(/trust_owner_mapping:/.test(js));
});
