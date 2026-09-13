'use strict';

// Static wiring of the HSTS UI (docs/feature-hsts.md): ids/classes exist in
// the templates of all three themes, script order on zones.njk, the island
// carries the hsts.* strings, i18n key coverage in de.json + en.json (one
// contiguous block at the end), the appended hs- CSS sections and the
// integration points in domain-modal.js / entry-editor.js / zones-view.js.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');
const H = require('../public/js/hsts-ui.js');
const THEMES = ['default', 'pro', 'aurora'];

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const hasId = (html, id) => html.includes('id="' + id + '"');

const EDITOR_IDS = ['edit-hsts-block', 'edit-route-hsts', 'edit-route-hsts-max-age', 'edit-route-hsts-subdomains', 'edit-route-hsts-preload', 'edit-hsts-fields', 'edit-hsts-hint', 'edit-headers-hsts-hint'];
const EDITOR_DATA = ['data-hint-https', 'data-hint-preload', 'data-preload-confirm', 'data-err-preload-requirements', 'data-err-requires-https', 'data-err-max-age-invalid'];
// Classes the browser scenario and the scripts rely on (built at runtime by hsts-ui.js).
const RUNTIME_CLASSES = ['hs-defaults', 'hs-def-age', 'hs-def-sub', 'hs-def-preload', 'hs-entry-tag', 'hs-off', 'hs-dialog', 'hs-btn-ok', 'hs-btn-save', 'hs-warn', 'hs-confirm-cb', "'hs-apply-' + value", 'hs-field-error', 'hs-toggle', 'hs-preview-value'];

describe('HSTS: DOM hooks per theme', () => {
  for (const theme of THEMES) {
    it(`${theme}/route-edit.njk has the HSTS block on the security tab, its texts and the preset hint`, () => {
      const src = read(`templates/${theme}/partials/modals/route-edit.njk`);
      for (const id of EDITOR_IDS) assert.ok(hasId(src, id), `${theme}: #${id}`);
      for (const d of EDITOR_DATA) assert.ok(src.includes(d + '="{{ t(\'hsts.'), `${theme}: ${d} from hsts.* i18n`);
      const sec = src.indexOf('data-panel="security"');
      const block = src.indexOf('id="edit-hsts-block"');
      const nextPanel = src.indexOf('data-panel="', sec + 20);
      assert.ok(sec > 0 && block > sec && block < nextPanel, `${theme}: block inside the security panel`);
      assert.match(src, /id="edit-route-hsts-max-age"[\s\S]*?value="15552000"[\s\S]*?value="31536000" selected[\s\S]*?value="63072000"/, 'select options 6m/1y/2y, 1y preselected');
      assert.doesNotMatch(src.slice(block, nextPanel), /value="0"/, 'the editor select has no "Aus" option (the toggle is the switch)');
      const headers = src.indexOf('data-panel="headers"');
      const hint = src.indexOf('id="edit-headers-hsts-hint"');
      assert.ok(hint > headers && hint < src.indexOf('id="edit-headers-request-list"'), `${theme}: preset hint in the headers panel`);
      assert.match(src, /id="edit-headers-hsts-hint"[^>]*>\{\{ t\('hsts\.preset_hint'\) \}\}/);
      assert.ok(hasId(src, 'edit-route-https'), 'force-HTTPS toggle the block follows');
    });

    it(`${theme}/zones.njk loads hsts-ui.js after tls-ui.js and before domain-modal.js and lists the hsts.* island keys`, () => {
      const src = read(`templates/${theme}/pages/zones.njk`);
      const tls = src.indexOf('/js/tls-ui.js?v=');
      const hs = src.indexOf('/js/hsts-ui.js?v=');
      const dm = src.indexOf('/js/domain-modal.js?v=');
      const ed = src.indexOf('/js/entry-editor.js?v=');
      assert.ok(tls > 0 && hs > tls && dm > hs, `${theme}: order tls-ui < hsts-ui < domain-modal`);
      assert.ok(ed > 0 && ed < hs, 'entry-editor.js loaded before (it only calls GCHstsUI lazily)');
      const m = /set zonesI18nKeys = \[([\s\S]*?)\]/.exec(src);
      assert.ok(m, 'zonesI18nKeys');
      const listed = Array.from(m[1].matchAll(/'([a-z0-9_.]+)'/g)).map((x) => x[1]);
      const contract = Object.keys(de).filter((k) => k.startsWith('hsts.')).sort();
      assert.deepEqual(listed.filter((k) => k.startsWith('hsts.')).sort(), contract, `${theme}: every hsts.* key in the island`);
      assert.equal(new Set(listed).size, listed.length, 'no duplicates');
    });
  }

  it('hsts-ui.js exposes the contract API, builds DOM without innerHTML and PUTs only the hsts fields', () => {
    const src = stripComments(read('public/js/hsts-ui.js'));
    for (const f of ['entryTag', 'openEntryDialog', 'defaultsControl', 'headerValue', 'labelFor', 'confirmPreload']) {
      assert.match(src, new RegExp('\\b' + f + '\\b'), f);
    }
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.match(src, /api\.put\('\/api\/v1\/routes\/' \+ entry\.id, toRouteFields\(cfg\)\)/, 'entry dialog PUT body = toRouteFields');
    assert.match(src, /api\.put\('\/api\/v1\/domains\/' \+ zone\.domain_id \+ '\/defaults', body\)/);
    assert.match(src, /hsts_default: toDefault\(next\), apply_hsts_to_existing: mode === 'existing'/, 'defaults body without default_external_enabled');
    assert.doesNotMatch(src, /default_external_enabled/, 'never touches the access default');
    for (const cls of RUNTIME_CLASSES) assert.ok(src.includes(cls), 'class ' + cls);
    assert.match(src, /zones-i18n/, 'reads the zones island');
    for (const code of H.ERROR_CODES) assert.ok(src.includes(code), code);
  });

  it('domain-modal.js renders the default control in the head panel and the entry tag next to the TLS tag', () => {
    const dm = stripComments(read('public/js/domain-modal.js'));
    assert.match(dm, /GCHstsUI\.defaultsControl\(zone, \{ onChanged: afterMutation \}\)/);
    assert.match(dm, /hsts \? ' hs-panel4' : ''/, 'four-field grid only with the control');
    assert.match(dm, /GCHstsUI\.entryTag\(e, \{ onChanged: afterMutation \}\)/);
    assert.match(dm, /V\.entryChip\(e, \{ hsts: false \}\)/, 'no duplicate HSTS note in the entry line');
    const tls = dm.indexOf('GCTlsUI.entryTag(e');
    const hs = dm.indexOf('GCHstsUI.entryTag(e');
    assert.ok(tls > 0 && hs > tls, 'HSTS tag after the TLS tag');
    assert.match(dm, /window\.GCHstsUI && window\.GCHstsUI\./, 'guards the absence of hsts-ui.js');
  });

  it('zones-view.js adds the HSTS chip note and zones-page.js still renders chips through chipEl', () => {
    assert.match(stripComments(read('public/js/zones-view.js')), /'HSTS'/);
    assert.match(read('public/js/zones-page.js'), /UI\.chipEl\(e\)/);
  });

  it('entry-editor.js populates, greys out, confirms preload, sends and maps the HSTS fields', () => {
    const ed = stripComments(read('public/js/entry-editor.js'));
    assert.match(ed, /populateHsts\(route\)/);
    assert.match(ed, /setToggle\('edit-route-hsts', on\)/);
    assert.match(ed, /isOn\('edit-route-https'\)/);
    assert.match(ed, /classList\.toggle\('hs-locked', !httpsOn\)/, 'block greyed out while force-HTTPS is off');
    assert.match(ed, /https\.addEventListener\('click', function \(\) \{ syncHstsBlock\(\); \}\)/);
    assert.match(ed, /GCHstsUI\.confirmPreload\(\)/);
    assert.match(ed, /Object\.assign\(payload, readHstsFields\(\)\)/, 'hsts_* in the PUT body');
    for (const f of ['hsts_enabled', 'hsts_max_age', 'hsts_subdomains', 'hsts_preload']) assert.match(ed, new RegExp('out\\.' + f + ' ='), f);
    assert.match(ed, /hstsErrorText\(data\.code\)/, '400 code mapped before the generic error');
    for (const code of H.ERROR_CODES) assert.ok(ed.includes(code), code);
    assert.match(ed, /showIf\('edit-headers-hsts-hint', val === 'security'\)/, 'preset hint');
    assert.doesNotMatch(ed, /Strict-Transport-Security/, 'the security preset never adds the header');
    assert.match(ed, /setupHstsControls\(\);/);
  });
});

describe('HSTS: i18n', () => {
  const pick = (o) => Object.keys(o).filter((k) => k.startsWith('hsts.'));

  function usedKeys() {
    const keys = new Set();
    const files = ['public/js/hsts-ui.js', 'public/js/entry-editor.js', 'public/js/domain-modal.js',
      ...THEMES.flatMap((th) => [`templates/${th}/pages/zones.njk`, `templates/${th}/partials/modals/route-edit.njk`])];
    for (const f of files) for (const m of read(f).matchAll(/['"](hsts\.[a-z0-9_]+(?:\.[a-z0-9_]+)*)['"]/g)) keys.add(m[1]);
    for (const c of H.ERROR_CODES) keys.add(H.errorKey(c));
    Object.keys(H.AGE_KEYS).forEach((k) => keys.add(H.AGE_KEYS[k]));
    return Array.from(keys).sort();
  }

  it('every key used by scripts and templates exists in de.json and en.json', () => {
    const used = usedKeys();
    assert.ok(used.length > 30, 'keys collected');
    for (const k of used) {
      assert.ok(typeof de[k] === 'string' && de[k].length, `de.json has ${k}`);
      assert.ok(typeof en[k] === 'string' && en[k].length, `en.json has ${k}`);
    }
  });

  it('de.json and en.json carry identical hsts.* key sets with matching placeholders', () => {
    assert.deepEqual(pick(de).sort(), pick(en).sort());
    assert.ok(pick(de).length >= 40);
    for (const k of pick(de)) {
      const ph = (s) => (s.match(/\{\{\w+\}\}/g) || []).sort().join();
      assert.equal(ph(de[k]), ph(en[k]), `${k}: same {{placeholders}}`);
    }
  });

  it('the hsts.* block is one contiguous tail of both files (contract: "am Ende")', () => {
    for (const [name, loc] of [['de', de], ['en', en]]) {
      const keys = Object.keys(loc);
      const first = keys.findIndex((k) => k.startsWith('hsts.'));
      assert.ok(first > 0, `${name}: block present`);
      for (let i = first; i < keys.length; i++) assert.ok(keys[i].startsWith('hsts.'), `${name}: ${keys[i]} inside the tail block`);
      assert.ok(keys[first - 1].startsWith('settings.tls.'), `${name}: appended after the TLS guard block`);
    }
  });

  it('German texts: select options and the two apply choices per contract', () => {
    assert.equal(de['hsts.age_off'], 'Aus');
    assert.equal(de['hsts.age_6m'], '6 Monate');
    assert.equal(de['hsts.age_1y'], '1 Jahr');
    assert.equal(de['hsts.age_2y'], '2 Jahre');
    assert.equal(de['hsts.apply_new_only'], 'Nur für neue Hosts');
    assert.match(de['hsts.apply_existing'], /^Auch auf \{\{n\}\} bestehende Hosts anwenden$/);
    assert.match(de['hsts.preload_warning'], /unumkehrbar/);
    assert.match(de['hsts.hint_cert'], /gültiges Zertifikat/);
  });
});

describe('HSTS: styles', () => {
  it('each theme stylesheet has exactly one appended hs- section after the tg- section', () => {
    for (const f of ['app.css', 'pro.css', 'aurora.css']) {
      const css = read('public/css/' + f);
      const marker = '/* ─── HSTS (hs-) ─── */';
      const at = css.indexOf(marker);
      assert.ok(at > 0, `${f}: section marker`);
      assert.equal(css.indexOf(marker, at + 1), -1, `${f}: only once`);
      assert.doesNotMatch(css.slice(0, at), /\.hs-/, `${f}: no hs- rules before the section`);
      const tg = css.indexOf('/* ─── TLS guard (tg-) ─── */');
      assert.ok(tg > 0 && tg < at, `${f}: appended after the tg- section`);
      assert.equal(css.indexOf('/* ─── ', at + 1), -1, `${f}: hs- is the last section`);
      // Every block before the marker is closed — an unclosed @media would
      // swallow the appended sections (happened with the zn-disc- block).
      const before = css.slice(0, at).replace(/\/\*[\s\S]*?\*\//g, '');
      assert.equal((before.match(/\{/g) || []).length, (before.match(/\}/g) || []).length, `${f}: braces balanced before the hs- section`);
      const whole = css.replace(/\/\*[\s\S]*?\*\//g, '');
      assert.equal((whole.match(/\{/g) || []).length, (whole.match(/\}/g) || []).length, `${f}: braces balanced overall`);
    }
    for (const f of ['app.css', 'pro.css']) {
      const css = read('public/css/' + f);
      for (const cls of ['.zn-panel.hs-panel4', '.hs-fields', '.hs-check', '.tag.hs-entry-tag', '.hs-warn', '.hs-radios', '.hs-editor-block.hs-locked', '.hs-editor-fields', '.hs-dialog-body', '.hs-preview']) {
        assert.ok(css.includes(cls), `${f}: ${cls}`);
      }
      assert.match(css, /@media \(max-width: 900px\) \{[^}]*\.zn-panel\.hs-panel4 \{ grid-template-columns: 1fr; \}/, `${f}: single column on phones`);
    }
  });
});
