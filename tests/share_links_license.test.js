'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('share_links defaults to false in COMMUNITY_FALLBACK', () => {
  const license = require('../src/services/license');
  assert.equal(license.COMMUNITY_FALLBACK.share_links, false);
});
