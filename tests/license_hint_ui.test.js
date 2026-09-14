'use strict';

// Licence hint component (docs/feature-release-b.md §11, UI strand B3):
// public/js/license-hint.js exposes window.GCLicenseHint.render(featureKey,
// opts) (stable API, also used by the backups UI), mount() and the
// data-license-hint auto-mount; reasons from GET /api/v1/license `locked`,
// „Lizenz aktualisieren“ = POST /api/v1/license/refresh. Integrations: WAF
// block of the entry editor, the locked /waf page, the mTLS block, the
// gateway discovery multi-subnet note.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nunjucks = require('nunjucks');

const ROOT = path.join(__dirname, '..');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');
const L = require('../public/js/license-hint.js');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(ROOT, 'templates')), { autoescape: true });
env.addFilter('bytes', (v) => String(v || 0) + ' B');
env.addFilter('reltime', () => '—');
env.addFilter('truncate', (s, n) => (!s || s.length <= n ? (s || '') : s.substring(0, n) + '...'));
function render(page, features) {
  const t = (key, params) => {
    let s = de[key] !== undefined ? de[key] : key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
    return s;
  };
  return env.render(`aurora/pages/${page}.njk`, {
    theme: 'aurora', language: 'de', t, availableLanguages: ['de', 'en'],
    license: { features: Object.assign({ http_routes: -1, l4_routes: -1 }, features || {}), hasFeature: () => false, tier: 'pro' },
    cspNonce: 'N', csrfToken: 'c', appVersion: '9.9.9', appName: 'GateControl', baseUrl: 'https://gc.example.com',
    user: { id: 1, username: 'admin', display_name: 'Admin', role: 'admin', theme: 'aurora' },
    title: 'x', activeNav: page === 'zones' ? 'routes' : page, currentPath: '/', flash: {},
    httpRouteCount: 3, l4RouteCount: 2, peerCount: 1, routeCount: 5, rdpRouteCount: 0, gatewayPools: [], l4BlockedPorts: [],
  });
}

describe('license-hint.js pure part', () => {
  it('reasonOf reads locked[feature] and only the three contract reasons', () => {
    assert.equal(L.reasonOf({ locked: { waf: 'plan' } }, 'waf'), 'plan');
    assert.equal(L.reasonOf({ locked: { waf: 'not_in_token' } }, 'waf'), 'not_in_token');
    assert.equal(L.reasonOf({ locked: { waf: 'unlicensed' } }, 'waf'), 'unlicensed');
    assert.equal(L.reasonOf({ locked: { waf: 'weird' } }, 'waf'), null);
    assert.equal(L.reasonOf({ locked: {} }, 'waf'), null);
    assert.equal(L.reasonOf(null, 'waf'), null);
    assert.deepEqual(L.REASONS, ['plan', 'not_in_token', 'unlicensed']);
  });

  it('view per reason: text key and actions', () => {
    assert.deepEqual(L.viewOf('plan', true), { text: 'license_hint.plan', actions: ['refresh', 'upgrade'] });
    assert.deepEqual(L.viewOf('not_in_token', true), { text: 'license_hint.not_in_token', actions: ['refresh'] });
    assert.deepEqual(L.viewOf('unlicensed', true), { text: 'license_hint.unlicensed', actions: ['enter', 'upgrade'] });
    assert.deepEqual(L.viewOf(null, true), { text: 'license_hint.unlocked', actions: ['reload'] });
    assert.deepEqual(L.viewOf('plan', false), { text: 'license_hint.generic', actions: [] });
    assert.equal(L.planLabel('pro'), 'Pro');
    assert.equal(L.planLabel(''), '—');
  });
});

describe('license-hint.js browser part', () => {
  it('stable API, contract endpoints, CSRF, DOM without innerHTML, auto-mount', () => {
    const src = stripComments(read('public/js/license-hint.js'));
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.match(src, /root\.GCLicenseHint = factory\(root\)/);
    assert.match(src, /return Object\.assign\(pure, \{ render, mount, mountAll, load, refresh \}\)/);
    assert.match(src, /function render\(featureKey, opts\)/);
    assert.match(src, /win\.fetch\('\/api\/v1\/license', /);
    assert.match(src, /win\.fetch\('\/api\/v1\/license\/refresh', \{\s*method: 'POST'/);
    assert.match(src, /'X-CSRF-Token'/);
    assert.match(src, /res\.status === 429/);
    assert.match(src, /win\.location\.reload\(\)/);
    assert.match(src, /querySelectorAll\('\[data-license-hint\]'\)/);
    assert.match(src, /settings-active-tab/);
  });

  it('every license_hint.* key it uses exists in de/en and is whitelisted in the layout', () => {
    const src = read('public/js/license-hint.js');
    const layout = read('templates/aurora/layout.njk');
    const keys = new Set(Array.from(src.matchAll(/'(license_hint\.[a-z_]+)'/g)).map((m) => m[1]));
    assert.ok(keys.size >= 13);
    for (const k of keys) {
      assert.ok(de[k] && en[k], k);
      assert.ok(layout.includes(`'${k}'`), `whitelisted ${k}`);
    }
    assert.match(de['license_hint.refresh'], /^Lizenz aktualisieren$/);
    assert.match(de['license_hint.plan'], /\{\{plan\}\}/);
  });
});

describe('integrations', () => {
  it('entry editor: the WAF locked hint mounts GCLicenseHint (local hunk)', () => {
    const ed = stripComments(read('public/js/entry-editor.js'));
    assert.match(ed, /if \(!licensed && window\.GCLicenseHint\) window\.GCLicenseHint\.mount\(locked, 'waf'\);/);
  });

  it('mTLS block without route_auth carries the auto-mount slot', () => {
    const off = render('zones', { waf: false, route_auth: false });
    assert.match(off, /class="so-editor-hint so-locked-hint" data-license-hint="route_auth">/);
    const on = render('zones', { waf: true, route_auth: true });
    assert.doesNotMatch(on, /data-license-hint="route_auth"/);
  });

  it('/waf without the licence: locked card with the compact hint slot', () => {
    const html = render('waf', { waf: false });
    assert.match(html, /id="wf-locked"/);
    assert.match(html, /id="wf-locked-hint" data-license-hint="waf" data-license-hint-compact>/);
    assert.match(html, /\/js\/license-hint\.js\?v=9\.9\.9/, 'component loaded by the layout');
  });

  it('gateway discovery: compact hint under the multi-subnet note', () => {
    assert.match(read('public/js/gateways.js'), /window\.GCLicenseHint\.render\('gateway_lan_discovery_multi_subnet', \{ compact: true \}\)/);
  });

  it('security page: hint for checks that are n/a without their licence feature', () => {
    const S = require('../public/js/security.js');
    assert.deepEqual(S.CHECK_FEATURE, { waf_coverage: 'waf', waf_ready: 'waf', backup_offsite: 'scheduled_backups' });
  });
});
