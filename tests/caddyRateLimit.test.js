'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildRateLimitHandler } = require('../src/services/caddyRateLimit');

describe('caddyRateLimit: buildRateLimitHandler', () => {
  it('returns the canonical Caddy rate_limit handler shape', () => {
    const handler = buildRateLimitHandler({
      rate_limit_window: '1m',
      rate_limit_requests: 60,
    });

    assert.equal(handler.handler, 'rate_limit');
    assert.equal(handler.rate_limits.static.key, '{http.request.remote.host}');
    assert.equal(handler.rate_limits.static.window, '1m');
    assert.equal(handler.rate_limits.static.max_events, 60);
  });

  it('defaults max_events to 100 when rate_limit_requests is unset', () => {
    const handler = buildRateLimitHandler({ rate_limit_window: '1m' });
    assert.equal(handler.rate_limits.static.max_events, 100);
  });

  it('passes the window value through sanitizeRateWindow — invalid values fall back', () => {
    // sanitizeRateWindow whitelists ['1s','1m','5m','1h']; anything else
    // gets normalised. The exact fallback is the validator's call; here
    // we just assert the value never leaks an unsanitised string into
    // the handler.
    const handler = buildRateLimitHandler({
      rate_limit_window: 'not-a-window',
      rate_limit_requests: 10,
    });
    assert.notEqual(handler.rate_limits.static.window, 'not-a-window',
      'sanitizeRateWindow must normalise invalid input before it lands in the handler');
  });
});
