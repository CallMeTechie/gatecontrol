'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const license = require('../src/services/license');

test('browser_sessions defaults to false in COMMUNITY_FALLBACK', () => {
  assert.equal(license.COMMUNITY_FALLBACK.browser_sessions, false);
});
