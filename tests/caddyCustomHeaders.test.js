'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildHeaderSetMap,
  buildRequestHeadersHandler,
  applyResponseHeaders,
} = require('../src/services/caddyCustomHeaders');

describe('caddyCustomHeaders: buildHeaderSetMap', () => {
  it('returns null on a non-array input', () => {
    assert.equal(buildHeaderSetMap(null), null);
    assert.equal(buildHeaderSetMap(undefined), null);
    assert.equal(buildHeaderSetMap('not-an-array'), null);
  });

  it('returns null on an empty list', () => {
    assert.equal(buildHeaderSetMap([]), null);
  });

  it('returns null when all entries fail validation', () => {
    // Names with $ or () must be rejected by isValidHeaderName.
    assert.equal(buildHeaderSetMap([{ name: 'X-$bad', value: 'v' }]), null);
    assert.equal(buildHeaderSetMap([{ name: '', value: 'v' }]), null);
    assert.equal(buildHeaderSetMap([{ name: 'X-Ok', value: '' }]), null);
  });

  it('keeps valid entries and shapes them as { name: [value] }', () => {
    const set = buildHeaderSetMap([
      { name: 'X-Forwarded-For', value: '10.0.0.1' },
      { name: 'X-Custom', value: 'hello' },
    ]);
    assert.deepEqual(set, {
      'X-Forwarded-For': ['10.0.0.1'],
      'X-Custom': ['hello'],
    });
  });

  it('drops invalid entries but keeps valid siblings', () => {
    const set = buildHeaderSetMap([
      { name: 'X-Good', value: 'ok' },
      { name: 'X-$bad', value: 'rejected' },
    ]);
    assert.deepEqual(set, { 'X-Good': ['ok'] });
  });
});

describe('caddyCustomHeaders: buildRequestHeadersHandler', () => {
  it('returns null when there is nothing valid to set', () => {
    assert.equal(buildRequestHeadersHandler(null), null);
    assert.equal(buildRequestHeadersHandler([]), null);
  });

  it('returns the canonical Caddy request-headers handler shape', () => {
    const h = buildRequestHeadersHandler([{ name: 'X-Trace-Id', value: 'abc' }]);
    assert.deepEqual(h, {
      handler: 'headers',
      request: { set: { 'X-Trace-Id': ['abc'] } },
    });
  });
});

describe('caddyCustomHeaders: applyResponseHeaders', () => {
  it('is a no-op when there is nothing valid to set', () => {
    const rp = { handler: 'reverse_proxy' };
    applyResponseHeaders(rp, []);
    assert.equal(rp.headers, undefined);
  });

  it('writes a response.set object onto reverseProxy.headers', () => {
    const rp = { handler: 'reverse_proxy' };
    applyResponseHeaders(rp, [{ name: 'X-Frame-Options', value: 'DENY' }]);
    assert.deepEqual(rp.headers, {
      response: { set: { 'X-Frame-Options': ['DENY'] } },
    });
  });

  it('preserves a pre-existing reverseProxy.headers.request block when adding response headers', () => {
    // Regression sentinel for the gateway-routing + response-headers
    // collision: the pre-fix version assigned a fresh
    // `{ response: { set } }` object and clobbered the gateway
    // headers.request block (delete + set), turning every gateway
    // route with response headers into a 502. The fix merges instead.
    const rp = {
      handler: 'reverse_proxy',
      headers: {
        request: {
          delete: ['X-Forwarded-For'],
          set: { 'X-Gateway-Target': ['lan-host:5001'] },
        },
      },
    };
    applyResponseHeaders(rp, [{ name: 'X-Frame-Options', value: 'DENY' }]);

    assert.deepEqual(rp.headers.request, {
      delete: ['X-Forwarded-For'],
      set: { 'X-Gateway-Target': ['lan-host:5001'] },
    }, 'gateway-routing request block must not be clobbered');

    assert.deepEqual(rp.headers.response, {
      set: { 'X-Frame-Options': ['DENY'] },
    });
  });

  it('overwrites only the response.set sub-key — leaves other response sub-keys (if any) alone', () => {
    // Defensive: a future feature might write `response.delete` or
    // `response.add`. This call should only touch response.set.
    const rp = {
      handler: 'reverse_proxy',
      headers: { response: { add: { 'X-Probe': ['v1'] } } },
    };
    applyResponseHeaders(rp, [{ name: 'X-Frame-Options', value: 'DENY' }]);

    assert.deepEqual(rp.headers.response.add, { 'X-Probe': ['v1'] });
    assert.deepEqual(rp.headers.response.set, { 'X-Frame-Options': ['DENY'] });
  });
});
