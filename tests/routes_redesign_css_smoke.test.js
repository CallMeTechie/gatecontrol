'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Wave 2 §W2: one stylesheet — §1 is the former pro.css, §2 the former aurora.css.
const APP_CSS = fs.readFileSync('public/css/app.css', 'utf8');
const appSection = (n) => APP_CSS.slice(APP_CSS.indexOf(`\n * \u00a7${n} `), APP_CSS.indexOf(`\n * \u00a7${n + 1} `) < 0 ? APP_CSS.length : APP_CSS.indexOf(`\n * \u00a7${n + 1} `));
const aurora = appSection(2);

// The zones page (aurora) fills #zn-kpis with .aurora-routes-kpi items.
test('aurora.css defines the routes KPI strip classes', () => {
  for (const cls of ['.aurora-routes-kpis', '.aurora-routes-kpi']) {
    assert.ok(aurora.includes(cls), `aurora.css missing ${cls}`);
  }
});

test('coral bg/bd tokens exist in dark AND light theme blocks', () => {
  const dark = aurora.slice(aurora.indexOf('[data-theme="dark"]'), aurora.indexOf('[data-theme="light"]'));
  const light = aurora.slice(aurora.indexOf('[data-theme="light"]'));
  for (const tok of ['--coral-bg', '--coral-bd']) {
    assert.ok(dark.includes(tok), `dark theme missing ${tok}`);
    assert.ok(light.includes(tok), `light theme missing ${tok}`);
  }
});

// Negativ-Assertion (Lehre css_smoke): die Aurora-Klassen gehören in den
// Aurora-Abschnitt (§2) von app.css, nicht in den Basis-Abschnitt (§1).
test('the base section (former pro.css) is untouched by the Aurora routes classes', () => {
  assert.ok(!appSection(1).includes('.aurora-routes-'), 'app.css §1 leaked .aurora-routes-*');
});
