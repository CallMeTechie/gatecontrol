'use strict';

// Pure helpers of the security-options UI (docs/feature-security-options.md):
// alias label rules and host alias views (§A), header preset contents (§C),
// body-limit parsing/formatting (§D), backend-TLS applicability (§B), TLS
// profile (§E), mTLS helpers (§F), error mapping and the CAA view of tls-ui.js
// (§G). public/js/secopt-ui.js and tls-ui.js load as UMD modules without a DOM.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const S = require('../public/js/secopt-ui.js');
const TG = require('../public/js/tls-ui.js');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

describe('secopt: alias labels', () => {
  it('validAliasLabel follows the subdomain label rules and rejects "@"', () => {
    for (const ok of ['www', 'WWW', 'www.', ' shop ', 'a', 'shop.eu', 'x-1', 'a'.repeat(63)]) assert.equal(S.validAliasLabel(ok), true, ok);
    for (const bad of ['', '@', '-www', 'www-', 'a_b', 'a..b', '.www', 'a b', 'ä', 'a'.repeat(64), 'x/y', '*']) assert.equal(S.validAliasLabel(bad), false, JSON.stringify(bad));
  });

  it('aliasLabelError: invalid, duplicate (normalised), limit of 10, else null', () => {
    assert.equal(S.aliasLabelError('www', []), null);
    assert.equal(S.aliasLabelError('-x', []), 'invalid');
    assert.equal(S.aliasLabelError('WWW.', ['www']), 'duplicate');
    const ten = Array.from({ length: 10 }, (_, i) => 'a' + i);
    assert.equal(S.ALIAS_MAX, 10);
    assert.equal(S.aliasLabelError('b', ten), 'limit');
    assert.equal(S.aliasLabelError('b', ten.slice(0, 9)), null);
    assert.equal(S.aliasCheckKey('duplicate'), 'alias.err.duplicate');
    assert.equal(S.aliasCheckKey(null), null);
  });

  it('aliasFqdn is relative to the host FQDN', () => {
    assert.equal(S.aliasFqdn('www', 'jennybackes.de'), 'www.jennybackes.de');
    assert.equal(S.aliasFqdn('WWW', 'App.Example.com.'), 'www.app.example.com');
    assert.equal(S.aliasFqdn('www', ''), 'www');
  });

  it('hostAliases reads arrays and JSON text, prefers alias_fqdns, defaults to redirect', () => {
    assert.deepEqual(S.hostAliases({ fqdn: 'jennybackes.de', aliases: ['www'], alias_mode: 'redirect', alias_fqdns: ['www.jennybackes.de'] }),
      { labels: ['www'], mode: 'redirect', fqdns: ['www.jennybackes.de'] });
    assert.deepEqual(S.hostAliases({ fqdn: 'app.x.de', aliases: '["www","WWW","shop"]', alias_mode: 'serve' }),
      { labels: ['www', 'shop'], mode: 'serve', fqdns: ['www.app.x.de', 'shop.app.x.de'] });
    assert.deepEqual(S.hostAliases({ fqdn: 'x.de', aliases: null }), { labels: [], mode: 'redirect', fqdns: [] });
    assert.deepEqual(S.hostAliases({ aliases: 'not json' }).labels, []);
    assert.equal(S.aliasModeOf({ alias_mode: 'bogus' }), 'redirect');
  });

  it('tag text and zones-row summary', () => {
    assert.equal(S.aliasTagText('www', 'redirect'), 'www ↗');
    assert.equal(S.aliasTagText('www', 'serve'), 'www');
    assert.equal(S.aliasSummary({ aliases: ['www'] }), '+ www');
    assert.equal(S.aliasSummary({ aliases: ['www', 'shop'] }), '+ www, shop');
    assert.equal(S.aliasSummary({ aliases: [] }), '');
  });

  it('www checkbox of a new "@" host: only for apex + HTTP, never when www is taken', () => {
    const zone = { domain: 'jennybackes.de', hosts: [{ subdomain: '@', fqdn: 'jennybackes.de', aliases: [] }] };
    assert.equal(S.wwwTaken(zone), false);
    assert.equal(S.wwwTaken({ domain: 'x.de', hosts: [{ subdomain: 'www', fqdn: 'www.x.de' }] }), true);
    assert.equal(S.wwwTaken({ domain: 'x.de', hosts: [{ subdomain: 'app', fqdn: 'app.x.de', aliases: ['www'], alias_fqdns: ['www.app.x.de'] }] }), false, 'www.app.x.de is not www.x.de');
    assert.equal(S.wwwTaken({ domain: 'x.de', hosts: [{ subdomain: '@', fqdn: 'x.de', aliases: ['www'] }] }), true);
    const draft = { sub: '', type: 'http', template: null, www: true };
    assert.deepEqual(S.wwwAliasFields(draft, zone), { aliases: ['www'], alias_mode: 'redirect' });
    assert.deepEqual(S.wwwAliasFields(Object.assign({}, draft, { sub: '@' }), zone), { aliases: ['www'], alias_mode: 'redirect' });
    assert.equal(S.wwwAliasFields(Object.assign({}, draft, { sub: 'app' }), zone), null, 'not apex');
    assert.equal(S.wwwAliasFields(Object.assign({}, draft, { www: false }), zone), null, 'unchecked');
    assert.equal(S.wwwAliasFields(Object.assign({}, draft, { type: 'tcp' }), zone), null, 'no HTTP entry');
    assert.equal(S.wwwAliasFields(Object.assign({}, draft, { template: { entries: [{ type: 'tcp' }] } }), zone), null, 'template without HTTP');
    assert.deepEqual(S.wwwAliasFields(Object.assign({}, draft, { type: 'tcp', template: { entries: [{ type: 'http' }] } }), zone), { aliases: ['www'], alias_mode: 'redirect' });
    assert.equal(S.wwwAliasFields(draft, { domain: 'x.de', hosts: [{ subdomain: 'www' }] }), null, 'www taken');
    assert.equal(S.hostHasHttp({ entries: [{ route_type: 'l4' }] }), false);
    assert.equal(S.hostHasHttp({ entries: [{ route_type: 'l4' }, { route_type: 'http' }] }), true);
  });
});

describe('secopt: header presets', () => {
  it('"Sicherheits-Header (modern)" is the contract set, without X-XSS-Protection and HSTS', () => {
    assert.deepEqual(S.presetHeaders('security'), [
      { name: 'X-Content-Type-Options', value: 'nosniff' },
      { name: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { name: 'X-Frame-Options', value: 'DENY' },
      { name: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      { name: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    ]);
    for (const name of Object.keys(S.HEADER_PRESETS)) {
      for (const h of S.presetHeaders(name)) {
        assert.notEqual(h.name.toLowerCase(), 'x-xss-protection', name);
        assert.notEqual(h.name.toLowerCase(), 'strict-transport-security', name);
      }
    }
  });

  it('"CSP (nur eigene Quellen)" and its warning key; CORS unchanged', () => {
    assert.deepEqual(S.presetHeaders('csp'), [{ name: 'Content-Security-Policy', value: "default-src 'self'; frame-ancestors 'none'" }]);
    assert.equal(S.PRESET_WARNINGS.csp, 'headers.preset_csp_warning');
    assert.ok(de['headers.preset_csp_warning'] && en['headers.preset_csp_warning']);
    assert.equal(S.presetHeaders('cors').length, 3);
    assert.deepEqual(S.presetHeaders('nope'), []);
  });

  it('applyPreset replaces same-name headers case-insensitively and never mutates', () => {
    const list = [{ name: 'x-frame-options', value: 'SAMEORIGIN' }, { name: 'X-Custom', value: '1' }];
    const snap = JSON.stringify(list);
    const out = S.applyPreset(list, 'security');
    assert.equal(JSON.stringify(list), snap, 'input untouched');
    assert.equal(out.filter((h) => h.name.toLowerCase() === 'x-frame-options').length, 1);
    assert.equal(out.find((h) => h.name === 'X-Frame-Options').value, 'DENY');
    assert.equal(out[0].name, 'X-Custom', 'unrelated headers keep their place');
    assert.equal(out.length, 6);
    const twice = S.applyPreset(S.applyPreset([], 'csp'), 'csp');
    assert.equal(twice.length, 1, 'applying twice does not duplicate');
    assert.deepEqual(S.presetHeaders('security')[0], S.presetHeaders('security')[0], 'copies');
    S.presetHeaders('security')[0].value = 'x';
    assert.equal(S.presetHeaders('security')[0].value, 'nosniff', 'presets cannot be modified through a copy');
  });

  it('German preset labels per contract', () => {
    assert.equal(de['headers.preset_security'], 'Sicherheits-Header (modern)');
    assert.equal(de['headers.preset_csp'], 'CSP (nur eigene Quellen)');
    assert.match(de['headers.preset_csp_warning'], /bricht|funktionieren damit nicht mehr/);
  });
});

describe('secopt: body limit', () => {
  it('parseBodyLimit: empty = 0 (unlimited), integers 0…4096, else null', () => {
    assert.equal(S.parseBodyLimit(''), 0);
    assert.equal(S.parseBodyLimit(null), 0);
    assert.equal(S.parseBodyLimit(' 50 '), 50);
    assert.equal(S.parseBodyLimit('0'), 0);
    assert.equal(S.parseBodyLimit(4096), 4096);
    for (const bad of ['4097', '-1', '1.5', 'abc', '1e3', '50MB']) assert.equal(S.parseBodyLimit(bad), null, bad);
    assert.equal(S.BODY_MAX_MB, 4096);
  });

  it('bodyLimitOf / bodyLimitLabel: tag "≤ N MB" only above 0', () => {
    assert.equal(S.bodyLimitOf({ max_body_mb: 50 }), 50);
    assert.equal(S.bodyLimitOf({ max_body_mb: '12' }), 12);
    assert.equal(S.bodyLimitOf({ max_body_mb: 0 }), 0);
    assert.equal(S.bodyLimitOf({}), 0);
    assert.equal(S.bodyLimitLabel(50), '≤ 50 MB');
    assert.equal(S.bodyLimitLabel(0), null);
    assert.equal(S.bodyLimitLabel('x'), null);
    assert.equal(S.bodyLimitLabel(7, (k, p) => k + ':' + p.mb), 'body_limit.tag:7');
    assert.equal(de['body_limit.tag'].replace('{{mb}}', '50'), '≤ 50 MB');
  });
});

describe('secopt: backend TLS, mTLS, TLS profile', () => {
  it('backend TLS applies to peer targets only (gateway/pool dial themselves)', () => {
    assert.equal(S.backendTlsApplies({ target_kind: 'peer' }), true);
    assert.equal(S.backendTlsApplies({}), true, 'legacy rows without target_kind are peer routes');
    assert.equal(S.backendTlsApplies({ target_kind: 'gateway', target_peer_id: 3 }), false);
    assert.equal(S.backendTlsApplies({ target_kind: 'gateway', target_pool_id: 2 }), false);
    assert.equal(S.backendTlsApplies(null), false);
  });

  it('mtlsActive / pemCertCount', () => {
    assert.equal(S.mtlsActive({ route_type: 'http', mtls_enabled: 1 }), true);
    assert.equal(S.mtlsActive({ route_type: 'http', mtls_enabled: 0 }), false);
    assert.equal(S.mtlsActive({ route_type: 'l4', mtls_enabled: 1 }), false);
    const pem = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----';
    assert.equal(S.pemCertCount(pem + '\n' + pem), 2);
    assert.equal(S.pemCertCount('garbage'), 0);
  });

  it('zoneTlsMin defaults to 1.2', () => {
    assert.equal(S.zoneTlsMin({ tls_min_version: '1.3' }), '1.3');
    assert.equal(S.zoneTlsMin({ tls_min_version: '1.2' }), '1.2');
    assert.equal(S.zoneTlsMin({}), '1.2');
    assert.deepEqual(S.TLS_VERSIONS, ['1.2', '1.3']);
  });
});

describe('secopt: error mapping', () => {
  const CONTRACT = ['ALIAS_CONFLICT', 'HOST_EXISTS', 'ALIAS_REQUIRES_HTTP', 'ALIAS_INVALID', 'ALIAS_LIMIT',
    'BACKEND_CA_INVALID', 'BACKEND_SERVER_NAME_INVALID', 'MAX_BODY_INVALID', 'MTLS_CA_INVALID', 'MTLS_REQUIRES_HTTPS',
    'MTLS_MODE_INVALID', 'TLS_MIN_VERSION_INVALID'];

  it('every contract code maps to a key that exists in de.json and en.json', () => {
    assert.deepEqual(S.ERROR_CODES.slice().sort(), CONTRACT.slice().sort());
    for (const code of CONTRACT) {
      const k = S.errorKey(code);
      assert.ok(k, code);
      assert.ok(de[k] && en[k], `${code} → ${k}`);
    }
    assert.equal(S.errorKey('alias_conflict'), 'alias.err.conflict', 'case-insensitive');
    assert.equal(S.errorKey('HSTS_REQUIRES_HTTPS'), null, 'foreign codes are not mapped');
    assert.equal(S.errorKey(undefined), null);
    for (const c of ['invalid', 'duplicate', 'limit']) assert.ok(de[S.aliasCheckKey(c)] && en[S.aliasCheckKey(c)], c);
  });
});

describe('tls-ui: CAA recommendation (§G)', () => {
  it('caaInfo normalises caa_status / caa_suggestion', () => {
    assert.deepEqual(TG.caaInfo({ caa_status: 'none', caa_suggestion: 'jennybackes.de. CAA 0 issue "letsencrypt.org"' }),
      { status: 'none', suggestion: 'jennybackes.de. CAA 0 issue "letsencrypt.org"' });
    assert.deepEqual(TG.caaInfo({ caa_status: 'allows', caa_suggestion: 'ignored' }), { status: 'allows', suggestion: null });
    assert.deepEqual(TG.caaInfo({ caa_status: 'blocks' }), { status: 'blocks', suggestion: null });
    assert.equal(TG.caaInfo({ caa_status: null }), null, 'check ended before the CAA lookup');
    assert.equal(TG.caaInfo({}), null, 'rows from before the feature');
    assert.equal(TG.caaInfo(null), null);
    assert.equal(de['caa.allows'], 'CAA schützt die Domain');
  });
});
