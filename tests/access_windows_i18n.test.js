'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const en = require('../src/i18n/en.json');
const de = require('../src/i18n/de.json');

const KEYS = [
  'access.title',
  'access.add_rule',
  'access.mode_allow',
  'access.mode_block',
  'access.schedule',
  'access.valid_from',
  'access.valid_until',
  'access.label',
  'access.state_allowed',
  'access.state_blocked',
  'access.delete',
  'access.err_schedule',
  'access.err_date_order',
  'access.err_mode',
  'access.target_not_found',
];

test('all access.* keys exist in en.json and de.json', () => {
  for (const k of KEYS) {
    assert.ok(k in en, 'missing en: ' + k);
    assert.ok(k in de, 'missing de: ' + k);
  }
});
