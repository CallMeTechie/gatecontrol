'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getAgent } = require('./helpers/setup');

let app;
beforeEach(async () => { await setup(); app = require('../src/app').createApp(); });
afterEach(teardown);

test('autosave core + controller are served', async () => {
  const core = await supertest(app).get('/js/settingsAutosaveCore.js').expect(200);
  assert.match(core.text, /SETTINGS_CLUSTERS/);
  assert.match(core.text, /createQueue/);
  const ctrl = await supertest(app).get('/js/settingsAutosave.js').expect(200);
  assert.match(ctrl.text, /SettingsAutosave/);
  assert.match(ctrl.text, /addEventListener/);
});

test('toggles dispatch a change event (setupManagedToggle)', async () => {
  const js = await supertest(app).get('/js/settings.js').expect(200);
  assert.match(js.text, /dispatchEvent\(new Event\(['"]change['"]\)\)/);
});

test('field-saving style is served in both stylesheets', async () => {
  const appCss = await supertest(app).get('/css/app.css').expect(200);
  assert.match(appCss.text, /\.field-saving/);
  const proCss = await supertest(app).get('/css/pro.css').expect(200);
  assert.match(proCss.text, /\.field-saving/);
});

test('independent clusters migrated: buttons gone, autosave bound, mb fixed', async () => {
  const js = await supertest(app).get('/js/settings.js').expect(200);
  assert.match(js.text, /SettingsAutosave\.bind/);
  assert.doesNotMatch(js.text, /getElementById\(['"]mb-msg['"]\)/);
  assert.doesNotMatch(js.text, /fetch\(['"]\/api\/v1\/settings\/gateway-failover/); // now via api.put
  const page = await getAgent().get('/settings').expect(200);
  ['btn-metrics-save','btn-dns-save','btn-data-save','btn-monitoring-save','mb-save','au-mode-save']
    .forEach(id => assert.doesNotMatch(page.text, new RegExp('id="' + id + '"')));
  // dedicated status badges present (incl. machine-binding + default-theme)
  ['machine-binding-status','default-theme-status']
    .forEach(id => assert.match(page.text, new RegExp('id="' + id + '"')));
  // machine-binding JS points statusEl at its dedicated badge, not the old hidden div
  assert.match(js.text, /getElementById\(['"]machine-binding-status['"]\)/);
});

test('security/backup/portal migrated; single security bind', async () => {
  const page = await getAgent().get('/settings').expect(200);
  ['btn-security-save','btn-password-save','btn-autobackup-save','btn-portal-save']
    .forEach(id => assert.doesNotMatch(page.text, new RegExp('id="' + id + '"')));
});
