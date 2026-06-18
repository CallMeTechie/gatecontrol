'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeConfigHash, CONFIG_HASH_VERSION } = require('@callmetechie/gatecontrol-config-hash');

describe('config-hash package wired correctly', () => {
  it('CONFIG_HASH_VERSION is 2', () => {
    assert.equal(CONFIG_HASH_VERSION, 2);
  });

  it('computeConfigHash produces sha256: hash', () => {
    const cfg = { config_hash_version: 2, peer_id: 1, routes: [], l4_routes: [] };
    const hash = computeConfigHash(cfg);
    assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  });
});
