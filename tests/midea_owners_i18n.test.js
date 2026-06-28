'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const en = require('../src/i18n/en.json');
const de = require('../src/i18n/de.json');

const KEYS = ['midea.owners.label', 'midea.owners.none', 'midea.owners.save', 'midea.owners.saved', 'midea.owners.error_unknown_user'];

test('owner i18n keys exist in en + de', () => {
  for (const k of KEYS) {
    assert.ok(en[k], `en missing ${k}`);
    assert.ok(de[k], `de missing ${k}`);
  }
});

test('client-facing owner keys are whitelisted in all 3 layouts', () => {
  const clientKeys = KEYS;   // all 5 are client-facing — T() resolves them in the browser (incl. the alert)
  for (const theme of ['aurora', 'default', 'pro']) {
    const layout = fs.readFileSync(`templates/${theme}/layout.njk`, 'utf8');
    for (const k of clientKeys) {
      assert.ok(layout.includes(`'${k}'`), `${theme}/layout.njk missing whitelist for ${k}`);
    }
  }
});
