'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const en = require('../src/i18n/en.json');
const de = require('../src/i18n/de.json');

// i18n files are FLAT — literal dotted keys, NOT nested objects.
// translate() does a flat locale[key] lookup, so each key must exist as a
// top-level entry. This is the FULL set the feature actually uses (Tasks 11
// and 12 introduced more keys than the plan's original list), discovered by
// grepping public/js/routes.js + the share login/route-edit templates.
const keys = [
  'route_auth.method_share',
  'route_auth.share_managed',
  'route_auth.share_invite_title',
  'route_auth.share_invite_body',
  'route_auth.share_invalid_body',
  'route_auth.share_links_title',
  'route_auth.share_create',
  'route_auth.share_gate_warning',
  'route_auth.share_copy_warning',
  'route_auth.share_none',
  'route_auth.share_one_time',
  'route_auth.share_reusable',
  'route_auth.share_redeemed',
  'route_auth.share_revoke',
  'route_auth.share_label',
];

test('all share-link i18n keys exist in en + de', () => {
  for (const k of keys) {
    assert.ok(k in en, `en missing ${k}`);
    assert.ok(k in de, `de missing ${k}`);
  }
});

test('common.copy (read by routes.js for the share URL Copy button) exists', () => {
  assert.ok('common.copy' in en, 'en missing common.copy');
  assert.ok('common.copy' in de, 'de missing common.copy');
});
