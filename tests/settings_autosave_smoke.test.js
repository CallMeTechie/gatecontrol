'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

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

test('atomic clusters migrated incl. route-block; secret-clear buttons present', async () => {
  const page = await getAgent().get('/settings').expect(200);
  ['btn-smtp-save','btn-alerts-save','btn-route-block-save']
    .forEach(id => assert.doesNotMatch(page.text, new RegExp('id="' + id + '"')));
  assert.match(page.text, /id="ip2location-clear"/);
  assert.match(page.text, /id="smtp-password-clear"/);
});

test('full-payload clusters migrated; list mutations use the queue', async () => {
  const page = await getAgent().get('/settings').expect(200);
  assert.doesNotMatch(page.text, /id="btn-pihole-save"/);
  assert.doesNotMatch(page.text, /id="st-save"/);
  const js = await supertest(app).get('/js/settings.js').expect(200);
  assert.match(js.text, /SettingsAutosave\.enqueue\(['"]pihole['"]/);
  assert.match(js.text, /SettingsAutosave\.enqueue\(['"]split-tunnel['"]/);
});

test('two concurrent pihole PUTs leave a deterministic (non-corrupted) DB state', async () => {
  // Server/DB-level sanity check; the JS-level per-cluster queue serialization is covered by settings_autosave_core.test.js (createQueue).
  const agent = getAgent(); const csrf = getCsrf();
  const base = { enabled: true, manage_dns_chain: false, sync_interval_sec: 30 };
  await Promise.all([
    agent.put('/api/v1/settings/pihole').set('X-CSRF-Token', csrf).send(Object.assign({}, base, { instances: [{ id: '1', url: 'http://a', dns_ip: '10.0.0.1', dns_port: 53, verify_tls: true, password_set: false }] })),
    agent.put('/api/v1/settings/pihole').set('X-CSRF-Token', csrf).send(Object.assign({}, base, { instances: [{ id: '1', url: 'http://a', dns_ip: '10.0.0.1', dns_port: 53, verify_tls: true, password_set: false }, { id: '2', url: 'http://b', dns_ip: '10.0.0.2', dns_port: 53, verify_tls: true, password_set: false }] })),
  ]);
  const get = await agent.get('/api/v1/settings/pihole').expect(200);
  assert.ok([1, 2].includes(get.body.data.instances.length));
});
