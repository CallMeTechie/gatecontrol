'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('shareRedeemLimiter middleware is exported', () => {
  const rl = require('../src/middleware/rateLimit');
  assert.equal(typeof rl.shareRedeemLimiter, 'function');
});
