'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assembleRouteDomain, isValidPrefix } = require('../public/js/routeDomain');

test('assembleRouteDomain joins prefix + base; empty prefix = apex', () => {
  assert.equal(assembleRouteDomain('nas', 'domaincaster.com'), 'nas.domaincaster.com');
  assert.equal(assembleRouteDomain('', 'domaincaster.com'), 'domaincaster.com');
  assert.equal(assembleRouteDomain(' NAS ', 'Domaincaster.com'), 'nas.domaincaster.com');
  assert.equal(assembleRouteDomain('a.b', 'example.com'), 'a.b.example.com');
  assert.equal(assembleRouteDomain('nas', ''), '');
});

test('isValidPrefix: empty ok; labels validated', () => {
  assert.equal(isValidPrefix(''), true);
  assert.equal(isValidPrefix('nas'), true);
  assert.equal(isValidPrefix('a.b'), true);
  assert.equal(isValidPrefix('bad_label'), false);
  assert.equal(isValidPrefix('-bad'), false);
});
