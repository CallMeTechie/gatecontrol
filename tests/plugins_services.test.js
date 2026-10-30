'use strict';

// Services between plugins (docs/plugins.md "Services"): plugin.json
// services.provides and permissions.services, gc.services.call({ plugin,
// service, userId, payload }) → the provider's hook service({ name, caller,
// user, payload }); 60 calls per hour and caller, payload ≤ 512 KB, answer ≤ 16 KB,
// an activity row per call.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');
const PUI = require('../public/js/plugins-ui.js');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

let agent, csrf, runtime, plugins, manifest, hostApi, registry, anna, inspectedCaller, inspectedProvider;
const API = '/api/v1/plugins';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const PROVIDES = { send_message: { label: { de: 'Chat-Nachricht senden', en: 'Send a chat message' } }, sync_group: { label: 'Gruppe abgleichen' } };

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  return r.body;
}
const kv = (id, key, value) => agent.post(`${API}/${id}/api/kv`).set('X-CSRF-Token', csrf).send({ key, value }).expect(200);
const kvGet = async (id, key) => (await agent.get(`${API}/${id}/api/kv`).query({ key }).expect(200)).body.value;
const svc = (id, body) => agent.post(`${API}/${id}/api/service`).set('X-CSRF-Token', csrf).send(body);
const errCode = async (id, body) => { const r = await svc(id, body).expect(400); return r.body.code; };

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  manifest = require('../src/services/plugins/manifest');
  hostApi = require('../src/services/plugins/hostApi');
  registry = require('../src/services/plugins/registry');
  anna = H.makeUser('svc-anna');
  inspectedProvider = await install(helloPackage({ overrides: { id: 'hello-prov', name: 'Anbieter', services: { provides: PROVIDES } } }));
  inspectedCaller = await install(helloPackage({ overrides: { id: 'hello-call', name: 'Aufrufer',
    permissions: { ...clone(helloManifest.permissions), services: ['hello-prov:send_message', 'hello-prov:nope', 'hello-gone:send_message'] } } }));
  await install(helloPackage({ overrides: { id: 'hello-other', name: 'Fremd' } }));
  for (const id of ['hello-prov', 'hello-call', 'hello-other']) assert.equal(await runtime.waitRunning(id), true, id);
});
after(async () => { hostApi._serviceTimeoutMs = null; await plugins.stop(); teardown(); });
beforeEach(async () => { hostApi._resetBudgetsForTest(); await kv('hello-prov', 'service-mode', null); });

describe('plugin.json services.provides / permissions.services', () => {
  const base = () => clone(helloManifest);
  it('provides: { <name>: { label } }, names [a-z][a-z0-9_]{0,31}, ≤ 32; default none', () => {
    const m = base();
    assert.deepEqual(manifest.validate(m).manifest.services, { provides: {} });
    m.services = { provides: PROVIDES };
    assert.deepEqual(manifest.validate(m).manifest.services, { provides: {
      send_message: { label: { de: 'Chat-Nachricht senden', en: 'Send a chat message' } }, sync_group: { label: { de: 'Gruppe abgleichen', en: 'Gruppe abgleichen' } },
    } });
    const errs = (services) => { const x = base(); x.services = services; return manifest.validate(x).errors; };
    assert.deepEqual(errs([]), ['services: invalid']);
    assert.deepEqual(errs({ provides: PROVIDES, other: 1 }), ['services: invalid']);
    assert.deepEqual(errs({ provides: [] }), ['services: invalid']);
    assert.deepEqual(errs({ provides: { 'Send-Message': { label: 'x' } } }), ['services.provides: invalid']);
    assert.deepEqual(errs({ provides: { send: {} } }), ['services.provides: invalid']);
    assert.deepEqual(errs({ provides: { send: { label: 'x', run: 'y' } } }), ['services.provides: invalid']);
    const many = {};
    for (let i = 0; i < 33; i++) many[`s${i}`] = { label: 'x' };
    assert.deepEqual(errs({ provides: many }), ['services: invalid']);
  });

  it('permissions.services: ["<plugin>:<service>"], ≤ 32, never the plugin\'s own', () => {
    const m = base();
    assert.deepEqual(manifest.validate(m).manifest.permissions.services, []);
    m.permissions.services = ['gatecontrol-messenger:send_message', 'gatecontrol-messenger:send_message'];
    assert.deepEqual(manifest.validate(m).manifest.permissions.services, ['gatecontrol-messenger:send_message']);
    const errs = (services) => { const x = base(); x.permissions.services = services; return manifest.validate(x).errors; };
    for (const bad of ['gatecontrol-messenger:send_message', ['messenger'], ['Messenger:send'], ['a:B'], [7], new Array(33).fill('a:b')]) {
      assert.deepEqual(errs(bad), ['permissions.services: invalid'], JSON.stringify(bad));
    }
    assert.deepEqual(errs(['hello:x']), ['permissions.services: own service']);
  });

  it('the install dialog names the services a plugin uses and those it offers', () => {
    assert.deepEqual(inspectedCaller.plugin.permissions.services, ['hello-prov:send_message', 'hello-prov:nope', 'hello-gone:send_message']);
    assert.ok(['Chat-Nachricht senden', 'Send a chat message'].includes(inspectedProvider.plugin.permissions.servicesProvided[0]));
    const t = (k, p) => { let s = de[k] || k; for (const [a, b] of Object.entries(p || {})) s = s.split('{{' + a + '}}').join(String(b)); return s; };
    const rows = Object.fromEntries(PUI.permRows({ network: { internet: [], homeTargets: [] }, services: ['gatecontrol-messenger:send_message'], servicesProvided: ['Chat-Nachricht senden'] }, t).map((r) => [r.label, r.value]));
    assert.equal(rows['Dienste anderer Plugins'], 'darf nutzen: gatecontrol-messenger: send_message');
    assert.equal(rows['Eigene Dienste'], 'bietet anderen Plugins an: Chat-Nachricht senden');
    for (const k of ['plugins.perm.services', 'plugins.perm.services_v', 'plugins.perm.services_provided', 'plugins.perm.services_provided_v']) assert.ok(de[k] && en[k], k);
  });
});

describe('gc.services.call', () => {
  it('runs the provider\'s hook service({ name, caller, user, payload }) and answers its result', async () => {
    const r = await svc('hello-call', { plugin: 'hello-prov', service: 'send_message', userId: anna, payload: { to: 'group:familie', text: 'Tim ist zu Hause' } }).expect(200);
    assert.deepEqual(r.body.result, { ok: true, name: 'send_message', caller: 'hello-call', echo: { to: 'group:familie', text: 'Tim ist zu Hause' } });
    assert.deepEqual(await kvGet('hello-prov', 'service-last'), {
      name: 'send_message', caller: 'hello-call', user: { id: anna, name: 'svc-anna', role: 'user' }, payload: { to: 'group:familie', text: 'Tim ist zu Hause' },
    });
    const row = H.db().prepare("SELECT message, details FROM activity_log WHERE event_type = 'plugin_service' ORDER BY id DESC LIMIT 1").get();
    assert.equal(row.message, 'Plugin "hello-call" called service "send_message" of plugin "hello-prov" (ok)');
    assert.deepEqual(JSON.parse(row.details), { plugin: 'hello-call', target: 'hello-prov', service: 'send_message', userId: anna, ok: true });
    assert.doesNotMatch(row.details, /Tim ist/, 'never the payload');
  });

  it('without userId the provider gets user null; without payload null', async () => {
    await svc('hello-call', { plugin: 'hello-prov', service: 'send_message' }).expect(200);
    assert.deepEqual(await kvGet('hello-prov', 'service-last'), { name: 'send_message', caller: 'hello-call', user: null, payload: null });
  });

  it('refusals: permission, availability, arguments', async () => {
    assert.equal(await errCode('hello-call', { plugin: 'hello-prov', service: 'sync_group' }), 'ERR_SERVICES_DENIED', 'provided, but not listed by the caller');
    assert.equal(await errCode('hello-other', { plugin: 'hello-prov', service: 'send_message' }), 'ERR_SERVICES_DENIED');
    assert.equal(await errCode('hello-call', { plugin: 'hello-prov', service: 'nope' }), 'ERR_SERVICE_UNAVAILABLE', 'listed, not provided');
    assert.equal(await errCode('hello-call', { plugin: 'hello-gone', service: 'send_message' }), 'ERR_SERVICE_UNAVAILABLE', 'not installed');
    assert.equal(await errCode('hello-call', { plugin: 'Hello', service: 'send_message' }), 'ERR_INVALID');
    assert.equal(await errCode('hello-call', { plugin: 'hello-prov', service: 'Send' }), 'ERR_INVALID');
    assert.equal(await errCode('hello-call', { plugin: 'hello-prov', service: 'send_message', userId: '1' }), 'ERR_INVALID');
    assert.equal(await errCode('hello-call', { plugin: 'hello-prov', service: 'send_message', userId: 999999 }), 'ERR_INVALID');
    const off = H.makeUser('svc-off', { enabled: 0 });
    assert.equal(await errCode('hello-call', { plugin: 'hello-prov', service: 'send_message', userId: off }), 'ERR_INVALID');
    assert.equal(await errCode('hello-call', { plugin: 'hello-prov', service: 'send_message', payload: { x: 'y'.repeat(512 * 1024) } }), 'ERR_INVALID');
  });

  it('a disabled provider is unavailable', async () => {
    await agent.post(`${API}/hello-prov/disable`).set('X-CSRF-Token', csrf).expect(200);
    try {
      assert.equal(await errCode('hello-call', { plugin: 'hello-prov', service: 'send_message' }), 'ERR_SERVICE_UNAVAILABLE');
    } finally {
      await agent.post(`${API}/hello-prov/enable`).set('X-CSRF-Token', csrf).expect(200);
      assert.equal(await runtime.waitRunning('hello-prov'), true);
    }
  });

  it('the provider fails, answers too much or too late', async () => {
    await kv('hello-prov', 'service-mode', 'throw');
    let r = await svc('hello-call', { plugin: 'hello-prov', service: 'send_message' }).expect(400);
    assert.equal(r.body.code, 'ERR_SERVICE_FAILED');
    assert.match(r.body.error, /broken on purpose/);
    const row = H.db().prepare("SELECT details FROM activity_log WHERE event_type = 'plugin_service' ORDER BY id DESC LIMIT 1").get();
    assert.equal(JSON.parse(row.details).ok, false);
    await kv('hello-prov', 'service-mode', 'big');
    r = await svc('hello-call', { plugin: 'hello-prov', service: 'send_message' }).expect(400);
    assert.equal(r.body.code, 'ERR_SERVICE_FAILED');
    hostApi._serviceTimeoutMs = 300;
    await kv('hello-prov', 'service-mode', 'slow');
    r = await svc('hello-call', { plugin: 'hello-prov', service: 'send_message' }).expect(400);
    assert.equal(r.body.code, 'ERR_TIMEOUT');
    hostApi._serviceTimeoutMs = null;
    await new Promise((res) => setTimeout(res, 2000)); // the slow call ends in the provider
  });

  it('60 calls per hour and calling plugin', async () => {
    const caller = registry.get('hello-call');
    for (let i = 0; i < hostApi.SERVICES_PER_HOUR; i++) await hostApi.handle(caller, 'services.call', { plugin: 'hello-prov', service: 'send_message', payload: i });
    await assert.rejects(() => hostApi.handle(caller, 'services.call', { plugin: 'hello-prov', service: 'send_message' }), (e) => e.code === 'ERR_RATE_LIMIT');
  });

  it('a provider without the hook: ERR_SERVICE_FAILED ("offers no services"), its process keeps running', async () => {
    const bare = new Map([['server/bare.js', "'use strict';\nmodule.exports = { async request() { return { json: { ok: true } }; } };\n"]]);
    await install(helloPackage({ overrides: { id: 'hello-bare', name: 'Ohne Hook', entry: 'server/bare.js', services: { provides: { send_message: { label: 'x' } } } }, extra: bare }));
    assert.equal(await runtime.waitRunning('hello-bare'), true);
    const caller = { ...registry.get('hello-call') };
    caller.manifest = { ...caller.manifest, permissions: { ...caller.manifest.permissions, services: ['hello-bare:send_message'] } };
    await assert.rejects(() => hostApi.handle(caller, 'services.call', { plugin: 'hello-bare', service: 'send_message' }),
      (e) => e.code === 'ERR_SERVICE_FAILED' && /offers no services/.test(e.message));
    assert.equal(runtime.info('hello-bare').state, 'running');
  });
});

describe('services.provides.<name>.maxPerHour (since 1.216.0)', () => {
  before(async () => {
    await install(helloPackage({ overrides: { id: 'hello-prov2', name: 'Anbieter 2',
      services: { provides: { fast: { label: 'Schnell', maxPerHour: 90 }, slow: { label: 'Langsam' } } } } }));
    await install(helloPackage({ overrides: { id: 'hello-call2', name: 'Aufrufer 2',
      permissions: { ...clone(helloManifest.permissions), services: ['hello-prov2:fast', 'hello-prov2:slow'] } } }));
    for (const id of ['hello-prov2', 'hello-call2']) assert.equal(await runtime.waitRunning(id), true, id);
  });

  it('an integer 60 … 3600 next to the label; anything else → services.provides.maxPerHour: invalid', () => {
    const m = clone(helloManifest);
    m.services = { provides: { fast: { label: 'x', maxPerHour: 600 }, plain: { label: 'y' } } };
    assert.deepEqual(manifest.validate(m).manifest.services.provides, { fast: { label: { de: 'x', en: 'x' }, maxPerHour: 600 }, plain: { label: { de: 'y', en: 'y' } } });
    for (const bad of [59, 3601, 1.5, '600', 0, -1]) {
      const x = clone(helloManifest);
      x.services = { provides: { fast: { label: 'x', maxPerHour: bad } } };
      assert.deepEqual(manifest.validate(x).errors, ['services.provides.maxPerHour: invalid'], String(bad));
    }
  });

  it('a service with maxPerHour has that budget per calling plugin, the others keep the shared 60', async () => {
    const caller = registry.get('hello-call2');
    for (let i = 0; i < hostApi.SERVICES_PER_HOUR; i++) await hostApi.handle(caller, 'services.call', { plugin: 'hello-prov2', service: 'slow', payload: i });
    await assert.rejects(() => hostApi.handle(caller, 'services.call', { plugin: 'hello-prov2', service: 'slow' }), (e) => e.code === 'ERR_RATE_LIMIT');
    // the shared budget is used up — the service with its own budget still answers, 90 times
    for (let i = 0; i < 90; i++) await hostApi.handle(caller, 'services.call', { plugin: 'hello-prov2', service: 'fast', payload: i });
    await assert.rejects(() => hostApi.handle(caller, 'services.call', { plugin: 'hello-prov2', service: 'fast' }), (e) => e.code === 'ERR_RATE_LIMIT' && /90 per hour/.test(e.message));
    // per calling plugin: another caller is not affected (hello-call lists none of them, but its own budget is untouched)
    await hostApi.handle(registry.get('hello-call'), 'services.call', { plugin: 'hello-prov', service: 'send_message' });
  });
});

describe('gc.services.available', () => {
  const avail = (id, body) => agent.post(`${API}/${id}/api/service-available`).set('X-CSRF-Token', csrf).send(body);
  const serviceRows = () => H.db().prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'plugin_service'").get().n;

  it('true for a listed, provided service of a running provider — positional or object form, through the plugin process', async () => {
    assert.equal((await avail('hello-call', { plugin: 'hello-prov', service: 'send_message' }).expect(200)).body.result, true);
    assert.equal((await avail('hello-call', { plugin: 'hello-prov', service: 'send_message', object: true }).expect(200)).body.result, true);
  });

  it('false when not listed, not provided, not installed, or the caller itself', async () => {
    const caller = registry.get('hello-call');
    const ask = (plugin, service, who = caller) => hostApi.handle(who, 'services.available', { plugin, service });
    assert.equal(await ask('hello-prov', 'sync_group'), false, 'provided, but not listed by the caller');
    assert.equal(await ask('hello-prov', 'send_message', registry.get('hello-other')), false, 'no permissions.services');
    assert.equal(await ask('hello-prov', 'nope'), false, 'listed, not provided');
    assert.equal(await ask('hello-gone', 'send_message'), false, 'not installed');
    const self = { ...caller, manifest: { ...caller.manifest, permissions: { ...caller.manifest.permissions, services: ['hello-call:send_message'] } } };
    assert.equal(await ask('hello-call', 'send_message', self), false, 'its own plugin');
  });

  it('malformed plugin id or service name → ERR_INVALID', async () => {
    let r = await avail('hello-call', { plugin: 'Hello', service: 'send_message' }).expect(400);
    assert.equal(r.body.code, 'ERR_INVALID');
    r = await avail('hello-call', { plugin: 'hello-prov', service: 'Send' }).expect(400);
    assert.equal(r.body.code, 'ERR_INVALID');
    r = await avail('hello-call', {}).expect(400);
    assert.equal(r.body.code, 'ERR_INVALID');
  });

  it('a disabled or stopped provider is not available', async () => {
    await agent.post(`${API}/hello-prov/disable`).set('X-CSRF-Token', csrf).expect(200);
    try {
      assert.equal((await avail('hello-call', { plugin: 'hello-prov', service: 'send_message' }).expect(200)).body.result, false);
    } finally {
      await agent.post(`${API}/hello-prov/enable`).set('X-CSRF-Token', csrf).expect(200);
      assert.equal(await runtime.waitRunning('hello-prov'), true);
    }
    assert.equal((await avail('hello-call', { plugin: 'hello-prov', service: 'send_message' }).expect(200)).body.result, true);
  });

  it('never runs the provider, never counts against the budget, no activity row', async () => {
    const caller = registry.get('hello-call');
    await kv('hello-prov', 'service-last', null);
    const rows = serviceRows();
    for (let i = 0; i < hostApi.SERVICES_PER_HOUR + 5; i++) assert.equal(await hostApi.handle(caller, 'services.available', { plugin: 'hello-prov', service: 'send_message' }), true);
    assert.equal(await kvGet('hello-prov', 'service-last'), null, 'the hook did not run');
    assert.equal(serviceRows(), rows, 'no plugin_service row');
    // the full budget is still there
    for (let i = 0; i < hostApi.SERVICES_PER_HOUR; i++) await hostApi.handle(caller, 'services.call', { plugin: 'hello-prov', service: 'send_message', payload: i });
    await assert.rejects(() => hostApi.handle(caller, 'services.call', { plugin: 'hello-prov', service: 'send_message' }), (e) => e.code === 'ERR_RATE_LIMIT');
    // …and over budget, available still answers (it is not a call)
    assert.equal(await hostApi.handle(caller, 'services.available', { plugin: 'hello-prov', service: 'send_message' }), true);
  });
});
