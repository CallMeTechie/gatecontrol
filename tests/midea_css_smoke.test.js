'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('midea.css exists and defines scoped component + modal classes', () => {
  const css = fs.readFileSync('public/css/midea.css', 'utf8');
  for (const sel of ['.midea-page .ac-grid', '.midea-page .kpi-strip', '.midea-page .kpi', '.midea-page .ac-ring', '.midea-modal .pick-row', '.av-accent']) {
    assert.ok(css.includes(sel), `midea.css missing ${sel}`);
  }
});

// midea.css stays a page-local stylesheet (docs/feature-wave2.md §W2): it
// declares unscoped generic selectors (.avatar, .av-*) that must not go global.
test('app.css defines the --purple-bd alias midea.css builds on', () => {
  const css = fs.readFileSync('public/css/app.css', 'utf8');
  assert.ok(/--purple-bd\s*:/.test(css), 'app.css missing --purple-bd alias');
});

test('midea.css is linked (page-scoped) in all 3 midea pages', () => {
  for (const theme of ['aurora']) {
    const page = fs.readFileSync(`templates/${theme}/pages/midea.njk`, 'utf8');
    assert.ok(page.includes('/css/midea.css'), `${theme}/pages/midea.njk does not link midea.css`);
  }
});
