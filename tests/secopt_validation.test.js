'use strict';

// routesValidation: security-option rules (docs/feature-security-options.md
// §B/§D/§E/§F) — PEM parsing (several certificates), body limit range, TLS
// minimum version, mTLS prerequisites, PATCH semantics of resolveSecurityFields.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/services/routesValidation');
const { CA_PEM, CA2_PEM, BUNDLE_PEM } = require('./helpers/secopt_ca');

const codeOf = (fn) => { try { fn(); } catch (e) { return { code: e.code, status: e.statusCode }; } return null; };

test('parsePemCertificates: one, several, CRLF, garbage', () => {
  assert.equal(v.parsePemCertificates(CA_PEM).count, 1);
  assert.equal(v.parsePemCertificates(BUNDLE_PEM).count, 2);
  const crlf = v.parsePemCertificates(CA_PEM.replace(/\n/g, '\r\n'));
  assert.equal(crlf.count, 1);
  assert.equal(crlf.pem, CA_PEM);
  assert.throws(() => v.parsePemCertificates(''));
  assert.throws(() => v.parsePemCertificates('not a certificate'));
  assert.throws(() => v.parsePemCertificates('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'));
  // a private key alone is not a certificate
  assert.throws(() => v.parsePemCertificates('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'));
});

test('normalizeCaPem: empty → null, invalid → coded 400', () => {
  assert.equal(v.normalizeCaPem(undefined, 'X'), null);
  assert.equal(v.normalizeCaPem('', 'X'), null);
  assert.equal(v.normalizeCaPem('  \n', 'X'), null);
  assert.equal(v.normalizeCaPem(BUNDLE_PEM, 'X'), CA_PEM + CA2_PEM);
  assert.deepEqual(codeOf(() => v.normalizeCaPem('garbage', 'BACKEND_CA_INVALID')), { code: 'BACKEND_CA_INVALID', status: 400 });
  assert.deepEqual(codeOf(() => v.normalizeCaPem('garbage', 'MTLS_CA_INVALID')), { code: 'MTLS_CA_INVALID', status: 400 });
});

test('validateMaxBodyMb: 0 … 4096, strings, empty = 0', () => {
  assert.equal(v.validateMaxBodyMb(undefined), 0);
  assert.equal(v.validateMaxBodyMb(''), 0);
  assert.equal(v.validateMaxBodyMb(0), 0);
  assert.equal(v.validateMaxBodyMb('50'), 50);
  assert.equal(v.validateMaxBodyMb(4096), 4096);
  for (const bad of [-1, 4097, 1.5, 'lots', '1e3x']) {
    assert.deepEqual(codeOf(() => v.validateMaxBodyMb(bad)), { code: 'MAX_BODY_INVALID', status: 400 }, String(bad));
  }
});

test('validateBackendServerName / validateTlsMinVersion / validateMtlsMode', () => {
  assert.equal(v.validateBackendServerName(''), null);
  assert.equal(v.validateBackendServerName(' NAS.Lan. '), 'nas.lan');
  assert.deepEqual(codeOf(() => v.validateBackendServerName('bad host')), { code: 'BACKEND_SERVER_NAME_INVALID', status: 400 });
  assert.deepEqual(codeOf(() => v.validateBackendServerName('https://nas.lan')), { code: 'BACKEND_SERVER_NAME_INVALID', status: 400 });
  assert.equal(v.validateTlsMinVersion(undefined), '1.2');
  assert.equal(v.validateTlsMinVersion('1.3'), '1.3');
  assert.deepEqual(codeOf(() => v.validateTlsMinVersion('1.1')), { code: 'TLS_MIN_VERSION_INVALID', status: 400 });
  assert.deepEqual(codeOf(() => v.validateTlsMinVersion('tls1.3')), { code: 'TLS_MIN_VERSION_INVALID', status: 400 });
  assert.equal(v.validateMtlsMode(undefined), 'require');
  assert.equal(v.validateMtlsMode('require'), 'require');
  assert.deepEqual(codeOf(() => v.validateMtlsMode('verify_if_given')), { code: 'MTLS_MODE_INVALID', status: 400 });
});

test('resolveSecurityFields: create defaults', () => {
  assert.deepEqual(v.resolveSecurityFields({}, null, { route_type: 'http', https_enabled: true }), {
    backend_tls_verify: 0, backend_tls_server_name: null, backend_tls_ca_pem: null, max_body_mb: 0,
    mtls_enabled: 0, mtls_ca_pem: null, mtls_mode: 'require',
  });
});

test('resolveSecurityFields: explicit values, flags as booleans/strings, PEM normalised', () => {
  const r = v.resolveSecurityFields({
    backend_tls_verify: true, backend_tls_server_name: 'NAS.lan', backend_tls_ca_pem: CA_PEM.replace(/\n/g, '\r\n'),
    max_body_mb: '25', mtls_enabled: '1', mtls_ca_pem: BUNDLE_PEM, mtls_mode: 'require',
  }, null, { route_type: 'http', https_enabled: 1 });
  assert.deepEqual(r, {
    backend_tls_verify: 1, backend_tls_server_name: 'nas.lan', backend_tls_ca_pem: CA_PEM, max_body_mb: 25,
    mtls_enabled: 1, mtls_ca_pem: BUNDLE_PEM, mtls_mode: 'require',
  });
});

test('resolveSecurityFields: PATCH keeps stored values; empty strings clear', () => {
  const cur = {
    backend_tls_verify: 1, backend_tls_server_name: 'nas.lan', backend_tls_ca_pem: CA_PEM, max_body_mb: 10,
    mtls_enabled: 1, mtls_ca_pem: CA2_PEM, mtls_mode: 'require',
  };
  assert.deepEqual(v.resolveSecurityFields({ description: 'x' }, cur, { route_type: 'http', https_enabled: 1 }), cur);
  const cleared = v.resolveSecurityFields({ backend_tls_server_name: '', backend_tls_ca_pem: '', max_body_mb: '' }, cur, { route_type: 'http', https_enabled: 1 });
  assert.equal(cleared.backend_tls_server_name, null);
  assert.equal(cleared.backend_tls_ca_pem, null);
  assert.equal(cleared.max_body_mb, 0);
  assert.equal(cleared.mtls_ca_pem, CA2_PEM);
});

test('resolveSecurityFields: mTLS prerequisites', () => {
  const on = { route_type: 'http', https_enabled: 1 };
  // enabling without CA
  assert.deepEqual(codeOf(() => v.resolveSecurityFields({ mtls_enabled: 1 }, null, on)), { code: 'MTLS_CA_INVALID', status: 400 });
  // enabling with garbage CA
  assert.deepEqual(codeOf(() => v.resolveSecurityFields({ mtls_enabled: 1, mtls_ca_pem: 'nope' }, null, on)), { code: 'MTLS_CA_INVALID', status: 400 });
  // clearing the CA while enabled
  const cur = { mtls_enabled: 1, mtls_ca_pem: CA_PEM };
  assert.deepEqual(codeOf(() => v.resolveSecurityFields({ mtls_ca_pem: '' }, cur, on)), { code: 'MTLS_CA_INVALID', status: 400 });
  // explicit enable without HTTPS / on L4
  assert.deepEqual(codeOf(() => v.resolveSecurityFields({ mtls_enabled: 1, mtls_ca_pem: CA_PEM }, null, { route_type: 'http', https_enabled: 0 })), { code: 'MTLS_REQUIRES_HTTPS', status: 400 });
  assert.deepEqual(codeOf(() => v.resolveSecurityFields({ mtls_enabled: 1, mtls_ca_pem: CA_PEM }, null, { route_type: 'l4', https_enabled: 1 })), { code: 'MTLS_REQUIRES_HTTPS', status: 400 });
  // inherited enable + HTTPS turned off → silently cleared, CA kept
  const off = v.resolveSecurityFields({ https_enabled: false }, cur, { route_type: 'http', https_enabled: 0 });
  assert.equal(off.mtls_enabled, 0);
  assert.equal(off.mtls_ca_pem, CA_PEM);
  // disabling explicitly never needs a CA
  assert.equal(v.resolveSecurityFields({ mtls_enabled: false, mtls_ca_pem: '' }, cur, on).mtls_enabled, 0);
});
