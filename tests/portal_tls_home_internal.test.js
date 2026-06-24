'use strict';

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildTlsAutomation } = require('../src/services/caddyTlsAutomation');

// FIX 1: home.<domain> must ALWAYS use Caddy's internal TLS issuer,
// even when the DNS domain has a public TLD (e.g. example.com).
describe('portal_tls_home_internal: forceInternalDomains', () => {
  it('puts home.example.com under internal issuer when forced, and app.example.com under ACME', () => {
    const out = buildTlsAutomation(
      ['home.example.com', 'app.example.com'],
      { email: 'x@example.com' },
      ['home.example.com'],
    );
    assert.ok(out, 'buildTlsAutomation must return a result when email is set');
    const policies = out.automation.policies;

    // Locate policies by issuer module, then assert subject membership via Set
    // (exact membership; avoids substring-style host checks).
    const internalPolicy = policies.find(
      p => Array.isArray(p.issuers) && p.issuers.some(i => i.module === 'internal'),
    );
    assert.ok(
      internalPolicy,
      'an internal-issuer policy must exist (forceInternalDomains override)',
    );
    const internalSubjects = new Set(internalPolicy.subjects || []);
    assert.ok(
      internalSubjects.has('home.example.com'),
      'home.example.com must be in the internal-issuer policy',
    );

    const acmePolicy = policies.find(
      p => Array.isArray(p.issuers) && p.issuers.some(i => i.module === 'acme'),
    );
    assert.ok(acmePolicy, 'an ACME policy must exist for the public domain');
    const acmeSubjects = new Set(acmePolicy.subjects || []);

    // home.example.com must NOT appear in the ACME policy
    assert.ok(
      !acmeSubjects.has('home.example.com'),
      'home.example.com must NOT appear in the ACME policy',
    );
    // app.example.com must be in the ACME policy
    assert.ok(
      acmeSubjects.has('app.example.com'),
      'app.example.com must be in the ACME policy',
    );
  });

  it('does not duplicate a domain that is already private-by-TLD when also listed in forceInternalDomains', () => {
    const out = buildTlsAutomation(
      ['home.gc.internal', 'app.example.com'],
      { email: 'x@example.com' },
      ['home.gc.internal'],
    );
    const policies = out.automation.policies;
    const internalPolicy = policies.find(
      p => Array.isArray(p.issuers) && p.issuers.some(i => i.module === 'internal'),
    );
    assert.ok(internalPolicy, 'internal policy must exist');
    // home.gc.internal must appear exactly once
    const count = internalPolicy.subjects.filter(s => s === 'home.gc.internal').length;
    assert.equal(count, 1, 'home.gc.internal must appear exactly once in the internal policy');
  });

  it('existing behavior still works when forceInternalDomains is omitted', () => {
    const out = buildTlsAutomation(['example.com'], { email: 'admin@example.com' });
    assert.ok(out.automation.policies[0].issuers[0].module === 'acme');
  });
});
