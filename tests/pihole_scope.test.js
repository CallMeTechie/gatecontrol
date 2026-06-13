'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tokens = require('../src/services/tokens');

test('pihole read path requires pihole scope', () => {
  assert.equal(tokens.checkScope(['pihole'], '/api/v1/pihole/summary', 'GET'), true);
  assert.equal(tokens.checkScope(['routes'], '/api/v1/pihole/summary', 'GET'), false);
});

test('pihole blocking control requires pihole:control scope', () => {
  assert.equal(tokens.checkScope(['pihole:control'], '/api/v1/pihole/blocking', 'POST'), true);
  assert.equal(tokens.checkScope(['pihole'], '/api/v1/pihole/blocking', 'POST'), false);
});
