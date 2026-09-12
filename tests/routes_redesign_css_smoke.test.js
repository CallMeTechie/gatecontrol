'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const aurora = fs.readFileSync('public/css/aurora.css', 'utf8');

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

// Negativ-Assertion (Lehre css_smoke): Redesign darf NICHT in Default/Pro leaken.
test('default/pro css untouched by aurora routes classes', () => {
  for (const f of ['public/css/app.css', 'public/css/pro.css']) {
    assert.ok(!fs.readFileSync(f, 'utf8').includes('.aurora-routes-'), `${f} leaked .aurora-routes-*`);
  }
});
