'use strict';

// Quick actions of the apps (docs/plugins.md "Quick actions",
// src/services/plugins/quickActions.js, src/routes/api/client/actions.js):
// hooks quickActions / runQuickAction of plugins with `permissions.portal`,
// asked for the device token's owner, every plugin with its own timeout,
// everything a plugin answers validated and capped.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');

let app, agent, csrf, runtime, plugins, quickActions, anna, annaDev, annaEn, adminId;
const API = '/api/v1/plugins';
const LIST = '/api/v1/client/actions';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}
const kv = (id, key, value) => agent.post(`${API}/${id}/api/kv`).set('X-CSRF-Token', csrf).send({ key, value }).expect(200);
const kvGet = async (id, key) => (await agent.get(`${API}/${id}/api/kv`).query({ key }).expect(200)).body.value;

// "hello-two": a second plugin with the portal permission; "hello-np": one without
function twoOverrides() { return { id: 'hello-two', name: { de: 'Zweites', en: 'Second' } }; }
function noPortalOverrides() {
  const permissions = JSON.parse(JSON.stringify(helloManifest.permissions));
  delete permissions.portal;
  const ui = JSON.parse(JSON.stringify(helloManifest.ui));
  delete ui.portal;
  return { id: 'hello-np', name: 'Ohne Portal', permissions, ui };
}

const list = (dev, q = {}) => supertest(app).get(LIST).query(q).set('X-API-Token', dev.raw);
const runAction = (dev, plugin, id) => supertest(app).post(`${LIST}/${plugin}/${encodeURIComponent(id)}`).set('X-API-Token', dev.raw).send({});
const lastActivity = () => H.db().prepare("SELECT * FROM activity_log WHERE event_type = 'plugin_quick_action' ORDER BY id DESC LIMIT 1").get();

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  quickActions = require('../src/services/plugins/quickActions');
  adminId = H.db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  anna = H.makeUser('qa-anna', { language: 'de' });
  annaDev = H.makeDevice(anna, { name: 'qa-anna-phone' });
  annaEn = H.makeDevice(H.makeUser('qa-en', { language: 'en' }), { name: 'qa-en-phone' });
  await install(helloPackage());
  await install(helloPackage({ overrides: twoOverrides() }));
  await install(helloPackage({ overrides: noPortalOverrides() }));
  for (const id of ['hello', 'hello-two', 'hello-np']) assert.equal(await runtime.waitRunning(id), true, id);
  await kv('hello-two', 'quick-actions', [{ id: 'scene:evening', title: 'Abend' }]);
  await kv('hello-np', 'quick-actions', [{ id: 'np', title: 'Nicht erlaubt' }]);
});
after(async () => { await plugins.stop(); teardown(); });

describe('GET /api/v1/client/actions', () => {
  it('declarative actions of every plugin with the portal permission, validated and capped', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: 'extra-' + i, title: 'Extra ' + i }));
    await kv('hello', 'quick-actions', [
      { id: 'light:3', title: 'Wohnzimmer', subtitle: 'Licht', icon: 'M4 12h16', kind: 'toggle', state: 'on', confirm: true },
      { id: 'scene.evening_1-a', title: 'Abend', state: 'on', confirm: 'yes' },
      { id: 'heater', title: 'Heizung', kind: 'toggle', state: 'dim', icon: '<script>alert(1)</script>' },
      { id: 'ctl', title: 'A\u0000B\u0007C', subtitle: 'S'.repeat(100) },
      { id: 'long', title: 'T'.repeat(100), icon: 'M' + '1 '.repeat(999) },
      { id: 'bad id', title: 'space in id' },
      { id: 'x'.repeat(65), title: 'id too long' },
      { id: 'notitle', title: '' },
      { id: 'slider', title: 'Regler', kind: 'slider' },
      { id: 'light:3', title: 'duplicate' },
      { id: 'viewer', title: '$viewer' },
      null, 'x', 42, [],
      ...many,
    ]);
    const r = await list(annaDev).expect(200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.body.ok, true);
    const mine = r.body.actions.filter((a) => a.plugin === 'hello');
    assert.equal(mine.length, 16, 'at most 16 per plugin');
    const by = (id) => mine.find((a) => a.id === id);
    assert.deepEqual(by('light:3'), { plugin: 'hello', pluginName: 'Hallo Welt', id: 'light:3', title: 'Wohnzimmer', subtitle: 'Licht', icon: 'M4 12h16', kind: 'toggle', state: 'on', confirm: true });
    assert.deepEqual(by('scene.evening_1-a'), { plugin: 'hello', pluginName: 'Hallo Welt', id: 'scene.evening_1-a', title: 'Abend', subtitle: null, icon: null, kind: 'button', state: null, confirm: false });
    assert.deepEqual([by('heater').state, by('heater').icon], [null, null]);
    assert.deepEqual([by('ctl').title, by('ctl').subtitle.length], ['A B C', 60]);
    assert.deepEqual([by('long').title.length, by('long').icon.length], [40, 1999]);
    assert.equal(by('viewer').title, `v${anna} true/true/true de`, 'the token owner as portal viewer, logged in, from the app');
    for (const id of ['bad id', 'x'.repeat(65), 'notitle', 'slider']) assert.equal(by(id), undefined, id);
    assert.equal(mine.filter((a) => a.id === 'light:3').length, 1, 'duplicate ids dropped');
    assert.deepEqual(r.body.actions.filter((a) => a.plugin === 'hello-two').map((a) => [a.id, a.pluginName, a.kind]), [['scene:evening', 'Zweites', 'button']]);
    assert.ok(!r.body.actions.some((a) => a.plugin === 'hello-np'), 'a plugin without permissions.portal is never asked');
  });

  it('language: ?lang, else the owner\'s setting, else Accept-Language', async () => {
    await kv('hello', 'quick-actions', [{ id: 'viewer', title: '$viewer' }]);
    const name = (r) => r.body.actions.find((a) => a.plugin === 'hello').pluginName;
    const en = await list(annaEn).expect(200);
    assert.equal(name(en), 'Hello World');
    assert.match(en.body.actions.find((a) => a.plugin === 'hello').title, / en$/);
    assert.equal(name(await list(annaEn, { lang: 'de' }).expect(200)), 'Hallo Welt');
    assert.equal(name(await list(annaDev).set('Accept-Language', 'en').expect(200)), 'Hallo Welt', 'the owner\'s setting wins over the header');
  });

  it('a slow, throwing or garbage-answering plugin only loses its own actions', async () => {
    await kv('hello', 'quick-actions', [{ id: 'a', title: 'A' }]);
    for (const mode of ['slow', 'throw', 'garbage']) {
      await kv('hello', 'quick-mode', mode);
      const t0 = Date.now();
      const r = await list(annaDev).expect(200);
      assert.ok(Date.now() - t0 < 4500, `${mode}: answered after the timeout, not after the plugin`);
      assert.deepEqual(r.body.actions.map((a) => a.plugin), ['hello-two'], mode);
    }
    await kv('hello', 'quick-mode', null);
  });

  it('a disabled plugin is not asked', async () => {
    await agent.post(`${API}/hello-two/disable`).set('X-CSRF-Token', csrf).expect(200);
    try {
      const r = await list(annaDev).expect(200);
      assert.ok(!r.body.actions.some((a) => a.plugin === 'hello-two'));
      assert.equal((await runAction(annaDev, 'hello-two', 'scene:evening')).status, 404);
    } finally {
      await agent.post(`${API}/hello-two/enable`).set('X-CSRF-Token', csrf).expect(200);
      assert.equal(await runtime.waitRunning('hello-two'), true);
    }
  });
});

describe('POST /api/v1/client/actions/:plugin/:id', () => {
  before(async () => {
    await kv('hello', 'quick-actions', [{ id: 'light:3', title: 'Licht', kind: 'toggle', state: 'off' }, { id: 'scene.evening', title: 'Abend' }]);
    await kv('hello', 'quick-mode', null);
  });

  it('runs a listed action for the token owner and answers the sanitised result', async () => {
    await kv('hello', 'quick-result', null);
    const r = await runAction(annaDev, 'hello', 'light:3').expect(200);
    assert.deepEqual(r.body, { ok: true, message: 'ran light:3', state: 'on' });
    const last = await kvGet('hello', 'quick-last');
    assert.deepEqual(last, { id: 'light:3', user: { id: anna, name: 'qa-anna', role: 'user', portal: true, loggedIn: true, app: true }, lang: 'de' });
    const row = lastActivity();
    assert.equal(row.severity, 'info');
    assert.deepEqual(JSON.parse(row.details), { plugin: 'hello', action: 'light:3', userId: anna, ok: true });

    await kv('hello', 'quick-result', { ok: false, message: 'Gerät\u0007 ' + 'x'.repeat(300), state: 'dim', extra: 'dropped' });
    const bad = await runAction(annaDev, 'hello', 'scene.evening').expect(200);
    assert.deepEqual(Object.keys(bad.body).sort(), ['message', 'ok', 'state']);
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.state, null);
    assert.equal(bad.body.message.length, 120);
    assert.ok(bad.body.message.startsWith('Gerät  x'));
    assert.equal(JSON.parse(lastActivity().details).ok, false);
    assert.doesNotMatch(lastActivity().message, /Gerät/, 'no free text of the plugin in the activity log');
    await kv('hello', 'quick-result', null);
  });

  it('404 for an unknown plugin, an action the plugin does not list and a plugin without the portal permission', async () => {
    const before = lastActivity().id;
    for (const [plugin, id] of [['nope', 'light:3'], ['hello', 'light:4'], ['hello', 'bad id'], ['hello', 'x'.repeat(65)], ['hello-np', 'np'], ['Hello', 'light:3']]) {
      const r = await runAction(annaDev, plugin, id);
      assert.equal(r.status, 404, `${plugin}/${id}`);
      assert.deepEqual(r.body, { ok: false, error: 'not_found' });
    }
    assert.equal(lastActivity().id, before, 'unknown actions are not logged');
    assert.equal(await kvGet('hello-np', 'quick-last'), null, 'never run');
  });

  it('502 when the plugin fails or answers garbage, 504 when it does not answer in time', async () => {
    quickActions._setRunTimeoutForTest(1500);
    try {
      for (const [mode, status, error] of [['throw', 502, 'plugin_error'], ['garbage', 502, 'plugin_error'], ['slow', 504, 'timeout']]) {
        await kv('hello', 'quick-run-mode', mode);
        const r = await runAction(annaDev, 'hello', 'light:3');
        assert.equal(r.status, status, mode);
        assert.deepEqual(r.body, { ok: false, error }, mode);
        assert.equal(JSON.parse(lastActivity().details).ok, false);
      }
      await kv('hello', 'quick-run-mode', null);
      await kv('hello', 'quick-mode', 'slow');
      assert.deepEqual((await runAction(annaDev, 'hello', 'light:3').expect(504)).body, { ok: false, error: 'timeout' }, 'listing timed out');
    } finally {
      quickActions._setRunTimeoutForTest(null);
      await kv('hello', 'quick-run-mode', null);
      await kv('hello', 'quick-mode', null);
    }
  });

  it('30 runs per minute and device', async () => {
    const dev = H.makeDevice(anna, { name: 'qa-rate' });
    for (let i = 0; i < 30; i += 1) await runAction(dev, 'hello', 'scene.evening').expect(200);
    assert.deepEqual((await runAction(dev, 'hello', 'scene.evening').expect(429)).body, { ok: false, error: 'rate_limited' });
    await list(dev).expect(200);
  });
});

describe('auth', () => {
  it('401 without a token, 403 for a session and for tokens without the client scope', async () => {
    await supertest(app).get(LIST).expect(401);
    await supertest(app).post(`${LIST}/hello/light:3`).send({}).expect(401);
    assert.equal((await agent.get(LIST).expect(403)).body.error, 'token_required');
    const peersOnly = H.makeDevice(anna, { name: 'qa-peers', scopes: ['peers'] });
    await list(peersOnly).expect(403);
    await runAction(peersOnly, 'hello', 'light:3').expect(403);
    const ro = H.makeDevice(adminId, { name: 'qa-ro', scopes: ['read-only'] });
    assert.equal((await list(ro).expect(403)).body.error, 'scope_required');
  });

  it('full-access tokens work like client tokens', async () => {
    const dev = H.makeDevice(adminId, { name: 'qa-full', scopes: ['full-access'] });
    const r = await list(dev).expect(200);
    assert.ok(r.body.actions.some((a) => a.plugin === 'hello' && a.id === 'light:3'));
    await runAction(dev, 'hello', 'light:3').expect(200);
    assert.equal((await kvGet('hello', 'quick-last')).user.id, adminId);
  });

  it('a token without an owner: no actions, 403 for a run', async () => {
    const dev = H.makeDevice(null, { name: 'qa-noowner', app: false });
    const r = await list(dev).expect(200);
    assert.deepEqual(r.body, { ok: true, actions: [] });
    assert.deepEqual((await runAction(dev, 'hello', 'light:3').expect(403)).body, { ok: false, error: 'no_user' });
  });
});
