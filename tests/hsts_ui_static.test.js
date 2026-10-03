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
const THEMES = ['aurora']; // Aurora is the only theme (docs/feature-aurora-only.md)

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// Wave 2 §W2 (docs/feature-wave2.md): one stylesheet. §1 of public/css/app.css
// is the former pro.css (base layer), §2 the former aurora.css.
const APP_CSS = read('public/css/app.css');
const APP_LAYERS = [['app.css §1 (base)', 1], ['app.css §2 (Aurora)', 2]];
function appSection(n) {
  const a = APP_CSS.indexOf(`\n * \u00a7${n} `);
  assert.ok(a > 0, `app.css section \u00a7${n}`);
  const b = APP_CSS.indexOf(`\n * \u00a7${n + 1} `);
  return APP_CSS.slice(a, b < 0 ? APP_CSS.length : b);
}

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const hasId = (html, id) => html.includes('id="' + id + '"');

const EDITOR_IDS = ['edit-hsts-block', 'edit-route-hsts', 'edit-route-hsts-max-age', 'edit-route-hsts-subdomains', 'edit-route-hsts-preload', 'edit-hsts-fields', 'edit-hsts-hint', 'edit-headers-hsts-hint'];
const EDITOR_DATA = ['data-hint-https', 'data-hint-preload', 'data-preload-confirm', 'data-err-preload-requirements', 'data-err-requires-https', 'data-err-max-age-invalid'];
// Classes the browser scenario and the scripts rely on (built at runtime by hsts-ui.js).
const RUNTIME_CLASSES = ['hs-dialog', 'hs-btn-ok', 'hs-warn', 'hs-confirm-cb', 'hs-age', 'hs-sub', 'hs-preload'];

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

  it('hsts-ui.js exposes the contract API and builds DOM without innerHTML', () => {
    const src = stripComments(read('public/js/hsts-ui.js'));
    for (const f of ['headerValue', 'labelFor', 'fieldsEl', 'confirmPreload', 'fromZone']) {
      assert.match(src, new RegExp('\\b' + f + '\\b'), f);
    }
    // The per-entry tag/dialog and the head control of the former domain
    // modal are gone: HSTS is edited in the entry editor ("Sicherheit") and
    // the zone default in "Domain-Einstellungen".
    for (const f of ['entryTag', 'openEntryDialog', 'defaultsControl', 'openApplyDialog']) {
      assert.doesNotMatch(src, new RegExp('\\b' + f + '\\b'), f + ' removed');
    }
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    for (const cls of RUNTIME_CLASSES) assert.ok(src.includes(cls), 'class ' + cls);
    assert.match(src, /zones-i18n/, 'reads the zones island');
    for (const code of H.ERROR_CODES) assert.ok(src.includes(code), code);
  });

  it('domain-modal.js: HSTS default in "Domain-Einstellungen" with preload confirmation and one apply checkbox', () => {
    const dm = stripComments(read('public/js/domain-modal.js'));
    assert.match(dm, /H\.fromZone\(zone\)/);
    assert.match(dm, /H\.fieldsEl\(/);
    assert.match(dm, /H\.confirmPreload\(\)\.then/);
    assert.match(dm, /body\.hsts_default = /);
    assert.match(dm, /body\.apply_hsts_to_existing = true/);
    assert.match(dm, /window\.GCHstsUI/, 'guards the absence of hsts-ui.js');
  });

  it('zones-view.js adds the HSTS note; the page renders it on the entry line', () => {
    assert.match(stripComments(read('public/js/zones-view.js')), /id: 'hsts'/);
    assert.match(read('public/js/zones-page.js'), /n\.id === 'hsts'\) return 'HSTS'/);
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
    assert.ok(used.length > 15, 'keys collected');
    for (const k of used) {
      assert.ok(typeof de[k] === 'string' && de[k].length, `de.json has ${k}`);
      assert.ok(typeof en[k] === 'string' && en[k].length, `en.json has ${k}`);
    }
  });

  it('de.json and en.json carry identical hsts.* key sets with matching placeholders', () => {
    assert.deepEqual(pick(de).sort(), pick(en).sort());
    assert.ok(pick(de).length >= 20);
    for (const k of pick(de)) {
      const ph = (s) => (s.match(/\{\{\w+\}\}/g) || []).sort().join();
      assert.equal(ph(de[k]), ph(en[k]), `${k}: same {{placeholders}}`);
    }
  });

  it('the hsts.* block is one contiguous block in both files', () => {
    // Contract: the block stays CONTIGUOUS and identical in de/en. Its former
    // "at the end of the file" clause was dropped once several feature blocks
    // (problems.*, entry.*, l4p.* …) shared the tail — see
    // docs/feature-next-package.md.
    for (const [nm, loc] of [['de', de], ['en', en]]) {
      const keys = Object.keys(loc);
      const idx = keys.map((k, i) => (/^hsts\./.test(k) ? i : -1)).filter((i) => i >= 0);
      assert.ok(idx.length > 0, `${nm}: block present`);
      assert.equal(idx[idx.length - 1] - idx[0], idx.length - 1, `${nm}: block is contiguous`);
    }
  });

  it('German texts: select options and the preload warning per contract', () => {
    assert.equal(de['hsts.age_off'], 'Aus');
    assert.equal(de['hsts.age_6m'], '6 Monate');
    assert.equal(de['hsts.age_1y'], '1 Jahr');
    assert.equal(de['hsts.age_2y'], '2 Jahre');
    assert.match(de['hsts.preload_warning'], /unumkehrbar/);
  });
});

describe('HSTS: styles', () => {
  it('app.css §1 / §2 each have exactly one hs- section after the tg- section', () => {
    for (const [f, n] of APP_LAYERS) {
      const css = appSection(n);
      const marker = '/* ─── HSTS (hs-) ─── */';
      const at = css.indexOf(marker);
      assert.ok(at > 0, `${f}: section marker`);
      assert.equal(css.indexOf(marker, at + 1), -1, `${f}: only once`);
      assert.doesNotMatch(css.slice(0, at), /\.hs-/, `${f}: no hs- rules before the section`);
      const tg = css.indexOf('/* ─── TLS guard (tg-) ─── */');
      assert.ok(tg > 0 && tg < at, `${f}: appended after the tg- section`);
      // Only the security-options section (docs/feature-security-options.md) may follow.
      const next = css.indexOf('/* ─── ', at + 1);
      assert.ok(next === -1 || css.startsWith('/* ─── Security options (so-) ─── */', next), `${f}: hs- is the last section before so-`);
      // Every block before the marker is closed — an unclosed @media would
      // swallow the appended sections (happened with the zn-disc- block).
      const before = css.slice(0, at).replace(/\/\*[\s\S]*?\*\//g, '');
      assert.equal((before.match(/\{/g) || []).length, (before.match(/\}/g) || []).length, `${f}: braces balanced before the hs- section`);
      const whole = css.replace(/\/\*[\s\S]*?\*\//g, '');
      assert.equal((whole.match(/\{/g) || []).length, (whole.match(/\}/g) || []).length, `${f}: braces balanced overall`);
    }
    for (const f of ['app.css §1 (base)']) {
      const css = appSection(1);
      for (const cls of ['.hs-fields', '.hs-check', '.hs-warn', '.hs-editor-block.hs-locked', '.hs-editor-fields', '.hs-dialog-body']) {
        assert.ok(css.includes(cls), `${f}: ${cls}`);
      }
    }
  });
});
