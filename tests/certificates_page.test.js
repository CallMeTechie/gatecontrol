'use strict';

// certificates.njk (default, pro, aurora): compiles with the page locals,
// carries the TLS-guard hooks certificates.js/tls-ui.js query, loads the
// scripts in order and ships the #tls-i18n island translated
// (docs/feature-tls-guard.md, "Oberfläche → Zertifikate").
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nunjucks = require('nunjucks');

const ROOT = path.join(__dirname, '..');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');
const THEMES = ['aurora']; // Aurora is the only theme (docs/feature-aurora-only.md)

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

function render(theme, lang = 'de') {
  return env.render(`${theme}/pages/certificates.njk`, {
    theme, language: lang, t: translator(lang), availableLanguages: ['de', 'en'],
    license: { features: { http_routes: -1, l4_routes: -1 }, hasFeature: () => false, tier: 'pro' },
    cspNonce: 'NONCE123', csrfToken: 'csrf-token', appVersion: '9.9.9', appName: 'GateControl',
    baseUrl: 'https://gc.example.com', user: { id: 1, username: 'admin', display_name: 'Admin', role: 'admin', theme },
    title: 'Zertifikate', activeNav: 'certificates', currentPath: '/certificates', flash: {},
    httpRouteCount: 3, l4RouteCount: 2, peerCount: 1, routeCount: 5, rdpRouteCount: 0,
  });
}

const REQUIRED_IDS = [
  'tg-summary', 'btn-certificates-refresh', 'tg-tiles', 'tg-tile-issued', 'tg-tile-issued-val', 'tg-tile-expiring',
  'tg-tile-expiring-val', 'tg-tile-failed', 'tg-tile-failed-val', 'tg-tile-paused', 'tg-tile-paused-val',
  'tg-email-banner', 'tg-chips', 'tg-table', 'certificates-list', 'tls-i18n',
];

function island(html) {
  const m = /<script type="application\/json" id="tls-i18n"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'tls-i18n JSON island present');
  return JSON.parse(m[1]);
}

describe('certificates.njk renders in every theme', () => {
  for (const theme of THEMES) {
    it(`${theme}: compiles and carries every id certificates.js queries`, () => {
      const html = render(theme);
      for (const id of REQUIRED_IDS) assert.ok(html.includes(`id="${id}"`), `${theme}: #${id} rendered`);
      assert.match(html, /<tbody id="certificates-list">/, 'rows go into the tbody');
      assert.match(html, /id="tg-email-banner"[^>]*\bhidden\b/, 'banner starts hidden');
      assert.match(html, /href="\/settings"/, 'banner links to the settings page');
      const chips = Array.from(html.matchAll(/data-filter="([a-z]+)"[^>]*aria-pressed/g)).map((m) => m[1]);
      assert.deepEqual(chips, ['all', 'problems', 'expiring', 'valid'], 'filter chips in contract order');
      const tiles = Array.from(html.matchAll(/id="tg-tile-(issued|expiring|failed|paused)" data-filter="([a-z]+)"/g)).map((m) => m[1] + '→' + m[2]);
      assert.deepEqual(tiles, ['issued→valid', 'expiring→expiring', 'failed→problems', 'paused→problems']);
      assert.equal((html.match(/<th>/g) || []).length, 7, 'seven table columns');
      assert.match(html, /class="app"/, 'aurora shell');
      assert.match(html, /class="card span12" id="tg-card"/);
      assert.match(html, /class="data-table" id="tg-table"/);
      assert.match(html, /class="page-actions">\s*<button class="btn btn-primary" id="btn-certificates-refresh"/);
      assert.match(html, /aurora-routes-kpi tg-tile/);
    });

    it(`${theme}: loads tls-ui.js before certificates.js, after app.js, with cache busting`, () => {
      const html = render(theme);
      const srcs = Array.from(html.matchAll(/<script src="([^"?]+)\?v=9\.9\.9"/g)).map((m) => m[1]);
      const app = srcs.indexOf('/js/app.js');
      const ui = srcs.indexOf('/js/tls-ui.js');
      const page = srcs.indexOf('/js/certificates.js');
      assert.ok(ui >= 0 && page >= 0, 'both scripts loaded');
      assert.ok(app < ui && ui < page, `order app.js(${app}) < tls-ui.js(${ui}) < certificates.js(${page})`);
      assert.ok(html.indexOf('id="tls-i18n"') < html.indexOf('/js/tls-ui.js?v='), 'island precedes the script that reads it');
    });

    it(`${theme}: #tls-i18n carries every tls./dns_check./settings.tls. key, translated`, () => {
      for (const lang of ['de', 'en']) {
        const isl = island(render(theme, lang));
        const loc = lang === 'en' ? en : de;
        const expected = Object.keys(de).filter((k) => /^(tls\.|dns_check\.|settings\.tls\.)/.test(k));
        assert.ok(expected.length > 100, 'contract block present in de.json');
        for (const k of expected) {
          assert.ok(Object.prototype.hasOwnProperty.call(isl, k), `${theme}/${lang}: island has ${k}`);
          assert.equal(isl[k], loc[k], `${theme}/${lang}: ${k} translated`);
        }
        for (const k of ['common.close', 'common.cancel', 'common.loading', 'common.refresh']) assert.equal(isl[k], loc[k]);
      }
    });

    it(`${theme}: template keys exist in both locales and the column keys the aurora test expects stay`, () => {
      const src = fs.readFileSync(path.join(ROOT, `templates/${theme}/pages/certificates.njk`), 'utf8');
      for (const m of src.matchAll(/\bt\('([a-z0-9_.]+)'/g)) {
        assert.ok(de[m[1]] !== undefined, `de.json has ${m[1]}`);
        assert.ok(en[m[1]] !== undefined, `en.json has ${m[1]}`);
      }
      for (const k of ['certificates.col_domain', 'certificates.col_issuer', 'certificates.col_valid_until', 'peers.status']) {
        assert.ok(src.includes(k), `${theme}: ${k}`);
      }
      assert.match(src, /partials\/tls-i18n\.njk/, 'shared island partial included');
    });
  }

  it('English rendering uses en.json', () => {
    const html = render('aurora', 'en');
    assert.match(html, /Certificate status per host/);
    assert.match(html, /Set the ACME e-mail in Settings/);
  });
});
