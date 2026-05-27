'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
test('access_windows defaults false', () => {
  assert.equal(require('../src/services/license').COMMUNITY_FALLBACK.access_windows, false);
});
