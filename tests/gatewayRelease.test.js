'use strict';
process.env.NODE_ENV = 'test';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
function fresh() { delete require.cache[require.resolve('../src/services/gatewayRelease')]; return require('../src/services/gatewayRelease'); }

describe('gatewayRelease', () => {
  let svc;
  beforeEach(() => { svc = fresh(); });
  it('returns null on a cold cache without blocking or firing a real request', () => {
    const t0 = Date.now();
    assert.equal(svc.getLatestVersion(), null);
    assert.ok(Date.now() - t0 < 100);
  });
  it('normalises a tag (strips leading v)', () => {
    assert.equal(svc._normalizeTag('v1.9.3'), '1.9.3');
    assert.equal(svc._normalizeTag('1.9.3'), '1.9.3');
    assert.equal(svc._normalizeTag(null), null);
  });
  it('serves a set cache value', () => { svc._setCache('1.9.3'); assert.equal(svc.getLatestVersion(), '1.9.3'); });
});
