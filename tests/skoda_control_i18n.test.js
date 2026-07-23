'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

const KEYS = ['skoda.cmd.ac_on','skoda.cmd.ac_off','skoda.cmd.charge_on','skoda.cmd.charge_off','skoda.cmd.window_heat_on','skoda.cmd.window_heat_off','skoda.cmd.lock','skoda.cmd.unlock','skoda.cmd.set_temp','skoda.cmd.set_limit','skoda.cmd.confirm_unlock','skoda.cmd.running','skoda.cmd.failed','skoda.cmd.spin','skoda.cmd.spin_set'];

test('skoda.cmd.* keys exist in de and en', () => {
  for (const k of KEYS) { assert.ok(de[k] && de[k].trim(), `de ${k}`); assert.ok(en[k] && en[k].trim(), `en ${k}`); }
});
test('all three layouts carry the skoda.cmd.* GC.t whitelist', () => {
  for (const theme of ['aurora','default','pro']) {
    const layout = fs.readFileSync(path.join(__dirname,'..','templates',theme,'layout.njk'),'utf8');
    for (const k of KEYS) assert.ok(layout.includes(`'${k}'`), `${theme} ${k}`);
  }
});

test('skoda.js wires command buttons to the admin command endpoint', () => {
  const js = fs.readFileSync(path.join(__dirname,'..','public','js','skoda.js'),'utf8');
  assert.match(js, /function command/);
  assert.match(js, /\/vehicles\/.*\/command/);
  assert.match(js, /data-cmd/);
});
