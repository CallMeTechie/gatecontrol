'use strict';

// Plugin licences (docs/plugins.md "Lizenzen"): first-party plugins through
// the GateControl licence server's entitlements, third-party plugins through
// their own licence server (mocked transport), the 14-day grace.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { helloPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let agent, csrf, runtime, plugins, license, licensing, registry;
const API = '/api/v1/plugins';
const DAY = 86400000;

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  return (await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200)).body;
}
const view = async (id) => (await agent.get(`${API}/${id}`).expect(200)).body.plugin;

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  license = require('../src/services/license');
  licensing = require('../src/services/plugins/licensing');
  registry = require('../src/services/plugins/registry');
});
after(async () => { licensing._setTransportForTest(null); license._setPluginEntitlementsForTest([]); await plugins.stop(); teardown(); });

describe('first-party (signed by the trusted key)', () => {
  const id = 'hello-fp';
  it('without an entitlement it is installed but stays off', async () => {
    const r = await install(helloPackage({ overrides: { id, license: { required: true } } }));
    assert.equal(r.plugin.license.kind, 'first_party');
    const v = await view(id);
    assert.deepEqual([v.status, v.reason, v.license.state, v.license.licensed], ['blocked', 'license', 'missing', false]);
    assert.equal(runtime.info(id).state, 'stopped');
  });
  it('a valid entitlement (slug = plugin id) starts it', async () => {
    license._setPluginEntitlementsForTest([{ slug: id, name: 'x', source: 'license', key_masked: 'GCP-HELL-••••-0001', valid: true, error: null,
      expires_at: new Date(Date.now() + 90 * DAY).toISOString(), updates_until: null }]);
    await plugins.reconcile();
    assert.equal(await runtime.waitRunning(id), true);
    const v = await view(id);
    assert.deepEqual([v.license.state, v.license.keyMasked], ['valid', 'GCP-HELL-••••-0001']);
  });
  it('expiring soon keeps running; expired or a wrong product stops it (data kept)', async () => {
    const ent = (o) => license._setPluginEntitlementsForTest([{ slug: id, name: 'x', source: 'license', key_masked: null, valid: true, error: null, expires_at: null, updates_until: null, ...o }]);
    ent({ expires_at: new Date(Date.now() + 3 * DAY).toISOString() });
    await plugins.reconcile();
    assert.equal((await view(id)).license.state, 'expiring');
    assert.equal(runtime.info(id).state, 'running');
    ent({ expires_at: new Date(Date.now() - DAY).toISOString() });
    await plugins.reconcile();
    assert.deepEqual([(await view(id)).license.state, runtime.info(id).state], ['expired', 'stopped']);
    ent({ valid: false, error: 'wrong_product' });
    await plugins.reconcile();
    assert.equal((await view(id)).license.state, 'wrong_plugin');
    ent({ valid: false, error: 'expired' });
    assert.equal((await view(id)).license.state, 'expired');
    const reasons = registry.logs(id).map((l) => l.message);
    assert.ok(reasons.some((m) => /stopped: license/.test(m)), reasons.join(' | '));
  });
  it('source "plan": included in the GateControl plan, runs without a key of its own and says so', async () => {
    license._setPluginEntitlementsForTest([{ slug: id, name: 'x', source: 'plan', key_masked: null, valid: true, error: null, expires_at: null, updates_until: null }]);
    await plugins.reconcile();
    assert.equal(await runtime.waitRunning(id), true);
    const v = await view(id);
    assert.deepEqual([v.license.state, v.license.source, v.license.licensed, v.license.keyMasked], ['valid', 'plan', true, null]);
    assert.equal(v.license.coveredBy, undefined);
  });
  it('a redundant key ("covered_by_plan" / "covered_by_lifetime") never decides the state and is reported', async () => {
    for (const [error, by, source] of [['covered_by_plan', 'plan', 'plan'], ['covered_by_lifetime', 'lifetime', 'lifetime']]) {
      // the redundant key may come first: the covering entitlement still wins
      license._setPluginEntitlementsForTest([
        { slug: id, name: 'x', source: 'license', key_masked: 'GCP-HELL-••••-0009', valid: false, error, expires_at: null, updates_until: null },
        { slug: id, name: 'x', source, key_masked: null, valid: true, error: null, expires_at: null, updates_until: null },
      ]);
      await plugins.reconcile();
      const v = await view(id);
      assert.deepEqual([v.license.state, v.license.source, v.license.licensed, v.license.coveredBy, v.license.redundantKeyMasked],
        ['valid', source, true, by, 'GCP-HELL-••••-0009'], error);
      assert.equal(runtime.info(id).state === 'running' || await runtime.waitRunning(id), true);
    }
    // a covered key alone (no covering entitlement in the answer) is no licence
    license._setPluginEntitlementsForTest([{ slug: id, name: 'x', source: 'license', key_masked: null, valid: false, error: 'covered_by_plan', expires_at: null, updates_until: null }]);
    assert.deepEqual([(await view(id)).license.state, (await view(id)).license.coveredBy], ['missing', 'plan']);
  });
  it('the plugins UI names the plan source and the redundant key', () => {
    const fs = require('node:fs');
    const js = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'settings-plugins.js'), 'utf8');
    assert.match(js, /plugins\.lic\.source_' \+ s/);
    assert.match(js, /plugins\.lic\.covered_' \+ L\.coveredBy/);
    for (const l of ['de', 'en']) {
      const t = require(`../src/i18n/${l}.json`);
      for (const k of ['plugins.lic.source_plan', 'plugins.lic.source_lifetime', 'plugins.lic.covered_plan', 'plugins.lic.covered_lifetime', 'plugins.lic.hint_plan', 'plugins.lic.kind']) assert.ok(t[k], `${l}: ${k}`);
    }
    assert.equal(require('../src/i18n/de.json')['plugins.lic.source_plan'], 'Im Plan enthalten');
    assert.equal(require('../src/i18n/en.json')['plugins.lic.source_plan'], 'Included in your plan');
  });
  it('a key entered for it joins the plugin keys of the GateControl licence', async () => {
    const r = await agent.put(`${API}/${id}/license`).set('X-CSRF-Token', csrf).send({ key: 'GCP-HELL-AAAA-0001' }).expect(200);
    assert.ok(license.getPluginKeys().includes('GCP-HELL-AAAA-0001'));
    assert.equal(r.body.license.kind, 'first_party');
    await agent.put(`${API}/${id}/license`).set('X-CSRF-Token', csrf).send({ key: 'bad key with spaces' }).expect(400);
  });
});

describe('third-party (own licence server)', () => {
  const id = 'hello-tp';
  const server = 'https://licenses.solar-dev.example/api/check';
  const calls = [];
  let answer;
  before(async () => {
    await agent.put(API + '/policy').set('X-CSRF-Token', csrf).send({ allowUnsigned: true, confirm: 'ERLAUBEN' }).expect(200);
    licensing._setTransportForTest(async (url, body) => {
      calls.push({ url, body });
      if (answer instanceof Error) throw answer;
      return answer;
    });
  });
  it('installs unsigned with its licence server; stays off without a key', async () => {
    const r = await install(helloPackage({ sign: false, overrides: { id, license: { required: true, server } } }));
    assert.deepEqual([r.plugin.license.kind, r.plugin.license.state, r.plugin.license.server], ['third_party', 'missing', server]);
    assert.equal(runtime.info(id).state, 'stopped');
  });
  it('the key is checked at the plugin’s server with an anonymous server id', async () => {
    answer = { status: 200, json: { valid: true, expires_at: new Date(Date.now() + 365 * DAY).toISOString() } };
    const r = await agent.put(`${API}/${id}/license`).set('X-CSRF-Token', csrf).send({ key: 'SOLAR-7781-AB2C' }).expect(200);
    assert.equal(r.body.license.state, 'valid');
    assert.equal(r.body.license.keyMasked, 'SOLA-••••-AB2C');
    assert.equal(calls[0].url, server);
    assert.deepEqual(Object.keys(calls[0].body).sort(), ['license_key', 'plugin_id', 'server_id']);
    assert.equal(calls[0].body.plugin_id, id);
    assert.match(calls[0].body.server_id, /^[0-9a-f]{64}$/);
    assert.notEqual(calls[0].body.server_id, license._getHardwareFingerprint(), 'not the hardware fingerprint');
    assert.equal(licensing.serverId(server), calls[0].body.server_id, 'stable');
    assert.notEqual(licensing.serverId('https://other.example/x'), calls[0].body.server_id, 'per licence server');
    assert.equal(await runtime.waitRunning(id), true);
  });
  it('server unreachable: keeps running within 14 days, off after the grace', async () => {
    answer = new Error('ECONNREFUSED');
    let r = await agent.post(`${API}/${id}/license/check`).set('X-CSRF-Token', csrf).send({}).expect(200);
    assert.deepEqual([r.body.license.state, r.body.license.licensed], ['unreachable', true]);
    assert.equal(runtime.info(id).state, 'running');
    const rec = registry.getLicense(id);
    registry.setLicense(id, { state: { ...rec.state, last_ok_at: new Date(Date.now() - 15 * DAY).toISOString() } });
    r = await agent.post(`${API}/${id}/license/check`).set('X-CSRF-Token', csrf).send({}).expect(200);
    assert.deepEqual([r.body.license.state, r.body.license.licensed], ['grace_over', false]);
    assert.equal(runtime.info(id).state, 'stopped');
  });
  it('an invalid or expired answer switches it off', async () => {
    answer = { status: 200, json: { valid: true, expires_at: new Date(Date.now() + DAY).toISOString() } };
    await agent.post(`${API}/${id}/license/check`).set('X-CSRF-Token', csrf).send({}).expect(200);
    assert.equal(await runtime.waitRunning(id), true);
    answer = { status: 403, json: { valid: false } };
    const r = await agent.post(`${API}/${id}/license/check`).set('X-CSRF-Token', csrf).send({}).expect(200);
    assert.equal(r.body.license.state, 'invalid');
    assert.equal(runtime.info(id).state, 'stopped');
    answer = { status: 200, json: { valid: true, expires_at: new Date(Date.now() - DAY).toISOString() } };
    assert.equal((await agent.post(`${API}/${id}/license/check`).set('X-CSRF-Token', csrf).send({}).expect(200)).body.license.state, 'expired');
  });
  it('the real transport refuses non-public licence server addresses', async () => {
    licensing._setTransportForTest(null);
    const net = require('../src/services/plugins/netPolicy');
    const r = await net.checkTarget('https://127.0.0.1/x', { network: ['127.0.0.1'], lan: false });
    assert.equal(r.ok, false);
  });
});
