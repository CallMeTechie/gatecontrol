'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

test('portal.njk has the climate (Midea) list in "Zuhause", gated by tabs.midea', () => {
  const njk = fs.readFileSync('templates/portal/portal.njk', 'utf8');
  assert.ok(njk.includes('{% if tabs.midea %}'), 'missing tabs.midea gate');
  assert.ok(njk.includes('id="pt-midea"') && njk.includes('data-area="midea"'), 'missing midea container');
  const route = fs.readFileSync('src/routes/portal.js', 'utf8');
  assert.match(route, /w\.midea && license\.hasFeature\('midea_integration'\)/);
});
test('the midea client keys exist in de and en', () => {
  for (const k of ['portal.control.login_hint', 'portal.midea.offline', 'portal.midea.mode_auto', 'portal.midea.power_name', 'portal.midea.power_on', 'portal.midea.power_off', 'portal.midea.fan_auto_btn']) {
    assert.ok(de[k] && en[k], k);
  }
});
test('portal.css defines the climate card styles', () => {
  const css = fs.readFileSync('public/css/portal.css', 'utf8');
  for (const s of ['.pt-ac', '.pt-stepper', '.pt-fan', '.pt-ac-mini']) assert.ok(css.includes(s), s);
});
test('portal.js climate card renders fan slider + auto/turbo/eco chips + outdoor + modes', () => {
  const src = fs.readFileSync('public/js/portal.js', 'utf8');
  for (const m of ["'data-act': 'fan'", "'data-act': 'fan-auto'", "'data-act': 'turbo'", "'data-act': 'eco'", "'portal.midea.outside'", "'data-mode': m"]) {
    assert.ok(src.includes(m), `portal.js missing marker ${m}`);
  }
});
