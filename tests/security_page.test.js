'use strict';

// Sicherheits-Check page (docs/feature-release-b.md §1 + §10, UI strand B3):
// security.njk renders with the page locals and carries the hooks security.js
// queries, the page is registered (/security, activeNav 'security') and served,
// the pure helpers of public/js/security.js (grouping, pills, safe fixes, item
// links, exposure filters and marks), the i18n block (security.* +
// license_hint.* right after certificates.*, identical in de/en), the layout
// whitelist / stylesheet / script wiring and the security section of app.css.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nunjucks = require('nunjucks');

const ROOT = path.join(__dirname, '..');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');
const S = require('../public/js/security.js');

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

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
// The page block: every security.* key except the older settings strings
// (security.title / lockout / password / save(d) / machine_binding), plus license_hint.*.
const LEGACY_RE = /^security\.(title$|lockout\.|password\.|save$|saved$|machine_binding\.)/;
const inBlock = (k) => (k.startsWith('security.') && !LEGACY_RE.test(k)) || k.startsWith('license_hint.');

const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(ROOT, 'templates')), { autoescape: true });
env.addFilter('bytes', (v) => String(v || 0) + ' B');
env.addFilter('reltime', () => '—');
env.addFilter('truncate', (s, n) => (!s || s.length <= n ? (s || '') : s.substring(0, n) + '...'));
function translator(lang) {
  const loc = lang === 'en' ? en : de;
  return (key, params) => {
    let s = loc[key] !== undefined ? loc[key] : (de[key] !== undefined ? de[key] : key);
    if (params) for (const [k, v] of Object.entries(params)) s = s.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
    return s;
  };
}
function render(opts = {}) {
  const lang = opts.lang || 'de';
  return env.render('aurora/pages/security.njk', {
    theme: 'aurora', language: lang, t: translator(lang), availableLanguages: ['de', 'en'],
    license: { features: { http_routes: -1, l4_routes: -1, waf: opts.waf !== false }, hasFeature: () => false, tier: 'pro' },
    cspNonce: 'NONCE123', csrfToken: 'csrf-token', appVersion: '9.9.9', appName: 'GateControl',
    baseUrl: 'https://gc.example.com', user: { id: 1, username: 'admin', display_name: 'Admin', role: 'admin', theme: 'aurora' },
    title: 'Sicherheits-Check', activeNav: 'security', currentPath: '/security', flash: {},
    httpRouteCount: 3, l4RouteCount: 2, peerCount: 1, routeCount: 5, rdpRouteCount: 0,
  });
}

const IDS = ['sc-page', 'sc-summary', 'sc-refresh', 'sc-tabs', 'sc-tab-check', 'sc-tab-exposure', 'sc-tab-check-count', 'sc-tab-exposure-count',
  'sc-panel-check', 'sc-panel-exposure', 'sc-tiles', 'sc-tile-fail', 'sc-tile-fail-val', 'sc-tile-info', 'sc-tile-info-val', 'sc-tile-pass',
  'sc-tile-pass-val', 'sc-pending', 'sc-checks', 'sc-exp-search', 'sc-exp-chips', 'sc-exp-card', 'sc-exp-summary', 'sc-exp-table', 'sc-exp-list'];

describe('security.njk', () => {
  it('renders the shell with every hook security.js queries', () => {
    const html = render();
    for (const id of IDS) assert.ok(html.includes(`id="${id}"`), `#${id}`);
    const js = stripComments(read('public/js/security.js'));
    for (const m of js.matchAll(/\$\('([a-z0-9-]+)'\)/g)) assert.ok(html.includes(`id="${m[1]}"`), `security.js queries #${m[1]}`);
    assert.match(html, /<div class="page-title">Sicherheits-Check<\/div>/);
    assert.match(html, /id="sc-panel-exposure"[^>]*data-sc-panel="exposure" hidden/, 'exposure tab hidden at first');
    assert.match(html, /id="sc-pending" role="status" hidden/);
    assert.match(html, /class="tab active" id="sc-tab-check" role="tab" aria-selected="true"/);
    const chips = Array.from(html.matchAll(/data-filter="([a-z]+)" aria-pressed/g)).map((m) => m[1]);
    assert.deepEqual(chips, ['all', 'unprotected', 'nowaf']);
    const at = html.indexOf('id="sc-exp-table"');
    const heads = Array.from(html.slice(at, html.indexOf('</thead>', at)).matchAll(/<th(?:\s[^>]*)?>/g));
    assert.equal(heads.length, 12, '12 columns');
    assert.match(html, /<td colspan="12">/);
    assert.ok(html.includes('Nur ohne Schutz') && html.includes('Öffentlich erreichbar'));
    assert.match(html, /class="app"/, 'aurora shell');
  });

  it('English rendering and script order (app.js → license-hint.js → security.js)', () => {
    const html = render({ lang: 'en' });
    assert.match(html, /<div class="page-title">Security check<\/div>/);
    assert.ok(html.includes('Publicly reachable'));
    const srcs = Array.from(html.matchAll(/<script src="([^"?]+)\?v=9\.9\.9"/g)).map((m) => m[1]);
    const app = srcs.indexOf('/js/app.js');
    const hint = srcs.indexOf('/js/license-hint.js');
    const page = srcs.indexOf('/js/security.js');
    assert.ok(app >= 0 && hint > app && page > hint, srcs.join(','));
    assert.equal(srcs.filter((s) => s === '/js/license-hint.js').length, 1);
  });

  it('client strings reach window.GC.t (layout whitelist)', () => {
    const html = render();
    const gc = /window\.GC = \{[\s\S]*?\n {4}t: \{([\s\S]*?)\n {4}\}\n {2}\};/.exec(html);
    assert.ok(gc, 'GC.t block');
    for (const k of ['security.summary', 'security.check.hsts.fail', 'security.confirm.hsts', 'security.exp_col_waf', 'license_hint.refresh', 'license_hint.not_in_token', 'common.cancel']) {
      assert.ok(gc[1].includes(JSON.stringify(k) + ': ' + JSON.stringify(de[k])), k);
    }
    // valid JS object literal
    // eslint-disable-next-line no-new-func
    const obj = new Function('return {' + gc[1] + '}')();
    assert.equal(obj['security.status_fail'], 'Handlungsbedarf');
  });

  it('template keys exist in both locales', () => {
    const src = read('templates/aurora/pages/security.njk');
    for (const m of src.matchAll(/\bt\('([a-z0-9_.]+)'/g)) {
      assert.ok(de[m[1]] !== undefined, `de.json has ${m[1]}`);
      assert.ok(en[m[1]] !== undefined, `en.json has ${m[1]}`);
    }
  });
});

describe('page registration', () => {
  it('src/routes/index.js registers /security with the security template', () => {
    assert.match(read('src/routes/index.js'), /\{ path: '\/security', template: 'security', titleKey: 'security\.page_title' \}/);
  });

  describe('served page', () => {
    let setup;
    let agent;
    before(async () => {
      setup = require('./helpers/setup');
      await setup.setup();
      agent = setup.getAgent();
    });
    after(() => setup.teardown());
    it('GET /security renders for the admin', async () => {
      const res = await agent.get('/security').expect(200);
      assert.match(res.text, /id="sc-checks"/);
      assert.match(res.text, /<title>(Sicherheits-Check|Security check) — /);
      assert.match(res.text, /\/js\/security\.js\?v=/);
    });
  });
});

describe('security.js pure helpers', () => {
  const checks = [
    { id: 'tls_min', severity: 'info', status: 'fail', count: 1, items: [{ kind: 'zone', id: 3, label: 'a.de' }], fix: null },
    { id: 'hsts', severity: 'warning', status: 'pass', count: 0, items: [], fix: null },
    { id: 'admin_2fa', severity: 'critical', status: 'fail', count: 1, items: [{ kind: 'user', id: 1, label: 'admin' }], fix: { type: 'link', href: '/profile#two-factor' } },
    { id: 'caa', severity: 'warning', status: 'fail', count: 1, items: [], fix: { type: 'copy', copy: 'a.de. CAA 0 issue "letsencrypt.org"' }, pending: 0 },
    { id: 'waf_coverage', severity: 'warning', status: 'na', count: 0, items: [], fix: null },
  ];

  it('groups by severity (critical, warning, info), fail → na → pass inside', () => {
    const g = S.groupChecks(checks);
    assert.deepEqual(g.map((x) => x.severity), ['critical', 'warning', 'info']);
    assert.deepEqual(g[1].checks.map((c) => c.id), ['caa', 'waf_coverage', 'hsts']);
    assert.deepEqual(S.groupChecks(null), []);
  });

  it('display kind and pill: info findings are notes, na grey', () => {
    assert.equal(S.kindOf(checks[0]), 'info');
    assert.equal(S.kindOf(checks[2]), 'fail');
    assert.deepEqual(S.pillOf(checks[2]), { cls: 'tag-red', key: 'security.status_fail' });
    assert.deepEqual(S.pillOf(checks[3]), { cls: 'tag-amber', key: 'security.status_fail' });
    assert.deepEqual(S.pillOf(checks[0]), { cls: 'tag-blue', key: 'security.status_info' });
    assert.deepEqual(S.pillOf(checks[4]), { cls: 'tag-grey', key: 'security.status_na' });
    assert.deepEqual(S.pillOf(checks[1]), { cls: 'tag-green', key: 'security.status_pass' });
    assert.deepEqual(S.summaryOf({ summary: { pass: 7, fail: 3, info: 2 } }), { pass: 7, fail: 3, info: 2 });
    assert.deepEqual(S.summaryOf({ checks }), { pass: 1, fail: 2, info: 1 });
  });

  it('text keys: per check and status, special cases, unknown checks', () => {
    assert.deepEqual(S.textKeys(checks[2]), { title: 'security.check.admin_2fa.title', desc: 'security.check.admin_2fa.fail' });
    assert.equal(S.textKeys({ id: 'auto_update', severity: 'warning', status: 'fail' }).desc, 'security.check.auto_update.fail_failed');
    assert.equal(S.textKeys({ id: 'auto_update', severity: 'info', status: 'fail' }).desc, 'security.check.auto_update.fail');
    assert.equal(S.textKeys({ id: 'backup_offsite', severity: 'warning', status: 'fail', items: [] }).desc, 'security.check.backup_offsite.fail_none');
    assert.equal(S.textKeys({ id: 'backup_offsite', severity: 'warning', status: 'fail', items: [{ kind: 'target', id: 1 }] }).desc, 'security.check.backup_offsite.fail');
    assert.deepEqual(S.textKeys({ id: 'future_x', status: 'weird' }), { title: 'security.check.unknown_title', desc: 'security.check.unknown_na' });
  });

  it('safeFix only lets same-origin API writes, relative links and text through', () => {
    assert.deepEqual(S.safeFix({ type: 'api', method: 'post', url: '/api/v1/routes/bulk', body: { ids: [1] } }), { type: 'api', method: 'POST', url: '/api/v1/routes/bulk', body: { ids: [1] } });
    assert.equal(S.safeFix({ type: 'api', method: 'GET', url: '/api/v1/x' }), null, 'no GET');
    assert.equal(S.safeFix({ type: 'api', method: 'POST', url: 'https://evil.example/api/v1/x' }), null);
    assert.equal(S.safeFix({ type: 'api', method: 'POST', url: '/api/v1/../logout' }), null);
    assert.equal(S.safeFix({ type: 'api', method: 'POST', url: '/api/v1/x', body: 'str' }), null);
    assert.deepEqual(S.safeFix({ type: 'link', href: '/dashboard#auto-update' }), { type: 'link', href: '/dashboard#auto-update' });
    for (const bad of ['//evil.example', 'javascript:alert(1)', 'https://evil.example', '/a/../b', ' /x y']) assert.equal(S.safeFix({ type: 'link', href: bad }), null, bad);
    assert.equal(S.safeFix({ type: 'copy', copy: '' }), null);
    assert.equal(S.safeFix({ type: 'shell', cmd: 'rm' }), null);
    assert.equal(S.safeFix(null), null);
    assert.equal(S.settingsTab('/settings#backup'), 'backup');
    assert.equal(S.settingsTab('/settings'), null);
  });

  it('fix labels and confirmations', () => {
    assert.equal(S.fixLabelKey({ id: 'hsts' }, { type: 'api' }), 'security.fix.hsts');
    assert.equal(S.fixLabelKey({ id: 'x' }, { type: 'link' }), 'security.fix_open');
    assert.equal(S.fixLabelKey({ id: 'x' }, { type: 'copy' }), 'security.copy');
    assert.equal(S.fixLabelKey({ id: 'x' }, { type: 'api' }), 'security.fix_generic');
    assert.equal(S.fixLabelKey({ id: 'hsts' }, null), null);
    assert.equal(S.confirmKey({ id: 'waf_coverage' }), 'security.confirm.waf_coverage');
    assert.equal(S.confirmKey({ id: 'tls_min' }), 'security.confirm_generic');
  });

  const zones = { zones: [{ domain_id: 4, hosts: [{ id: 9, entries: [{ id: 43 }, { id: 44 }] }] }], unassigned: [{ id: null, entries: [{ id: 50 }] }] };
  it('item links into the zones page', () => {
    const idx = S.zoneIndex(zones);
    assert.equal(S.routeHref(43, idx), '/routes?domain=4&host=9');
    assert.equal(S.routeHref(50, idx), '/routes');
    assert.equal(S.routeHref(99, idx), '/routes');
    assert.equal(S.routeHref(43, null), '/routes');
    assert.equal(S.itemHref({ kind: 'route', id: 44 }, idx), '/routes?domain=4&host=9');
    assert.equal(S.itemHref({ kind: 'zone', id: 7 }, idx), '/routes?domain=7');
    assert.equal(S.itemHref({ kind: 'zone', id: 'x"><' }, idx), '/routes');
    assert.equal(S.itemHref({ kind: 'user', id: 1 }), '/users');
    assert.equal(S.itemHref({ kind: 'target', id: 1 }), '/settings#backup');
    assert.equal(S.itemHref({ kind: 'other' }), null);
  });

  const entries = [
    { route_id: 1, host: 'a.example.com', zone: 'example.com', type: 'http', target: '10.0.0.1:80', health: 'ok', protections: { auth: null, mtls: false, ip_filter: false, waf: null, hsts: true, rate_limit: false, tls_min: '1.2' } },
    { route_id: 2, host: 'b.example.com', zone: 'example.com', type: 'http', target: '10.0.0.2:80', health: 'down', protections: { auth: 'route_auth', mtls: false, ip_filter: false, waf: 'block', hsts: true, rate_limit: true, tls_min: '1.3' } },
    { route_id: 3, host: 'c.example.com', zone: 'example.com', type: 'l4', target: '10.0.0.3:22', health: 'unknown', listen_port: '2222', protocol: 'tcp', protections: { auth: null, mtls: false, ip_filter: false, waf: null, hsts: false, rate_limit: false, tls_min: '1.2' } },
  ];
  it('exposure filters, counts and search', () => {
    assert.deepEqual(S.exposureCounts(entries), { all: 3, unprotected: 2, nowaf: 1 });
    assert.deepEqual(S.filterEntries(entries, 'unprotected').map((e) => e.route_id), [1, 3]);
    assert.deepEqual(S.filterEntries(entries, 'nowaf').map((e) => e.route_id), [1], 'layer 4 has no WAF to miss');
    assert.deepEqual(S.filterEntries(entries, 'bogus', '10.0.0.2').map((e) => e.route_id), [2]);
    assert.deepEqual(S.filterEntries(entries, 'all', '2222').map((e) => e.route_id), [3]);
    assert.deepEqual(S.filterEntries(null, 'all'), []);
  });

  it('protection marks: on/off per protection, flavours, na for layer 4', () => {
    const a = S.protectionCells(entries[0]);
    assert.deepEqual(a.map((c) => c.key), S.PROTECTIONS);
    assert.deepEqual(a.map((c) => c.state), ['off', 'off', 'off', 'off', 'on', 'off', 'off']);
    const b = S.protectionCells(entries[1]);
    assert.equal(b[0].value, 'security.exp_auth_route_auth');
    assert.equal(b[3].value, 'security.exp_waf_block');
    assert.deepEqual(b[6], { key: 'tls_min', state: 'on', value: null, text: '1.3' });
    assert.ok(S.protectionCells(entries[2]).every((c) => c.state === 'na'));
    assert.equal(S.healthKind('weird'), 'unknown');
    assert.equal(S.parseHash('#exposure'), 'exposure');
    assert.equal(S.parseHash('#nope'), 'check');
  });
});

describe('security.js integration', () => {
  it('no innerHTML, contract endpoints, SSE wiring, confirm before API fixes', () => {
    const src = stripComments(read('public/js/security.js'));
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.match(src, /request\('GET', '\/api\/v1\/security\/check'\)/);
    assert.match(src, /request\('GET', '\/api\/v1\/security\/exposure'\)/);
    assert.match(src, /request\('GET', '\/api\/v1\/zones'\)/);
    assert.match(src, /doc\.addEventListener\('gc:security'/);
    assert.match(src, /doc\.addEventListener\('gc:routes'/);
    assert.match(src, /const ok = await confirmDialog\([\s\S]*?if \(!ok\) return;[\s\S]*?await request\(fix\.method, fix\.url, fix\.body\)/);
    assert.match(src, /'X-CSRF-Token'/);
    assert.match(src, /GCLicenseHint\.render\(feature, \{ compact: true \}\)/);
  });

  it('events.js forwards the security SSE event (gc:security)', () => {
    const list = read('public/js/events.js').match(/\[([^\]]*'waf'[^\]]*)\]\.forEach/);
    assert.ok(list && /'security'/.test(list[1]), 'security is in the forwarded SSE types');
  });
});

describe('i18n: security.* + license_hint.* block', () => {
  const pick = (o) => Object.keys(o).filter(inBlock);
  it('identical key sets with matching placeholders', () => {
    assert.deepEqual(pick(de), pick(en));
    assert.ok(pick(de).length > 120);
    for (const k of pick(de)) {
      assert.ok(typeof de[k] === 'string' && de[k] && typeof en[k] === 'string' && en[k], k);
      const ph = (s) => (s.match(/\{\{\w+\}\}/g) || []).sort().join();
      assert.equal(ph(de[k]), ph(en[k]), `${k}: same {{placeholders}}`);
    }
  });

  it('ONE contiguous block directly after the last certificates.* key', () => {
    for (const [name, loc] of [['de', de], ['en', en]]) {
      const keys = Object.keys(loc);
      const block = pick(loc);
      const first = keys.indexOf(block[0]);
      assert.deepEqual(keys.slice(first, first + block.length), block, `${name}: contiguous`);
      assert.ok(keys[first - 1].startsWith('certificates.'), `${name}: after ${keys[first - 1]}`);
      const lastCert = keys.map((k, i) => (k.startsWith('certificates.') ? i : -1)).filter((i) => i >= 0).pop();
      assert.equal(first, lastCert + 1, `${name}: right after the last certificates.* key`);
      assert.ok(block[block.length - 1].startsWith('license_hint.'), 'license_hint.* closes the block');
    }
  });

  it('every key security.js can ask for exists (literal and composed) and is whitelisted', () => {
    const src = read('public/js/security.js');
    const layout = read('templates/aurora/layout.njk');
    const keys = new Set(Array.from(src.matchAll(/'((?:security|license_hint|common)\.[a-z0-9_.]+)'/g)).map((m) => m[1]).filter((k) => !/[._]$/.test(k)));
    for (const id of S.CHECK_IDS) {
      ['title', 'pass', 'fail', 'na'].forEach((s) => keys.add(`security.check.${id}.${s}`));
    }
    ['security.check.auto_update.fail_failed', 'security.check.backup_offsite.fail_none', 'security.check.unknown_pass', 'security.check.unknown_fail', 'security.check.unknown_na'].forEach((k) => keys.add(k));
    S.FIX_LABELS.forEach((id) => keys.add('security.fix.' + id));
    S.CONFIRM_IDS.forEach((id) => keys.add('security.confirm.' + id));
    S.SEVERITIES.forEach((s) => keys.add('security.group_' + s));
    ['pass', 'fail', 'info', 'na'].forEach((s) => keys.add('security.status_' + s));
    ['ok', 'down', 'unknown'].forEach((h) => keys.add('security.exp_health_' + h));
    ['security.exp_auth_basic', 'security.exp_auth_route_auth', 'security.exp_waf_block', 'security.exp_waf_detect'].forEach((k) => keys.add(k));
    for (const k of keys) {
      assert.ok(typeof de[k] === 'string' && de[k], `de.json has ${k}`);
      assert.ok(typeof en[k] === 'string' && en[k], `en.json has ${k}`);
      if (k !== 'common.loading' && k !== 'common.close' && k !== 'common.error') assert.ok(layout.includes(`'${k}'`), `layout GC.t whitelist has ${k}`);
    }
  });
});

describe('layout wiring and stylesheet', () => {
  it('the layout links app.css once, license-hint.js once after events.js', () => {
    const layout = read('templates/aurora/layout.njk');
    assert.equal(layout.split('<link rel="stylesheet"').length - 1, 1, 'exactly one stylesheet link');
    assert.match(layout, /<link rel="stylesheet" href="\/css\/app\.css\?v=\{\{ appVersion \}\}">/);
    assert.match(layout, /<script src="\/js\/events\.js\?v=\{\{ appVersion \}\}"><\/script>\n<script src="\/js\/license-hint\.js\?v=\{\{ appVersion \}\}"><\/script>/);
    assert.equal(layout.split('/js/license-hint.js').length, 2);
  });

  it('the security section of app.css: sections, balanced braces, no rules for foreign prefixes', () => {
    const css = appSection(3);
    for (const m of ['/* ─── Licence hint (lh-) ─── */', '/* ─── Sicherheits-Check (sc-) ─── */']) assert.equal(css.split(m).length, 2, m);
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal((bare.match(/\{/g) || []).length, (bare.match(/\}/g) || []).length);
    assert.doesNotMatch(bare, /(^|[\s,}])\.(zn|hs|so|tg)-[a-z-]+\s*\{/m, 'no zones/hsts/secopt/tls rules');
    for (const cls of ['.lh-hint', '.feature-locked.lh-in-locked', '.sc-check', '.sc-exp-table', '.sc-mark.sc-on']) assert.ok(css.includes(cls), cls);
    assert.match(css, /@media \(max-width: 720px\)/, 'phone layout');
    assert.ok(!appSection(2).includes('.sc-') && !appSection(2).includes('.lh-'), 'no sc-/lh- rules in the Aurora section');
  });
});
