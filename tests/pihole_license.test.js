'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const license = require('../src/services/license');

test('pihole_integration defaults to false in community fallback', () => {
  assert.equal(license.hasFeature('pihole_integration'), false);
});
