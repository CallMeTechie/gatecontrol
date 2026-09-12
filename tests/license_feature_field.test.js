'use strict';

// requireFeatureField must only gate values that turn a feature ON. The route
// editor always sends e.g. compress_enabled: false, which used to 403 every
// save on plans without that feature.

const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const license = require('../src/services/license');
const { requireFeatureField } = require('../src/middleware/license');

license._overrideForTest({ compression: false, custom_headers: false, load_balancing: false, gateway_pool_load_balancing: false });

function run(mw, body) {
  let status = 200; let nextCalled = false;
  const res = { status(s) { status = s; return this; }, json() { return this; } };
  mw({ body }, res, () => { nextCalled = true; });
  return nextCalled ? 'next' : status;
}

test('values that keep an unlicensed feature off pass', () => {
  const compress = requireFeatureField('compress_enabled', 'compression');
  for (const v of [false, 0, '', '0', 'false', undefined, null]) {
    assert.equal(run(compress, { compress_enabled: v }), 'next', `compress_enabled=${JSON.stringify(v)}`);
  }
  assert.equal(run(requireFeatureField('backends', 'load_balancing'), { backends: [] }), 'next');
  assert.equal(run(requireFeatureField('custom_headers', 'custom_headers'), { custom_headers: { request: [], response: [] } }), 'next');
});

test('values that turn an unlicensed feature on are rejected', () => {
  assert.equal(run(requireFeatureField('compress_enabled', 'compression'), { compress_enabled: true }), 403);
  assert.equal(run(requireFeatureField('compress_enabled', 'compression'), { compress_enabled: 1 }), 403);
  assert.equal(run(requireFeatureField('backends', 'load_balancing'), { backends: [{ peer_id: 1, port: 80 }] }), 403);
  assert.equal(run(requireFeatureField('custom_headers', 'custom_headers'), { custom_headers: { request: [{ name: 'X', value: '1' }], response: [] } }), 403);
});

test('onlyValue gates keep their exact-match semantics', () => {
  const mw = requireFeatureField('mode', 'gateway_pool_load_balancing', { onlyValue: 'load_balancing' });
  assert.equal(run(mw, { mode: 'failover' }), 'next');
  assert.equal(run(mw, { mode: 'load_balancing' }), 403);
});
