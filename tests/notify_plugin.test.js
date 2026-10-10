'use strict';

// Plugin API v2 for notifications (docs/plugins.md "Notifications"):
// gc.notify(message, { severity }) keeps working (activity row + push on
// plugin:<id>:default), gc.notify({ topic, title, … }) pushes on a topic
// declared in plugin.json notifyTopics; priority capped at high, 30/h,
// licence email_alerts for the push.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { helloPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');

let agent, csrf, hostApi, manifest, registry, rules, license, plugins;
let adminId, anna, annaDev, ben, benDev;

const TOPICS = [{ id: 'charging', label: { de: 'Laden abgeschlossen', en: 'Charging complete' }, default: true },
  { id: 'service', label: 'Wartung', default: false }];

function fakePlugin(id, { notify = true, topics = TOPICS } = {}) {
  const raw = {
    id, name: { de: 'Fahrzeug', en: 'Vehicle' }, version: '1.0.0', publisher: 'Test', gatecontrol: '>=1.0.0', entry: 'server/index.js',
    permissions: { notify }, ...(topics ? { notifyTopics: topics } : {}),
  };
  const v = manifest.validate(raw);
  assert.ok(v.ok, JSON.stringify(v.errors));
  registry.upsert({ manifest: v.manifest, signature: 'trusted', enabled: true });
  return { id, name: 'Fahrzeug', manifest: v.manifest };
}
const call = (plugin, args) => hostApi.handle(plugin, 'notify', args);

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  hostApi = require('../src/services/plugins/hostApi');
  manifest = require('../src/services/plugins/manifest');
  registry = require('../src/services/plugins/registry');
  rules = require('../src/services/notify/rules');
  license = require('../src/services/license');
  plugins = require('../src/services/plugins');
  adminId = H.db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  anna = H.makeUser('anna');
  ben = H.makeUser('ben');
  annaDev = H.makeDevice(anna);
  benDev = H.makeDevice(ben);
});
after(async () => { await plugins.stop(); teardown(); });
beforeEach(() => H.clearNotifications());

describe('plugin.json notifyTopics', () => {
  it('validates id, label, default, needs permissions.notify', () => {
    const base = { id: 'x-car', name: 'X', version: '1.0.0', publisher: 'T', gatecontrol: '>=1.0.0', entry: 'server/index.js' };
    let v = manifest.validate({ ...base, permissions: { notify: true }, notifyTopics: TOPICS });
    assert.equal(v.ok, true);
    assert.deepEqual(v.manifest.notifyTopics, [
      { id: 'charging', label: { de: 'Laden abgeschlossen', en: 'Charging complete' }, default: true },
      { id: 'service', label: { de: 'Wartung', en: 'Wartung' }, default: false },
    ]);
    v = manifest.validate({ ...base, notifyTopics: TOPICS });
    assert.deepEqual(v.errors, ['notifyTopics: needs permissions.notify']);
    v = manifest.validate({ ...base, permissions: { notify: true }, notifyTopics: [{ id: 'Bad Id', label: 'x' }] });
    assert.deepEqual(v.errors, ['notifyTopics: invalid']);
    v = manifest.validate({ ...base, permissions: { notify: true }, notifyTopics: [{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }] });
    assert.deepEqual(v.errors, ['notifyTopics: duplicate']);
    v = manifest.validate({ ...base, permissions: { notify: true } });
    assert.equal(v.ok, true);
    assert.equal(v.manifest.notifyTopics, undefined);
  });
});

describe('hostApi notify', () => {
  it('v1 string form: activity row as before + push on plugin:<id>:default to the subscribers', async () => {
    const p = fakePlugin('car-one');
    await call(p, { message: 'Laden fertig', opts: { severity: 'warning' } });
    const row = H.db().prepare("SELECT message, severity FROM activity_log WHERE event_type = 'plugin_notice' ORDER BY id DESC LIMIT 1").get();
    assert.deepEqual(row, { message: 'Fahrzeug: Laden fertig', severity: 'warning' });
    const n = H.lastNotification();
    assert.equal(n.topic, 'plugin:car-one:default');
    assert.equal(n.event_id, 'plugin:car-one:default');
    assert.equal(n.source, 'plugin:car-one');
    assert.equal(n.priority, 'normal', 'warning → normal');
    assert.equal(n.title, 'Fahrzeug');
    assert.equal(n.body, 'Laden fertig');
    assert.equal(JSON.parse(n.data).route, 'plg-car-one');
    const tokens = H.deliveries(n.id).map((d) => d.token_id);
    assert.ok(tokens.includes(annaDev.tokenId) && tokens.includes(benDev.tokenId));
    await call(p, { message: 'Info', opts: { severity: 'info' } });
    assert.equal(H.lastNotification().priority, 'info');
  });

  it('v2 object form: declared topic, priority capped at high, users, namespaced collapse key, data', async () => {
    const p = fakePlugin('car-two');
    const r = await call(p, { notification: { topic: 'charging', title: 'Laden abgeschlossen', body: 'Enyaq · 80 %', priority: 'critical',
      users: [anna], collapseKey: 'charge:VIN123', ttl: 6 * 3600, data: { route: 'plg-car-two', vin: 'VIN123' } } });
    assert.equal(r.pushed, true);
    const n = H.lastNotification();
    assert.equal(n.id, r.id);
    assert.equal(n.topic, 'plugin:car-two:charging');
    assert.equal(n.priority, 'high');
    assert.equal(n.collapse_key, 'plugin:car-two:charge:VIN123');
    assert.deepEqual(JSON.parse(n.data), { route: 'plg-car-two', vin: 'VIN123' });
    assert.deepEqual(H.deliveries(n.id).map((d) => d.token_id), [annaDev.tokenId]);
    const ttl = Date.parse(n.expires_at) - Date.parse(n.created_at);
    assert.ok(Math.abs(ttl - 6 * 3600 * 1000) < 2000);
  });

  it('v2: topic default off → only people who opted in', async () => {
    const p = fakePlugin('car-three');
    await call(p, { notification: { topic: 'service', title: 'Wartung fällig' } });
    assert.deepEqual(H.deliveries(H.lastNotification().id), []);
    H.db().prepare("INSERT INTO notify_subscriptions (user_id, topic, enabled) VALUES (?, 'plugin:car-three:service', 1)").run(ben);
    await call(p, { notification: { topic: 'service', title: 'Wartung fällig' } });
    assert.deepEqual(H.deliveries(H.lastNotification().id).map((d) => d.token_id), [benDev.tokenId]);
  });

  it('refusals: undeclared topic, no permission, empty title, bad data, too large data', async () => {
    const p = fakePlugin('car-four');
    const code = async (args, plugin = p) => { try { await call(plugin, args); return null; } catch (e) { return e.code; } };
    assert.equal(await code({ notification: { topic: 'nope', title: 'x' } }), 'ERR_INVALID');
    assert.equal(await code({ notification: { topic: 'charging', title: '  ' } }), 'ERR_INVALID');
    assert.equal(await code({ notification: { topic: 'charging', title: 'x', data: 'str' } }), 'ERR_INVALID');
    assert.equal(await code({ notification: { topic: 'charging', title: 'x', data: { a: 'z'.repeat(900), b: 'z'.repeat(900), c: 'z'.repeat(900), d: 'z'.repeat(900), e: 'z'.repeat(900) } } }), 'ERR_INVALID');
    assert.equal(await code({ notification: { topic: 'charging', title: 'x', priority: 'urgent' } }), 'ERR_INVALID');
    assert.equal(await code({ notification: { topic: 'charging', title: 'x', users: ['1'] } }), 'ERR_INVALID');
    const denied = fakePlugin('car-five', { notify: false, topics: null });
    assert.equal(await code({ message: 'x' }, denied), 'ERR_NOTIFY_DENIED');
  });

  it('30 per hour and plugin, both forms together', async () => {
    const p = fakePlugin('car-six');
    for (let i = 0; i < 15; i++) await call(p, { message: `m${i}` });
    for (let i = 0; i < 15; i++) await call(p, { notification: { topic: 'charging', title: `t${i}` } });
    await assert.rejects(() => call(p, { message: 'one too many' }), (e) => e.code === 'ERR_RATE_LIMIT');
  });

  it('without the email_alerts licence: only the activity row, no push', async () => {
    const p = fakePlugin('car-seven');
    license._overrideForTest({ email_alerts: false });
    try {
      const r = await call(p, { notification: { topic: 'charging', title: 'Fertig' } });
      assert.equal(r.pushed, false);
      assert.equal(H.lastNotification(), null);
      assert.ok(H.db().prepare("SELECT 1 FROM activity_log WHERE message = 'Fahrzeug: Fertig'").get());
    } finally { license._overrideForTest({ email_alerts: true }); }
  });

  it('plugin topics become rules (group plugins) and topics in hello', () => {
    fakePlugin('car-eight');
    const list = rules.list().filter((r) => r.plugin_id === 'car-eight');
    assert.deepEqual(list.map((r) => r.event_id), ['plugin:car-eight:default', 'plugin:car-eight:charging', 'plugin:car-eight:service']);
    assert.deepEqual(list[1].recipients, { admins: false, owner: false, subscribers: true, users: [], groups: [] });
    const topics = require('../src/services/notify/hub').topicsForUser(anna, 'de');
    assert.ok(topics.some((t) => t.id === 'plugin:car-eight:charging' && t.label === 'Fahrzeug · Laden abgeschlossen'));
  });

  it('a disabled plugin rule pushes nothing', async () => {
    const p = fakePlugin('car-nine');
    rules.ensurePluginRule('plugin:car-nine:charging');
    rules.update('plugin:car-nine:charging', { enabled: false });
    const r = await call(p, { notification: { topic: 'charging', title: 'Aus' } });
    assert.equal(r.pushed, false);
  });
});

describe('through the plugin process (bootstrap)', () => {
  it('gc.notify(object) reaches the host as the v2 form', async () => {
    const API = '/api/v1/plugins';
    const buf = helloPackage({ overrides: { notifyTopics: [{ id: 'greeting', label: { de: 'Gruß', en: 'Greeting' } }] } });
    const ins = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf);
    assert.equal(ins.status, 200, JSON.stringify(ins.body));
    const res = await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: ins.body.token, accept: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await require('../src/services/plugins/runtime').waitRunning('hello'), true);
    const r = await agent.post(`${API}/hello/api/notify2`).set('X-CSRF-Token', csrf).send({ topic: 'greeting', title: 'Hallo Welt', body: 'aus dem Plugin' });
    assert.equal(r.status, 200, JSON.stringify(r.body) + JSON.stringify(res.body));
    assert.equal(r.body.result.pushed, true);
    const n = H.lastNotification();
    assert.equal(n.topic, 'plugin:hello:greeting');
    assert.equal(n.title, 'Hallo Welt');
    const bad = await agent.post(`${API}/hello/api/notify2`).set('X-CSRF-Token', csrf).send({ topic: 'undeclared', title: 'x' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'ERR_INVALID');
    // the old string form still works through the process
    await agent.post(`${API}/hello/api/notify`).set('X-CSRF-Token', csrf).send({}).expect(200);
    assert.equal(H.lastNotification().topic, 'plugin:hello:default');
    assert.equal(adminId > 0, true);
  });
});
