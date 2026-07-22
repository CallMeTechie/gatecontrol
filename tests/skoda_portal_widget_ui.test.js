'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

const I18N_KEYS = [
  'portal.skoda.title', 'portal.skoda.soc', 'portal.skoda.range', 'portal.skoda.locked',
  'portal.skoda.unlocked', 'portal.skoda.charging', 'portal.skoda.climate', 'portal.skoda.target_temp',
  'portal.skoda.climate_remaining', 'portal.skoda.window_heating',
  'portal.skoda.mileage', 'portal.skoda.inspection', 'portal.skoda.partner',
  'portal.skoda.position', 'portal.skoda.as_of',
  'portal.skoda.doors', 'portal.skoda.windows', 'portal.skoda.cable_connected', 'portal.skoda.warnings',
  'portal.skoda.bonnet', 'portal.skoda.trunk', 'portal.skoda.sunroof', 'portal.skoda.lights_on',
  'portal.skoda.climate_on', 'portal.skoda.climate_off',
];
// PT_CAMEL must cover every client-used key so a forgotten PT entry fails the test.
const PT_CAMEL = ['skodaTitle', 'skodaSoc', 'skodaRange', 'skodaLocked', 'skodaUnlocked', 'skodaCharging',
  'skodaClimate', 'skodaTargetTemp', 'skodaClimateRemaining', 'skodaWindowHeating', 'skodaMileage',
  'skodaInspection', 'skodaPartner', 'skodaPosition', 'skodaAsOf', 'skodaWindows', 'skodaDoors',
  'skodaCableConnected', 'skodaWarnings', 'skodaBonnet', 'skodaTrunk', 'skodaSunroof', 'skodaLightsOn',
  'skodaClimateOn', 'skodaClimateOff'];

test('portal.skoda.* keys exist in de and en', () => {
  for (const k of I18N_KEYS) {
    assert.ok(de[k] && de[k].trim(), `de missing ${k}`);
    assert.ok(en[k] && en[k].trim(), `en missing ${k}`);
  }
});

test('portal.njk carries the skoda widget block, PT keys and container ids', () => {
  const njk = fs.readFileSync(path.join(__dirname, '..', 'templates', 'portal', 'portal.njk'), 'utf8');
  assert.match(njk, /\{%\s*if widgets\.skoda\s*%\}/);
  assert.match(njk, /c-skoda/);
  assert.match(njk, /id="skoda-list"/);
  for (const k of PT_CAMEL) assert.ok(njk.includes(k), `portal-i18n block missing ${k}`);
});

test('portal.css styles the skoda widget and portal.js hydrates it', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'portal.css'), 'utf8');
  assert.match(css, /\.c-skoda/);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'portal.js'), 'utf8');
  assert.match(js, /hydrateSkoda/);
  assert.match(js, /\/api\/v1\/portal\/skoda/);
});
