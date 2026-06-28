'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const en = require('../src/i18n/en.json');
const de = require('../src/i18n/de.json');

const KEYS = [
  'midea.owners.manage', 'midea.owners.assign', 'midea.owners.modal_title',
  'midea.owners.modal_sub', 'midea.owners.search', 'midea.owners.selected',
  'midea.owners.cancel', 'midea.kpi.devices', 'midea.kpi.online',
  'midea.kpi.assigned', 'midea.kpi.cloud', 'midea.add.title',
  'midea.add.tab_cloud', 'midea.add.tab_manual', 'midea.device.current',
  'midea.device.online',
];

test('redesign i18n keys exist in en + de', () => {
  for (const k of KEYS) {
    assert.ok(en[k], `en missing ${k}`);
    assert.ok(de[k], `de missing ${k}`);
  }
});

// reused keys the redesign JS resolves via T() at runtime (must also be whitelisted)
const REUSED_CLIENT = ['midea.owners.label', 'midea.owners.none', 'midea.owners.error_unknown_user', 'midea.device.mode', 'midea.cloud.connected'];
test('redesign + reused client keys are whitelisted in all 3 layouts', () => {
  for (const theme of ['aurora', 'default', 'pro']) {
    const layout = fs.readFileSync(`templates/${theme}/layout.njk`, 'utf8');
    for (const k of [...KEYS, ...REUSED_CLIENT]) {
      assert.ok(layout.includes(`'${k}'`), `${theme}/layout.njk missing whitelist for ${k}`);
    }
  }
});
