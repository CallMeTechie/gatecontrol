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
const THEMES = ['aurora']; // Aurora is the only theme (docs/feature-aurora-only.md)
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
  '/js/zones-view.js', '/js/domain-modal.js', '/js/host-dialogs.js', '/js/zones-page.js',
];

const REQUIRED_IDS = [
  'zn-summary', 'zn-add-domain', 'zn-new-host', 'zn-search', 'zn-type', 'zn-status', 'zn-risk',
  'zn-gateway-filter', 'zn-collapse-all', 'zn-zones', 'zn-bulkbar', 'zones-i18n',
];
const SCRIPTS = ['domain-modal.js', 'host-dialogs.js', 'zones-page.js', 'entry-editor.js'];

function island(html) {
  const m = /<script type="application\/json" id="zones-i18n"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'zones-i18n JSON island present');
  return JSON.parse(m[1]);
}

// Keys the scripts look up: every quoted 'prefix.key' literal plus the ones
// built at runtime (template ids, notes, checks, '_one' plural variants).
// Literals ending in '_' or '.' are prefixes of runtime keys, not keys.
function jsKeys() {
  const src = SCRIPTS.map((f) => fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8')).join('\n');
  const keys = new Set();
  for (const m of src.matchAll(/'((?:zones|host|entry|template|common|entry_editor)\.[a-z0-9_.]+)'/g)) {
    if (!/[._]$/.test(m[1]) && de[m[1]] !== undefined) keys.add(m[1]);
  }
  for (const id of ['printer', 'nas', 'proxmox', 'ssh']) { keys.add('template.' + id); keys.add('template.' + id + '_hint'); }
  for (const k of Object.keys(de)) if (/^(zones\.note_|host\.check_|entry_editor\.listen_)/.test(k)) keys.add(k);
  for (const m of src.matchAll(/\btn\('([a-z_.]+)'/g)) if (de[m[1] + '_one'] !== undefined) keys.add(m[1] + '_one');
  for (const k of Array.from(keys)) if (de[k + '_one'] !== undefined) keys.add(k + '_one');
  return Array.from(keys).sort();
}

function templateKeys(theme) {
  const src = fs.readFileSync(path.join(ROOT, `templates/${theme}/pages/zones.njk`), 'utf8');
  return Array.from(src.matchAll(/\bt\('([a-z0-9_.]+)'/g)).map((m) => m[1]);
}

describe('zones.njk renders in every theme', () => {
  for (const theme of THEMES) {
    it(`${theme}: compiles, includes route-edit + confirm partials, no KPI strip or old domain modal`, () => {
      const html = render(theme);
      assert.match(html, /id="modal-edit-route"/, 'route-edit.njk included');
      assert.match(html, /id="modal-confirm"/, 'confirm.njk included');
      for (const id of REQUIRED_IDS) assert.ok(html.includes(`id="${id}"`), `#${id} rendered`);
      assert.doesNotMatch(html, /id="zn-kpis"|id="zn-domain-modal"|id="zn-chips"/, 'KPI strip, filter chips and the old domain modal are gone');
      assert.match(html, /class="app"/, 'aurora shell');
      assert.doesNotMatch(html, /id="routes-list"|id="btn-add-route"|zn-legacy-link|\/routes\/legacy/, 'no legacy page markup');
      assert.match(html, /id="zn-zones"[^>]*data-l4-blocked=/, 'blocked L4 ports for the new-host checks');
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

    it(`${theme}: toolbar controls match the filterZones dimensions`, () => {
      const html = render(theme);
      const types = Array.from(html.matchAll(/class="rt-seg-btn" data-type="([a-z0-9]*)" aria-pressed="(true|false)"/g)).map((m) => m[1] + ':' + m[2]);
      assert.deepEqual(types, [':true', 'http:false', 'l4:false']);
      const opts = (id) => {
        const at = html.indexOf('<select id="' + id + '"');
        return Array.from(html.slice(at, html.indexOf('</select>', at)).matchAll(/<option value="([a-z]*)"/g)).map((m) => m[1]);
      };
      assert.deepEqual(opts('zn-status'), ['', 'problem', 'disabled', 'external', 'internal']);
      assert.deepEqual(opts('zn-risk'), ['', 'nowaf', 'unprotected', 'nohsts']);
    });
  }

  it('the vendor QR script the page loads exists', () => {
    for (const theme of THEMES) {
      const qr = /<script src="([^"?]*qrcode[^"?]*)\?/.exec(render(theme));
      assert.ok(qr, `${theme}/zones.njk loads qrcode`);
      assert.ok(fs.existsSync(path.join(ROOT, 'public', qr[1])), 'vendor file exists');
    }
  });

  it('English rendering uses en.json', () => {
    const html = render('aurora', 'en');
    assert.match(html, /id="zn-add-domain"[\s\S]*?Add domain/);
    assert.match(html, /Collapse all/);
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

});

describe('zones scripts and styles', () => {
  it('build DOM without innerHTML/outerHTML/insertAdjacentHTML', () => {
    for (const f of ['zones-view.js', 'domain-modal.js', 'host-dialogs.js', 'zones-page.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // comments may name the API
      assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, f);
    }
  });

  it('open GCEntryEditor without lockTarget, with the host context, and guard its absence', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/host-dialogs.js'), 'utf8');
    assert.match(src, /window\.GCEntryEditor/);
    assert.match(src, /context: \{ host, zone \}/);
    assert.match(src, /entry\.editor_missing/);
    for (const f of SCRIPTS) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8').replace(/\/\/.*$/gm, ''), /lockTarget: true/, f);
  });

  // Wave 2 §W2: one stylesheet — §1 of app.css is the former pro.css, §2 the
  // former aurora.css. Each layer still owns exactly one zn- section.
  it('app.css §1 / §2 each have one zn- section', () => {
    const app = fs.readFileSync(path.join(ROOT, 'public/css/app.css'), 'utf8');
    for (const n of [1, 2]) {
      const a = app.indexOf(`\n * \u00a7${n} `);
      assert.ok(a > 0, `app.css section \u00a7${n}`);
      const b = app.indexOf(`\n * \u00a7${n + 1} `);
      const css = app.slice(a, b < 0 ? app.length : b);
      const f = 'app.css §' + n;
      const at = css.indexOf('/* ─── Domain zones (zn-) ─── */');
      assert.ok(at > 0, `${f}: section marker`);
      assert.equal(css.indexOf('/* ─── Domain zones (zn-) ─── */', at + 1), -1, `${f}: only once`);
      assert.doesNotMatch(css.slice(0, at), /\.zn-/, `${f}: no zn- rules before the section`);
    }
  });
});
