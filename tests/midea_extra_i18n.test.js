'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

const ADMIN = ['midea.fan.label', 'midea.fan.auto', 'midea.fan.silent', 'midea.extras.label', 'midea.turbo', 'midea.eco', 'midea.device.outdoor'];
const PORTAL = ['portal.midea.fan', 'portal.midea.fan_auto', 'portal.midea.fan_silent', 'portal.midea.extras', 'portal.midea.turbo', 'portal.midea.eco', 'portal.midea.outdoor', 'portal.midea.target', 'portal.midea.mode'];

test('admin + portal midea extra keys exist in de and en', () => {
  for (const k of [...ADMIN, ...PORTAL]) {
    assert.ok(de[k] && de[k].trim(), `de missing ${k}`);
    assert.ok(en[k] && en[k].trim(), `en missing ${k}`);
  }
});
