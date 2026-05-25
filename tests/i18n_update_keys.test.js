'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const en = require('../src/i18n/en.json');
const de = require('../src/i18n/de.json');
const KEYS = ['gateways.update_confirm','gateways.update_requested','gateways.update_running','gateways.update_done','gateways.update_failed','gateways.update_unknown','gateways.update_dismiss','gateways.update_cooldown','gateways.update_not_migrated','gateways.release_notes','gateways.lbl_image_digest','gateways.lbl_last_pull','gateways.last_pull_never'];
test('all new gateway update keys exist in en + de', () => {
  for (const k of KEYS) { assert.ok(k in en, 'missing en: '+k); assert.ok(k in de, 'missing de: '+k); }
});
