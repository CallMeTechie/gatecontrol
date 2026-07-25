'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

const THEMES = ['aurora', 'default', 'pro'];
const ALL_KEYS = [
  'settings.acme_email',
  'settings.acme_email_hint',
  'settings.acme_email.inherited',
  'settings.acme_email.push_failed',
  'error.settings.acme_email_invalid',
  'error.settings.acme_email_save',
];
// Nur diese werden vom Client-JS gelesen und brauchen deshalb die GC.t-Brücke.
// settings.autosave.saved existiert seit je in beiden Sprachdateien, fehlt aber in
// ALLEN drei Whitelists — settingsAutosave.js:13 fällt deshalb auf das
// hartkodierte englische 'Saved' zurück, auch in der deutschen Oberfläche.
const BRIDGED = ['settings.acme_email.push_failed', 'settings.autosave.saved'];

test('all new keys exist in de and en', () => {
  for (const k of ALL_KEYS) {
    assert.ok(de[k] && de[k].trim(), `de ${k}`);
    assert.ok(en[k] && en[k].trim(), `en ${k}`);
  }
});

test('client-read keys are bridged into GC.t in all three layouts', () => {
  for (const theme of THEMES) {
    const layout = fs.readFileSync(path.join(__dirname, '..', 'templates', theme, 'layout.njk'), 'utf8');
    // Mit Doppelpunkt prüfen (Projektkonvention, tests/i18n_update_keys.test.js:16):
    // ohne ihn erfüllt schon ein beliebiges t('key')-Vorkommen die Assertion.
    for (const k of BRIDGED) assert.ok(layout.includes(`'${k}':`), `${theme} ${k}`);
  }
});
