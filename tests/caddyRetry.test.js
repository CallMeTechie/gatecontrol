'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { applyRetryConfig } = require('../src/services/caddyRetry');

describe('caddyRetry: applyRetryConfig', () => {
  it('is a no-op when retry_enabled is falsy', () => {
    const rp = { handler: 'reverse_proxy', upstreams: [{ dial: '10.0.0.1:80' }] };
    applyRetryConfig(rp, { retry_enabled: 0 });
    assert.equal(rp.load_balancing, undefined);
  });

  it('creates load_balancing when missing', () => {
    const rp = { handler: 'reverse_proxy', upstreams: [{ dial: '10.0.0.1:80' }] };
    applyRetryConfig(rp, { retry_enabled: 1, retry_count: 3 });
    assert.equal(rp.load_balancing.retries, 3);
  });

  it('preserves an existing load_balancing object — only adds retry fields', () => {
    const rp = {
      handler: 'reverse_proxy',
      load_balancing: { selection_policy: { policy: 'round_robin' } },
    };
    applyRetryConfig(rp, { retry_enabled: 1, retry_count: 4 });
    assert.deepEqual(rp.load_balancing.selection_policy, { policy: 'round_robin' });
    assert.equal(rp.load_balancing.retries, 4);
  });

  it('defaults retry_count to 3 when unset', () => {
    const rp = { handler: 'reverse_proxy' };
    applyRetryConfig(rp, { retry_enabled: 1 });
    assert.equal(rp.load_balancing.retries, 3);
  });

  it('try_duration = max(5, retry_count*2) seconds', () => {
    const lo = { handler: 'reverse_proxy' };
    applyRetryConfig(lo, { retry_enabled: 1, retry_count: 1 });
    assert.equal(lo.load_balancing.try_duration, '5s', 'low retry_count clamps to 5s floor');

    const hi = { handler: 'reverse_proxy' };
    applyRetryConfig(hi, { retry_enabled: 1, retry_count: 10 });
    assert.equal(hi.load_balancing.try_duration, '20s', 'high retry_count scales as count*2');
  });

  it('retry_match.status_code carries parsed codes; absent when none parse', () => {
    const withCodes = { handler: 'reverse_proxy' };
    applyRetryConfig(withCodes, {
      retry_enabled: 1, retry_count: 3, retry_match_status: '502,503,504',
    });
    assert.deepEqual(withCodes.load_balancing.retry_match, [{ status_code: [502, 503, 504] }]);

    const noCodes = { handler: 'reverse_proxy' };
    applyRetryConfig(noCodes, { retry_enabled: 1, retry_count: 3 });
    assert.equal(noCodes.load_balancing.retry_match, undefined,
      'no retry_match key when retry_match_status is empty');
  });
});
