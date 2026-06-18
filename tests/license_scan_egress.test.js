'use strict';
const crypto = require('crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test } = require('node:test');
const assert = require('node:assert/strict');
test('gateway_scan_egress defaults to false in community fallback', () => {
  delete require.cache[require.resolve('../src/services/license')];
  const lic = require('../src/services/license');
  assert.equal(lic.getFeatures().gateway_scan_egress, false);
});
