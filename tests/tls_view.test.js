'use strict';

// Pure helpers of public/js/tls-ui.js (UMD, no DOM in node): sorting,
// filtering, summaries and reason codes of the certificates page
// (docs/feature-tls-guard.md).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const TG = require('../public/js/tls-ui.js');

function host(name, extra) {
  return Object.assign({ host: name, route_id: 1, host_id: 1, domain_id: 1, kind: 'acme', state: 'pending', attempts: 0, max_attempts: 3,
    last_error: null, last_error_code: null, last_attempt_at: null, next_retry_at: null, paused_at: null, paused_reason: null,
    preflight: null, not_after: null, days_left: null, issuer: null }, extra);
}

const FIXTURE = [
  host('ok.example.com', { state: 'issued', days_left: 60, not_after: '2026-11-12T00:00:00Z', issuer: "Let's Encrypt" }),
  host('soon.example.com', { state: 'issued', days_left: 5, not_after: '2026-09-18T00:00:00Z', issuer: "Let's Encrypt" }),
  host('edge.example.com', { state: 'issued', days_left: 14 }),
  host('rate.example.com', { state: 'failed', attempts: 2, last_error_code: 'rate_limited', last_error: 'too many failed authorizations', next_retry_at: '2026-09-13T13:00:00Z' }),
  host('v6.example.com', { state: 'paused', paused_reason: 'preflight', last_error_code: 'preflight:aaaa_without_ipv6', preflight: { ok: false, code: 'aaaa_without_ipv6' } }),
  host('tries.example.com', { state: 'paused', paused_reason: 'attempts', attempts: 3, last_error_code: 'dns' }),
  host('new.example.com', { state: 'pending' }),
  host('lan.home.arpa', { kind: 'internal', state: 'internal' }),
  host('plain.example.com', { kind: 'none', state: 'none' }),
];

describe('tls-ui pure helpers', () => {
  it('exports without touching the DOM and exposes the contract helpers', () => {
    for (const fn of ['sortHosts', 'filterHosts', 'summarize', 'filterCounts', 'stateKey', 'reasonKey', 'errorCode', 'dnsCode', 'parseCheck', 'hostTlsProblem', 'tlsFromResponse']) {
      assert.equal(typeof TG[fn], 'function', fn);
    }
    assert.deepEqual(TG.FILTERS, ['all', 'problems', 'expiring', 'valid']);
    assert.equal(typeof TG.openDetail, 'undefined', 'DOM part absent in node');
  });

  it('stateKey splits expiring (< 14 days) out of issued and maps unknown states', () => {
    assert.equal(TG.stateKey(FIXTURE[0]), 'issued');
    assert.equal(TG.stateKey(FIXTURE[1]), 'expiring');
    assert.equal(TG.stateKey(FIXTURE[2]), 'issued', '14 days is not yet expiring');
    assert.equal(TG.stateKey({ state: 'issued', days_left: -1 }), 'expiring', 'expired counts as expiring');
    assert.equal(TG.stateKey({ state: 'weird' }), 'unknown');
    assert.equal(TG.stateKey(null), 'unknown');
  });

  it('sortHosts: problems first (paused, failed, expiring), then pending, issued, internal, none; alphabetical inside', () => {
    const shuffled = FIXTURE.slice().reverse();
    const sorted = TG.sortHosts(shuffled);
    assert.deepEqual(sorted.map((h) => h.host), [
      'tries.example.com', 'v6.example.com',   // paused, alphabetical
      'rate.example.com',                      // failed
      'soon.example.com',                      // expiring
      'new.example.com',                       // pending
      'edge.example.com', 'ok.example.com',    // issued
      'lan.home.arpa',                         // internal
      'plain.example.com',                     // none
    ]);
    assert.deepEqual(shuffled.map((h) => h.host), FIXTURE.slice().reverse().map((h) => h.host), 'input not mutated');
  });

  it('filterHosts: all / problems / expiring / valid (unknown filter = all)', () => {
    const names = (f) => TG.filterHosts(FIXTURE, f).map((h) => h.host).sort();
    assert.equal(names('all').length, FIXTURE.length);
    assert.deepEqual(names('problems'), ['rate.example.com', 'soon.example.com', 'tries.example.com', 'v6.example.com']);
    assert.deepEqual(names('expiring'), ['soon.example.com']);
    assert.deepEqual(names('valid'), ['edge.example.com', 'ok.example.com', 'soon.example.com'], 'expiring certificates are still valid');
    assert.equal(names('nope').length, FIXTURE.length);
    assert.deepEqual(TG.filterHosts(null, 'problems'), []);
  });

  it('summarize matches the API Summary shape; filterCounts feeds the chips', () => {
    assert.deepEqual(TG.summarize(FIXTURE), { total: 9, issued: 3, expiring: 1, failed: 1, paused: 2, pending: 1, internal: 1, none: 1 });
    assert.deepEqual(TG.filterCounts(FIXTURE), { all: 9, problems: 4, expiring: 1, valid: 3 });
    assert.deepEqual(TG.summarize([]), { total: 0, issued: 0, expiring: 0, failed: 0, paused: 0, pending: 0, internal: 0, none: 0 });
  });

  it('errorCode / reasonKey: preflight codes map to dns_check.*, Caddy codes to tls.err.*, unknown to the generic keys', () => {
    assert.equal(TG.errorCode(FIXTURE[3]), 'rate_limited');
    assert.equal(TG.errorCode(FIXTURE[4]), 'preflight:aaaa_without_ipv6');
    assert.equal(TG.errorCode(host('x', { paused_reason: 'preflight', preflight: { code: 'caa_blocks' } })), 'preflight:caa_blocks', 'derived from preflight when the code column is empty');
    assert.equal(TG.errorCode(host('x')), null);
    assert.equal(TG.reasonKey('rate_limited'), 'tls.err.rate_limited');
    assert.equal(TG.reasonKey('preflight:aaaa_without_ipv6'), 'dns_check.aaaa_without_ipv6');
    assert.equal(TG.reasonKey('preflight:made_up'), 'dns_check.unknown');
    assert.equal(TG.reasonKey('made_up'), 'tls.err.other');
    assert.equal(TG.reasonKey(''), null);
    assert.equal(TG.reasonKey(null), null);
  });

  it('dnsCode / parseCheck read domains rows with a code or a check_json (string or object)', () => {
    assert.equal(TG.dnsCode({ last_error: 'a_mismatch' }), 'a_mismatch');
    assert.equal(TG.dnsCode({ check_json: JSON.stringify({ ok: false, code: 'caa_blocks' }) }), 'caa_blocks');
    assert.equal(TG.dnsCode({ check_json: { ok: true, code: 'ok' } }), 'ok');
    assert.equal(TG.dnsCode({ last_error: 'no valid A records (legacy text)' }), null, 'free text is not a code');
    assert.equal(TG.dnsCode(null), null);
    assert.equal(TG.parseCheck('{not json'), null);
    assert.deepEqual(TG.parseCheck('{"code":"ok"}'), { code: 'ok' });
    assert.equal(TG.dnsCodeKey('no_records'), 'dns_check.no_records');
    assert.equal(TG.dnsCodeKey('???'), 'dns_check.unknown');
  });

  it('hostTlsProblem finds the failed/paused HTTP entry of a zones host; tls_problem alone still counts', () => {
    const ok = { id: 1, tls_problem: false, entries: [{ id: 5, route_type: 'http', tls: { state: 'issued' } }] };
    const bad = { id: 2, tls_problem: true, entries: [{ id: 6, route_type: 'l4' }, { id: 7, route_type: 'http', tls: { state: 'paused', last_error_code: 'preflight:a_mismatch' } }] };
    assert.equal(TG.hostTlsProblem(ok), null);
    const p = TG.hostTlsProblem(bad);
    assert.equal(p.state, 'paused');
    assert.equal(p.entry.id, 7);
    assert.equal(TG.hostTlsProblem({ id: 3, tls_problem: true, entries: [] }).state, 'failed');
    assert.equal(TG.hostTlsProblem(null), null);
  });

  it('tlsFromResponse reads tls from host/entry create responses', () => {
    assert.deepEqual(TG.tlsFromResponse({ ok: true, host: { id: 1 }, tls: { state: 'paused', code: 'aaaa_without_ipv6', detail: 'x' } }).code, 'aaaa_without_ipv6');
    assert.equal(TG.tlsFromResponse({ ok: true, host: { id: 1, tls: { state: 'pending' } } }).state, 'pending');
    assert.equal(TG.tlsFromResponse({ ok: true, entry: { id: 1 } }), null);
    assert.equal(TG.tlsFromResponse(null), null);
  });
});
