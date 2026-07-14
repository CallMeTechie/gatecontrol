'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const en = require('../src/i18n/en.json');
const de = require('../src/i18n/de.json');

const ALL_KEYS = [
  'routes.kpi.total', 'routes.kpi.http', 'routes.kpi.l4',
  'routes.kpi.external', 'routes.kpi.disabled',
  'routes.tag_external', 'routes.tag_internal',
  'routes.exposure_external', 'routes.exposure_internal',
  'routes.search_placeholder',
];
// Client-gerenderte Keys — MÜSSEN in der GC.t-Whitelist aller 3 Layouts stehen
// (Bridge-Lehre: reine Existenz-Tests fangen fehlende Whitelist nicht).
const CLIENT_KEYS = [
  'routes.kpi.total', 'routes.kpi.http', 'routes.kpi.l4',
  'routes.kpi.external', 'routes.kpi.disabled',
  'routes.tag_external', 'routes.tag_internal',
];

test('routes redesign i18n keys exist in en + de', () => {
  for (const k of ALL_KEYS) {
    assert.ok(en[k], `en missing ${k}`);
    assert.ok(de[k], `de missing ${k}`);
  }
});

test('client keys are whitelisted in all 3 layouts', () => {
  for (const theme of ['aurora', 'default', 'pro']) {
    const layout = fs.readFileSync(`templates/${theme}/layout.njk`, 'utf8');
    for (const k of CLIENT_KEYS) {
      assert.ok(layout.includes(`'${k}'`), `${theme}/layout.njk missing whitelist for ${k}`);
    }
  }
});
