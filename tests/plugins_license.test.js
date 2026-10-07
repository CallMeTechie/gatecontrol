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
