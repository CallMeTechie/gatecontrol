'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const en = require('../src/i18n/en.json');
const de = require('../src/i18n/de.json');

const KEYS = [
  'gateways.discovery.title', 'gateways.discovery.subtitle', 'gateways.discovery.devices_title',
  'gateways.discovery.scan_button', 'gateways.discovery.scanning', 'gateways.discovery.scan_failed',
  'gateways.discovery.not_enabled',
  'gateways.discovery.enable', 'gateways.discovery.active_scan', 'gateways.discovery.active_scan_warn',
  'gateways.discovery.subnets', 'gateways.discovery.categories', 'gateways.discovery.category_mode',
  'gateways.discovery.mode_include', 'gateways.discovery.mode_exclude',
  'gateways.discovery.save', 'gateways.discovery.saved', 'gateways.discovery.multi_subnet_locked',
  'gateways.discovery.no_devices', 'gateways.discovery.last_seen_min', 'gateways.discovery.timed_out',
  'routes.suggested.button', 'routes.suggested.adopt', 'routes.suggested.unavailable',
];

test('discovery i18n keys present in en + de', () => {
  for (const k of KEYS) {
    assert.ok(k in en, 'en missing ' + k);
    assert.ok(k in de, 'de missing ' + k);
  }
});

test('en + de discovery keys are non-empty strings', () => {
  for (const k of KEYS) {
    assert.equal(typeof en[k], 'string'); assert.ok(en[k].length);
    assert.equal(typeof de[k], 'string'); assert.ok(de[k].length);
  }
});

// Guards against a key existing in JSON but not injected into window.GC.t
// (the client would silently fall back to the inline default). Covers Step 4.
test('every discovery key is injected into both layout GC.t blocks', () => {
  for (const theme of ['default', 'pro']) {
    const p = path.join(__dirname, '..', 'templates', theme, 'layout.njk');
    if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, 'utf8');
    for (const k of KEYS) {
      assert.ok(txt.includes("'" + k + "'") || txt.includes('"' + k + '"'), theme + ' layout missing GC.t injection for ' + k);
    }
  }
});
