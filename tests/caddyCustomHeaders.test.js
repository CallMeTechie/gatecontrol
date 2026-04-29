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

  it('REPLACES any pre-existing reverseProxy.headers (preserves prior overwrite semantics)', () => {
    // The original inline code did `reverseProxy.headers = { response: ... }`
    // which obliterates any earlier `request` block. We preserve that here
    // and call out the bug in the helper docstring rather than fixing it
    // implicitly inside a refactor PR.
    const rp = {
      handler: 'reverse_proxy',
      headers: { request: { delete: ['X-Forwarded-For'] } },
    };
    applyResponseHeaders(rp, [{ name: 'X-Custom', value: 'v' }]);
    assert.deepEqual(rp.headers, {
      response: { set: { 'X-Custom': ['v'] } },
    });
    assert.equal(rp.headers.request, undefined,
      'pre-existing request block is overwritten — known pre-refactor behaviour');
  });
});
