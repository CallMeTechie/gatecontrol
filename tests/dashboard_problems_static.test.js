'use strict';

// Static contract of strand S3 (docs/feature-next-package.md §S3): the new
// stylesheet is its own file and linked once, the dashboard carries the DOM
// hooks, the editor carries the name field and the switch, the client strings
// are in the window.GC.t whitelist, and the i18n block sits before the waf.*
// block (which stays last).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');
const LAYOUT = read('templates/aurora/layout.njk');
const DASH_TPL = read('templates/aurora/pages/dashboard.njk');
const EDITOR_TPL = read('templates/aurora/partials/modals/route-edit.njk');
const PR_CSS = read('public/css/problems.css');
const PR_JS = read('public/js/dashboard-problems.js');

describe('S3: stylesheet and scripts', () => {
  it('problems.css is linked exactly once, after aurora.css among the feature stylesheets', () => {
    const links = Array.from(LAYOUT.matchAll(/<link rel="stylesheet" href="([^"?]+)/g)).map((m) => m[1]);
    assert.equal(links.filter((l) => l === '/css/problems.css').length, 1);
    const a = links.indexOf('/css/aurora.css');
    const p = links.indexOf('/css/problems.css');
    assert.ok(p > a, 'after aurora.css');
    assert.ok(links.slice(a + 1, p).every((l) => /^\/css\/[a-z-]+\.css$/.test(l)), 'only feature stylesheets in between');
  });

  it('aurora.css is untouched by this strand (no pr- rules); problems.css braces balance', () => {
    assert.doesNotMatch(read('public/css/aurora.css'), /\.pr-row|\.pr-card/);
    assert.equal((PR_CSS.match(/\{/g) || []).length, (PR_CSS.match(/\}/g) || []).length);
  });

  it('dashboard-problems.js loads after dashboard.js', () => {
    const d = DASH_TPL.indexOf('/js/dashboard.js');
    const p = DASH_TPL.indexOf('/js/dashboard-problems.js');
    assert.ok(d > 0 && p > d, 'dashboard-problems.js after dashboard.js');
  });

  it('no innerHTML in the new code', () => {
    assert.doesNotMatch(stripComments(PR_JS), /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  });

  it('the problems section carries its DOM hooks and starts hidden', () => {
    for (const id of ['dash-problems', 'dash-problems-list', 'dash-problems-count',
      'dash-problems-hint', 'dash-problems-ondemand', 'dash-problems-ondemand-list']) {
      assert.ok(DASH_TPL.includes(`id="${id}"`), `#${id} in dashboard.njk`);
    }
    assert.match(DASH_TPL, /<section class="card pr-card" id="dash-problems" hidden/);
  });

  it('the section refreshes on the existing SSE types', () => {
    for (const ev of ['gc:gateway', 'gc:monitor', 'gc:tls', 'gc:backup', 'gc:routes', 'gc:security', 'gc:reconnected']) {
      assert.ok(PR_JS.includes(`'${ev}'`), ev);
    }
  });

  it('the entry editor carries the name field and the "nur bei Bedarf" switch', () => {
    assert.match(EDITOR_TPL, /id="edit-route-label"/);
    assert.match(EDITOR_TPL, /id="edit-route-on-demand"/);
    assert.match(EDITOR_TPL, /id="edit-route-on-demand-wol"/);
    const editor = read('public/js/entry-editor.js');
    assert.match(editor, /label: label,/, 'the PUT body carries the name');
    assert.match(editor, /on_demand: isOn\('edit-route-on-demand'\)/);
  });
});

describe('S3: i18n', () => {
  const keysOf = (src) => Array.from(new Set(Array.from(src.matchAll(/'(problems\.[a-z0-9_.]+)'/g)).map((m) => m[1])));

  it('every problems.* string the script uses exists in both languages', () => {
    const keys = keysOf(PR_JS);
    assert.ok(keys.length > 20, `${keys.length} keys`);
    for (const k of keys) {
      assert.ok(typeof de[k] === 'string' && de[k].length, `de.json has ${k}`);
      assert.ok(typeof en[k] === 'string' && en[k].length, `en.json has ${k}`);
    }
  });

  it('every client string is in the window.GC.t whitelist', () => {
    for (const k of keysOf(PR_JS).concat(['entry.on_demand_tag'])) {
      assert.ok(LAYOUT.includes(`'${k}': {{ t('${k}')`), `layout.njk exposes ${k}`);
    }
  });

  it('de and en carry the same problems.* keys with the same placeholders', () => {
    const pick = (o) => Object.keys(o).filter((k) => k.startsWith('problems.')).sort();
    assert.deepEqual(pick(de), pick(en));
    const ph = (s) => (s.match(/\{\{\w+\}\}/g) || []).sort().join();
    for (const k of pick(de)) assert.equal(ph(de[k]), ph(en[k]), k);
  });

  it('the new block sits before the waf.* block, which stays last', () => {
    for (const f of ['src/i18n/de.json', 'src/i18n/en.json']) {
      const lines = read(f).split('\n');
      const lastWaf = lines.reduce((acc, l, i) => (l.trimStart().startsWith('"waf.') ? i : acc), -1);
      const lastProblems = lines.reduce((acc, l, i) => (l.trimStart().startsWith('"problems.') ? i : acc), -1);
      const firstWaf = lines.findIndex((l) => l.trimStart().startsWith('"waf.'));
      assert.ok(lastProblems > 0 && lastProblems < firstWaf, `${f}: problems.* before the waf.* block`);
      // Nothing but the closing brace after the last waf.* line.
      assert.equal(lines.slice(lastWaf + 1).filter((l) => l.trim() && l.trim() !== '}').length, 0, `${f}: waf.* block is last`);
    }
  });
});
