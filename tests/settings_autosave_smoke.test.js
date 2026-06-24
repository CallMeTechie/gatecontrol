'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

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
