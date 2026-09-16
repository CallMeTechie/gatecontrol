'use strict';

// Wave 2, strand W2 (docs/feature-wave2.md §W2 "Ein Stylesheet"): pro.css,
// aurora.css, security.css, nav.css, ops.css, problems.css, l4-protect.css and
// two-factor.css are one file, public/css/app.css, in exactly the order in
// which layout.njk used to link them — so the cascade, and with it the look,
// is unchanged. portal.css keeps its own design, and midea/skoda/smarthome stay
// page-local because they declare unscoped generic selectors (.pill, .banner,
// .arrow, .avatar) that must not become global.

const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CSS_DIR = path.join(ROOT, 'public/css');
const APP = read('public/css/app.css');

// The merged sections, in order. The comment banner of each carries "§<n> ".
const SECTIONS = [
  [1, 'pro.css', ['.btn-primary', '.zn-panel', '.field-saving', '.gw-fleet']],
  [2, 'aurora.css', ['body.au-page', '.aurora-routes-kpi', '--teal']],
  [3, 'security.css', ['.lh-', '.sc-check', '.wfa-']],
  [4, 'nav.css', ['.sh-shield', '.cp-']],
  [5, 'ops.css', ['.op-']],
  [6, 'problems.css', ['.pr-row', '.pr-card']],
  [7, 'l4-protect.css', ['.gc-l4-protect']],
  [8, 'two-factor.css', ['.tf-card', '.tf-codes']],
];
const MERGED = SECTIONS.map(([, f]) => f);

function sectionAt(n) {
  const a = APP.indexOf(`\n * §${n} `);
  assert.ok(a > 0, `section §${n} banner`);
  return a;
}
function section(n) {
  const a = sectionAt(n);
  const next = APP.indexOf(`\n * §${n + 1} `);
  return APP.slice(a, next < 0 ? APP.length : next);
}

describe('app.css: one stylesheet', () => {
  it('the eight merged files are gone; app.css and the page-local sheets remain', () => {
    for (const f of MERGED) assert.equal(fs.existsSync(path.join(CSS_DIR, f)), false, f);
    const left = fs.readdirSync(CSS_DIR).sort();
    assert.deepEqual(left, ['app.css', 'midea.css', 'portal.css', 'skoda.css', 'smarthome.css'], left.join(','));
  });

  it('carries all eight sections, in the order layout.njk used to link them', () => {
    let prev = -1;
    for (const [n, file] of SECTIONS) {
      const at = sectionAt(n);
      assert.ok(at > prev, `§${n} (${file}) comes after §${n - 1}`);
      assert.ok(APP.slice(at, at + 400).includes(file), `§${n} banner names ${file}`);
      assert.equal(APP.indexOf(`\n * §${n} `, at + 1), -1, `§${n} banner appears once`);
      prev = at;
    }
  });

  it('every section still carries its own rules', () => {
    for (const [n, file, needles] of SECTIONS) {
      const css = section(n);
      for (const needle of needles) assert.ok(css.includes(needle), `§${n} (${file}) is missing ${needle}`);
    }
  });

  it('feature sections do not leak into the base or Aurora layer', () => {
    const base = section(1).replace(/\/\*[\s\S]*?\*\//g, '');
    const aurora = section(2).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const prefix of ['.op-', '.pr-row', '.pr-card', '.wfa-', '.gc-l4-protect', '.sh-shield']) {
      assert.ok(!base.includes(prefix), `base layer leaks ${prefix}`);
      assert.ok(!aurora.includes(prefix), `Aurora layer leaks ${prefix}`);
    }
  });

  it('braces balance — overall and up to the start of every section', () => {
    const balanced = (s) => {
      const t = s.replace(/\/\*[\s\S]*?\*\//g, '');
      return (t.match(/\{/g) || []).length === (t.match(/\}/g) || []).length;
    };
    assert.ok(balanced(APP), 'app.css braces balanced');
    for (const [n] of SECTIONS) assert.ok(balanced(APP.slice(0, sectionAt(n))), `braces balanced before §${n}`);
  });

  it('no leftovers of the deleted Default/Pro themes (removed in this strand)', () => {
    // Every one of these was removed because its class occurs nowhere else in
    // the repo — see the commit message for the search that proved it.
    for (const gone of ['.stat-card', '.topbar-btn', '.sidebar-nav', '.vm-card', '.peer-card', '.route-card',
      '.toolbar-search', '.activity-item', '.app-layout', '.toggle-slider', '.status-dot', '.gw-setup']) {
      assert.ok(!APP.includes(gone + ' ') && !APP.includes(gone + '{') && !APP.includes(gone + ','), `${gone} still styled`);
    }
  });
});

describe('app.css: templates link it exactly once', () => {
  const pages = fs.readdirSync(path.join(ROOT, 'templates/aurora/pages'));

  it('layout.njk links app.css and nothing else', () => {
    const links = Array.from(read('templates/aurora/layout.njk').matchAll(/<link rel="stylesheet" href="([^"?]+)/g)).map((m) => m[1]);
    assert.deepEqual(links, ['/css/app.css']);
  });

  it('no template links a merged-away stylesheet', () => {
    const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
      .flatMap((d) => (d.isDirectory() ? walk(dir + '/' + d.name) : [dir + '/' + d.name]));
    for (const f of walk('templates').filter((x) => x.endsWith('.njk'))) {
      for (const m of MERGED) assert.ok(!read(f).includes('/css/' + m), `${f} links ${m}`);
    }
  });

  it('standalone pages link app.css once; pages that extend the layout add at most an integration sheet', () => {
    for (const f of pages) {
      const src = read('templates/aurora/pages/' + f);
      const links = Array.from(src.matchAll(/<link rel="stylesheet" href="([^"?]+)/g)).map((m) => m[1]);
      if (/\{% extends/.test(src)) {
        assert.ok(links.every((l) => /\/(midea|skoda|smarthome)\.css$/.test(l)), `${f}: ${links.join(',')}`);
        assert.ok(links.length <= 1, `${f}: at most one page-local sheet`);
      } else {
        assert.equal(links.length, 1, `${f}: ${links.join(',')}`);
        assert.match(links[0], /\/css\/app\.css$/, f);
      }
    }
  });

  it('the portal keeps its own stylesheet', () => {
    const links = Array.from(read('templates/portal/portal.njk').matchAll(/<link rel="stylesheet" href="([^"?]+)/g)).map((m) => m[1]);
    assert.deepEqual(links, ['/css/portal.css']);
  });
});
