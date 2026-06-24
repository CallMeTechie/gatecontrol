'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const en = require('../src/i18n/en.json');
const de = require('../src/i18n/de.json');

const KEYS = [
  'settings.domains.title', 'settings.domains.intro', 'settings.domains.add',
  'settings.domains.domain', 'settings.domains.status', 'settings.domains.verified_at',
  'settings.domains.verify', 'settings.domains.remove', 'settings.domains.invalid',
  'settings.domains.status_verified', 'settings.domains.status_failed', 'settings.domains.status_pending',
  'settings.domains.server_ip', 'settings.domains.server_ip_override', 'settings.domains.server_ip_warning',
  'settings.domains.points_note', 'settings.domains.invalid_ip',
];

test('all settings.domains.* keys present in both locales', () => {
  for (const k of KEYS) {
    assert.ok(en[k], `en missing ${k}`);
    assert.ok(de[k], `de missing ${k}`);
  }
});
