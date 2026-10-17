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
    assert.deepEqual(by('light:3'), { plugin: 'hello', pluginName: 'Hallo Welt', id: 'light:3', title: 'Wohnzimmer', subtitle: 'Licht', icon: 'M4 12h16', kind: 'toggle', state: 'on', confirm: true, confirmWhen: null, look: null, verbs: null, targets: false, device: null, widget: null });
    assert.deepEqual(by('scene.evening_1-a'), { plugin: 'hello', pluginName: 'Hallo Welt', id: 'scene.evening_1-a', title: 'Abend', subtitle: null, icon: null, kind: 'button', state: null, confirm: false, confirmWhen: null, look: null, verbs: null, targets: false, device: null, widget: null });
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
    assert.deepEqual(r.body, { ok: true, message: 'ran light:3', state: 'on', widget: null, unchanged: false });
    const last = await kvGet('hello', 'quick-last');
    assert.deepEqual(last, { id: 'light:3', user: { id: anna, name: 'qa-anna', role: 'user', portal: true, loggedIn: true, app: true }, lang: 'de', via: 'app', automation: false });
    const row = lastActivity();
    assert.equal(row.severity, 'info');
    assert.deepEqual(JSON.parse(row.details), { plugin: 'hello', action: 'light:3', userId: anna, ok: true, via: 'app' });

    await kv('hello', 'quick-result', { ok: false, message: 'Gerät\u0007 ' + 'x'.repeat(300), state: 'dim', extra: 'dropped' });
    const bad = await runAction(annaDev, 'hello', 'scene.evening').expect(200);
    assert.deepEqual(Object.keys(bad.body).sort(), ['message', 'ok', 'state', 'unchanged', 'widget']);
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
    { id: 'mode', kind: 'choice', label: 'Modus', value: 'cool', options: [{ id: 'auto', label: 'Auto' }, { id: 'cool', label: 'Kühlen', icon: 'M12 2v20M2 12h20' }, { id: 'heat', label: 'Heizen', icon: '<svg/>' }] },
  ],
};
// a sanitised widget: every key, with the defaults for what the plugin left out
const W = (over = {}) => ({ label: null, value: null, unit: null, status: null, state: null, readings: [], controls: [], power: true, ...over });
const AC_SANITISED = {
  label: null, value: '21,5', unit: '°C', status: 'Kühlen · Ziel 22 °C', state: 'on', readings: [], power: true,
  controls: [
    { id: 'target', kind: 'stepper', label: 'Ziel', value: 22, min: 16, max: 30, step: 0.5, unit: '°C' },
    { id: 'mode', kind: 'choice', label: 'Modus', value: 'cool', options: [{ id: 'auto', label: 'Auto', icon: null }, { id: 'cool', label: 'Kühlen', icon: 'M12 2v20M2 12h20' }, { id: 'heat', label: 'Heizen', icon: null }] },
  ],
};
const stepper = (over = {}) => ({ id: 'target', kind: 'stepper', value: 22, min: 16, max: 30, step: 0.5, ...over });
const choice = (over = {}) => ({ id: 'mode', kind: 'choice', value: 'cool', options: [{ id: 'auto', label: 'Auto' }, { id: 'cool', label: 'Kühlen' }], ...over });

describe('widget sanitiser (sanitizeWidget)', () => {
  let sanitizeWidget;
  before(() => { ({ sanitizeWidget } = quickActions); });

  it('a valid widget passes with every field; missing fields become null / []', () => {
    assert.deepEqual(sanitizeWidget(AC_WIDGET), AC_SANITISED);
    assert.deepEqual(sanitizeWidget({}), W());
    assert.deepEqual(sanitizeWidget({ value: 21.5, controls: null }), W({ value: 21.5 }));
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
    assert.deepEqual(ok({}).controls, [{ id: 'mode', kind: 'choice', label: null, value: 'cool', options: [{ id: 'auto', label: 'Auto', icon: null }, { id: 'cool', label: 'Kühlen', icon: null }] }]);
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

  it('choice: an option carries an icon (SVG path) — valid kept, invalid or missing → null, the option stays', () => {
    const SNOW = 'M12 2v20M2 12h20M5 5l14 14M19 5L5 19';
    const w = sanitizeWidget({ controls: [choice({ options: [
      { id: 'auto', label: 'Auto', icon: SNOW },
      { id: 'cool', label: 'Kühlen', icon: '<svg onload="x">' },
      { id: 'heat', label: 'Heizen' },
      { id: 'dry', label: 'Trocken', icon: 42 },
      { id: 'fan', label: 'Lüften', icon: 'M'.repeat(2001) },
    ] })] });
    assert.ok(w, 'an invalid icon never drops the control');
    assert.deepEqual(w.controls[0].options, [
      { id: 'auto', label: 'Auto', icon: SNOW },
      { id: 'cool', label: 'Kühlen', icon: null },
      { id: 'heat', label: 'Heizen', icon: null },
      { id: 'dry', label: 'Trocken', icon: null },
      { id: 'fan', label: 'Lüften', icon: null },
    ]);
    const a = quickActions.sanitize({ id: 'ac', title: 'Klima', widget: { controls: [choice({ options: [{ id: 'auto', label: 'Auto', icon: SNOW }, { id: 'cool', label: 'Kühlen', icon: '"><script>' }] })] } });
    assert.deepEqual(a.widget.controls[0].options, [{ id: 'auto', label: 'Auto', icon: SNOW }, { id: 'cool', label: 'Kühlen', icon: null }], 'the listed entry carries the icons');
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
    assert.deepEqual(by('lamp').widget, { label: null, value: 'Aus', unit: null, status: null, state: 'off', readings: [], power: true, controls: [{ id: 'bri', kind: 'slider', label: null, value: 100, min: 1, max: 100, step: 1, unit: '%' }] });
    assert.equal(by('broken').widget, null, 'invalid widget → null, the action stays');
    assert.equal(by('broken').title, 'Kaputt');
    assert.equal(by('plain').widget, null);
    assert.deepEqual(Object.keys(by('plain')).sort(), ['confirm', 'confirmWhen', 'device', 'icon', 'id', 'kind', 'look', 'plugin', 'pluginName', 'state', 'subtitle', 'targets', 'title', 'verbs', 'widget']);
  });

  it('a control run reaches the hook with control and value (validated) and answers the sanitised widget', async () => {
    await kv('hello', 'quick-result', { ok: true, message: 'Ziel 23', state: 'on', widget: { ...AC_WIDGET, value: 23.0, status: 'S'.repeat(80), controls: [{ ...AC_WIDGET.controls[0], value: 23 }] } });
    const r = await runCtl('ac:7', { control: 'target', value: 23 }).expect(200);
    assert.deepEqual(r.body, {
      ok: true, message: 'Ziel 23', state: 'on',
      widget: W({ value: 23, unit: '°C', status: 'S'.repeat(60), state: 'on', controls: [{ id: 'target', kind: 'stepper', label: 'Ziel', value: 23, min: 16, max: 30, step: 0.5, unit: '°C' }] }),
      unchanged: false,
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
    assert.deepEqual(r.body, { ok: true, message: null, state: null, widget: AC_SANITISED, unchanged: false });
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
    assert.deepEqual(r, { status: 200, body: { ok: true, message: null, state: null, widget: W({ value: 'x' }), unchanged: false } });
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

const LOCK_CLOSED = 'M6 10V7a6 6 0 0 1 12 0v3';
const LOCK_OPEN = 'M6 10V7a6 6 0 0 1 11-3';

describe('devices, looks and confirmWhen (sanitize)', () => {
  const toggle = (over = {}) => quickActions.sanitize({ id: 'lock:1', title: 'Schloss', kind: 'toggle', state: 'on', ...over });
  const button = (over = {}) => quickActions.sanitize({ id: 'b', title: 'Knopf', ...over });

  it('device: { id, title, subtitle, icon } with every key; invalid → null, the action stays', () => {
    assert.deepEqual(toggle({ device: { id: 'v:42', title: 'Familienauto', subtitle: 'Enyaq', icon: 'M4 12h16' } }).device, { id: 'v:42', title: 'Familienauto', subtitle: 'Enyaq', icon: 'M4 12h16' });
    assert.deepEqual(button({ device: { id: 'r:a.b_c-1', title: 'Licht' } }).device, { id: 'r:a.b_c-1', title: 'Licht', subtitle: null, icon: null }, 'buttons have devices too');
    const d = button({ device: { id: 'x'.repeat(64), title: 'T\u0000' + 'x'.repeat(60), subtitle: 'S'.repeat(80), icon: '<svg/>', extra: 1 } }).device;
    assert.deepEqual([d.id.length, d.title.length, d.title.slice(0, 3), d.subtitle.length, d.icon, 'extra' in d], [64, 40, 'T x', 60, null, false]);
    assert.equal(button({ device: { id: 'd', title: 'D', icon: 'M' + '1 '.repeat(999) } }).device.icon.length, 1999, 'icons like the action icon (≤ 2000)');
    for (const device of [
      undefined, null, 'v:42', 42, true, [], [{ id: 'v', title: 'V' }], {}, { id: 'v:42' }, { title: 'Auto' }, { id: 'v:42', title: '' }, { id: 'v:42', title: '  ' },
      { id: 'bad id', title: 'A' }, { id: 'x'.repeat(65), title: 'A' }, { id: '', title: 'A' }, { id: 7, title: 'A' }, { id: 'v/1', title: 'A' },
    ]) {
      const a = button({ device });
      assert.equal(a.device, null, JSON.stringify(device));
      assert.deepEqual([a.id, a.title], ['b', 'Knopf'], 'the action stays');
    }
    assert.deepEqual(button({ device: { id: 'n', title: 42 } }).device.title, '42', 'text() turns a number into its string');
  });

  it('look (toggles only): { on, off } of { icon, tone }; a part without a valid icon or tone is null, both null → null', () => {
    const LOOK = { on: { icon: LOCK_CLOSED, tone: 'good' }, off: { icon: LOCK_OPEN, tone: 'crit' } };
    assert.deepEqual(toggle({ look: LOOK }).look, LOOK);
    assert.deepEqual(toggle({ look: { on: { tone: 'warn' } } }).look, { on: { icon: null, tone: 'warn' }, off: null });
    assert.deepEqual(toggle({ look: { off: { icon: LOCK_OPEN } } }).look, { on: null, off: { icon: LOCK_OPEN, tone: null } });
    assert.deepEqual(toggle({ look: { on: { icon: '<script>', tone: 'neutral' }, off: { icon: LOCK_OPEN, tone: 'red' } } }).look, { on: { icon: null, tone: 'neutral' }, off: { icon: LOCK_OPEN, tone: null } });
    for (const tone of ['good', 'warn', 'crit', 'neutral']) assert.equal(toggle({ look: { on: { tone } } }).look.on.tone, tone);
    assert.deepEqual(toggle({ look: { on: { icon: 'M1 1', tone: 'good', extra: 1 }, extra: 2 } }).look, { on: { icon: 'M1 1', tone: 'good' }, off: null }, 'unknown keys dropped');
    for (const look of [
      undefined, null, 'x', 42, [], [LOOK], {}, { on: null, off: null }, { on: 'good' }, { on: { tone: 'on' } }, { on: { icon: '<x>', tone: 'GOOD' } }, { on: {}, off: [] }, { on: [{ tone: 'good' }] },
    ]) assert.equal(toggle({ look }).look, null, JSON.stringify(look));
    assert.equal(button({ look: LOOK }).look, null, 'buttons never have a look');
    assert.equal(quickActions.sanitizeLook(LOOK).on.tone, 'good', 'exported for the tests');
  });

  it('confirmWhen (toggles only): \'on\' | \'off\', else null; confirm stays independent', () => {
    assert.deepEqual([toggle({ confirmWhen: 'off' }).confirmWhen, toggle({ confirmWhen: 'off' }).confirm], ['off', false]);
    assert.deepEqual([toggle({ confirm: true, confirmWhen: 'on' }).confirmWhen, toggle({ confirm: true, confirmWhen: 'on' }).confirm], ['on', true]);
    for (const v of [undefined, null, 'ON', 'both', '', true, 1, ['off']]) assert.equal(toggle({ confirmWhen: v }).confirmWhen, null, JSON.stringify(v));
    assert.equal(button({ confirmWhen: 'off' }).confirmWhen, null, 'buttons: always null');
    assert.equal(button({ confirmWhen: 'off', confirm: true }).confirm, true);
  });

  it('verbs (toggles only): { on, off }, each trimmed 1–20 characters without control characters, both required, else null', () => {
    assert.deepEqual(toggle({ verbs: { on: 'Verriegeln', off: 'Entriegeln' } }).verbs, { on: 'Verriegeln', off: 'Entriegeln' });
    assert.deepEqual(toggle({ verbs: { on: '  Einschalten ', off: 'Ausschalten  ', extra: 'x' } }).verbs, { on: 'Einschalten', off: 'Ausschalten' }, 'trimmed, extra keys dropped');
    assert.deepEqual(toggle({ verbs: { on: 'x'.repeat(20), off: 'y' } }).verbs, { on: 'x'.repeat(20), off: 'y' }, '20 characters and 1 character');
    assert.deepEqual(toggle({ verbs: { on: ' ' + 'x'.repeat(20) + ' ', off: 'Aus' } }).verbs, { on: 'x'.repeat(20), off: 'Aus' }, 'the length counts after trimming');
    for (const verbs of [
      undefined, null, 'Verriegeln', ['Verriegeln', 'Entriegeln'], 42, {},
      { on: 'Verriegeln' }, { off: 'Entriegeln' }, { on: 'Verriegeln', off: null }, { on: 7, off: 'Aus' },
      { on: 'x'.repeat(21), off: 'Aus' }, { on: 'An', off: 'y'.repeat(21) },
      { on: '', off: 'Aus' }, { on: '   ', off: 'Aus' }, { on: 'An\u0000', off: 'Aus' }, { on: 'An', off: 'A\u0007us' }, { on: 'An', off: 'Aus\u007f' }, { on: 'An', off: 'Aus\t' },
    ]) assert.equal(toggle({ verbs }).verbs, null, JSON.stringify(verbs));
    assert.equal(button({ verbs: { on: 'An', off: 'Aus' } }).verbs, null, 'buttons: always null');
  });

  it('targets (toggles only): true only for true, else false', () => {
    assert.equal(toggle({ targets: true }).targets, true);
    for (const v of [undefined, null, false, 'true', 1, {}, ['x']]) assert.equal(toggle({ targets: v }).targets, false, JSON.stringify(v));
    assert.equal(button({ targets: true }).targets, false, 'buttons: always false');
    assert.equal(quickActions.sanitizeVerbs({ on: 'An', off: 'Aus' }).on, 'An');
  });

  it('every action has every key', () => {
    assert.deepEqual(Object.keys(button()), ['id', 'title', 'subtitle', 'icon', 'kind', 'state', 'confirm', 'confirmWhen', 'look', 'verbs', 'targets', 'device', 'widget']);
    assert.deepEqual(button(), { id: 'b', title: 'Knopf', subtitle: null, icon: null, kind: 'button', state: null, confirm: false, confirmWhen: null, look: null, verbs: null, targets: false, device: null, widget: null });
  });
});

describe('widget label, readings and power (sanitizeWidget)', () => {
  let sanitizeWidget;
  before(() => { ({ sanitizeWidget } = quickActions); });
  const reading = (over = {}) => ({ id: 'range', label: 'Reichweite', value: 312, unit: 'km', icon: 'M4 12h16', state: 'good', ...over });

  it('label: ≤ 24, control characters removed, else null', () => {
    assert.equal(sanitizeWidget({ label: 'Ladestand' }).label, 'Ladestand');
    const w = sanitizeWidget({ label: 'A\u0000B ' + 'x'.repeat(40) });
    assert.deepEqual([w.label.length, w.label.slice(0, 5)], [24, 'A B x']);
    for (const v of [undefined, null, '', '  ', {}, [], true]) assert.equal(sanitizeWidget({ label: v }).label, null, JSON.stringify(v));
    assert.equal(sanitizeWidget({ label: 7 }).label, '7');
  });

  it('readings: { id, label, value, unit, icon, state } with every key, capped', () => {
    assert.deepEqual(sanitizeWidget({ readings: [reading()] }).readings, [{ id: 'range', label: 'Reichweite', value: 312, unit: 'km', icon: 'M4 12h16', state: 'good' }]);
    assert.deepEqual(sanitizeWidget({ readings: [{ id: 'lock', label: 'Verriegelt', icon: LOCK_CLOSED }] }).readings, [{ id: 'lock', label: 'Verriegelt', value: null, unit: null, icon: LOCK_CLOSED, state: null }], 'an icon without a value');
    assert.deepEqual(sanitizeWidget({ readings: [{ id: 'o', label: 'Außen', value: '12,5' }] }).readings, [{ id: 'o', label: 'Außen', value: '12,5', unit: null, icon: null, state: null }], 'a value without an icon');
    const r = sanitizeWidget({ readings: [reading({ label: 'L\u0007' + 'l'.repeat(40), value: 'V'.repeat(30), unit: 'U'.repeat(20), extra: 1 })] }).readings[0];
    assert.deepEqual([r.label.length, r.label.slice(0, 3), r.value.length, r.unit.length, 'extra' in r], [20, 'L l', 16, 8, false]);
    assert.equal(sanitizeWidget({ readings: [reading({ value: -0.5 })] }).readings[0].value, -0.5);
    for (const st of ['on', 'off', 'good', 'warn', 'crit']) assert.equal(sanitizeWidget({ readings: [reading({ state: st })] }).readings[0].state, st);
    for (const st of ['neutral', 'dim', '', 1]) assert.equal(sanitizeWidget({ readings: [reading({ state: st })] }).readings[0].state, null, String(st));
    for (const v of [NaN, Infinity, true, {}, [], '', '  ']) assert.equal(sanitizeWidget({ readings: [reading({ value: v })] }).readings[0].value, null, String(v));
    assert.equal(sanitizeWidget({ readings: [reading({ icon: '<svg>' })] }).readings[0].icon, null);
  });

  it('an invalid reading is dropped, the widget stays; duplicate ids dropped; at most 4; always a list', () => {
    const bad = [
      reading({ id: 'bad id' }), reading({ id: 'x'.repeat(25) }), reading({ id: undefined }), reading({ id: 7 }),
      reading({ label: '' }), reading({ label: undefined }), reading({ value: undefined, icon: undefined }), reading({ value: NaN, icon: '<x>' }),
      null, 'x', 42, [],
    ];
    for (const raw of bad) {
      const w = sanitizeWidget({ value: 81, unit: '%', readings: [raw, reading({ id: 'ok' })] });
      assert.ok(w, JSON.stringify(raw));
      assert.equal(w.value, 81);
      assert.deepEqual(w.readings.map((x) => x.id), ['ok'], JSON.stringify(raw));
    }
    assert.deepEqual(sanitizeWidget({ readings: [reading({ id: 'a', value: 1 }), reading({ id: 'a', value: 2 })] }).readings.map((x) => x.value), [1], 'the first of an id wins');
    const six = Array.from({ length: 6 }, (_, i) => reading({ id: 'r' + i }));
    assert.deepEqual(sanitizeWidget({ readings: six }).readings.map((x) => x.id), ['r0', 'r1', 'r2', 'r3']);
    assert.deepEqual(sanitizeWidget({ readings: [null, null, ...six] }).readings.map((x) => x.id), ['r0', 'r1', 'r2', 'r3'], 'four valid ones after invalid ones');
    for (const readings of [undefined, null, 'x', 42, {}, { 0: reading() }]) assert.deepEqual(sanitizeWidget({ readings }).readings, [], JSON.stringify(readings));
    assert.deepEqual(sanitizeWidget({ readings: [reading()], controls: [{ id: 'x', kind: 'dial' }] }), null, 'a bad control still makes the widget null');
    assert.equal(quickActions.MAX_READINGS, 4);
    assert.equal(quickActions.sanitizeReading(reading({ id: 'bad id' })), null, 'exported for the tests');
    assert.deepEqual(quickActions.sanitizeReadings('x'), []);
  });

  it('a reading id may equal a control id (separate namespaces)', () => {
    const w = sanitizeWidget({ readings: [reading({ id: 'target' })], controls: [{ id: 'target', kind: 'stepper', value: 22, min: 16, max: 30, step: 0.5 }] });
    assert.deepEqual([w.readings[0].id, w.controls[0].id], ['target', 'target']);
  });

  it('power: boolean, default true; only false is false', () => {
    assert.equal(sanitizeWidget({}).power, true);
    assert.equal(sanitizeWidget({ power: true }).power, true);
    assert.equal(sanitizeWidget({ power: false }).power, false);
    for (const v of [null, 0, '', 'false', 'no', [], {}]) assert.equal(sanitizeWidget({ power: v }).power, true, JSON.stringify(v));
  });

  it('a widget with only readings is valid; every key always present', () => {
    const w = sanitizeWidget({ readings: [reading()] });
    assert.deepEqual(w, W({ readings: [{ id: 'range', label: 'Reichweite', value: 312, unit: 'km', icon: 'M4 12h16', state: 'good' }] }));
    assert.deepEqual(Object.keys(w), ['label', 'value', 'unit', 'status', 'state', 'readings', 'controls', 'power']);
  });
});

describe('devices and widget readings through the client API', () => {
  const CAR = { id: 'v:42', title: 'Familienauto', subtitle: 'Enyaq', icon: 'M4 4h16' };
  const LOOK = { on: { icon: LOCK_CLOSED, tone: 'good' }, off: { icon: LOCK_OPEN, tone: 'crit' } };
  const CAR_WIDGET = {
    label: 'Ladestand', value: 81, unit: '%', status: 'Lädt', state: 'good', power: false,
    readings: [{ id: 'range', label: 'Reichweite', value: 312, unit: 'km', icon: 'M2 2h4' }, { id: 'lock', label: 'Verriegelt', icon: LOCK_CLOSED, state: 'good' }, { id: 'bad id', label: 'X', value: 1 }],
  };
  let dev;
  const run = (id, body = {}) => supertest(app).post(`${LIST}/hello/${encodeURIComponent(id)}`).set('X-API-Token', dev.raw).send(body);
  before(async () => {
    dev = H.makeDevice(anna, { name: 'qa-devices' });
    await kv('hello', 'quick-actions', [
      { id: 'lock:42', title: 'Verriegelt', kind: 'toggle', state: 'on', confirm: true, confirmWhen: 'off', look: LOOK, device: CAR },
      { id: 'climate:42', title: 'Klimatisierung', kind: 'toggle', state: 'off', device: CAR, widget: CAR_WIDGET },
      { id: 'honk:42', title: 'Hupen', device: { ...CAR, id: 'bad id' }, look: LOOK, confirmWhen: 'on' },
    ]);
    await kv('hello', 'quick-mode', null);
    await kv('hello', 'quick-run-mode', null);
    await kv('hello', 'quick-result', null);
  });
  after(async () => {
    await kv('hello', 'quick-result', null);
    await kv('hello', 'quick-actions', [{ id: 'light:3', title: 'Licht', kind: 'toggle', state: 'off' }, { id: 'scene.evening', title: 'Abend' }]);
  });

  it('GET lists device, look, confirmWhen and the widget\'s label, readings and power', async () => {
    const r = await list(dev).expect(200);
    const by = (id) => r.body.actions.find((a) => a.plugin === 'hello' && a.id === id);
    assert.deepEqual(by('lock:42'), {
      plugin: 'hello', pluginName: 'Hallo Welt', id: 'lock:42', title: 'Verriegelt', subtitle: null, icon: null, kind: 'toggle', state: 'on',
      confirm: true, confirmWhen: 'off', look: LOOK, verbs: null, targets: false, device: CAR, widget: null,
    });
    assert.deepEqual(by('climate:42').device, CAR);
    assert.deepEqual(by('climate:42').widget, W({
      label: 'Ladestand', value: 81, unit: '%', status: 'Lädt', state: 'good', power: false,
      readings: [
        { id: 'range', label: 'Reichweite', value: 312, unit: 'km', icon: 'M2 2h4', state: null },
        { id: 'lock', label: 'Verriegelt', value: null, unit: null, icon: LOCK_CLOSED, state: 'good' },
      ],
    }));
    assert.deepEqual([by('honk:42').device, by('honk:42').look, by('honk:42').confirmWhen], [null, null, null], 'invalid device → null; a button has no look / confirmWhen');
    assert.equal(by('honk:42').title, 'Hupen');
  });

  it('a run answers the sanitised widget with label, readings and power; gc.actions-style runs are unchanged', async () => {
    await kv('hello', 'quick-result', { ok: true, state: 'on', widget: { ...CAR_WIDGET, label: 'L'.repeat(40), power: 'no' } });
    const r = await run('climate:42').expect(200);
    assert.equal(r.body.widget.label.length, 24);
    assert.equal(r.body.widget.power, true, 'anything but false is true');
    assert.deepEqual(r.body.widget.readings.map((x) => x.id), ['range', 'lock']);
    assert.deepEqual(Object.keys(r.body).sort(), ['message', 'ok', 'state', 'unchanged', 'widget']);
    await kv('hello', 'quick-result', { ok: true, widget: { readings: 'x' } });
    assert.deepEqual((await run('lock:42').expect(200)).body.widget, W(), 'readings not a list → []');
    await kv('hello', 'quick-result', null);
  });
});

describe('target states: runs with state (client API)', () => {
  const VERBS = { on: 'Verriegeln', off: 'Entriegeln' };
  const LAMP_WIDGET = { value: 'An', state: 'on', controls: [{ id: 'bri', kind: 'slider', value: 50, min: 1, max: 100, step: 1 }] };
  const ACTIONS = [
    { id: 'lock:1', title: 'Schloss', kind: 'toggle', state: 'on', targets: true, verbs: VERBS },   // honours target
    { id: 'lock:2', title: 'Schloss 2', kind: 'toggle', targets: true },                            // targets, state unknown
    { id: 'lamp:on', title: 'Lampe', kind: 'toggle', state: 'on', widget: LAMP_WIDGET },             // no targets, on
    { id: 'lamp:off', title: 'Lampe 2', kind: 'toggle', state: 'off' },                             // no targets, off
    { id: 'lamp:unknown', title: 'Lampe 3', kind: 'toggle' },                                       // no targets, no state
    { id: 'scene', title: 'Szene', targets: true, verbs: VERBS },                                   // a button
  ];
  // own devices of anna: 30 runs per minute and token (400s count)
  let devA, devB;
  const runS = (id, body, dev = devA) => supertest(app).post(`${LIST}/hello/${encodeURIComponent(id)}`).set('X-API-Token', dev.raw).send(body);
  before(async () => {
    devA = H.makeDevice(anna, { name: 'qa-state-a' });
    devB = H.makeDevice(anna, { name: 'qa-state-b' });
    await kv('hello', 'quick-actions', ACTIONS);
    await kv('hello', 'quick-mode', null);
    await kv('hello', 'quick-run-mode', null);
    await kv('hello', 'quick-result', null);
  });
  after(async () => {
    await kv('hello', 'quick-result', null);
    await kv('hello', 'quick-actions', [{ id: 'light:3', title: 'Licht', kind: 'toggle', state: 'off' }, { id: 'scene.evening', title: 'Abend' }]);
  });

  it('GET lists verbs and targets (null / false when not declared, always for buttons)', async () => {
    const r = await list(devA).expect(200);
    const by = (id) => r.body.actions.find((a) => a.plugin === 'hello' && a.id === id);
    assert.deepEqual([by('lock:1').verbs, by('lock:1').targets], [VERBS, true]);
    assert.deepEqual([by('lock:2').verbs, by('lock:2').targets, by('lock:2').state], [null, true, null]);
    assert.deepEqual([by('lamp:on').verbs, by('lamp:on').targets], [null, false]);
    assert.deepEqual([by('scene').verbs, by('scene').targets], [null, false]);
  });

  it('targets: true → the hook gets target (also when already in that state, also with an unknown state) and answers as usual', async () => {
    await kv('hello', 'quick-result', { ok: true, message: 'Verriegelt', state: 'on' });
    const r = await runS('lock:1', { state: 'on' }).expect(200);
    assert.deepEqual(r.body, { ok: true, message: 'Verriegelt', state: 'on', widget: null, unchanged: false });
    const last = await kvGet('hello', 'quick-last');
    assert.deepEqual(last, { id: 'lock:1', user: { id: anna, name: 'qa-anna', role: 'user', portal: true, loggedIn: true, app: true }, lang: 'de', via: 'app', automation: false, target: 'on' });
    assert.deepEqual(JSON.parse(lastActivity().details), { plugin: 'hello', action: 'lock:1', userId: anna, ok: true, via: 'app', state: 'on' });
    await kv('hello', 'quick-result', null);
    await runS('lock:1', { state: 'off', source: 'notification' }).expect(200);
    const l2 = await kvGet('hello', 'quick-last');
    assert.deepEqual([l2.target, l2.via], ['off', 'notification']);
    await runS('lock:2', { state: 'off' }).expect(200);
    assert.equal((await kvGet('hello', 'quick-last')).target, 'off', 'a targets toggle needs no known state');
  });

  it('targets: false, already in the requested state → no hook call, 200 unchanged with the listed state and widget', async () => {
    await kv('hello', 'quick-last', null);
    const r = await runS('lamp:on', { state: 'on' }).expect(200);
    assert.deepEqual(r.body, {
      ok: true, message: null, state: 'on', unchanged: true,
      widget: W({ value: 'An', state: 'on', controls: [{ id: 'bri', kind: 'slider', label: null, value: 50, min: 1, max: 100, step: 1, unit: null }] }),
    });
    assert.deepEqual((await runS('lamp:off', { state: 'off' }).expect(200)).body, { ok: true, message: null, state: 'off', widget: null, unchanged: true });
    assert.equal(await kvGet('hello', 'quick-last'), null, 'the plugin was not asked to run');
    assert.deepEqual(JSON.parse(lastActivity().details), { plugin: 'hello', action: 'lamp:off', userId: anna, ok: true, via: 'app', state: 'off', unchanged: true });
  });

  it('targets: false, in the other state → the plain run (a flip), no target in the payload', async () => {
    await kv('hello', 'quick-result', { ok: true, message: 'aus', state: 'off' });
    const r = await runS('lamp:on', { state: 'off' }).expect(200);
    assert.deepEqual(r.body, { ok: true, message: 'aus', state: 'off', widget: null, unchanged: false });
    const last = await kvGet('hello', 'quick-last');
    assert.equal(last.id, 'lamp:on');
    assert.ok(!('target' in last), 'no target for a plugin that does not declare targets');
    await kv('hello', 'quick-result', null);
    await kv('hello', 'quick-last', null);
    await runS('lamp:off', { state: 'on' }).expect(200);
    assert.equal((await kvGet('hello', 'quick-last')).id, 'lamp:off');
  });

  it('targets: false, no listed state → 409 state_unknown; nothing runs, the refusal is logged', async () => {
    await kv('hello', 'quick-last', null);
    for (const want of ['on', 'off']) {
      const r = await runS('lamp:unknown', { state: want });
      assert.equal(r.status, 409, want);
      assert.deepEqual(r.body, { ok: false, error: 'state_unknown' });
    }
    assert.equal(await kvGet('hello', 'quick-last'), null, 'nothing ran');
    assert.deepEqual(JSON.parse(lastActivity().details), { plugin: 'hello', action: 'lamp:unknown', userId: anna, ok: false, via: 'app', state: 'off' });
  });

  it('400 invalid_state: a bad value, state on a button, state with control; nothing runs, nothing is logged', async () => {
    await kv('hello', 'quick-last', null);
    const before = lastActivity().id;
    for (const [id, body] of [
      ['lock:1', { state: 'ON' }], ['lock:1', { state: '' }], ['lock:1', { state: 'toggle' }], ['lock:1', { state: 1 }], ['lock:1', { state: true }],
      ['lock:1', { state: false }], ['lock:1', { state: ['on'] }], ['lock:1', { state: { on: true } }], ['lamp:on', { state: 'dim' }],
      ['scene', { state: 'on' }], ['scene', { state: 'off' }],
      ['lamp:on', { state: 'on', control: 'bri', value: 20 }], ['lamp:on', { state: 'off', control: 'bri', value: 20 }],
    ]) {
      const r = await runS(id, body, devB);
      assert.equal(r.status, 400, `${id} ${JSON.stringify(body)}`);
      assert.deepEqual(r.body, { ok: false, error: 'invalid_state' }, `${id} ${JSON.stringify(body)}`);
    }
    assert.equal(await kvGet('hello', 'quick-last'), null, 'nothing ran');
    assert.equal(lastActivity().id, before, 'nothing logged');
    assert.deepEqual((await runS('lamp:9', { state: 'nope' }, devB).expect(404)).body, { ok: false, error: 'not_found' }, '404 before 400');
  });

  it('without state (or state: null) a toggle runs as before; every answer that reached the plugin is unchanged: false', async () => {
    await kv('hello', 'quick-result', null);
    for (const body of [{}, { state: null }]) {
      await kv('hello', 'quick-last', null);
      const r = await runS('lamp:on', body).expect(200);
      assert.deepEqual(r.body, { ok: true, message: 'ran lamp:on', state: 'on', widget: null, unchanged: false });
      assert.ok(!('target' in await kvGet('hello', 'quick-last')));
    }
    await runS('lock:1', {}).expect(200);
    assert.ok(!('target' in await kvGet('hello', 'quick-last')), 'a targets toggle without state gets no target');
    assert.equal(JSON.parse(lastActivity().details).state, undefined);
  });

  it('hook level: run() with opts.state', async () => {
    const user = { id: anna, name: 'qa-anna', role: 'user', portal: true, loggedIn: true, app: true };
    await kv('hello', 'quick-last', null);
    assert.deepEqual(await quickActions.run('hello', 'lamp:off', user, 'de', { state: 'off' }), { status: 200, body: { ok: true, message: null, state: 'off', widget: null, unchanged: true } });
    assert.deepEqual(await quickActions.run('hello', 'lamp:unknown', user, 'de', { state: 'on' }), { status: 409, body: { ok: false, error: 'state_unknown' } });
    assert.deepEqual(await quickActions.run('hello', 'scene', user, 'de', { state: 'on' }), { status: 400, body: { ok: false, error: 'invalid_state' } });
    assert.equal(await kvGet('hello', 'quick-last'), null);
    const r = await quickActions.run('hello', 'lock:1', user, 'de', { state: 'off' });
    assert.deepEqual([r.status, r.body.unchanged, (await kvGet('hello', 'quick-last')).target], [200, false, 'off']);
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
