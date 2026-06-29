'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

beforeEach(async () => { await setup(); });
afterEach(async () => { await teardown(); });

test('smarthome key exists in COMMUNITY_FALLBACK (default false)', () => {
  const license = require('../src/services/license');
  assert.ok(Object.prototype.hasOwnProperty.call(license.COMMUNITY_FALLBACK, 'smarthome'));
  assert.equal(license.COMMUNITY_FALLBACK.smarthome, false);
});

test('hasFeature reflects override', () => {
  const license = require('../src/services/license');
  license._overrideForTest({ smarthome: false });
  assert.equal(license.hasFeature('smarthome'), false);
  license._overrideForTest({ smarthome: true });
  assert.equal(license.hasFeature('smarthome'), true);
});
