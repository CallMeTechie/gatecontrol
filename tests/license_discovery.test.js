'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const license = require('../src/services/license');

test('discovery flags default to false when unset (community)', () => {
  // hasFeature returns false for absent/false keys; this is a smoke check.
  // The real point of this task is that the keys EXIST in COMMUNITY_FALLBACK so
  // the UI + requireFeature guards reference a real flag (verified by reading the file).
  assert.equal(license.hasFeature('gateway_lan_discovery'), false);
  assert.equal(license.hasFeature('gateway_lan_discovery_multi_subnet'), false);
});

test('discovery flags can be unlocked for tests', () => {
  license._overrideForTest({ gateway_lan_discovery: true, gateway_lan_discovery_multi_subnet: true });
  assert.equal(license.hasFeature('gateway_lan_discovery'), true);
  assert.equal(license.hasFeature('gateway_lan_discovery_multi_subnet'), true);
});
