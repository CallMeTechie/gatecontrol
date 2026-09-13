'use strict';

// waf.njk (default, pro, aurora): compiles with the page locals, carries the
// hooks waf.js / waf-ui.js query, loads the scripts in order, ships the
// #waf-i18n island translated and renders only a locked notice without the
// waf license (docs/feature-waf.md, "Oberfläche").
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nunjucks = require('nunjucks');

const ROOT = path.join(__dirname, '..');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');
const THEMES = ['default', 'pro', 'aurora'];

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

function render(theme, opts = {}) {
  const lang = opts.lang || 'de';
  const waf = opts.waf !== false;
  return env.render(`${theme}/pages/waf.njk`, {
    theme, language: lang, t: translator(lang), availableLanguages: ['de', 'en'],
    license: { features: { http_routes: -1, l4_routes: -1, waf }, hasFeature: () => false, tier: 'pro' },
    cspNonce: 'NONCE123', csrfToken: 'csrf-token', appVersion: '9.9.9', appName: 'GateControl',
    baseUrl: 'https://gc.example.com', user: { id: 1, username: 'admin', display_name: 'Admin', role: 'admin', theme },
    title: 'Web Application Firewall', activeNav: 'waf', currentPath: '/waf', flash: {},
    httpRouteCount: 3, l4RouteCount: 2, peerCount: 1, routeCount: 5, rdpRouteCount: 0,
  });
}

const REQUIRED_IDS = [
  'wf-summary', 'btn-waf-refresh', 'wf-tiles', 'wf-tile-events', 'wf-tile-events-val', 'wf-tile-blocked', 'wf-tile-blocked-val',
  'wf-tile-routes', 'wf-tile-routes-val', 'wf-engine-banner', 'wf-events-card', 'wf-new-events', 'wf-filters', 'wf-host',
  'wf-action-chips', 'wf-range-chips', 'wf-table', 'wf-events-list', 'wf-pager', 'wf-page-info', 'wf-more',
  'wf-routes-card', 'wf-routes-table', 'wf-routes-list', 'waf-i18n',
];

function island(html) {
  const m = /<script type="application\/json" id="waf-i18n"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'waf-i18n JSON island present');
  return JSON.parse(m[1]);
}
function headCells(html, tableId) {
  const at = html.indexOf(`id="${tableId}"`);
  const thead = html.slice(at, html.indexOf('</thead>', at));
  return Array.from(thead.matchAll(/<th>([^<]*)<\/th>/g)).map((m) => m[1]);
}

describe('waf.njk renders in every theme', () => {
  for (const theme of THEMES) {
    it(`${theme}: compiles and carries every id waf.js queries`, () => {
      const html = render(theme);
      for (const id of REQUIRED_IDS) assert.ok(html.includes(`id="${id}"`), `${theme}: #${id} rendered`);
      assert.match(html, /<tbody id="wf-events-list">/);
      assert.match(html, /id="wf-engine-banner"[^>]*\bhidden\b/, 'engine banner starts hidden');
      assert.match(html, /id="wf-new-events" hidden/, 'new-events notice starts hidden');
      assert.match(html, /id="wf-more" hidden/, 'pager button starts hidden');
      assert.match(html, /<select class="form-select wf-host-select" id="wf-host"><option value="">Alle Hosts<\/option><\/select>/);
      const actions = Array.from(html.matchAll(/data-action="([a-z]+)" aria-pressed/g)).map((m) => m[1]);
      assert.deepEqual(actions, ['all', 'blocked', 'detected'], 'action chips Alle/Blockiert/Erkannt');
      const ranges = Array.from(html.matchAll(/data-range="([a-z0-9]+)" aria-pressed/g)).map((m) => m[1]);
      assert.deepEqual(ranges, ['24h', '7d', '30d'], 'period chips');
      assert.match(html, /class="filter-chip on" data-action="all" aria-pressed="true"/);
      assert.match(html, /class="filter-chip on" data-range="24h" aria-pressed="true"/);
      const tiles = Array.from(html.matchAll(/id="wf-tile-(events|blocked|routes)" data-(action|target)="([a-z-]+)"/g)).map((m) => m[1] + '→' + m[3]);
      assert.deepEqual(tiles, ['events→all', 'blocked→blocked', 'routes→wf-routes-card']);
      assert.deepEqual(headCells(html, 'wf-table'), ['Zeit', 'Host', 'Aktion', 'Regel-ID', 'Nachricht', 'Client-IP', 'Methode + URI', 'Aktionen']);
      assert.deepEqual(headCells(html, 'wf-routes-table'), ['Host', 'Modus', 'Paranoia', 'Ereignisse 24 h', 'Blockiert 24 h', 'Aktionen']);
      assert.match(html, /<td colspan="8">Lädt|<td colspan="8">/);
      assert.ok(!html.includes('id="wf-locked"'), 'no locked notice with the license');
      if (theme === 'aurora') {
        assert.match(html, /class="app"/, 'aurora shell');
        assert.match(html, /aurora-routes-kpi wf-tile/);
        assert.match(html, /class="data-table wf-table" id="wf-table"/);
        assert.match(html, /class="card span12 wf-card" id="wf-events-card"/);
        assert.match(html, /class="toolbar wf-toolbar"/);
        assert.match(html, /class="page-actions">\s*<button class="btn btn-primary" id="btn-waf-refresh"/);
      } else {
        assert.match(html, /stats-grid wf-tiles/);
        assert.match(html, /stat-card wf-tile/);
        assert.match(html, /class="wf-table" id="wf-table"/);
      }
      if (theme === 'pro') assert.match(html, /stat-card-header/);
    });

    it(`${theme}: loads waf-ui.js before waf.js, after app.js, island first`, () => {
      const html = render(theme);
      const srcs = Array.from(html.matchAll(/<script src="([^"?]+)\?v=9\.9\.9"/g)).map((m) => m[1]);
      const app = srcs.indexOf('/js/app.js');
      const ui = srcs.indexOf('/js/waf-ui.js');
      const page = srcs.indexOf('/js/waf.js');
      assert.ok(ui >= 0 && page >= 0, 'both scripts loaded');
      assert.ok(app < ui && ui < page, `order app.js(${app}) < waf-ui.js(${ui}) < waf.js(${page})`);
      assert.ok(html.indexOf('id="waf-i18n"') < html.indexOf('/js/waf-ui.js?v='), 'island precedes the script that reads it');
      assert.match(html, /id="waf-i18n" nonce="NONCE123"/);
    });

    it(`${theme}: #waf-i18n carries every waf.* key, translated`, () => {
      for (const lang of ['de', 'en']) {
        const isl = island(render(theme, { lang }));
        const loc = lang === 'en' ? en : de;
        const expected = Object.keys(de).filter((k) => k.startsWith('waf.'));
        assert.ok(expected.length > 100, 'contract block present in de.json');
        for (const k of expected) {
          assert.ok(Object.prototype.hasOwnProperty.call(isl, k), `${theme}/${lang}: island has ${k}`);
          assert.equal(isl[k], loc[k], `${theme}/${lang}: ${k} translated`);
        }
        for (const k of ['common.close', 'common.cancel', 'common.loading', 'common.refresh']) assert.equal(isl[k], loc[k]);
      }
    });

    it(`${theme}: without the waf license only the locked notice renders, no scripts`, () => {
      const html = render(theme, { waf: false });
      assert.match(html, /id="wf-locked"/);
      assert.ok(html.includes(de['waf.locked']) && html.includes(de['waf.locked_title']));
      for (const id of ['wf-events-list', 'wf-tiles', 'waf-i18n', 'btn-waf-refresh', 'wf-routes-list']) assert.ok(!html.includes(`id="${id}"`), `${theme}: no #${id}`);
      assert.ok(!html.includes('/js/waf.js') && !html.includes('/js/waf-ui.js'), 'scripts not loaded');
      assert.ok(!html.includes('href="/waf"'), 'no sidebar item without the license');
      assert.match(html, /waf: false,/, 'window.GC.features.waf = false');
    });

    it(`${theme}: sidebar item under Routing and window.GC.features.waf with the license`, () => {
      const html = render(theme);
      assert.match(html, /<a href="\/waf" class="nav-item active"/, 'active nav item');
      assert.match(html, /waf: true,/, 'window.GC.features.waf = true');
      const routing = html.indexOf(de['nav.routing'], html.indexOf('id="sidebar"'));
      const item = html.indexOf('href="/waf"');
      const next = html.indexOf(de['nav.access_control'], routing);
      assert.ok(routing > 0 && item > routing && item < next, 'inside the Routing group');
      assert.ok(item > html.indexOf('href="/certificates"'), 'after Zertifikate');
    });

    it(`${theme}: template keys exist in both locales`, () => {
      const src = fs.readFileSync(path.join(ROOT, `templates/${theme}/pages/waf.njk`), 'utf8');
      for (const m of src.matchAll(/\bt\('([a-z0-9_.]+)'/g)) {
        assert.ok(de[m[1]] !== undefined, `de.json has ${m[1]}`);
        assert.ok(en[m[1]] !== undefined, `en.json has ${m[1]}`);
      }
      assert.match(src, /partials\/waf-i18n\.njk/, 'shared island partial included');
    });
  }

  it('English rendering uses en.json', () => {
    const html = render('default', { lang: 'en' });
    assert.match(html, /<div class="page-title">WAF<\/div>/);
    assert.match(html, /Events 24 h/);
    assert.match(html, /All hosts/);
  });
});
