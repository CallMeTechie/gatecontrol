'use strict';

// Static wiring of the WAF UI (docs/feature-waf.md, "Oberfläche"): the
// editor block on the Security tab in all three themes (ids, options,
// license lock), script order + island keys on zones.njk, the integration
// points in entry-editor.js / domain-modal.js / zones-view.js, the page
// registration and licensed sidebar item, the i18n block (one contiguous
// tail of de/en, identical keys) and the appended wf- CSS sections.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nunjucks = require('nunjucks');

const ROOT = path.join(__dirname, '..');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');
const W = require('../public/js/waf-ui.js');
const THEMES = ['default', 'pro', 'aurora'];
const BLOCK_RE = /^(waf\.|nav\.waf$)/;

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const hasId = (html, id) => html.includes('id="' + id + '"');
const editorTpl = (theme) => read(`templates/${theme}/partials/modals/route-edit.njk`);

const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(ROOT, 'templates')), { autoescape: true });
env.addFilter('bytes', (v) => String(v || 0) + ' B');
env.addFilter('reltime', () => '—');
env.addFilter('truncate', (s, n) => (!s || s.length <= n ? (s || '') : s.substring(0, n) + '...'));
function render(theme, page, features) {
  const t = (key, params) => {
    let s = de[key] !== undefined ? de[key] : key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
    return s;
  };
  return env.render(`${theme}/pages/${page}.njk`, {
    theme, language: 'de', t, availableLanguages: ['de', 'en'],
    license: { features: Object.assign({ http_routes: -1, l4_routes: -1 }, features || {}), hasFeature: () => false, tier: 'pro' },
    cspNonce: 'NONCE123', csrfToken: 'csrf-token', appVersion: '9.9.9', appName: 'GateControl',
    baseUrl: 'https://gc.example.com', user: { id: 1, username: 'admin', display_name: 'Admin', role: 'admin', theme },
    title: 'x', activeNav: page === 'zones' ? 'routes' : page, currentPath: '/', flash: {},
    httpRouteCount: 3, l4RouteCount: 2, peerCount: 1, routeCount: 5, rdpRouteCount: 0, gatewayPools: [], l4BlockedPorts: [],
  });
}
function panel(src, name) {
  const at = src.indexOf(`data-panel="${name}"`);
  assert.ok(at > 0, `panel ${name}`);
  const next = src.indexOf('data-panel="', at + 20);
  return src.slice(at, next > 0 ? next : undefined);
}
// Every waf.* key waf-ui.js looks up (literals + keys built at runtime).
function kitKeys() {
  const src = read('public/js/waf-ui.js');
  const keys = new Set(Array.from(src.matchAll(/'(waf\.[a-z0-9_.]+)'/g)).map((m) => m[1]).filter((k) => !/[._]$/.test(k)));
  W.MODES.forEach((m) => { keys.add(W.modeKey(m)); keys.add('waf.mode_' + m + '_hint'); });
  W.PARANOIA_LEVELS.forEach((n) => { keys.add(W.paranoiaKey(n)); keys.add(W.paranoiaHintKey(n)); });
  ['block', 'detect'].forEach((s) => { keys.add(W.tagKey(s)); keys.add(W.chipKey(s)); });
  W.ACTIONS.forEach((a) => keys.add('waf.action_' + a));
  ['invalid_rule', 'invalid_path', 'duplicate'].forEach((e) => keys.add(W.clientErrorKey(e)));
  Object.values(W.ERROR_KEYS).forEach((k) => keys.add(k));
  return keys;
}

const EDITOR_IDS = ['edit-waf-block', 'edit-route-waf', 'edit-waf-fields', 'edit-route-waf-mode', 'edit-route-waf-paranoia', 'edit-waf-mode-hint',
  'edit-waf-paranoia-hint', 'edit-waf-exclusions', 'edit-waf-engine-hint', 'edit-waf-hint', 'edit-waf-locked-hint', 'edit-waf-events-link', 'edit-waf-error'];

describe('WAF: entry editor markup per theme', () => {
  for (const theme of THEMES) {
    it(`${theme}: block on the security tab after the body limit, mode + paranoia options, texts as data attributes`, () => {
      const src = editorTpl(theme);
      for (const id of EDITOR_IDS) assert.ok(hasId(src, id), `${theme}: #${id}`);
      const sec = panel(src, 'security');
      const blk = sec.indexOf('id="edit-waf-block"');
      assert.ok(blk > sec.indexOf('id="edit-body-limit-block"') && blk > sec.indexOf('id="edit-hsts-block"'), 'after HSTS and the body limit');
      assert.match(sec, /<select class="form-select" id="edit-route-waf-mode"[^>]*>\s*<option value="detect" selected>\{\{ t\('waf\.mode_detect'\) \}\}<\/option>\s*<option value="block">\{\{ t\('waf\.mode_block'\) \}\}<\/option>/);
      const par = Array.from(sec.matchAll(/<option value="(\d)"( selected)?>\{\{ t\('waf\.paranoia_(\d)'\) \}\}<\/option>/g)).map((m) => m[1] + (m[2] ? '*' : '') + m[3]);
      assert.deepEqual(par, ['1*1', '22', '33', '44'], 'paranoia 1–4, 1 preselected');
      assert.match(src, /class="toggle" id="edit-route-waf" data-managed="true" role="switch"/, 'toggle never wired by app.js');
      assert.ok(src.includes(`data-licensed="{{ '1' if license.features.waf else '0' }}"`));
      for (const n of [1, 2, 3, 4]) assert.ok(src.includes(`data-paranoia-hint${n}="{{ t('waf.paranoia_${n}_hint') }}"`), `paranoia hint ${n}`);
      for (const [attr, key] of [['data-hint-http', 'waf.hint_http'], ['data-mode-hint-detect', 'waf.mode_detect_hint'], ['data-mode-hint-block', 'waf.mode_block_hint'],
        ['data-err-license', 'waf.err.license'], ['data-err-waf-mode-invalid', 'waf.err.mode_invalid'], ['data-err-waf-paranoia-invalid', 'waf.err.paranoia_invalid'],
        ['data-err-waf-requires-http', 'waf.err.requires_http']]) {
        assert.ok(src.includes(`${attr}="{{ t('${key}') }}"`), `${theme}: ${attr}`);
      }
      assert.ok(sec.includes("t('waf.recommendation')") && sec.includes("t('waf.title')") && sec.includes("t('waf.editor_desc')"));
      assert.match(src, /id="edit-waf-error" class="so-editor-error" role="alert" hidden/);
    });

    it(`${theme}: zones.njk renders the WAF block licensed and locked`, () => {
      const on = render(theme, 'zones', { waf: true, route_auth: true });
      const off = render(theme, 'zones', { waf: false, route_auth: true });
      const blk = (html) => /<div id="edit-waf-block"[^>]*>/.exec(html)[0];
      assert.match(blk(on), /data-licensed="1"/);
      assert.doesNotMatch(blk(on), /feature-locked/);
      assert.match(blk(off), /data-licensed="0"/);
      assert.match(blk(off), /feature-locked wf-license-locked/);
      assert.match(off, /id="edit-route-waf" data-managed="true" role="switch" aria-checked="false" aria-label="[^"]+" aria-disabled="true" tabindex="-1"/);
      assert.match(off, /<select class="form-select" id="edit-route-waf-mode" disabled>/);
      assert.match(off, /<select class="form-select" id="edit-route-waf-paranoia" disabled>/);
      assert.match(off, /id="edit-waf-locked-hint" class="wf-editor-hint wf-locked-hint">Die Web Application Firewall ist Teil der Pro-Lizenz\./);
      assert.match(on, /id="edit-waf-locked-hint" class="wf-editor-hint wf-locked-hint" hidden>/);
      assert.match(on, /id="edit-route-waf" data-managed="true" role="switch" aria-checked="false" aria-label="[^"]+" tabindex="0"/);
      assert.match(off, /id="edit-waf-events-link" class="wf-events-link" href="\/waf" hidden>/);
      assert.ok(on.includes('Nur erkennen') && on.includes('Blockieren') && on.includes('1–2 Tage „Nur erkennen“'), 'German texts rendered');
      assert.match(on, /waf: true,/);
      assert.match(off, /waf: false,/);
    });
  }
});

describe('WAF: zones page wiring', () => {
  for (const theme of THEMES) {
    it(`${theme}: waf-ui.js loads after secopt-ui.js and before domain-modal.js`, () => {
      const src = read(`templates/${theme}/pages/zones.njk`);
      const order = ['/js/entry-editor.js?v=', '/js/secopt-ui.js?v=', '/js/waf-ui.js?v=', '/js/domain-modal.js?v=', '/js/zones-page.js?v='].map((s) => src.indexOf(s));
      order.forEach((i, n) => assert.ok(i > 0, `script ${n}`));
      for (let n = 1; n < order.length; n++) assert.ok(order[n] > order[n - 1], `order ${n}`);
      assert.equal(src.split('/js/waf-ui.js').length, 2, 'loaded once');
    });

    it(`${theme}: the zones island lists every waf.* key waf-ui.js uses, translated`, () => {
      const src = read(`templates/${theme}/pages/zones.njk`);
      const listed = Array.from(/set zonesI18nKeys = \[([\s\S]*?)\]/.exec(src)[1].matchAll(/'([a-z0-9_.]+)'/g)).map((x) => x[1]);
      assert.equal(new Set(listed).size, listed.length, 'no duplicates');
      for (const k of kitKeys()) assert.ok(listed.includes(k), `${theme}: island has ${k}`);
      const html = render(theme, 'zones', { waf: true });
      const isl = JSON.parse(/<script type="application\/json" id="zones-i18n"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1]);
      assert.equal(isl['waf.tag_block'], 'WAF');
      assert.equal(isl['waf.tag_detect'], 'WAF · erkennt');
      assert.equal(isl['waf.chip_detect'], 'WAF (erkennt)');
    });
  }

  it('the WAF page island lists every key waf-ui.js and waf.js use', () => {
    const listed = Array.from(/set wafI18nKeys = \[([\s\S]*?)\]/.exec(read('templates/partials/waf-i18n.njk'))[1].matchAll(/'([a-z0-9_.]+)'/g)).map((x) => x[1]);
    assert.equal(new Set(listed).size, listed.length, 'no duplicates');
    const used = kitKeys();
    for (const m of read('public/js/waf.js').matchAll(/'((?:waf|common)\.[a-z0-9_.]+)'/g)) used.add(m[1]);
    for (const m of read('public/js/waf-ui.js').matchAll(/'(common\.[a-z0-9_.]+)'/g)) used.add(m[1]);
    for (const k of used) assert.ok(listed.includes(k), `waf island has ${k}`);
  });
});

describe('WAF: script integration', () => {
  it('waf-ui.js: no innerHTML, contract endpoints, both islands, CSRF', () => {
    const src = stripComments(read('public/js/waf-ui.js'));
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.match(src, /'\/api\/v1\/waf\/status'/);
    assert.match(src, /'\/api\/v1\/waf\/events' \+ eventsQuery\(filter, opts\)/);
    assert.match(src, /'\/api\/v1\/waf\/routes\/' \+ encodeURIComponent\(routeId\) \+ '\/exclusions'/);
    assert.match(src, /request\('POST', exclusionUrl\(routeId\), body\)/);
    assert.match(src, /request\('DELETE', exclusionUrl\(routeId\), body\)/);
    assert.match(src, /'X-CSRF-Token'/);
    assert.match(src, /\['waf-i18n', 'zones-i18n'\]/);
    for (const cls of ['wf-entry-tag', 'wf-exclude-dialog', 'wf-path-input', 'wf-btn-ok', 'wf-excl-row', 'wf-excl-remove', 'wf-excl-add', 'wf-excl-input', 'wf-excl-type', 'wf-mode-tag', 'wf-action-tag', 'wf-field-error']) {
      assert.ok(src.includes(cls), cls);
    }
  });

  it('waf.js: no innerHTML, filters, cursor pagination, raw toggle, row actions, live reload on gc:waf', () => {
    const src = stripComments(read('public/js/waf.js'));
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.match(src, /W\.parseDeepLink\(window\.location\.search\)/, 'deep link /waf?host=');
    assert.match(src, /history\.replaceState\(null, '', '\/waf' \+ W\.deepLinkQuery\(next\)\)/);
    assert.match(src, /W\.fetchEvents\(filter, \{ cursor: state\.next \}\)/);
    assert.match(src, /W\.mergeEvents\(/);
    assert.match(src, /document\.addEventListener\('gc:waf', onWafEvent\)/);
    assert.match(src, /setTimeout\(\(\) => \{[\s\S]*?\}, 800\)/, 'debounced');
    assert.match(src, /W\.openExclusionDialog\(kind, \{ routeId, host: ev\.host, ruleId: ev\.rule_id, uri: ev\.uri \}\)/);
    assert.match(src, /W\.isNotFound\(err\)/);
    assert.match(src, /engine_available === false/);
    for (const id of ['wf-events-list', 'wf-host', 'wf-action-chips', 'wf-range-chips', 'wf-tiles', 'wf-more', 'wf-page-info', 'wf-new-events', 'wf-routes-list', 'wf-engine-banner', 'wf-summary', 'btn-waf-refresh', 'wf-events-card']) {
      assert.ok(src.includes(`'${id}'`), id);
    }
    for (const cls of ['wf-raw', 'wf-raw-toggle', 'wf-exclude-rule', 'wf-exclude-path', 'wf-host-link', 'wf-backend-missing']) assert.ok(src.includes(cls), cls);
  });

  it('entry-editor.js populates, locks, sends and maps the WAF fields', () => {
    const ed = stripComments(read('public/js/entry-editor.js'));
    assert.match(ed, /populateWaf\(route\);/);
    assert.match(ed, /setupWafControls\(\);/);
    assert.match(ed, /Object\.assign\(payload, readWafFields\(target\)\)/);
    assert.match(ed, /window\.GC\.features\.waf === false/, 'license flag from the layout');
    assert.match(ed, /block\.dataset\.licensed === '0'/);
    for (const f of ['waf_enabled', 'waf_mode', 'waf_paranoia']) assert.match(ed, new RegExp(f + ':'), f);
    assert.match(ed, /W\.exclusionsEditor\(box, route\)/);
    assert.match(ed, /W\.engineHint\(engine\)/);
    assert.match(ed, /data\.feature === 'waf' && payload\.waf_enabled/);
    for (const code of ['WAF_MODE_INVALID', 'WAF_PARANOIA_INVALID', 'WAF_REQUIRES_HTTP', 'WAF_LICENSE']) assert.ok(ed.includes(code + ':'), code);
    assert.match(ed, /opts\.tab \? modal\.querySelector/, 'start tab option');
    assert.match(ed, /'edit-waf-error'/);
  });

  it('domain-modal.js renders the WAF tag and opens the editor on the security tab; zones chip note', () => {
    const dm = stripComments(read('public/js/domain-modal.js'));
    assert.match(dm, /window\.GCWafUI && window\.GCWafUI\.entryTag\(e, \{ onOpen: \(\) => editEntry\(e, \{ tab: 'security', focus: 'edit-waf-block' \}\) \}\)/);
    assert.ok(dm.indexOf('GCWafUI.entryTag(e') > dm.indexOf('GCSecOptUI.entryTags(e)'), 'after the security-option tags');
    assert.match(dm, /V\.entryChip\(e, \{ hsts: false, waf: false \}\)/);
    assert.match(dm, /wafLabel: \(state\) => t\(state === 'block' \? 'waf\.chip_block' : 'waf\.chip_detect'\)/);
    assert.match(dm, /lockTarget: true/);
    const zv = stripComments(read('public/js/zones-view.js'));
    assert.match(zv, /'WAF \(erkennt\)'/);
    assert.match(zv, /opts\.waf === false/);
  });
});

describe('WAF: page registration and sidebar', () => {
  it('src/routes/index.js registers /waf with nav.waf', () => {
    assert.match(read('src/routes/index.js'), /\{ path: '\/waf', template: 'waf', titleKey: 'nav\.waf' \}/);
  });

  for (const theme of THEMES) {
    it(`${theme}: sidebar item only with the waf license, under Routing after Zertifikate`, () => {
      const src = read(`templates/${theme}/partials/sidebar.njk`);
      const item = src.indexOf('href="/waf"');
      assert.ok(item > src.indexOf('href="/certificates"'), 'after the certificates item');
      const before = src.slice(0, item);
      assert.ok(before.lastIndexOf('{% if license.features.waf %}') > before.lastIndexOf('{% endif %}'), 'inside the license guard');
      assert.ok(src.includes("{{ 'active' if activeNav == 'waf' }}"));
      assert.ok(src.includes("{{ t('nav.waf') }}"));
      const on = render(theme, 'certificates', { waf: true });
      const off = render(theme, 'certificates', { waf: false });
      assert.ok(on.includes('href="/waf"') && !off.includes('href="/waf"'));
    });

    it(`${theme}: layout exposes window.GC.features.waf`, () => {
      assert.ok(read(`templates/${theme}/layout.njk`).includes("waf: {{ ('true' if license.features.waf else 'false') | safe }},"));
    });
  }
});

describe('WAF: i18n', () => {
  it('de.json and en.json carry identical key sets with matching placeholders', () => {
    const pick = (o) => Object.keys(o).filter((k) => BLOCK_RE.test(k));
    assert.deepEqual(pick(de), pick(en));
    assert.ok(pick(de).length >= 100);
    for (const k of pick(de)) {
      assert.ok(typeof de[k] === 'string' && de[k].length && typeof en[k] === 'string' && en[k].length, k);
      const ph = (s) => (s.match(/\{\{\w+\}\}/g) || []).sort().join();
      assert.equal(ph(de[k]), ph(en[k]), `${k}: same {{placeholders}}`);
    }
  });

  it('is ONE contiguous block at the end of both files, after the security options', () => {
    for (const [name, loc] of [['de', de], ['en', en]]) {
      const keys = Object.keys(loc);
      const first = keys.findIndex((k) => BLOCK_RE.test(k));
      assert.ok(first > 0, `${name}: block present`);
      assert.equal(keys[first], 'nav.waf', `${name}: starts with nav.waf`);
      assert.ok(/^(caa|mtls|alias|tls_profile|body_limit|backend_tls)\./.test(keys[first - 1]), `${name}: after the security options (${keys[first - 1]})`);
      for (let i = first; i < keys.length; i++) assert.ok(BLOCK_RE.test(keys[i]), `${name}: ${keys[i]} inside the tail block`);
    }
  });

  it('every waf key used by scripts and templates exists in both languages', () => {
    const keys = kitKeys();
    const files = ['public/js/waf.js', 'public/js/domain-modal.js', 'templates/partials/waf-i18n.njk',
      ...THEMES.flatMap((th) => [`templates/${th}/pages/waf.njk`, `templates/${th}/pages/zones.njk`, `templates/${th}/partials/modals/route-edit.njk`, `templates/${th}/partials/sidebar.njk`])];
    for (const f of files) for (const m of read(f).matchAll(/['"]((?:waf\.|nav\.waf)[a-z0-9_.]*)['"]/g)) keys.add(m[1]);
    for (const k of keys) {
      if (/[._]$/.test(k)) continue;
      assert.ok(typeof de[k] === 'string' && de[k].length, `de.json has ${k}`);
      assert.ok(typeof en[k] === 'string' && en[k].length, `en.json has ${k}`);
    }
    assert.ok(keys.size > 80, 'keys collected');
  });

  it('German contract texts', () => {
    assert.equal(de['nav.waf'], 'Web Application Firewall');
    assert.equal(de['waf.title'], 'Web Application Firewall');
    assert.equal(de['waf.mode_detect'], 'Nur erkennen');
    assert.equal(de['waf.mode_block'], 'Blockieren');
    assert.match(de['waf.recommendation'], /erst 1–2 Tage „Nur erkennen“/);
    assert.equal(de['waf.tile_events'], 'Ereignisse 24 h');
    assert.equal(de['waf.tile_blocked'], 'Blockiert 24 h');
    assert.equal(de['waf.tile_routes'], 'Routen mit WAF');
    assert.equal(de['waf.exclude_rule'], 'Regel für diese Route ausschließen');
    assert.equal(de['waf.exclude_path'], 'Pfad ausschließen');
    assert.equal(de['waf.tag_detect'], 'WAF · erkennt');
    assert.equal(de['waf.chip_detect'], 'WAF (erkennt)');
  });
});

describe('WAF: styles', () => {
  it('app.css / pro.css / aurora.css end with one wf- section after so-, braces balanced', () => {
    for (const f of ['app.css', 'pro.css', 'aurora.css']) {
      const css = read('public/css/' + f);
      const marker = '/* ─── WAF (wf-) ─── */';
      const at = css.indexOf(marker);
      assert.ok(at > 0, `${f}: section marker`);
      assert.equal(css.indexOf(marker, at + 1), -1, `${f}: only once`);
      assert.doesNotMatch(css.slice(0, at).replace(/\/\*[\s\S]*?\*\//g, ''), /\.wf-[a-z]|#wf-/, `${f}: no wf- rules before the section`);
      const so = css.indexOf('/* ─── Security options (so-) ─── */');
      assert.ok(so > 0 && so < at, `${f}: after the so- section`);
      assert.equal(css.indexOf('/* ─── ', at + 1), -1, `${f}: wf- is the last section`);
      const whole = css.replace(/\/\*[\s\S]*?\*\//g, '');
      assert.equal((whole.match(/\{/g) || []).length, (whole.match(/\}/g) || []).length, `${f}: braces balanced`);
    }
    for (const f of ['app.css', 'pro.css']) {
      const css = read('public/css/' + f);
      for (const cls of ['.stats-grid.wf-tiles', '.wf-tile.on', '.wf-banner', '.wf-filters', '.wf-table-wrap', '#wf-table', '.wf-row-blocked', '.wf-raw', '.btn.wf-act',
        '.wf-pager', '.wf-locked', '.modal.wf-dialog-box', '.wf-editor-block.wf-locked', '.wf-editor-row', '.wf-recommendation', '.wf-excl-row', '.tag.wf-entry-tag']) {
        assert.ok(css.includes(cls), `${f}: ${cls}`);
      }
      assert.match(css, /@media \(max-width: 600px\) \{[^}]*\.stats-grid\.wf-tiles \{ grid-template-columns: 1fr; \}/, `${f}: tiles stack on phones`);
    }
    assert.ok(read('public/css/aurora.css').includes('.aurora-routes-kpi.wf-tile.on'));
  });
});
