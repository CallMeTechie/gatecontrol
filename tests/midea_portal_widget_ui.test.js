'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('portal.njk has the midea widget block, gated by widgets.midea', () => {
  const njk = fs.readFileSync('templates/portal/portal.njk', 'utf8');
  assert.ok(njk.includes('{% if widgets.midea %}'), 'missing widgets.midea gate');
  assert.ok(njk.includes('c-midea'), 'missing c-midea section');
  assert.ok(njk.includes('id="midea-list"'), 'missing midea-list container');
});
test('portal-i18n block carries the midea client keys', () => {
  const njk = fs.readFileSync('templates/portal/portal.njk', 'utf8');
  for (const k of ['mideaLoginToControl', 'mideaOffline', 'mideaModeAuto', 'mideaPower', 'mideaUnavailable', 'mideaPowerOn', 'mideaPowerOff']) {
    assert.ok(njk.includes(k), `portal-i18n missing ${k}`);
  }
});
test('portal.css defines .c-midea styles', () => {
  const css = fs.readFileSync('public/css/portal.css', 'utf8');
  assert.ok(css.includes('.c-midea'), 'portal.css missing .c-midea');
});
