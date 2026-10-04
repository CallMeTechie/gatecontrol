'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const en = require('../src/i18n/en.json');
const de = require('../src/i18n/de.json');

// The settings page (Domains section) labels come from st.domains.* / st.serverip.*;
// these are the server-side messages and the warning that are still used.
const KEYS = [
  'settings.domains.invalid', 'settings.domains.server_ip', 'settings.domains.server_ip_warning',
  'settings.domains.invalid_ip', 'st.domains.title', 'st.domains.add', 'st.serverip.title',
];

test('all settings.domains.* keys present in both locales', () => {
  for (const k of KEYS) {
    assert.ok(en[k], `en missing ${k}`);
    assert.ok(de[k], `de missing ${k}`);
  }
});
