'use strict';

// zones.njk (default, pro, aurora): compiles with minimal locals, carries the
// editor/confirm partials and the script order from
// docs/feature-domain-zones.md, and every string the zones scripts ask for
// exists in de.json + en.json and in the page's JSON island.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nunjucks = require('nunjucks');

const ROOT = path.join(__dirname, '..');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');
const THEMES = ['default', 'pro', 'aurora'];
const PREFIXES = ['zones.', 'host.', 'entry.', 'template.'];

const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(ROOT, 'templates')), { autoescape: true });
// Same custom filters as src/app.js registers.
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

function render(theme, lang = 'de', features = { http_routes: -1, l4_routes: -1 }) {
  return env.render(`${theme}/pages/zones.njk`, {
    theme, language: lang, t: translator(lang), availableLanguages: ['de', 'en'],
    license: { features, hasFeature: () => false, tier: 'pro' },
    cspNonce: 'NONCE123', csrfToken: 'csrf-token', appVersion: '9.9.9', appName: 'GateControl',
    baseUrl: 'https://gc.example.com', user: { id: 1, username: 'admin', display_name: 'Admin', role: 'admin', theme },
    title: 'Domains & Routen', activeNav: 'routes', currentPath: '/routes', flash: {},
    httpRouteCount: 3, l4RouteCount: 2, peerCount: 1, routeCount: 5, rdpRouteCount: 0,
    gatewayPools: [], l4BlockedPorts: [],
  });
}

const SCRIPT_ORDER = [
  '/js/vendor/qrcode.min.js', '/js/routes-view.js', '/js/routeDomain.js', '/js/entry-editor.js',
  '/js/zones-view.js', '/js/domain-modal.js', '/js/zones-page.js',
];

const REQUIRED_IDS = [
  'zn-summary', 'zn-add-domain', 'zn-legacy-link', 'zn-search', 'zn-chips', 'zn-chip-all-count',
  'zn-gateway-filter', 'zn-collapse-all', 'zn-zones', 'zn-domain-modal', 'zn-dm-title', 'zn-dm-domain',
  'zn-dm-tags', 'zn-dm-counts', 'zn-dm-body', 'zn-dm-sync', 'zones-i18n',
];

function island(html) {
  const m = /<script type="application\/json" id="zones-i18n"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'zones-i18n JSON island present');
  return JSON.parse(m[1]);
}

// Keys the scripts look up: every quoted 'prefix.key' literal plus the ones
// built at runtime (template ids, '_one' plural variants).
function jsKeys() {
  const src = ['domain-modal.js', 'zones-page.js']
    .map((f) => fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8')).join('\n');
  const keys = new Set();
  for (const m of src.matchAll(/'((?:zones|host|entry|template|common)\.[a-z0-9_.]+)'/g)) keys.add(m[1]);
  for (const id of ['printer', 'nas', 'proxmox', 'ssh']) { keys.add('template.' + id); keys.add('template.' + id + '_hint'); }
  for (const m of src.matchAll(/\btn\('([a-z_.]+)'/g)) if (de[m[1] + '_one'] !== undefined) keys.add(m[1] + '_one');
  return Array.from(keys).sort();
}

function templateKeys(theme) {
  const src = fs.readFileSync(path.join(ROOT, `templates/${theme}/pages/zones.njk`), 'utf8');
  return Array.from(src.matchAll(/\bt\('([a-z0-9_.]+)'/g)).map((m) => m[1]);
}

describe('zones.njk renders in every theme', () => {
  for (const theme of THEMES) {
    it(`${theme}: compiles, includes route-edit + confirm partials, keeps the modal below them`, () => {
      const html = render(theme);
      assert.match(html, /id="modal-edit-route"/, 'route-edit.njk included');
      assert.match(html, /id="modal-confirm"/, 'confirm.njk included');
      const dm = html.indexOf('id="zn-domain-modal"');
      assert.ok(dm > 0 && dm < html.indexOf('id="modal-edit-route"') && dm < html.indexOf('id="modal-confirm"'),
        'domain modal precedes the editor/confirm overlays (they must stack above it)');
      for (const id of REQUIRED_IDS) assert.ok(html.includes(`id="${id}"`), `#${id} rendered`);
      if (theme === 'aurora') {
        assert.match(html, /id="zn-kpis"/);
        assert.match(html, /class="app"/, 'aurora shell');
      }
      assert.doesNotMatch(html, /id="routes-list"|id="btn-add-route"/, 'no legacy page markup');
    });

    it(`${theme}: loads the scripts in contract order with cache busting`, () => {
      const html = render(theme);
      const srcs = Array.from(html.matchAll(/<script src="([^"?]+)\?v=9\.9\.9"/g)).map((m) => m[1]);
      const idx = SCRIPT_ORDER.map((s) => srcs.indexOf(s));
      idx.forEach((i, n) => assert.ok(i >= 0, `${SCRIPT_ORDER[n]} loaded`));
      for (let n = 1; n < idx.length; n++) assert.ok(idx[n] > idx[n - 1], `${SCRIPT_ORDER[n]} after ${SCRIPT_ORDER[n - 1]}`);
      assert.ok(srcs.indexOf('/js/app.js') < idx[0], 'page scripts come after app.js');
      assert.ok(!srcs.includes('/js/routes.js'), 'legacy routes.js not loaded');
      assert.ok(!srcs.includes('/js/printerPresetForm.js'), 'wizard helper not loaded');
    });

    it(`${theme}: JSON island carries every script string, translated`, () => {
      for (const lang of ['de', 'en']) {
        const isl = island(render(theme, lang));
        const loc = lang === 'en' ? en : de;
        for (const k of jsKeys()) {
          assert.ok(Object.prototype.hasOwnProperty.call(isl, k), `${theme}/${lang}: island has ${k}`);
          assert.equal(isl[k], loc[k], `${theme}/${lang}: ${k} translated`);
        }
      }
    });

    it(`${theme}: filter chips match the filterZones dimensions`, () => {
      const html = render(theme);
      const chips = Array.from(html.matchAll(/data-dim="([a-z]+)"(?: data-value="([a-z0-9]+)")?/g)).map((m) => m[1] + ':' + (m[2] || ''));
      assert.deepEqual(chips, ['all:', 'type:http', 'type:l4', 'access:external', 'access:internal', 'state:disabled', 'state:problem']);
    });
  }

  it('the vendor QR script path matches the legacy routes page', () => {
    for (const theme of THEMES) {
      const legacy = fs.readFileSync(path.join(ROOT, `templates/${theme}/pages/routes.njk`), 'utf8');
      const qr = /<script src="([^"?]*qrcode[^"?]*)\?/.exec(legacy);
      assert.ok(qr, `${theme}/routes.njk loads qrcode`);
      assert.ok(fs.existsSync(path.join(ROOT, 'public', qr[1])), 'vendor file exists');
      assert.ok(render(theme).includes(`<script src="${qr[1]}?v=9.9.9"`), `${theme}: same qrcode path`);
    }
  });

  it('English rendering uses en.json', () => {
    const html = render('default', 'en');
    assert.match(html, /id="zn-add-domain"[\s\S]*?Add domain/);
    assert.match(html, /Classic view/);
  });

  it('license limit badges render only for limited tiers (default/pro)', () => {
    assert.doesNotMatch(render('default'), /limit-badge/);
    assert.match(render('default', 'de', { http_routes: 5, l4_routes: 2 }), /HTTPS: 3 \/ 5/);
    assert.match(render('pro', 'de', { http_routes: 5, l4_routes: 2 }), /TCP\/UDP: 2 \/ 2/);
  });
});

describe('zones i18n keys', () => {
  it('every t() key used in the templates exists in de.json and en.json', () => {
    for (const theme of THEMES) {
      for (const k of templateKeys(theme)) {
        assert.ok(de[k] !== undefined, `de.json has ${k} (${theme})`);
        assert.ok(en[k] !== undefined, `en.json has ${k} (${theme})`);
      }
    }
  });

  it('every key the scripts use exists in both languages', () => {
    for (const k of jsKeys()) {
      assert.ok(typeof de[k] === 'string' && de[k].length, `de.json has ${k}`);
      assert.ok(typeof en[k] === 'string' && en[k].length, `en.json has ${k}`);
    }
  });

  it('de.json and en.json have identical zones/host/entry/template key sets with matching placeholders', () => {
    const pick = (o) => Object.keys(o).filter((k) => PREFIXES.some((p) => k.startsWith(p))).sort();
    assert.deepEqual(pick(de), pick(en));
    assert.ok(pick(de).length > 100);
    for (const k of pick(de)) {
      const ph = (s) => (s.match(/\{\{\w+\}\}/g) || []).sort().join();
      assert.equal(ph(de[k]), ph(en[k]), `${k}: same {{placeholders}}`);
    }
  });

  it('all three themes ship the same island key list', () => {
    const list = (theme) => {
      const src = fs.readFileSync(path.join(ROOT, `templates/${theme}/pages/zones.njk`), 'utf8');
      const m = /set zonesI18nKeys = \[([\s\S]*?)\]/.exec(src);
      assert.ok(m, `${theme}: zonesI18nKeys defined`);
      return m[1].replace(/\s+/g, '');
    };
    assert.equal(list('pro'), list('default'));
    assert.equal(list('aurora'), list('default'));
  });
});

describe('zones scripts and styles', () => {
  it('build DOM without innerHTML/outerHTML/insertAdjacentHTML', () => {
    for (const f of ['zones-view.js', 'domain-modal.js', 'zones-page.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // comments may name the API
      assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, f);
    }
  });

  it('call GCEntryEditor.open with lockTarget and guard its absence', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/domain-modal.js'), 'utf8');
    assert.match(src, /GCEntryEditor/);
    assert.match(src, /lockTarget: true/);
    assert.match(src, /entry\.editor_missing/);
  });

  it('each theme stylesheet has one appended zn- section', () => {
    for (const f of ['app.css', 'pro.css', 'aurora.css']) {
      const css = fs.readFileSync(path.join(ROOT, 'public/css', f), 'utf8');
      const at = css.indexOf('/* ─── Domain zones (zn-) ─── */');
      assert.ok(at > 0, `${f}: section marker`);
      assert.equal(css.indexOf('/* ─── Domain zones (zn-) ─── */', at + 1), -1, `${f}: only once`);
      assert.doesNotMatch(css.slice(0, at), /\.zn-/, `${f}: no zn- rules before the section`);
    }
  });
});
