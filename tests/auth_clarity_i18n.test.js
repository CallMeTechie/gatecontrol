'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const en = require('../src/i18n/en.json');
const de = require('../src/i18n/de.json');
const keys = ['route_auth.share_err_basic_auth','route_auth.share_err_l4','route_auth.share_err_expiry'];
test('share error i18n keys exist in en + de', () => {
  for (const k of keys) { assert.ok(k in en, 'en missing '+k); assert.ok(k in de, 'de missing '+k); }
});
