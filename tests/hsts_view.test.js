'use strict';

// Pure helpers of public/js/hsts-ui.js (UMD, no DOM in node): config
// normalisation, header value, labels, preload rules, error mapping and the
// custom-header detection (docs/feature-hsts.md).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../public/js/hsts-ui.js');
const V = require('../public/js/zones-view.js');

describe('hsts-ui pure helpers', () => {
  it('exports without touching the DOM and exposes the contract helpers', () => {
    for (const fn of ['normalize', 'fromEntry', 'fromRoute', 'fromZone', 'headerValue', 'labelFor', 'preloadAllowed', 'validate', 'errorKey', 'toRouteFields', 'toDefault', 'applicableEntries', 'customHeaderHsts', 'certNotIssued']) {
      assert.equal(typeof H[fn], 'function', fn);
    }
    assert.deepEqual(H.AGE_OPTIONS, [0, 15552000, 31536000, 63072000]);
    assert.equal(H.PRELOAD_MIN_AGE, 31536000);
    assert.equal(typeof H.openEntryDialog, 'undefined', 'DOM part absent in node');
  });

  it('normalize accepts entry.hsts, routes rows, hsts_default and treats unknown shapes as off', () => {
    assert.deepEqual(H.normalize(null), { enabled: false, max_age: 31536000, include_subdomains: false, preload: false });
    assert.deepEqual(H.normalize({ foo: 1 }), { enabled: false, max_age: 31536000, include_subdomains: false, preload: false });
    assert.deepEqual(H.fromEntry({ https_enabled: 1 }), { enabled: false, max_age: 31536000, include_subdomains: false, preload: false }, 'entry without hsts field');
    assert.deepEqual(H.fromEntry({ hsts: { enabled: true, max_age: 15552000, include_subdomains: true, preload: false } }), { enabled: true, max_age: 15552000, include_subdomains: true, preload: false });
    assert.deepEqual(H.fromRoute({ hsts_enabled: 1, hsts_max_age: '63072000', hsts_subdomains: 1, hsts_preload: 1 }), { enabled: true, max_age: 63072000, include_subdomains: true, preload: true });
    assert.deepEqual(H.fromRoute({ id: 1 }), H.normalize(null), 'route without the columns (backend not merged)');
    assert.deepEqual(H.fromZone({ hsts_default: null }), H.normalize(null));
    assert.deepEqual(H.fromZone({ hsts_default: '{"enabled":true,"max_age":31536000,"include_subdomains":true,"preload":true}' }), { enabled: true, max_age: 31536000, include_subdomains: true, preload: true }, 'JSON string');
    assert.deepEqual(H.fromZone({ hsts_default: 'garbage' }), H.normalize(null));
  });

  it('headerValue follows the contract: max-age + includeSubDomains + preload, empty when off', () => {
    assert.equal(H.headerValue({ enabled: false, max_age: 31536000, include_subdomains: true, preload: true }), '');
    assert.equal(H.headerValue({ enabled: true, max_age: 31536000 }), 'max-age=31536000');
    assert.equal(H.headerValue({ enabled: true, max_age: 15552000, include_subdomains: true }), 'max-age=15552000; includeSubDomains');
    assert.equal(H.headerValue({ enabled: true, max_age: 63072000, include_subdomains: true, preload: true }), 'max-age=63072000; includeSubDomains; preload');
  });

  it('labelFor names the select option (German fallback) or a custom max-age, plus the flags', () => {
    assert.equal(H.labelFor(null), 'Aus');
    assert.equal(H.labelFor({ enabled: true, max_age: 15552000 }), '6 Monate');
    assert.equal(H.labelFor({ enabled: true, max_age: 31536000, include_subdomains: true }), '1 Jahr · includeSubDomains');
    assert.equal(H.labelFor({ enabled: true, max_age: 63072000, include_subdomains: true, preload: true }), '2 Jahre · includeSubDomains · preload');
    assert.equal(H.labelFor({ enabled: true, max_age: 3600 }), '3600 s');
    const tr = (k, p) => (p ? k + ':' + p.seconds : '[' + k + ']');
    assert.equal(H.labelFor({ enabled: true, max_age: 31536000, preload: true }, tr), '[hsts.age_1y] · [hsts.preload]', 'flags as configured (validate() flags the combination)');
    assert.equal(H.labelFor({ enabled: true, max_age: 600 }, tr), 'hsts.age_custom:600');
    assert.equal(H.ageLabel(0, tr), '[hsts.age_off]');
  });

  it('preload rules: includeSubDomains and max-age ≥ 31536000', () => {
    assert.equal(H.preloadAllowed({ enabled: true, max_age: 31536000, include_subdomains: true }), true);
    assert.equal(H.preloadAllowed({ enabled: true, max_age: 63072000, include_subdomains: true }), true);
    assert.equal(H.preloadAllowed({ enabled: true, max_age: 31535999, include_subdomains: true }), false);
    assert.equal(H.preloadAllowed({ enabled: true, max_age: 31536000, include_subdomains: false }), false);
    assert.equal(H.preloadAllowed({ enabled: true, max_age: 15552000, include_subdomains: true }), false, '6 months');
  });

  it('validate mirrors routesValidation and returns the contract codes', () => {
    assert.equal(H.validate({ enabled: false, max_age: 1, preload: true }), null, 'off: nothing to validate');
    assert.equal(H.validate({ enabled: true, max_age: 31536000 }), null);
    assert.equal(H.validate({ enabled: true, max_age: 299 }), 'HSTS_MAX_AGE_INVALID');
    assert.equal(H.validate({ enabled: true, max_age: 63072001 }), 'HSTS_MAX_AGE_INVALID');
    assert.equal(H.validate({ enabled: true, max_age: 300 }), null, 'lower bound inclusive');
    assert.equal(H.validate({ enabled: true, max_age: 31536000, preload: true }), 'HSTS_PRELOAD_REQUIREMENTS');
    assert.equal(H.validate({ enabled: true, max_age: 15552000, include_subdomains: true, preload: true }), 'HSTS_PRELOAD_REQUIREMENTS');
    assert.equal(H.validate({ enabled: true, max_age: 31536000, include_subdomains: true, preload: true }), null);
    assert.equal(H.validate({ enabled: true, max_age: 31536000 }, { https_enabled: false }), 'HSTS_REQUIRES_HTTPS');
  });

  it('errorKey maps the three contract codes and nothing else', () => {
    assert.equal(H.errorKey('HSTS_PRELOAD_REQUIREMENTS'), 'hsts.err.preload_requirements');
    assert.equal(H.errorKey('HSTS_REQUIRES_HTTPS'), 'hsts.err.requires_https');
    assert.equal(H.errorKey('hsts_max_age_invalid'), 'hsts.err.max_age_invalid');
    assert.equal(H.errorKey('BUNDLE_PORT_CONFLICT'), null);
    assert.equal(H.errorKey(undefined), null);
    const de = require('../src/i18n/de.json');
    for (const c of H.ERROR_CODES) assert.equal(typeof de[H.errorKey(c)], 'string', c + ' has a German text');
  });

  it('toRouteFields / toDefault produce exactly the contract bodies', () => {
    assert.deepEqual(H.toRouteFields({ enabled: true, max_age: 31536000, include_subdomains: true, preload: false }), { hsts_enabled: true, hsts_max_age: 31536000, hsts_subdomains: true, hsts_preload: false });
    assert.deepEqual(Object.keys(H.toRouteFields(null)), ['hsts_enabled', 'hsts_max_age', 'hsts_subdomains', 'hsts_preload']);
    assert.equal(H.toDefault({ enabled: false }), null, 'off → null');
    assert.deepEqual(H.toDefault({ enabled: true, max_age: 15552000 }), { enabled: true, max_age: 15552000, include_subdomains: false, preload: false });
    assert.equal(H.sameConfig({ enabled: true, max_age: 31536000 }, { hsts_enabled: 1, hsts_max_age: 31536000 }), true);
    assert.equal(H.sameConfig({ enabled: false }, { enabled: true, max_age: 31536000 }), false);
  });

  it('eligibility: HTTP entries with HTTPS; applicableEntries counts them per zone', () => {
    const zone = { hosts: [
      { entries: [{ id: 1, route_type: 'http', https_enabled: 1 }, { id: 2, route_type: 'l4', https_enabled: 1 }] },
      { entries: [{ id: 3, route_type: 'http', https_enabled: 0 }, { id: 4, route_type: 'http', https_enabled: true, rdp_owned: true }, { id: 5, route_type: 'http', https_enabled: 1 }] },
    ] };
    assert.equal(H.isEligible({ route_type: 'http', https_enabled: 1 }), true);
    assert.equal(H.isEligible({ route_type: 'http', https_enabled: 0 }), false);
    assert.equal(H.isEligible({ route_type: 'l4', https_enabled: 1 }), false);
    assert.deepEqual(H.applicableEntries(zone).map((e) => e.id), [1, 5]);
    assert.deepEqual(H.applicableEntries(null), []);
  });

  it('customHeaderHsts finds a response Strict-Transport-Security header (object or JSON string)', () => {
    assert.equal(H.customHeaderHsts({}), null);
    assert.equal(H.customHeaderHsts({ custom_headers: '{"request":[{"name":"Strict-Transport-Security","value":"x"}],"response":[]}' }), null, 'request headers do not count');
    assert.equal(H.customHeaderHsts({ custom_headers: '{"request":[],"response":[{"name":"strict-transport-security","value":"max-age=1"}]}' }), 'max-age=1');
    assert.equal(H.customHeaderHsts({ custom_headers: { response: [{ name: 'X-Frame-Options', value: 'DENY' }, { name: 'Strict-Transport-Security', value: 'max-age=2; preload' }] } }), 'max-age=2; preload');
    assert.equal(H.customHeaderHsts({ custom_headers: '{broken' }), null);
  });

  it('certNotIssued: only an entry.tls with a state other than issued', () => {
    assert.equal(H.certNotIssued({}), false, 'no tls → no hint');
    assert.equal(H.certNotIssued({ tls: { state: 'issued' } }), false);
    assert.equal(H.certNotIssued({ tls: { state: 'pending' } }), true);
    assert.equal(H.certNotIssued({ tls: { state: 'paused' } }), true);
  });
});

describe('zones-view HSTS chip note', () => {
  const http = { route_type: 'http', https_enabled: 1, target_kind: 'gateway', target_lan_port: 8080 };
  it('adds the note HSTS to the HTTPS chip when entry.hsts.enabled', () => {
    assert.equal(V.entryChip(http).note, undefined);
    assert.equal(V.entryChip(Object.assign({}, http, { hsts: { enabled: true } })).note, 'HSTS');
    assert.equal(V.entryChip(Object.assign({}, http, { backend_https: 1, hsts: { enabled: true } })).note, 'Backend HTTPS · HSTS');
    assert.equal(V.entryChip(Object.assign({}, http, { hsts: { enabled: false } })).note, undefined);
    assert.equal(V.entryChip(Object.assign({}, http, { hsts: 'on' })).note, undefined, 'unknown shape → off');
    assert.equal(V.entryChip(Object.assign({}, http, { https_enabled: 0, hsts: { enabled: true } })).note, undefined, 'HTTP-only entries never show it');
  });
  it('the domain dialog can leave the note out (own tag)', () => {
    assert.equal(V.entryChip(Object.assign({}, http, { hsts: { enabled: true } }), { hsts: false }).note, undefined);
    assert.equal(V.entryChip(Object.assign({}, http, { backend_https: 1, hsts: { enabled: true } }), { hsts: false }).note, 'Backend HTTPS');
    assert.equal(V.hstsActive({ https_enabled: 1, hsts: { enabled: true } }), true);
  });
});
