'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const BASE = ['title', 'none', 'timer', 'active', 'time', 'days', 'save', 'saved', 'save_failed', 'invalid', 'not_found', 'readonly'];
const ADMIN_KEYS = BASE.map((k) => `skoda.timers.${k}`).concat(DAYS.map((d) => `skoda.timers.day.${d}`));
const PORTAL_KEYS = BASE.map((k) => `portal.skoda.timers.${k}`).concat(DAYS.map((d) => `portal.skoda.timers.day.${d}`));

test('all timer keys exist in de and en', () => {
  for (const k of ADMIN_KEYS.concat(PORTAL_KEYS)) {
    assert.ok(de[k] && de[k].trim(), `de ${k}`);
    assert.ok(en[k] && en[k].trim(), `en ${k}`);
  }
});

test('all three layouts carry the skoda.timers.* GC.t whitelist', () => {
  for (const theme of ['aurora', 'default', 'pro']) {
    const layout = fs.readFileSync(path.join(__dirname, '..', 'templates', theme, 'layout.njk'), 'utf8');
    for (const k of ADMIN_KEYS) assert.ok(layout.includes(`'${k}'`), `${theme} ${k}`);
  }
});

test('the portal PT block carries every timer key', () => {
  const njk = fs.readFileSync(path.join(__dirname, '..', 'templates', 'portal', 'portal.njk'), 'utf8');
  for (const k of PORTAL_KEYS) assert.ok(njk.includes(`t('${k}')`), `PT block ${k}`);
});
