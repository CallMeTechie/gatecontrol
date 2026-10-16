'use strict';

// Quick actions of the apps (docs/plugins.md "Quick actions",
// src/services/plugins/quickActions.js, src/routes/api/client/actions.js):
// hooks quickActions / runQuickAction of plugins with `permissions.portal`,
// asked for the device token's owner, every plugin with its own timeout,
// everything a plugin answers validated and capped — widgets (controls of a
// card on the apps' Start tab) and control runs included.

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
    assert.deepEqual(by('light:3'), { plugin: 'hello', pluginName: 'Hallo Welt', id: 'light:3', title: 'Wohnzimmer', subtitle: 'Licht', icon: 'M4 12h16', kind: 'toggle', state: 'on', confirm: true, widget: null });
    assert.deepEqual(by('scene.evening_1-a'), { plugin: 'hello', pluginName: 'Hallo Welt', id: 'scene.evening_1-a', title: 'Abend', subtitle: null, icon: null, kind: 'button', state: null, confirm: false, widget: null });
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
    assert.deepEqual(r.body, { ok: true, message: 'ran light:3', state: 'on', widget: null });
    const last = await kvGet('hello', 'quick-last');
    assert.deepEqual(last, { id: 'light:3', user: { id: anna, name: 'qa-anna', role: 'user', portal: true, loggedIn: true, app: true }, lang: 'de', via: 'app', automation: false });
    const row = lastActivity();
    assert.equal(row.severity, 'info');
    assert.deepEqual(JSON.parse(row.details), { plugin: 'hello', action: 'light:3', userId: anna, ok: true, via: 'app' });

    await kv('hello', 'quick-result', { ok: false, message: 'Gerät\u0007 ' + 'x'.repeat(300), state: 'dim', extra: 'dropped' });
    const bad = await runAction(annaDev, 'hello', 'scene.evening').expect(200);
    assert.deepEqual(Object.keys(bad.body).sort(), ['message', 'ok', 'state', 'widget']);
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.state, null);
    assert.equal(bad.body.widget, null);
    assert.equal(bad.body.message.length, 120);
    assert.ok(bad.body.message.startsWith('Gerät  x'));
    assert.equal(JSON.parse(lastActivity().details).ok, false);
    assert.doesNotMatch(lastActivity().message, /Gerät/, 'no free text of the plugin in the activity log');
    await kv('hello', 'quick-result', null);
  });

  it('source: \'notification\' (the action button of a push) reaches the hook as via; never an automation', async () => {
    await kv('hello', 'quick-result', null);
    const run = (body) => supertest(app).post(`${LIST}/hello/light:3`).set('X-API-Token', annaDev.raw).send(body);
    await run({ source: 'notification' }).expect(200);
    const last = await kvGet('hello', 'quick-last');
    assert.equal(last.via, 'notification');
    assert.equal(last.automation, false);
    assert.equal(last.user.automation, undefined, 'the viewer of a person carries no automation flag');
    assert.equal(JSON.parse(lastActivity().details).via, 'notification');
    await run({ source: 'app' }).expect(200);
    assert.equal((await kvGet('hello', 'quick-last')).via, 'app');
    await run({ source: null }).expect(200);
    assert.equal((await kvGet('hello', 'quick-last')).via, 'app', 'null = app');

    const before = lastActivity().id;
    await kv('hello', 'quick-last', null);
    for (const source of ['automation', 'hello', 'gatecontrol-familie', 'Notification', '', 1, true, ['notification'], { via: 'notification' }]) {
      const r = await run({ source });
      assert.equal(r.status, 400, JSON.stringify(source));
      assert.deepEqual(r.body, { ok: false, error: 'invalid_source' });
    }
    assert.equal(await kvGet('hello', 'quick-last'), null, 'nothing ran');
    assert.equal(lastActivity().id, before, 'nothing logged');
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

// a valid widget of the tests: an air conditioner with a stepper and a choice
const AC_WIDGET = {
  value: '21,5', unit: '°C', status: 'Kühlen · Ziel 22 °C', state: 'on',
  controls: [
    { id: 'target', kind: 'stepper', label: 'Ziel', value: 22, min: 16, max: 30, step: 0.5, unit: '°C' },
    { id: 'mode', kind: 'choice', label: 'Modus', value: 'cool', options: [{ id: 'auto', label: 'Auto' }, { id: 'cool', label: 'Kühlen' }, { id: 'heat', label: 'Heizen' }] },
  ],
};
const AC_SANITISED = {
  value: '21,5', unit: '°C', status: 'Kühlen · Ziel 22 °C', state: 'on',
  controls: [
    { id: 'target', kind: 'stepper', label: 'Ziel', value: 22, min: 16, max: 30, step: 0.5, unit: '°C' },
    { id: 'mode', kind: 'choice', label: 'Modus', value: 'cool', options: [{ id: 'auto', label: 'Auto' }, { id: 'cool', label: 'Kühlen' }, { id: 'heat', label: 'Heizen' }] },
  ],
};
const stepper = (over = {}) => ({ id: 'target', kind: 'stepper', value: 22, min: 16, max: 30, step: 0.5, ...over });
const choice = (over = {}) => ({ id: 'mode', kind: 'choice', value: 'cool', options: [{ id: 'auto', label: 'Auto' }, { id: 'cool', label: 'Kühlen' }], ...over });

describe('widget sanitiser (sanitizeWidget)', () => {
  let sanitizeWidget;
  before(() => { ({ sanitizeWidget } = quickActions); });

  it('a valid widget passes with every field; missing fields become null / []', () => {
    assert.deepEqual(sanitizeWidget(AC_WIDGET), AC_SANITISED);
    assert.deepEqual(sanitizeWidget({}), { value: null, unit: null, status: null, state: null, controls: [] });
    assert.deepEqual(sanitizeWidget({ value: 21.5, controls: null }), { value: 21.5, unit: null, status: null, state: null, controls: [] });
    assert.deepEqual(sanitizeWidget({ controls: [] }).controls, []);
  });

  it('no widget / not an object → null', () => {
    for (const w of [undefined, null, 'x', 42, true, [], [AC_WIDGET]]) assert.equal(sanitizeWidget(w), null, JSON.stringify(w));
    assert.equal(quickActions.sanitize({ id: 'a', title: 'A' }).widget, null, 'an entry without a widget lists widget: null');
    assert.equal(quickActions.sanitize({ id: 'a', title: 'A', widget: 'big' }).widget, null);
    assert.deepEqual(quickActions.sanitize({ id: 'a', title: 'A', widget: AC_WIDGET }).widget, AC_SANITISED);
  });

  it('value: string ≤ 24 (control characters removed) or a finite number, else null; unit ≤ 8, status ≤ 60, state from the set', () => {
    const w = sanitizeWidget({ value: 'A\u0000B ' + 'x'.repeat(40), unit: 'u'.repeat(20), status: 's'.repeat(100), state: 'warn' });
    assert.equal(w.value.length, 24);
    assert.ok(w.value.startsWith('A B x'));
    assert.deepEqual([w.unit.length, w.status.length, w.state], [8, 60, 'warn']);
    assert.equal(sanitizeWidget({ value: 7 }).value, 7);
    assert.equal(sanitizeWidget({ value: -0.5 }).value, -0.5);
    for (const v of [NaN, Infinity, -Infinity, true, {}, [], null, '', '   ']) assert.equal(sanitizeWidget({ value: v }).value, null, String(v));
    for (const st of ['on', 'off', 'good', 'warn', 'crit']) assert.equal(sanitizeWidget({ state: st }).state, st);
    for (const st of ['dim', 'ON', '', 1, null, ['on']]) assert.equal(sanitizeWidget({ state: st }).state, null, String(st));
    assert.equal(sanitizeWidget({ unit: 42 }).unit, '42', 'text() turns a number into its string');
  });

  it('stepper / slider: finite numbers, min < max, step > 0, value clamped, label ≤ 20, unit ≤ 8', () => {
    const ok = (over) => sanitizeWidget({ controls: [stepper(over)] });
    assert.deepEqual(ok({}).controls, [{ id: 'target', kind: 'stepper', label: null, value: 22, min: 16, max: 30, step: 0.5, unit: null }]);
    assert.equal(ok({ kind: 'slider', value: 50, min: 1, max: 100, step: 1 }).controls[0].kind, 'slider');
    assert.equal(ok({ value: 99 }).controls[0].value, 30, 'clamped to max');
    assert.equal(ok({ value: -5 }).controls[0].value, 16, 'clamped to min');
    assert.equal(ok({ value: 16 }).controls[0].value, 16);
    assert.equal(ok({ value: 30 }).controls[0].value, 30);
    assert.equal(ok({ label: 'L'.repeat(50), unit: 'U'.repeat(20) }).controls[0].label.length, 20);
    assert.equal(ok({ label: 'L'.repeat(50), unit: 'U'.repeat(20) }).controls[0].unit.length, 8);
    assert.equal(ok({ label: '' }).controls[0].label, null);
    for (const over of [
      { value: '22' }, { value: NaN }, { value: undefined }, { min: '16' }, { max: Infinity }, { step: 0 }, { step: -1 }, { step: null },
      { min: 30, max: 30 }, { min: 31, max: 30 }, { kind: 'dial' }, { kind: undefined }, { id: 'bad id' }, { id: 'x'.repeat(25) }, { id: '' }, { id: 7 },
    ]) assert.equal(ok(over), null, JSON.stringify(over));
  });

  it('choice: 2–8 options with valid unique ids and labels; an unknown value falls back to the first option', () => {
    const ok = (over) => sanitizeWidget({ controls: [choice(over)] });
    assert.deepEqual(ok({}).controls, [{ id: 'mode', kind: 'choice', label: null, value: 'cool', options: [{ id: 'auto', label: 'Auto' }, { id: 'cool', label: 'Kühlen' }] }]);
    assert.equal(ok({ value: 'heat' }).controls[0].value, 'auto', 'not an option → first option');
    assert.equal(ok({ value: 3 }).controls[0].value, 'auto');
    assert.equal(ok({ value: undefined }).controls[0].value, 'auto');
    assert.equal(ok({ options: [{ id: 'a', label: 'A'.repeat(30) }, { id: 'b', label: 'B' }] }).controls[0].options[0].label.length, 20);
    const eight = Array.from({ length: 8 }, (_, i) => ({ id: 'o' + i, label: 'O' + i }));
    assert.equal(ok({ options: eight }).controls[0].options.length, 8);
    for (const options of [
      undefined, null, 'x', [], [{ id: 'a', label: 'A' }], [...eight, { id: 'o8', label: 'O8' }],
      [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }], [{ id: 'a', label: 'A' }, { id: 'bad id', label: 'B' }],
      [{ id: 'a', label: 'A' }, { id: 'b' }], [{ id: 'a', label: 'A' }, { id: 'b', label: '' }], [{ id: 'a', label: 'A' }, 'b'], [{ id: 'a', label: 'A' }, null],
    ]) assert.equal(ok({ options }), null, JSON.stringify(options));
    assert.equal(sanitizeWidget({ controls: [stepper({ kind: 'choice' })] }), null, 'a choice needs options');
  });

  it('controls: at most 4, unique ids, a list; one bad control makes the whole widget null', () => {
    const four = Array.from({ length: 4 }, (_, i) => stepper({ id: 'c' + i }));
    assert.equal(sanitizeWidget({ controls: four }).controls.length, 4);
    assert.equal(sanitizeWidget({ controls: [...four, stepper({ id: 'c4' })] }), null, 'five');
    assert.equal(sanitizeWidget({ controls: [stepper(), stepper()] }), null, 'duplicate ids');
    assert.equal(sanitizeWidget({ controls: [stepper(), choice({ id: 'target' })] }), null, 'duplicate ids across kinds');
    assert.equal(sanitizeWidget({ value: 1, controls: [stepper(), 'x'] }), null);
    assert.equal(sanitizeWidget({ value: 1, controls: [stepper(), null] }), null);
    assert.equal(sanitizeWidget({ value: 1, controls: [stepper(), stepper({ id: 'b', step: 0 })] }), null);
    for (const controls of ['x', 42, {}, { 0: stepper() }, true]) assert.equal(sanitizeWidget({ value: 1, controls }), null, JSON.stringify(controls));
    const a = quickActions.sanitize({ id: 'ac', title: 'Klima', widget: { controls: [stepper({ step: 0 })] } });
    assert.deepEqual([a.id, a.title, a.widget], ['ac', 'Klima', null], 'the entry stays, its widget is null');
  });
});

describe('widgets in the list and control runs', () => {
  const ACTIONS = [
    { id: 'ac:7', title: 'Wohnzimmer', subtitle: 'Klima', kind: 'toggle', state: 'on', widget: AC_WIDGET },
    { id: 'lamp', title: 'Lampe', kind: 'toggle', state: 'off', widget: { value: 'Aus', state: 'off', controls: [{ id: 'bri', kind: 'slider', value: 100, min: 1, max: 100, step: 1, unit: '%' }] } },
    { id: 'broken', title: 'Kaputt', widget: { value: 5, controls: [{ id: 'x', kind: 'stepper', value: 1, min: 1, max: 0, step: 1 }] } },
    { id: 'plain', title: 'Knopf' },
  ];
  // own devices of anna: the route allows 30 runs per minute and token (400s count)
  let devA, devB;
  const runCtl = (id, body, dev = devA) => supertest(app).post(`${LIST}/hello/${encodeURIComponent(id)}`).set('X-API-Token', dev.raw).send(body);
  before(async () => {
    devA = H.makeDevice(anna, { name: 'qa-widget-a' });
    devB = H.makeDevice(anna, { name: 'qa-widget-b' });
    await kv('hello', 'quick-actions', ACTIONS);
    await kv('hello', 'quick-mode', null);
    await kv('hello', 'quick-run-mode', null);
    await kv('hello', 'quick-result', null);
  });
  after(async () => {
    await kv('hello', 'quick-result', null);
    // the list the suites after this one expect
    await kv('hello', 'quick-actions', [{ id: 'light:3', title: 'Licht', kind: 'toggle', state: 'off' }, { id: 'scene.evening', title: 'Abend' }]);
  });

  it('GET lists the sanitised widget of every action (null without one or with an invalid one)', async () => {
    const r = await list(annaDev).expect(200);
    const by = (id) => r.body.actions.find((a) => a.plugin === 'hello' && a.id === id);
    assert.deepEqual(by('ac:7').widget, AC_SANITISED);
    assert.deepEqual(by('lamp').widget, { value: 'Aus', unit: null, status: null, state: 'off', controls: [{ id: 'bri', kind: 'slider', label: null, value: 100, min: 1, max: 100, step: 1, unit: '%' }] });
    assert.equal(by('broken').widget, null, 'invalid widget → null, the action stays');
    assert.equal(by('broken').title, 'Kaputt');
    assert.equal(by('plain').widget, null);
    assert.deepEqual(Object.keys(by('plain')).sort(), ['confirm', 'icon', 'id', 'kind', 'plugin', 'pluginName', 'state', 'subtitle', 'title', 'widget']);
  });

  it('a control run reaches the hook with control and value (validated) and answers the sanitised widget', async () => {
    await kv('hello', 'quick-result', { ok: true, message: 'Ziel 23', state: 'on', widget: { ...AC_WIDGET, value: 23.0, status: 'S'.repeat(80), controls: [{ ...AC_WIDGET.controls[0], value: 23 }] } });
    const r = await runCtl('ac:7', { control: 'target', value: 23 }).expect(200);
    assert.deepEqual(r.body, {
      ok: true, message: 'Ziel 23', state: 'on',
      widget: { value: 23, unit: '°C', status: 'S'.repeat(60), state: 'on', controls: [{ id: 'target', kind: 'stepper', label: 'Ziel', value: 23, min: 16, max: 30, step: 0.5, unit: '°C' }] },
    });
    const last = await kvGet('hello', 'quick-last');
    assert.deepEqual(last, { id: 'ac:7', user: { id: anna, name: 'qa-anna', role: 'user', portal: true, loggedIn: true, app: true }, lang: 'de', via: 'app', automation: false, control: 'target', value: 23 });
    const row = lastActivity();
    assert.deepEqual(JSON.parse(row.details), { plugin: 'hello', action: 'ac:7', userId: anna, ok: true, via: 'app', control: 'target' });
    assert.ok(!row.details.includes('23'), 'the value never reaches the activity log');

    // a choice: the option id reaches the hook as a string; source still works beside it
    await kv('hello', 'quick-result', null);
    await runCtl('ac:7', { control: 'mode', value: 'heat', source: 'notification' }).expect(200);
    const l2 = await kvGet('hello', 'quick-last');
    assert.deepEqual([l2.control, l2.value, l2.via], ['mode', 'heat', 'notification']);
    assert.equal(JSON.parse(lastActivity().details).control, 'mode');

    // the slider at its bounds
    await runCtl('lamp', { control: 'bri', value: 1 }).expect(200);
    assert.equal((await kvGet('hello', 'quick-last')).value, 1);
    await runCtl('lamp', { control: 'bri', value: 100 }).expect(200);
    assert.equal((await kvGet('hello', 'quick-last')).value, 100);
    await runCtl('ac:7', { control: 'target', value: 22.5 }).expect(200);
    assert.equal((await kvGet('hello', 'quick-last')).value, 22.5);
  });

  it('a plain run has neither control nor value in the hook payload; the answer\'s widget is sanitised or null', async () => {
    await kv('hello', 'quick-result', { ok: true, widget: AC_WIDGET });
    const r = await runCtl('ac:7', {}).expect(200);
    assert.deepEqual(r.body, { ok: true, message: null, state: null, widget: AC_SANITISED });
    const last = await kvGet('hello', 'quick-last');
    assert.ok(!('control' in last) && !('value' in last), 'no control / value keys in the payload');
    assert.equal(JSON.parse(lastActivity().details).control, undefined, 'no control in the log');
    await runCtl('ac:7', { control: null, value: 5 }).expect(200);
    assert.ok(!('control' in await kvGet('hello', 'quick-last')), 'control: null = a plain run; a stray value is ignored');
    await runCtl('plain', { value: 5 }).expect(200);
    assert.ok(!('control' in await kvGet('hello', 'quick-last')));

    for (const widget of [{ controls: [{ id: 'x', kind: 'stepper', value: 1, min: 2, max: 1, step: 1 }] }, 'x', 42, [AC_WIDGET]]) {
      await kv('hello', 'quick-result', { ok: true, widget });
      assert.equal((await runCtl('ac:7', {}).expect(200)).body.widget, null, JSON.stringify(widget));
    }
    await kv('hello', 'quick-result', null);
  });

  it('400 invalid_control: not a control of that action (or the action has no widget); nothing runs, nothing is logged', async () => {
    await kv('hello', 'quick-last', null);
    const before = lastActivity().id;
    for (const [id, control] of [['ac:7', 'bri'], ['ac:7', 'Target'], ['ac:7', ''], ['ac:7', 7], ['ac:7', true], ['ac:7', ['target']], ['ac:7', { id: 'target' }], ['lamp', 'target'], ['broken', 'x'], ['plain', 'target']]) {
      const r = await runCtl(id, { control, value: 20 });
      assert.equal(r.status, 400, `${id} ${JSON.stringify(control)}`);
      assert.deepEqual(r.body, { ok: false, error: 'invalid_control' });
    }
    assert.equal(await kvGet('hello', 'quick-last'), null, 'nothing ran');
    assert.equal(lastActivity().id, before, 'nothing logged');
  });

  it('400 invalid_value: outside min..max, not a finite number, not an option id', async () => {
    await kv('hello', 'quick-last', null);
    const before = lastActivity().id;
    for (const [id, control, value] of [
      ['ac:7', 'target', 15.5], ['ac:7', 'target', 30.5], ['ac:7', 'target', '22'], ['ac:7', 'target', undefined], ['ac:7', 'target', null], ['ac:7', 'target', true], ['ac:7', 'target', [22]], ['ac:7', 'target', { v: 22 }],
      ['lamp', 'bri', 0], ['lamp', 'bri', 101], ['lamp', 'bri', 'max'],
      ['ac:7', 'mode', 'dry'], ['ac:7', 'mode', 'Cool'], ['ac:7', 'mode', 1], ['ac:7', 'mode', undefined], ['ac:7', 'mode', ['cool']],
    ]) {
      const r = await runCtl(id, { control, value }, devB);
      assert.equal(r.status, 400, `${id} ${control} ${JSON.stringify(value)}`);
      assert.deepEqual(r.body, { ok: false, error: 'invalid_value' });
    }
    assert.equal(await kvGet('hello', 'quick-last'), null, 'nothing ran');
    assert.equal(lastActivity().id, before, 'nothing logged');
  });

  it('404 before 400: an unlisted action with a control; invalid_source wins over the control', async () => {
    assert.deepEqual((await runCtl('ac:8', { control: 'target', value: 22 }, devB).expect(404)).body, { ok: false, error: 'not_found' });
    assert.deepEqual((await runCtl('ac:7', { control: 'nope', value: 22, source: 'automation' }, devB).expect(400)).body, { ok: false, error: 'invalid_source' });
  });

  it('hook level: run() with opts.control / opts.value; gc.actions.run style calls (no opts) stay plain', async () => {
    const user = { id: anna, name: 'qa-anna', role: 'user', portal: true, loggedIn: true, app: true };
    await kv('hello', 'quick-result', { ok: true, widget: { value: 'x' } });
    const r = await quickActions.run('hello', 'ac:7', user, 'de', { control: 'mode', value: 'auto' });
    assert.deepEqual(r, { status: 200, body: { ok: true, message: null, state: null, widget: { value: 'x', unit: null, status: null, state: null, controls: [] } } });
    assert.deepEqual([(await kvGet('hello', 'quick-last')).control, (await kvGet('hello', 'quick-last')).value], ['mode', 'auto']);
    assert.deepEqual(await quickActions.run('hello', 'ac:7', user, 'de', { control: 'mode', value: 'nope' }), { status: 400, body: { ok: false, error: 'invalid_value' } });
    assert.deepEqual(await quickActions.run('hello', 'ac:7', user, 'de', { control: 'x', value: 1 }), { status: 400, body: { ok: false, error: 'invalid_control' } });
    assert.deepEqual(await quickActions.run('hello', 'plain', user, 'de', { control: 'x', value: 1 }), { status: 400, body: { ok: false, error: 'invalid_control' } });
    const plain = await quickActions.run('hello', 'ac:7', user, 'de');
    assert.equal(plain.status, 200);
    assert.ok(!('control' in await kvGet('hello', 'quick-last')));
    await kv('hello', 'quick-result', null);
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
