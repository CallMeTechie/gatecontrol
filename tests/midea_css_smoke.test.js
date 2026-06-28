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

test('aurora.css defines the --purple-bd alias', () => {
  const css = fs.readFileSync('public/css/aurora.css', 'utf8');
  assert.ok(/--purple-bd\s*:/.test(css), 'aurora.css missing --purple-bd alias');
});
