'use strict';

// A first-party plugin released after the last daily licence validation has
// no entitlement yet ("Lizenz fehlt") although the licence server already
// includes it (lifetime licence, plan). Installing or updating it revalidates
// the GateControl licence once (throttled, only with a licence key) and starts
// the plugin when the entitlement arrives (docs/plugins.md "Lizenzen").

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { helloPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let agent, csrf, runtime, plugins, license, licensing, registry, config;
const API = '/api/v1/plugins';

let refreshCalls = 0;
let deliver = null; // entitlements the stubbed revalidation delivers

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  return (await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200)).body;
}
const lifetime = (slug) => ({ slug, name: slug, source: 'lifetime', key_masked: null, valid: true, error: null, expires_at: null, updates_until: null });
const firstParty = (id, version) => helloPackage({ overrides: { id, ...(version ? { version } : {}), license: { required: true } } });

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  license = require('../src/services/license');
  licensing = require('../src/services/plugins/licensing');
  registry = require('../src/services/plugins/registry');
  config = require('../config/default');
});
beforeEach(() => {
  refreshCalls = 0;
  deliver = null;
  config.license.key = 'GATE-LIFE-TIME-0001';
  // a fresh throttle per test; the stub stands for license.refreshLicenseInBackground
  licensing._setRefreshForTest(async () => {
    refreshCalls++;
    if (deliver) license._setPluginEntitlementsForTest(deliver);
  });
});
after(async () => {
  licensing._setRefreshForTest(null);
  license._setPluginEntitlementsForTest([]);
  config.license.key = '';
  await plugins.stop();
  teardown();
});

describe('licence revalidation on install of a first-party plugin', () => {
  it('no entitlement + licence key: revalidates once, the delivered entitlement starts the plugin', async () => {
    license._setPluginEntitlementsForTest([]);
    deliver = [lifetime('hello-new')];
    const r = await install(firstParty('hello-new'));
    assert.equal(refreshCalls, 1);
    assert.deepEqual([r.plugin.license.kind, r.plugin.license.state, r.plugin.license.source, r.plugin.license.licensed],
      ['first_party', 'valid', 'lifetime', true]);
    assert.equal(await runtime.waitRunning('hello-new'), true);
    assert.ok(registry.logs('hello-new').some((l) => /licence revalidated after the install: valid/.test(l.message)));
  });

  it('is throttled: a second missing plugin within 10 minutes does not revalidate again', async () => {
    license._setPluginEntitlementsForTest([]);
    await install(firstParty('hello-new2'));
    assert.equal(refreshCalls, 1);
    const v = (await install(firstParty('hello-new3'))).plugin;
    assert.equal(refreshCalls, 1, 'throttled');
    assert.deepEqual([v.license.state, v.reason], ['missing', 'license']);
    // after the gap it may run again
    const p = registry.get('hello-new3');
    assert.equal(licensing.revalidateIfMissing(p, Date.now() + 5 * 60 * 1000), null);
    await licensing.revalidateIfMissing(p, Date.now() + licensing.AUTO_REFRESH_GAP_MS + 1000);
    assert.equal(refreshCalls, 2);
  });

  it('an update of a plugin still without entitlement revalidates as well', async () => {
    license._setPluginEntitlementsForTest([]);
    deliver = [lifetime('hello-new3')];
    const r = await install(firstParty('hello-new3', '1.1.0'));
    assert.equal(refreshCalls, 1);
    assert.equal(r.plugin.license.state, 'valid');
    assert.equal(await runtime.waitRunning('hello-new3'), true);
    assert.ok(registry.logs('hello-new3').some((l) => /licence revalidated after the update: valid/.test(l.message)));
  });

  it('not when an entitlement exists', async () => {
    license._setPluginEntitlementsForTest([lifetime('hello-ent')]);
    const r = await install(firstParty('hello-ent'));
    assert.equal(refreshCalls, 0);
    assert.equal(r.plugin.license.state, 'valid');
  });

  it('not without a GateControl licence key (community)', async () => {
    config.license.key = '';
    license._setPluginEntitlementsForTest([]);
    const r = await install(firstParty('hello-nokey'));
    assert.equal(refreshCalls, 0);
    assert.equal(r.plugin.license.state, 'missing');
  });

  it('not for a plugin that needs no licence', async () => {
    license._setPluginEntitlementsForTest([]);
    await install(helloPackage({ overrides: { id: 'hello-free', license: { required: false } } }));
    assert.equal(refreshCalls, 0);
  });

  it('not for third-party plugins (own licence server)', async () => {
    await agent.put(API + '/policy').set('X-CSRF-Token', csrf).send({ allowUnsigned: true, confirm: 'ERLAUBEN' }).expect(200);
    license._setPluginEntitlementsForTest([]);
    const r = await install(helloPackage({ sign: false, overrides: { id: 'hello-3p', license: { required: true, server: 'https://licenses.vendor.example/check' } } }));
    assert.equal(refreshCalls, 0);
    assert.deepEqual([r.plugin.license.kind, r.plugin.license.state], ['third_party', 'missing']);
    const signedByStranger = helloPackage({ sign: 'stranger', overrides: { id: 'hello-3p2', license: { required: true, server: 'https://licenses.vendor.example/check' } } });
    await install(signedByStranger);
    assert.equal(refreshCalls, 0);
  });
});

describe('POST /api/v1/license/refresh', () => {
  it('starts a plugin licensed by the refresh right away (no wait for the 5-minute reconcile); the cooldown answers 429', async () => {
    config.license.key = ''; // refreshLicenseInBackground returns at once — the entitlement "arrives" via the seam
    assert.equal(runtime.info('hello-nokey').state, 'stopped');
    license._setPluginEntitlementsForTest([lifetime('hello-nokey')]);
    await agent.post('/api/v1/license/refresh').set('X-CSRF-Token', csrf).send({}).expect(200);
    assert.equal(await runtime.waitRunning('hello-nokey'), true);
    const again = await agent.post('/api/v1/license/refresh').set('X-CSRF-Token', csrf).send({}).expect(429);
    assert.equal(again.body.ok, false);
    assert.ok(again.body.error);
  });
});

describe('licence UI: "Lizenz aktualisieren" for a first-party plugin without licence', () => {
  it('the licence panel offers the refresh (POST /api/v1/license/refresh) with the hint', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'settings-plugins.js'), 'utf8');
    assert.match(js, /L\.kind === 'first_party' && L\.state === 'missing'/);
    assert.match(js, /req\('POST', '\/api\/v1\/license\/refresh'/);
    assert.match(js, /t\('plugins\.lic\.refresh'\)/);
    assert.match(js, /t\('plugins\.lic\.refresh_hint'\)/);
    assert.match(js, /plugins\.lic\.refresh_still_missing/);
    // the own plugin key stays possible
    assert.match(js, /id: 'pg-lic-key'/);
  });
  it('the strings exist in de and en', () => {
    const de = require('../src/i18n/de.json');
    const en = require('../src/i18n/en.json');
    for (const k of ['plugins.lic.refresh', 'plugins.lic.refresh_hint', 'plugins.lic.refresh_still_missing']) {
      assert.ok(de[k], 'de: ' + k);
      assert.ok(en[k], 'en: ' + k);
    }
    assert.equal(de['plugins.lic.refresh'], 'Lizenz aktualisieren');
    assert.equal(en['plugins.lic.refresh'], 'Refresh licence');
  });
});
