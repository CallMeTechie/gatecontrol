'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tokens = require('../src/services/tokens');

describe('tokens: gateway scope', () => {
  it('gateway is in VALID_SCOPES', () => {
    assert.ok(tokens.VALID_SCOPES.includes('gateway'));
  });

  it('hasPathAccess(/api/v1/gateway/config, ["gateway"]) returns true', () => {
    assert.equal(tokens.hasPathAccess('/api/v1/gateway/config', ['gateway']), true);
  });

  it('hasPathAccess(/api/v1/gateway/config, ["client"]) returns false', () => {
    assert.equal(tokens.hasPathAccess('/api/v1/gateway/config', ['client']), false);
  });

  it('hasPathAccess(/api/v1/peers, ["gateway"]) returns false', () => {
    assert.equal(tokens.hasPathAccess('/api/v1/peers', ['gateway']), false);
  });
});
