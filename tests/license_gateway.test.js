'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { COMMUNITY_FALLBACK } = require('../src/services/license');

describe('license: gateway feature keys', () => {
  it('gateway_peers default is 1', () => {
    assert.equal(COMMUNITY_FALLBACK.gateway_peers, 1);
  });

  it('gateway_http_targets default is 3', () => {
    assert.equal(COMMUNITY_FALLBACK.gateway_http_targets, 3);
  });

  it('gateway_tcp_routing default is false', () => {
    assert.equal(COMMUNITY_FALLBACK.gateway_tcp_routing, false);
  });

  it('gateway_wol default is false', () => {
    assert.equal(COMMUNITY_FALLBACK.gateway_wol, false);
  });
});
