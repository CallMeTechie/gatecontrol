'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/services/guacNonceStore');

describe('guac nonce store', () => {
  beforeEach(() => store._clear());
  it('consumes a registered, unexpired jti exactly once', () => {
    store.register('abc', Date.now() + 60000);
    assert.equal(store.consume('abc'), true);   // first
    assert.equal(store.consume('abc'), false);  // replay rejected
  });
  it('rejects an unknown jti', () => {
    assert.equal(store.consume('nope'), false);
  });
  it('rejects an expired jti', () => {
    store.register('old', Date.now() - 1);
    assert.equal(store.consume('old'), false);
  });
});
