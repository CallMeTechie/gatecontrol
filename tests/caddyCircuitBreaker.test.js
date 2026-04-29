'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildCircuitBreakerOpenHandler } = require('../src/services/caddyCircuitBreaker');

describe('caddyCircuitBreaker: buildCircuitBreakerOpenHandler', () => {
  it('returns a 503 static_response with the configured Retry-After', () => {
    const h = buildCircuitBreakerOpenHandler(45);
    assert.equal(h.handler, 'static_response');
    assert.equal(h.status_code, '503');
    assert.equal(h.body, 'Service temporarily unavailable');
    assert.deepEqual(h.headers, { 'Retry-After': ['45'] });
  });

  it('defaults Retry-After to 30 seconds when timeout is undefined', () => {
    const h = buildCircuitBreakerOpenHandler(undefined);
    assert.deepEqual(h.headers, { 'Retry-After': ['30'] });
  });

  it('defaults Retry-After to 30 seconds when timeout is 0 / falsy', () => {
    const h = buildCircuitBreakerOpenHandler(0);
    assert.deepEqual(h.headers, { 'Retry-After': ['30'] });
  });

  it('coerces numeric timeouts to strings (Caddy header values are strings)', () => {
    const h = buildCircuitBreakerOpenHandler(120);
    assert.equal(typeof h.headers['Retry-After'][0], 'string');
    assert.equal(h.headers['Retry-After'][0], '120');
  });
});
