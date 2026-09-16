'use strict';

// Release B §9 / §2 (docs/feature-release-b.md) on the zones page and in the
// domain dialog: protections + shield, risk filters with URL-hash state, bulk
// selection (POST /api/v1/routes/bulk) and the WAF default per domain.
// Pure helpers from public/js/zones-view.js plus static wiring checks.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const V = require('../public/js/zones-view.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// Wave 2 §W2: the admin stylesheets are one file now — §1 former pro.css (base),
// §2 former aurora.css, §3 security.css, §4 nav.css, §5 ops.css, §6 problems.css,
// §7 l4-protect.css, §8 two-factor.css.
const APP_CSS = read('public/css/app.css');
function appSection(n) {
  const a = APP_CSS.indexOf(`\n * \u00a7${n} `);
  assert.ok(a > 0, `app.css section \u00a7${n}`);
  const b = APP_CSS.indexOf(`\n * \u00a7${n + 1} `);
  return APP_CSS.slice(a, b < 0 ? APP_CSS.length : b);
}

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const de = require('../src/i18n/de.json');

function e(over) {
  return Object.assign({
    id: 1, route_type: 'http', https_enabled: 1, enabled: 1, external_enabled: 1, rdp_owned: false,
    basic_auth_enabled: 0, route_auth_enabled: 0, mtls_enabled: 0, mtls_ca_pem: null, ip_filter_enabled: 0, acl_enabled: 0,
    rate_limit_enabled: 0, waf_enabled: 0, waf_mode: 'detect', hsts: { enabled: false },
  }, over);
}

describe('protections and shield', () => {
  it('entryProtections mirrors securityCheck.protectionsOf', () => {
    assert.deepEqual(V.entryProtections(e()), { auth: null, mtls: false, ip_filter: false, waf: null, hsts: false, rate_limit: false });
    const p = V.entryProtections(e({ basic_auth_enabled: 1, mtls_enabled: 1, mtls_ca_pem: 'PEM', acl_enabled: 1, waf_enabled: 1, waf_mode: 'block', hsts: { enabled: true }, rate_limit_enabled: 1 }));
    assert.deepEqual(p, { auth: 'basic', mtls: true, ip_filter: true, waf: 'block', hsts: true, rate_limit: true });
    assert.equal(V.entryProtections(e({ route_auth_enabled: 1 })).auth, 'route_auth');
    assert.equal(V.entryProtections(e({ mtls_enabled: 1, mtls_ca_pem: '' })).mtls, false, 'mTLS without CA does nothing');
    assert.equal(V.entryProtections(e({ https_enabled: 0, hsts: { enabled: true } })).hsts, false, 'HSTS needs HTTPS');
    const l4 = V.entryProtections(e({ route_type: 'l4', basic_auth_enabled: 1, ip_filter_enabled: 1 }));
    assert.equal(l4.auth, null);
    assert.equal(l4.ip_filter, false);
  });

  it('entryShield: count, active, missing (public only), level', () => {
    const open = V.entryShield(e());
    assert.equal(open.count, 0);
    assert.deepEqual(open.missing, ['auth', 'mtls', 'ip_filter', 'waf', 'hsts', 'rate_limit']);
    assert.equal(open.level, 'open');
    const ok = V.entryShield(e({ route_auth_enabled: 1, waf_enabled: 1 }));
    assert.deepEqual(ok.active, ['auth', 'waf']);
    assert.equal(ok.count, 2);
    assert.equal(ok.level, 'ok');
    const wafOnly = V.entryShield(e({ waf_enabled: 1 }));
    assert.equal(wafOnly.level, 'open', 'WAF alone is no access protection');
    const internal = V.entryShield(e({ external_enabled: 0, hsts: { enabled: true } }));
    assert.equal(internal.level, 'internal');
    assert.deepEqual(internal.missing, [], 'nothing is "missing" on an internal entry');
    assert.equal(internal.count, 1);
    assert.equal(V.entryShield(e({ enabled: 0 })).level, 'internal', 'a disabled entry is not public');
    const http = V.entryShield(e({ https_enabled: 0 }));
    assert.deepEqual(http.applicable, ['auth', 'ip_filter', 'waf', 'rate_limit'], 'no mTLS/HSTS without HTTPS');
    assert.equal(V.entryShield(e({ route_type: 'l4' })), null);
    assert.equal(V.entryShield(e({ rdp_owned: true })), null);
  });
});

describe('risk filters', () => {
  it('entryRisk per contract', () => {
    assert.ok(V.entryRisk(e(), 'nowaf'));
    assert.ok(!V.entryRisk(e({ waf_enabled: 1 }), 'nowaf'));
    assert.ok(!V.entryRisk(e({ external_enabled: 0 }), 'nowaf'));
    assert.ok(V.entryRisk(e({ waf_enabled: 1 }), 'unprotected'));
    assert.ok(!V.entryRisk(e({ ip_filter_enabled: 1 }), 'unprotected'));
    assert.ok(V.entryRisk(e({ external_enabled: 0 }), 'nohsts'), 'HSTS check also covers internal entries');
    assert.ok(!V.entryRisk(e({ enabled: 0 }), 'nohsts'));
    assert.ok(!V.entryRisk(e({ https_enabled: 0 }), 'nohsts'));
    assert.ok(!V.entryRisk(e({ route_type: 'l4' }), 'nowaf'));
    assert.ok(!V.entryRisk(e(), 'bogus'));
  });

  it('filterZones: risk is an entry-level criterion, combines with type/search', () => {
    const zones = [{ domain_id: 1, domain: 'a.de', hosts: [
      { id: 1, fqdn: 'x.a.de', entries: [e({ id: 11, waf_enabled: 1 }), e({ id: 12, route_type: 'l4', l4_listen_port: '2222' })] },
      { id: 2, fqdn: 'nas.a.de', entries: [e({ id: 21 })] },
      { id: 3, fqdn: 'int.a.de', entries: [e({ id: 31, external_enabled: 0 })] },
    ] }];
    const hosts = (f) => V.filterZones(zones, f).flatMap((z) => z.hosts.map((h) => h.id));
    assert.deepEqual(hosts({ risk: 'nowaf' }), [2]);
    assert.deepEqual(hosts({ risk: 'unprotected' }), [1, 2]);
    assert.deepEqual(hosts({ risk: 'nohsts' }), [1, 2, 3]);
    assert.deepEqual(hosts({ risk: 'nohsts', q: 'nas' }), [2]);
    assert.deepEqual(hosts({ risk: 'nowaf', type: 'l4' }), [], 'both must hold for one entry');
    assert.deepEqual(hosts({ risk: 'nope' }), [1, 2, 3], 'unknown risk ignored');
    assert.ok(V.isFilterActive({ risk: 'nowaf' }));
  });

  it('URL hash round trip; unknown keys/values dropped', () => {
    const f = { q: 'nas 1', type: 'http', access: null, state: 'problem', risk: 'nowaf', gatewayKey: 'pool:3' };
    const h = V.filtersToHash(f);
    assert.equal(h, 'q=nas%201&type=http&state=problem&risk=nowaf&gw=pool:3');
    assert.deepEqual(V.filtersFromHash('#' + h), f);
    assert.deepEqual(V.filtersFromHash('#risk=evil&type=l4&x=1&gw=foo:1&q=%E0%A4%A'), { q: '', type: 'l4', access: null, state: null, risk: null, gatewayKey: null });
    assert.equal(V.filtersToHash({}), '');
    assert.deepEqual(V.filtersFromHash(''), { q: '', type: null, access: null, state: null, risk: null, gatewayKey: null });
  });
});

describe('bulk selection', () => {
  const host = { id: 1, entries: [e({ id: 1 }), e({ id: 2, route_type: 'l4' }), e({ id: 3, rdp_owned: true }), e({ id: 4, https_enabled: 0 })] };
  it('selectableEntries: no RDP-owned; with an entry filter only the matching entries', () => {
    assert.deepEqual(V.selectableEntries(host, {}).map((x) => x.id), [1, 2, 4]);
    assert.deepEqual(V.selectableEntries(host, { q: 'x' }).map((x) => x.id), [1, 2, 4], 'the search is host-level');
    assert.deepEqual(V.selectableEntries(host, { type: 'l4' }).map((x) => x.id), [2]);
    assert.deepEqual(V.selectableEntries(host, { risk: 'nohsts' }).map((x) => x.id), [1]);
  });

  it('bulkPlan: ids per action, skipped count, set body', () => {
    const list = host.entries;
    assert.deepEqual(V.bulkPlan(list, 'waf', { mode: 'block', paranoia: 2 }), { ids: [1, 4], skipped: 1, set: { waf_enabled: true, waf_mode: 'block', waf_paranoia: 2 }, tooMany: false });
    assert.deepEqual(V.bulkPlan(list, 'waf', { mode: 'x', paranoia: 9 }).set, { waf_enabled: true, waf_mode: 'detect', waf_paranoia: 1 });
    assert.deepEqual(V.bulkPlan(list, 'hsts').ids, [1]);
    assert.deepEqual(V.bulkPlan(list, 'hsts').set, { hsts_enabled: true, hsts_max_age: 31536000 });
    assert.deepEqual(V.bulkPlan(list, 'monitoring').ids, [1, 2, 4]);
    assert.deepEqual(V.bulkPlan(list, 'disable').set, { enabled: false });
    assert.deepEqual(V.bulkPlan(list, 'enable').set, { enabled: true });
    assert.equal(V.bulkPlan(list, 'delete'), null);
    const many = Array.from({ length: 201 }, (_, i) => e({ id: i + 1 }));
    assert.equal(V.bulkPlan(many, 'enable').tooMany, true);
    assert.equal(V.BULK_MAX, 200);
  });

  it('entryIndex maps ids to entry/host/zone', () => {
    const idx = V.entryIndex([{ domain_id: 1, hosts: [host] }]);
    assert.equal(idx.get(2).host, host);
    assert.equal(idx.size, 4);
  });
});

describe('zones page + domain dialog wiring', () => {
  const page = strip(read('public/js/zones-page.js'));
  const dm = strip(read('public/js/domain-modal.js'));
  const njk = read('templates/aurora/pages/zones.njk');

  it('template: risk chips, bulk bar, island keys', () => {
    assert.deepEqual(Array.from(njk.matchAll(/data-risk="([a-z]+)"/g)).map((m) => m[1]), ['nowaf', 'unprotected', 'nohsts']);
    assert.match(njk, /id="zn-risk" role="group"/);
    assert.match(njk, /<div class="sh-bulkbar" id="zn-bulkbar" role="region"[^>]*hidden>/);
    const m = /set zonesI18nKeys = \[([\s\S]*?)\]/.exec(njk);
    const listed = Array.from(m[1].matchAll(/'([a-z0-9_.]+)'/g)).map((x) => x[1]);
    assert.equal(new Set(listed).size, listed.length, 'no duplicates');
    const used = new Set();
    for (const src of [page, dm]) for (const x of src.matchAll(/'((?:bulk|shield|zones\.wafdef|zones\.select)[._][a-z0-9_.]+)'/g)) if (!/[._]$/.test(x[1])) used.add(x[1]);
    for (const a of ['waf', 'hsts', 'monitoring', 'enable', 'disable']) { used.add('bulk.title_' + a); used.add('bulk.msg_' + a); }
    for (const k of ['auth', 'mtls', 'ip_filter', 'waf', 'hsts', 'rate_limit']) used.add('shield.' + k);
    for (const k of used) {
      assert.ok(listed.includes(k), `island lists ${k}`);
      assert.ok(typeof de[k] === 'string' && de[k].length, `de.json has ${k}`);
    }
    assert.equal(de['zones.filter_problems'], 'Backend gestört');
  });

  it('page: filters in the hash, selection pruned on reload, bulk POST with error handling', () => {
    assert.match(page, /f: V\.filtersFromHash\(window\.location\.hash\)/);
    assert.match(page, /history\.replaceState\(null, '', window\.location\.pathname \+ window\.location\.search \+ \(h \? '#' \+ h : ''\)\)/);
    assert.match(page, /window\.addEventListener\('hashchange'/);
    assert.match(page, /pruneSelection\(\);\n\s*state\.error = null;/, 'after every GET /zones');
    assert.match(page, /api\.post\('\/api\/v1\/routes\/bulk', \{ ids: plan\.ids, set \}\)/);
    assert.match(page, /data\.code === 'BULK_INVALID' && Array\.isArray\(data\.failed\)/);
    assert.match(page, /data\.code === 'CADDY_SYNC_FAILED'/);
    assert.match(page, /UI\.shieldEl\(e, \{ onPick:/);
    assert.match(page, /closest\('button,a,input,label'\)/, 'row click ignores the checkbox');
  });

  it('dialog: no negative HSTS chip, shield per entry, WAF default next to the HSTS default', () => {
    assert.match(dm, /if \(hstsTag && hstsTag\.dataset\.hsts === 'on'\) opts\.push\(hstsTag\);/);
    assert.match(dm, /const shield = shieldEl\(e, \{ onPick: \(k\) => fixProtection\(e, k\) \}\);/);
    assert.ok(dm.indexOf('hsts || null,\n      wafDef,') > 0, 'WAF default right after the HSTS default');
    assert.match(dm, /api\.put\('\/api\/v1\/domains\/' \+ zone\.domain_id \+ '\/defaults', body\)/);
    assert.match(dm, /waf_default: next\.mode === 'off' \? null : \{ enabled: true, mode: next\.mode, paranoia: next\.paranoia \}/);
    assert.match(dm, /apply_waf_to_existing: applyMode === 'existing'/);
    assert.match(dm, /res\.applied_waf/);
    assert.match(dm, /GC\.features\.waf === false/, 'licence lock');
  });

  it('nav.css styles the shield, bulk bar and palette; no zn-/sh- rules appended to aurora.css', () => {
    const css = appSection(4);
    for (const sel of ['.sh-shield', '.sh-shield-open', '.sh-bulkbar', '.sh-sel-cb', '.sh-risk-chips', '.sh-wafdef-row', '.cp-overlay', '.cp-opt[aria-selected="true"]', '.cp-trigger']) {
      assert.ok(css.includes(sel), sel);
    }
    for (const n of [1, 2]) assert.doesNotMatch(appSection(n).replace(/\/\*[\s\S]*?\*\//g, ''), /\.sh-|\.cp-/, 'section §' + n);
  });
});
