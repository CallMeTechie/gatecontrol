'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const tpl = fs.readFileSync('templates/aurora/pages/routes.njk', 'utf8');

test('aurora routes template has kpi container + exposure toggle + aria-pressed', () => {
  assert.ok(tpl.includes('id="routes-kpis"'), 'missing #routes-kpis');
  assert.ok(tpl.includes('id="aurora-exposure-toggle"'), 'missing #aurora-exposure-toggle');
  assert.ok(tpl.includes('data-value="external"'), 'missing external option');
  assert.ok(tpl.includes('data-value="internal"'), 'missing internal option');
  assert.ok(tpl.includes('aria-pressed'), 'toggle buttons missing aria-pressed');
  // erhaltene Kontrakte (alle 10 spec-verbindlichen IDs)
  for (const id of ['routes-list', 'routes-count', 'routes-subtitle', 'route-search',
    'aurora-type-toggle', 'aurora-collapse-all', 'btn-batch-routes',
    'btn-add-service', 'btn-add-route', 'open-printer-preset']) {
    assert.ok(tpl.includes(`id="${id}"`), `lost #${id}`);
  }
});

// Marker: Aurora-JS-Pfad rendert das Grid (fängt Zurückfallen auf die Tabelle).
test('routes.js aurora path renders card grid', () => {
  const js = fs.readFileSync('public/js/routes.js', 'utf8');
  assert.ok(js.includes('aurora-routes-grid'), 'routes.js missing aurora-routes-grid marker');
});
