'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const en = require('../src/i18n/en.json');
const de = require('../src/i18n/de.json');
const KEYS = ['gateways.update_confirm','gateways.update_requested','gateways.update_running','gateways.update_done','gateways.update_failed','gateways.update_unknown','gateways.update_dismiss','gateways.update_cooldown','gateways.update_not_migrated','gateways.release_notes','gateways.lbl_image_digest','gateways.lbl_last_pull','gateways.last_pull_never'];
test('all new gateway update keys exist in en + de', () => {
  for (const k of KEYS) { assert.ok(k in en, 'missing en: '+k); assert.ok(k in de, 'missing de: '+k); }
});

const SETUP_KEYS = ['gateways.setup_title','gateways.setup_note','gateways.setup_done','gateways.setup_pending','gateways.setup_download_update','gateways.setup_guide','gateways.setup_synology','gateways.setup_linux','gateways.setup_syn_1','gateways.setup_syn_2','gateways.setup_lin_1','gateways.setup_lin_2','gateways.setup_legacy_hint'];
test('setup_* keys present in en+de + the layout GC.t block', () => {
  const layout = fs.readFileSync('templates/aurora/layout.njk','utf8');
  for (const k of SETUP_KEYS) {
    assert.ok(k in en, 'missing en: '+k); assert.ok(k in de, 'missing de: '+k);
    assert.ok(layout.includes("'"+k+"':"), 'missing in the layout GC.t: '+k);
  }
});

const AU_ROLLBACK_KEYS = ['autoupdate.rolled_back', 'autoupdate.rolled_back_hint', 'autoupdate.rollback_failed'];
test('auto-update rollback keys present in en+de + the layout GC.t block', () => {
  const layouts = ['aurora'].map((t) => fs.readFileSync(`templates/${t}/layout.njk`, 'utf8'));
  for (const k of AU_ROLLBACK_KEYS) {
    assert.ok(k in en, 'missing en: ' + k); assert.ok(k in de, 'missing de: ' + k);
    for (const l of layouts) assert.ok(l.includes("'" + k + "':"), 'missing in a layout GC.t: ' + k);
  }
  assert.ok(en['autoupdate.rolled_back'].includes('{x}') && de['autoupdate.rolled_back'].includes('{x}'));
});
