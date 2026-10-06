'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

const I18N_KEYS = ['portal.tab.car', 'portal.car.battery', 'portal.car.range', 'portal.car.locked', 'portal.car.unlocked', 'portal.car.charging',
  'portal.car.charging_detail', 'portal.car.climate', 'portal.car.mileage', 'portal.car.inspection', 'portal.car.partner', 'portal.car.position',
  'portal.car.as_of', 'portal.car.doors', 'portal.car.windows', 'portal.car.cable', 'portal.car.warnings', 'portal.car.bonnet', 'portal.car.trunk',
  'portal.car.sunroof', 'portal.car.lights_on', 'portal.car.details', 'portal.car.d_model', 'portal.car.d_year', 'portal.car.d_made',
  'portal.car.d_body', 'portal.car.d_trim', 'portal.car.d_power', 'portal.car.d_battery', 'portal.car.d_max_charging', 'portal.car.d_connection',
  'portal.car.d_online', 'portal.car.d_offline', 'portal.car.d_ignition_on', 'portal.car.d_ignition_off', 'portal.car.d_in_motion',
  'portal.car.d_score', 'portal.car.d_score_week', 'portal.car.d_score_month', 'portal.car.details_error', 'portal.car.details_busy'];

test('portal.car.* keys exist in de and en', () => {
  for (const k of I18N_KEYS) {
    assert.ok(de[k] && de[k].trim(), `de missing ${k}`);
    assert.ok(en[k] && en[k].trim(), `en missing ${k}`);
  }
});

test('portal.njk carries the "Fahrzeug" tab and start card, gated by tabs.car', () => {
  const njk = fs.readFileSync(path.join(__dirname, '..', 'templates', 'portal', 'portal.njk'), 'utf8');
  assert.match(njk, /\{%\s*if tabs\.car\s*%\}/);
  assert.match(njk, /id="panel-fahrzeug"/);
  assert.match(njk, /id="pt-skoda"/);
  assert.match(njk, /id="pt-start-car"/);
});

test('portal.css styles the vehicle and portal.js loads it', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'portal.css'), 'utf8');
  assert.match(css, /\.pt-car /);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'portal.js'), 'utf8');
  assert.match(js, /function loadSkoda\(/);
  assert.match(js, /'\/api\/v1\/portal\/skoda'/);
  assert.match(js, /\/image'/);
  assert.match(js, /\/details'/);
});
