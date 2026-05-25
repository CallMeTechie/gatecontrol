'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions } = require('../src/utils/version');

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
    assert.equal(compareVersions('1.9.2', '1.9.10'), -1);
  });
  it('treats equal/missing-segment versions as 0', () => {
    assert.equal(compareVersions('1.9.2', '1.9.2'), 0);
    assert.equal(compareVersions('1.9', '1.9.0'), 0);
  });
  it('strips a leading v and any -suffix', () => {
    assert.equal(compareVersions('v1.9.3', '1.9.2'), 1);
    assert.equal(compareVersions('1.10.0-rc1', '1.9.0'), 1);
  });
  it('returns 0 (no badge) on unparseable input', () => {
    assert.equal(compareVersions('abc', '1.9.0'), 0);
    assert.equal(compareVersions(null, '1.9.0'), 0);
  });
});
