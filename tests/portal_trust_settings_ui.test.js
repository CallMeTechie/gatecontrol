'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
test('trust toggle + help present in the Portal section', () => {
  const html = fs.readFileSync(path.join(__dirname,'..','templates','aurora','pages','settings.njk'),'utf8');
  assert.ok(html.includes("switchRow('st-po-trust', 'po-trust'"), 'toggle row');
  assert.ok(html.includes('settings.portal.trust_owner_mapping'), 'label key');
  assert.ok(html.includes('settings.portal.trust_owner_mapping_help'), 'help key');
});
test('settings.js saves the trust toggle with the portal group (PUT trust_owner_mapping)', () => {
  const js = fs.readFileSync(path.join(__dirname,'..','public','js','settings.js'),'utf8');
  assert.match(js, /trust_owner_mapping: 'po-trust'/);
  assert.match(js, /'po-trust': !!d\.trustOwnerMapping/);
});
