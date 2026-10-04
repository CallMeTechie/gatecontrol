'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

const THEMES = ['aurora']; // Aurora is the only theme (docs/feature-aurora-only.md)
const ALL_KEYS = [
  'settings.acme_email',
  'settings.acme_email.push_failed',
  'error.settings.acme_email_invalid',
  'error.settings.acme_email_save',
];
test('all new keys exist in de and en', () => {
  for (const k of ALL_KEYS) {
    assert.ok(de[k] && de[k].trim(), `de ${k}`);
    assert.ok(en[k] && en[k].trim(), `en ${k}`);
  }
});

test('the push warning reaches the browser through the settings island (settings.* prefix)', () => {
  const njk = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'settings.njk'), 'utf8');
  assert.match(njk, /id="st-i18n" data-prefixes="[^"]*\bsettings\. /);
});

test('the settings page carries the field; the value comes from GET /settings/acme-email', () => {
  const njk = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'settings.njk'), 'utf8');
  assert.match(njk, /textRow\('st-acme', 'acme-email'/, 'field st-acme (data-st-field acme-email)');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'settings.js'), 'utf8');
  assert.match(js, /get\('\/api\/v1\/settings\/acme-email'\)/, 'prefill from the API');
  assert.match(js, /acme\.data\.inherited \? t\('st\.acme\.email_ph_env'\)/, 'hint for the inherited .env value');
});

test('the save group turns the push warning into a visible note, not a silent success', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'settings.js'), 'utf8');
  const i = js.indexOf("api.put('/api/v1/settings/acme-email'");
  assert.ok(i > 0, 'Bindung an die acme-email-Route fehlt');
  assert.match(js.slice(i, i + 300), /r\.warning \? Object\.assign\(\{\}, r, \{ warning: t\(r\.warning\) \}\)/);
  // save(): a warning is shown in the save bar.
  assert.match(js, /if \(r\.warning\) messages\.push\(r\.warning\)/);
});
