'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

const KEYS = [
  'skoda.title', 'skoda.accounts.title', 'skoda.accounts.add', 'skoda.accounts.email',
  'skoda.accounts.password', 'skoda.accounts.status.ok', 'skoda.accounts.status.login_failed',
  'skoda.accounts.status.rate_limited', 'skoda.accounts.status.error', 'skoda.accounts.remove',
  'skoda.accounts.change_password', 'skoda.vehicles.title', 'skoda.vehicles.empty',
  'skoda.vehicle.soc', 'skoda.vehicle.range', 'skoda.vehicle.locked', 'skoda.vehicle.unlocked',
  'skoda.vehicle.refresh', 'skoda.vehicle.owners', 'skoda.vehicle.fetched', 'skoda.vehicle.mileage',
  'skoda.settings.poll_interval', 'skoda.owner.save', 'skoda.owner.title',
  'nav.skoda', 'skoda.error.cooldown', 'skoda.error.generic',
];

test('all skoda keys exist in de and en', () => {
  for (const k of KEYS) {
    assert.ok(de[k] && de[k].trim(), `de missing ${k}`);
    assert.ok(en[k] && en[k].trim(), `en missing ${k}`);
  }
});

test('client-side keys are in all three layout GC.t whitelists', () => {
  const CLIENT_KEYS = KEYS.filter((k) => k.startsWith('skoda.'));
  for (const theme of ['aurora', 'default', 'pro']) {
    const layout = fs.readFileSync(path.join(__dirname, '..', 'templates', theme, 'layout.njk'), 'utf8');
    for (const k of CLIENT_KEYS) assert.ok(layout.includes(`'${k}'`), `${theme} layout missing ${k}`);
  }
});
