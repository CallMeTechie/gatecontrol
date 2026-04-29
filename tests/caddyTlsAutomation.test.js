'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildTlsAutomation, isPublicDomain } = require('../src/services/caddyTlsAutomation');

describe('caddyTlsAutomation: isPublicDomain', () => {
  it('treats real public TLDs as public', () => {
    assert.equal(isPublicDomain('example.com'), true);
    assert.equal(isPublicDomain('foo.example.org'), true);
    assert.equal(isPublicDomain('a.b.c.example.io'), true);
  });

  it('treats RFC1918-style TLDs as private', () => {
    assert.equal(isPublicDomain('home.lan'), false);
    assert.equal(isPublicDomain('host.local'), false);
    assert.equal(isPublicDomain('foo.test'), false);
    assert.equal(isPublicDomain('thing.internal'), false);
    assert.equal(isPublicDomain('site.invalid'), false);
    assert.equal(isPublicDomain('app.home'), false);
    assert.equal(isPublicDomain('localhost'), false);
    assert.equal(isPublicDomain('corp'), false);
  });

  it('treats null/undefined/empty as not-public', () => {
    assert.equal(isPublicDomain(null), false);
    assert.equal(isPublicDomain(undefined), false);
    assert.equal(isPublicDomain(''), false);
  });

  it('is case-insensitive on the TLD', () => {
    assert.equal(isPublicDomain('Host.LOCAL'), false);
    assert.equal(isPublicDomain('Foo.LAN'), false);
  });
});

describe('caddyTlsAutomation: buildTlsAutomation', () => {
  it('returns null when email is unset', () => {
    assert.equal(buildTlsAutomation(['example.com'], {}), null);
    assert.equal(buildTlsAutomation(['example.com'], { email: '' }), null);
    assert.equal(buildTlsAutomation(['example.com'], null), null);
  });

  it('emits an ACME policy for public domains', () => {
    const out = buildTlsAutomation(['example.com', 'api.example.com'], { email: 'admin@example.com' });
    assert.deepEqual(out, {
      automation: {
        policies: [{
          subjects: ['example.com', 'api.example.com'],
          issuers: [{ module: 'acme', email: 'admin@example.com' }],
        }],
      },
    });
  });

  it('emits an internal policy for private domains', () => {
    const out = buildTlsAutomation(['nas.local', 'host.lan'], { email: 'admin@example.com' });
    assert.equal(out.automation.policies.length, 1);
    assert.deepEqual(out.automation.policies[0], {
      subjects: ['nas.local', 'host.lan'],
      issuers: [{ module: 'internal' }],
    });
  });

  it('emits both policies when both kinds of domain are present', () => {
    const out = buildTlsAutomation(
      ['public.example.com', 'private.lan'],
      { email: 'admin@example.com' },
    );
    assert.equal(out.automation.policies.length, 2);
    assert.equal(out.automation.policies[0].issuers[0].module, 'acme');
    assert.deepEqual(out.automation.policies[0].subjects, ['public.example.com']);
    assert.equal(out.automation.policies[1].issuers[0].module, 'internal');
    assert.deepEqual(out.automation.policies[1].subjects, ['private.lan']);
  });

  it('emits a catch-all ACME fallback when there are no domains at all', () => {
    const out = buildTlsAutomation([], { email: 'admin@example.com' });
    assert.equal(out.automation.policies.length, 1);
    assert.deepEqual(out.automation.policies[0], {
      issuers: [{ module: 'acme', email: 'admin@example.com' }],
    });
  });

  it('passes acmeCa through to the issuer when configured', () => {
    const out = buildTlsAutomation(
      ['example.com'],
      { email: 'admin@example.com', acmeCa: 'https://acme-staging-v02.api.letsencrypt.org/directory' },
    );
    assert.equal(
      out.automation.policies[0].issuers[0].ca,
      'https://acme-staging-v02.api.letsencrypt.org/directory',
    );
  });

  it('adds acmeCa to the fallback policy too', () => {
    const out = buildTlsAutomation(
      [],
      { email: 'admin@example.com', acmeCa: 'https://staging' },
    );
    assert.equal(out.automation.policies[0].issuers[0].ca, 'https://staging');
  });

  it('filters out listener-only entries like ":443" — those are not real domains', () => {
    const out = buildTlsAutomation(
      [':443', ':80', 'example.com'],
      { email: 'admin@example.com' },
    );
    assert.equal(out.automation.policies.length, 1);
    assert.deepEqual(out.automation.policies[0].subjects, ['example.com']);
  });
});
