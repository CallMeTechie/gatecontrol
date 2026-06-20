// tests/route_license.test.js
'use strict';
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os'); const crypto = require('node:crypto');
process.env.NODE_ENV = 'test'; // MUST be first (Global Constraints)
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('evaluateRouteLicense', () => {
  let evaluateRouteLicense, license;
  before(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-rl-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db'); process.env.GC_DATA_DIR = tmp;
    require('../src/db/migrations').runMigrations();
    license = require('../src/services/license');
    evaluateRouteLicense = require('../src/services/routeLicense').evaluateRouteLicense;
  });
  it('blocks l4 gateway routing when gateway_tcp_routing is off', () => {
    license._overrideForTest({ l4_routes: 100, gateway_tcp_routing: false, http_routes: 100, gateway_scan_egress: true });
    const v = evaluateRouteLicense({ l4Count: 1, targetKind: 'gateway' });
    assert.equal(v.ok, false); assert.equal(v.extra.feature, 'gateway_tcp_routing');
  });
  it('blocks scan when gateway_scan_egress is off', () => {
    license._overrideForTest({ l4_routes: 100, gateway_tcp_routing: true, http_routes: 100, gateway_scan_egress: false });
    const v = evaluateRouteLicense({ l4Count: 1, targetKind: 'gateway', scanEgress: true });
    assert.equal(v.ok, false); assert.equal(v.extra.feature, 'gateway_scan_egress');
  });
  it('blocks EWS when http_routes limit is 0 (R3-M5)', () => {
    license._overrideForTest({ l4_routes: 100, gateway_tcp_routing: true, http_routes: 0, gateway_scan_egress: true });
    const v = evaluateRouteLicense({ httpCount: 1, targetKind: 'gateway' });
    assert.equal(v.ok, false); assert.equal(v.extra.feature, 'http_routes');
  });
  it('blocks print when l4_routes limit is 0 (R3-M5)', () => {
    license._overrideForTest({ l4_routes: 0, gateway_tcp_routing: true, http_routes: 100, gateway_scan_egress: true });
    const v = evaluateRouteLicense({ l4Count: 1, targetKind: 'gateway' });
    assert.equal(v.ok, false); assert.equal(v.extra.feature, 'l4_routes');
  });
  it('passes a fully-licensed print+ews+scan request', () => {
    license._overrideForTest({ l4_routes: 100, gateway_tcp_routing: true, http_routes: 100, gateway_scan_egress: true });
    const v = evaluateRouteLicense({ httpCount: 1, l4Count: 2, targetKind: 'gateway', scanEgress: true });
    assert.equal(v.ok, true);
  });
});
