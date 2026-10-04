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
const APP_CSS = read('public/css/app.css');
// Dashboard redesign: the problems list is part of dashboard.js and of the
// db- block in the Aurora section (§2) of app.css.
const DB_CSS = (() => {
  const a = APP_CSS.indexOf('DASHBOARD REDESIGN (db-)');
  const b = APP_CSS.indexOf('\n * \u00a73 ');
  return APP_CSS.slice(a, b);
})();
const PR_JS = read('public/js/dashboard.js');
const ROUTES = read('src/routes/index.js');

describe('S3: stylesheet and scripts', () => {
  it('the layout links app.css exactly once and nothing else', () => {
    const links = Array.from(LAYOUT.matchAll(/<link rel="stylesheet" href="([^"?]+)/g)).map((m) => m[1]);
    assert.deepEqual(links, ['/css/app.css']);
  });

  it('the problem rows are styled in the db- block of the Aurora section; braces balance', () => {
    const aurora = APP_CSS.indexOf('\n * \u00a72 ');
    const dbAt = APP_CSS.indexOf('DASHBOARD REDESIGN (db-)');
    assert.ok(aurora > 0 && dbAt > aurora && dbAt < APP_CSS.indexOf('\n * \u00a73 '), 'db- block inside §2');
    assert.match(DB_CSS, /\.db-prow\{/);
    assert.match(DB_CSS, /\.db-problems\{/);
    assert.doesNotMatch(APP_CSS.replace(/\/\*[\s\S]*?\*\//g, ''), /\.pr-(row|card|link)\b/, 'old pr- rules are gone');
    const whole = APP_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal((whole.match(/\{/g) || []).length, (whole.match(/\}/g) || []).length, 'app.css braces balanced');
  });

  it('dashboard-ui.js loads before dashboard.js; the old problems script is gone', () => {
    const u = DASH_TPL.indexOf('/js/dashboard-ui.js');
    const d = DASH_TPL.indexOf('/js/dashboard.js');
    assert.ok(u > 0 && d > u, 'dashboard-ui.js before dashboard.js');
    assert.ok(!DASH_TPL.includes('dashboard-problems.js'));
    assert.ok(!fs.existsSync(path.join(ROOT, 'public/js/dashboard-problems.js')));
  });

  it('no innerHTML in the new code', () => {
    assert.doesNotMatch(stripComments(PR_JS), /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
    assert.doesNotMatch(stripComments(read('public/js/dashboard-ui.js')), /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  });

  it('the problems section carries its DOM hooks and starts hidden', () => {
    for (const id of ['dash-problems', 'dash-problems-list', 'dash-problems-count',
      'dash-problems-hint', 'dash-problems-ondemand', 'dash-problems-ondemand-list']) {
      assert.ok(DASH_TPL.includes(`id="${id}"`), `#${id} in dashboard.njk`);
    }
    assert.match(DASH_TPL, /<section class="db-card db-problems" id="dash-problems" hidden/);
  });

  it('the section refreshes on the existing SSE types', () => {
    for (const ev of ['gc:gateway', 'gc:monitor', 'gc:tls', 'gc:backup', 'gc:routes', 'gc:security', 'gc:reconnected']) {
      assert.ok(PR_JS.includes(`'${ev}'`), ev);
    }
    // every SSE type that touches problems reloads the problems job
    const map = PR_JS.slice(PR_JS.indexOf('var SSE = {'), PR_JS.indexOf('};', PR_JS.indexOf('var SSE = {')));
    for (const ev of ['gc:gateway', 'gc:monitor', 'gc:tls', 'gc:backup', 'gc:routes', 'gc:security']) {
      assert.match(map, new RegExp(`'${ev}': \\[[^\\]]*'problems'`), ev);
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

  it('the strings reach the script through the JSON island of the page (dashboard.* + problems.*)', () => {
    assert.match(DASH_TPL, /<script type="application\/json" id="db-i18n" data-prefixes="dashboard\. problems\." nonce="\{\{ cspNonce \}\}">\{\{ dashI18n/);
    assert.match(ROUTES, /stringsWithPrefix\(req\.language \|\| res\.locals\.language, \['dashboard\.', 'problems\.'\]\)/);
    assert.ok(!LAYOUT.includes("'problems.title'"), 'problems.* left the global GC.t whitelist');
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
