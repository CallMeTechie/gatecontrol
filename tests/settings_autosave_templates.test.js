'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const THEMES = ['aurora', 'default', 'pro'];

// IDs confirmed REMOVED across all three themes (verified by grep before writing this test).
// btn-ip2location-save is intentionally KEPT in all themes — it is an action button whose
// "save key" flow was kept in scope (only a clear button was added in T4/T7), so it is
// NOT listed here.
const SAVE_IDS = [
  'btn-dns-save',
  'btn-data-save',
  'btn-route-block-save',
  'btn-security-save',
  'btn-password-save',
  'mb-save',
  'btn-autobackup-save',
  'btn-smtp-save',
  'btn-alerts-save',
  'btn-monitoring-save',
  'btn-metrics-save',
  'au-mode-save',
  'st-save',
  'btn-pihole-save',
  'btn-portal-save',
];

test('all three themes: autosave scripts present before settings.js, no migrated save buttons remain', () => {
  for (const theme of THEMES) {
    const f = path.join(__dirname, '..', 'templates', theme, 'pages', 'settings.njk');
    const html = fs.readFileSync(f, 'utf8');

    const coreIdx = html.indexOf('settingsAutosaveCore.js');
    const ctrlIdx = html.indexOf('settingsAutosave.js');
    const mainIdx = html.indexOf('/js/settings.js');

    assert.ok(coreIdx > -1, `${theme}: settingsAutosaveCore.js not found`);
    assert.ok(ctrlIdx > -1, `${theme}: settingsAutosave.js not found`);
    assert.ok(mainIdx > -1, `${theme}: /js/settings.js not found`);
    assert.ok(coreIdx < mainIdx, `${theme}: settingsAutosaveCore.js must appear before settings.js`);
    assert.ok(ctrlIdx < mainIdx, `${theme}: settingsAutosave.js must appear before settings.js`);

    for (const id of SAVE_IDS) {
      assert.ok(
        !html.includes(`id="${id}"`),
        `${theme}: save button "${id}" should have been removed by migration but is still present`,
      );
    }
  }
});
