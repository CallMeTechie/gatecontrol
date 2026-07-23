'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');
const KEYS = ['portal.skoda.cmd_ac_on','portal.skoda.cmd_ac_off','portal.skoda.cmd_set_temp','portal.skoda.cmd_charge_on','portal.skoda.cmd_charge_off','portal.skoda.cmd_charge_limit','portal.skoda.cmd_window_heat','portal.skoda.cmd_window_heat_off','portal.skoda.cmd_lock','portal.skoda.cmd_unlock','portal.skoda.cmd_confirm_unlock','portal.skoda.cmd_running','portal.skoda.cmd_failed'];
const PT = ['skodaCmdAcOn','skodaCmdAcOff','skodaCmdSetTemp','skodaCmdChargeOn','skodaCmdChargeOff','skodaCmdChargeLimit','skodaCmdWindowHeat','skodaCmdWindowHeatOff','skodaCmdLock','skodaCmdUnlock','skodaCmdConfirmUnlock','skodaCmdRunning','skodaCmdFailed'];

test('portal.skoda.cmd_* keys in de and en', () => {
  for (const k of KEYS) { assert.ok(de[k] && de[k].trim(), `de ${k}`); assert.ok(en[k] && en[k].trim(), `en ${k}`); }
});
test('portal.njk PT block + portal.js command wiring, gated on loggedIn', () => {
  const njk = fs.readFileSync(path.join(__dirname,'..','templates','portal','portal.njk'),'utf8');
  for (const k of PT) assert.ok(njk.includes(k), `njk ${k}`);
  const js = fs.readFileSync(path.join(__dirname,'..','public','js','portal.js'),'utf8');
  assert.match(js, /skodaCommand/);
  assert.match(js, /\/api\/v1\/portal\/skoda\/vehicles\//);
  assert.match(js, /loggedIn/); // buttons only when logged in
});
