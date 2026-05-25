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
test('setup_* keys present in en+de + both layout GC.t blocks', () => {
  const dflt = fs.readFileSync('templates/default/layout.njk','utf8');
  const pro = fs.readFileSync('templates/pro/layout.njk','utf8');
  for (const k of SETUP_KEYS) {
    assert.ok(k in en, 'missing en: '+k); assert.ok(k in de, 'missing de: '+k);
    assert.ok(dflt.includes("'"+k+"':"), 'missing in default layout GC.t: '+k);
    assert.ok(pro.includes("'"+k+"':"), 'missing in pro layout GC.t: '+k);
  }
});
