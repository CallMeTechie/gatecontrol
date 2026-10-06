'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');
const KEYS = ['portal.car.climatize', 'portal.car.climate_on', 'portal.car.climate_off', 'portal.car.target_temp', 'portal.car.apply', 'portal.car.charge_start',
  'portal.car.charge_stop', 'portal.car.charge_limit', 'portal.car.window_heat', 'portal.car.lock', 'portal.car.unlock', 'portal.car.unlock_ok',
  'portal.car.confirm_unlock', 'portal.car.confirm_unlock_title', 'portal.car.cmd_sent', 'portal.car.cmd_failed'];

test('portal.car command keys in de and en', () => {
  for (const k of KEYS) { assert.ok(de[k] && de[k].trim(), `de ${k}`); assert.ok(en[k] && en[k].trim(), `en ${k}`); }
});
test('portal.js command wiring: gated on the login, unlock asks first', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'portal.js'), 'utf8');
  assert.match(js, /function carCommand\(/);
  assert.match(js, /\/api\/v1\/portal\/skoda\/vehicles\/' \+ Number\(v\.id\) \+ '\/command'/);
  assert.match(js, /if \(!carLoggedIn\) return Promise\.resolve\(\);/);
  assert.match(js, /action === 'unlock'\s+\? portalConfirm\(\{[\s\S]{0,240}danger: true \}\)/);
});
