'use strict';

// routesValidation HSTS helpers (docs/feature-hsts.md): value ranges,
// preload rules, HTTPS requirement, header value and zone-default parsing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/services/routesValidation');

const codeOf = (fn) => {
  try { fn(); } catch (err) { return { code: err.code, status: err.statusCode }; }
  return null;
};

test('validateHstsMaxAge: 300 … 63072000, integers only', () => {
  assert.equal(v.validateHstsMaxAge(300), 300);
  assert.equal(v.validateHstsMaxAge(63072000), 63072000);
  assert.equal(v.validateHstsMaxAge('31536000'), 31536000, 'numeric strings are accepted');
  for (const bad of [299, 63072001, -1, 0, 1.5, 'abc', '', null, undefined, {}]) {
    assert.deepEqual(codeOf(() => v.validateHstsMaxAge(bad)), { code: 'HSTS_MAX_AGE_INVALID', status: 400 }, String(bad));
  }
});

test('validateHstsRules: preload needs includeSubDomains and max-age >= 1 year', () => {
  const base = { hsts_enabled: 1, hsts_max_age: 31536000, hsts_subdomains: 1, hsts_preload: 1, route_type: 'http', https_enabled: 1 };
  assert.equal(v.validateHstsRules(base), 31536000);
  assert.equal(codeOf(() => v.validateHstsRules({ ...base, hsts_subdomains: 0 })).code, 'HSTS_PRELOAD_REQUIREMENTS');
  assert.equal(codeOf(() => v.validateHstsRules({ ...base, hsts_max_age: 31535999 })).code, 'HSTS_PRELOAD_REQUIREMENTS');
  assert.equal(codeOf(() => v.validateHstsRules({ ...base, hsts_max_age: 15552000 })).code, 'HSTS_PRELOAD_REQUIREMENTS');
  // without preload the same values are fine
  assert.equal(v.validateHstsRules({ ...base, hsts_preload: 0, hsts_subdomains: 0, hsts_max_age: 15552000 }), 15552000);
  // max-age is checked first
  assert.equal(codeOf(() => v.validateHstsRules({ ...base, hsts_max_age: 10 })).code, 'HSTS_MAX_AGE_INVALID');
});

test('validateHstsRules: enabled requires an HTTP route with https_enabled', () => {
  const base = { hsts_enabled: 1, hsts_max_age: 31536000, hsts_subdomains: 0, hsts_preload: 0, route_type: 'http', https_enabled: 1 };
  assert.equal(v.validateHstsRules(base), 31536000);
  assert.equal(codeOf(() => v.validateHstsRules({ ...base, https_enabled: 0 })).code, 'HSTS_REQUIRES_HTTPS');
  assert.equal(codeOf(() => v.validateHstsRules({ ...base, route_type: 'l4' })).code, 'HSTS_REQUIRES_HTTPS');
  assert.equal(v.validateHstsRules({ ...base, hsts_enabled: 0, https_enabled: 0 }), 31536000, 'disabled HSTS never needs HTTPS');
});

test('resolveHstsFields: patch semantics, inherited flag is cleared when HTTPS goes off', () => {
  const stored = { hsts_enabled: 1, hsts_max_age: 63072000, hsts_subdomains: 1, hsts_preload: 1 };
  // untouched fields keep their stored value
  assert.deepEqual(v.resolveHstsFields({}, stored, { route_type: 'http', https_enabled: 1 }), stored);
  assert.deepEqual(v.resolveHstsFields({ hsts_max_age: '31536000' }, stored, { route_type: 'http', https_enabled: 1 }),
    { ...stored, hsts_max_age: 31536000 });
  // https off without touching hsts_enabled → silently 0
  assert.deepEqual(v.resolveHstsFields({}, stored, { route_type: 'http', https_enabled: 0 }), { ...stored, hsts_enabled: 0 });
  // explicit hsts_enabled with https off → 400
  assert.equal(codeOf(() => v.resolveHstsFields({ hsts_enabled: true }, stored, { route_type: 'http', https_enabled: 0 })).code, 'HSTS_REQUIRES_HTTPS');
  // create without stored row and without input → defaults
  assert.deepEqual(v.resolveHstsFields({}, null, { route_type: 'http', https_enabled: 1 }),
    { hsts_enabled: 0, hsts_max_age: 31536000, hsts_subdomains: 0, hsts_preload: 0 });
  // booleans and strings normalise to 0/1
  assert.deepEqual(v.resolveHstsFields({ hsts_enabled: 'true', hsts_subdomains: '1', hsts_preload: false, hsts_max_age: 15552000 }, null,
    { route_type: 'http', https_enabled: 1 }), { hsts_enabled: 1, hsts_max_age: 15552000, hsts_subdomains: 1, hsts_preload: 0 });
  // preload rule on the effective combination
  assert.equal(codeOf(() => v.resolveHstsFields({ hsts_max_age: 300 }, stored, { route_type: 'http', https_enabled: 1 })).code, 'HSTS_PRELOAD_REQUIREMENTS');
});

test('hasHstsInput and hstsHeaderValue', () => {
  assert.equal(v.hasHstsInput({}), false);
  assert.equal(v.hasHstsInput({ hsts_enabled: undefined }), false);
  assert.equal(v.hasHstsInput({ hsts_enabled: false }), true);
  assert.equal(v.hasHstsInput({ hsts_max_age: 300 }), true);
  assert.equal(v.hstsHeaderValue({ max_age: 31536000, include_subdomains: false, preload: false }), 'max-age=31536000');
  assert.equal(v.hstsHeaderValue({ max_age: 31536000, include_subdomains: true, preload: false }), 'max-age=31536000; includeSubDomains');
  assert.equal(v.hstsHeaderValue({ max_age: 63072000, include_subdomains: true, preload: true }), 'max-age=63072000; includeSubDomains; preload');
});

test('normalizeHstsDefault / parseHstsDefault / hstsDefaultToFields', () => {
  assert.equal(v.normalizeHstsDefault(null), null);
  assert.equal(v.normalizeHstsDefault(undefined), null);
  assert.deepEqual(v.normalizeHstsDefault({ enabled: true }), { enabled: true, max_age: 31536000, include_subdomains: false, preload: false });
  assert.deepEqual(v.normalizeHstsDefault({ enabled: 1, max_age: '63072000', include_subdomains: 1, preload: 1 }),
    { enabled: true, max_age: 63072000, include_subdomains: true, preload: true });
  assert.equal(codeOf(() => v.normalizeHstsDefault({ enabled: true, max_age: 5 })).code, 'HSTS_MAX_AGE_INVALID');
  assert.equal(codeOf(() => v.normalizeHstsDefault({ enabled: true, preload: true })).code, 'HSTS_PRELOAD_REQUIREMENTS');
  assert.equal(codeOf(() => v.normalizeHstsDefault('yes')).code, 'HSTS_MAX_AGE_INVALID');
  assert.equal(codeOf(() => v.normalizeHstsDefault([1])).code, 'HSTS_MAX_AGE_INVALID');

  assert.equal(v.parseHstsDefault(null), null);
  assert.equal(v.parseHstsDefault('not json'), null);
  assert.deepEqual(v.parseHstsDefault('{"enabled":true,"max_age":15552000,"include_subdomains":true,"preload":false}'),
    { enabled: true, max_age: 15552000, include_subdomains: true, preload: false });

  assert.deepEqual(v.hstsDefaultToFields(null), { hsts_enabled: 0, hsts_max_age: 31536000, hsts_subdomains: 0, hsts_preload: 0 });
  assert.deepEqual(v.hstsDefaultToFields({ enabled: true, max_age: 15552000, include_subdomains: true, preload: false }),
    { hsts_enabled: 1, hsts_max_age: 15552000, hsts_subdomains: 1, hsts_preload: 0 });
  assert.deepEqual(v.hstsOfRoute({ hsts_enabled: 1, hsts_max_age: 15552000, hsts_subdomains: 0, hsts_preload: 0 }),
    { enabled: true, max_age: 15552000, include_subdomains: false, preload: false });
});
