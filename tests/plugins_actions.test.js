'use strict';

// Plugin-to-plugin actions (docs/plugins.md "Running other plugins' quick
// actions"): permissions.actions + gc.actions.list / gc.actions.run — the
// quick actions other plugins offer to one user, run as that user with
// `automation: true, via: '<caller>'`; strict input checks, never for an
// unknown or disabled user, the caller itself excluded, 60 runs per hour per
// calling plugin, an activity row per run.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');

let agent, csrf, runtime, plugins, hostApi, quickActions, anna, bert, admin;
const API = '/api/v1/plugins';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}
const kv = (id, key, value) => agent.post(`${API}/${id}/api/kv`).set('X-CSRF-Token', csrf).send({ key, value }).expect(200);
const kvGet = async (id, key) => (await agent.get(`${API}/${id}/api/kv`).query({ key }).expect(200)).body.value;

// "hello-auto": the caller (permissions.actions); "hello-two": another plugin
// with the portal permission; "hello-np": one without it; "hello" has neither
// permissions.actions nor is it the caller.
function autoOverrides() {
  return { id: 'hello-auto', name: { de: 'Automatik', en: 'Automation' }, permissions: { ...helloManifest.permissions, actions: true } };
}
function twoOverrides() { return { id: 'hello-two', name: { de: 'Zweites', en: 'Second' } }; }
function noPortalOverrides() {
  const permissions = JSON.parse(JSON.stringify(helloManifest.permissions));
  delete permissions.portal;
  const ui = JSON.parse(JSON.stringify(helloManifest.ui));
  delete ui.portal;
  return { id: 'hello-np', name: 'Ohne Portal', permissions, ui };
}

/** gc.actions.* through a plugin's own API route /actions (as the administrator). */
function call(op, opts, pluginId = 'hello-auto') {
  return agent.post(`${API}/${pluginId}/api/actions`).set('X-CSRF-Token', csrf).send({ op, opts });
}
async function listOk(opts) {
  const r = await call('list', opts);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.result;
}
async function runOk(opts) {
  const r = await call('run', opts);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.result;
}
async function refused(op, opts, code, pluginId) {
  const r = await call(op, opts, pluginId);
  assert.equal(r.status, 400, `${op} ${JSON.stringify(opts)}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, code, `${op} ${JSON.stringify(opts)}`);
  return r.body;
}
const lastActivity = () => H.db().prepare("SELECT * FROM activity_log WHERE event_type = 'plugin_automation' ORDER BY id DESC LIMIT 1").get();
const activityCount = () => H.db().prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'plugin_automation'").get().n;

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  hostApi = require('../src/services/plugins/hostApi');
  quickActions = require('../src/services/plugins/quickActions');
  admin = H.db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  anna = H.makeUser('pa-anna', { language: 'de' });
  bert = H.makeUser('pa-bert', { language: 'en' });
  await install(helloPackage());
  await install(helloPackage({ overrides: autoOverrides() }));
  await install(helloPackage({ overrides: twoOverrides() }));
  await install(helloPackage({ overrides: noPortalOverrides() }));
  for (const id of ['hello', 'hello-auto', 'hello-two', 'hello-np']) assert.equal(await runtime.waitRunning(id), true, id);
  await kv('hello', 'quick-actions', [{ id: 'light:3', title: 'Licht', subtitle: 'Wohnzimmer', icon: 'M4 12h16', kind: 'toggle', state: 'off', confirm: true }]);
  await kv('hello-two', 'quick-actions', [{ id: 'scene:evening', title: 'Abend' }, { id: 'viewer', title: '$viewer' }]);
  await kv('hello-auto', 'quick-actions', [{ id: 'own', title: 'Eigene' }]);
  await kv('hello-np', 'quick-actions', [{ id: 'np', title: 'Nicht erlaubt' }]);
});
after(async () => { await plugins.stop(); teardown(); });

describe('permissions.actions', () => {
  it('plugin.json: a boolean, false by default, shown in the permission summary', async () => {
    const manifest = require('../src/services/plugins/manifest');
    const base = JSON.parse(JSON.stringify(helloManifest));
    assert.equal(manifest.validate(base).manifest.permissions.actions, false);
    base.permissions.actions = true;
    assert.equal(manifest.validate(base).manifest.permissions.actions, true);
    for (const bad of ['yes', 1, {}]) {
      base.permissions.actions = bad;
      const r = manifest.validate(base);
      assert.equal(r.ok, false);
      assert.ok(r.errors.includes('permissions.actions: invalid'), JSON.stringify(bad));
    }
    const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream')
      .send(helloPackage({ overrides: { ...autoOverrides(), id: 'hello-auto2' } })).expect(200);
    assert.equal(r.body.plugin.permissions.actions, true);
  });

  it('the consent dialog lists it (DE + EN)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'plugins-ui.js'), 'utf8');
    assert.ok(src.includes("t('plugins.perm.actions_on')"));
    const read = (lang) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', `${lang}.json`), 'utf8'));
    assert.equal(read('de')['plugins.perm.actions_on'], 'darf Schnellaktionen anderer Plugins auslösen (z. B. Smart-Home-Szenen)');
    assert.equal(read('en')['plugins.perm.actions_on'], "may run other plugins' quick actions (e.g. smart home scenes)");
    for (const lang of ['de', 'en']) assert.ok(read(lang)['plugins.perm.actions'], lang);
  });

  it('a plugin without it gets ERR_ACTIONS_DENIED and runs nothing', async () => {
    await kv('hello-two', 'quick-last', null);
    await refused('list', { userId: anna }, 'ERR_ACTIONS_DENIED', 'hello');
    await refused('run', { userId: anna, plugin: 'hello-two', id: 'scene:evening' }, 'ERR_ACTIONS_DENIED', 'hello');
    assert.equal(await kvGet('hello-two', 'quick-last'), null);
  });
});

describe('gc.actions.list', () => {
  it('the actions of the other plugins for that user — never the caller\'s own, never a plugin without permissions.portal', async () => {
    const all = await listOk({ userId: anna });
    assert.deepEqual(all.find((a) => a.plugin === 'hello'),
      { plugin: 'hello', pluginName: 'Hallo Welt', id: 'light:3', title: 'Licht', subtitle: 'Wohnzimmer', kind: 'toggle', state: 'off', verbs: null, targets: false });
    assert.deepEqual(all.find((a) => a.id === 'scene:evening'),
      { plugin: 'hello-two', pluginName: 'Zweites', id: 'scene:evening', title: 'Abend', subtitle: null, kind: 'button', state: null, verbs: null, targets: false });
    assert.ok(!all.some((a) => a.plugin === 'hello-auto'), 'the caller is excluded');
    assert.ok(!all.some((a) => a.plugin === 'hello-np'), 'no permissions.portal → not asked');
    // the target sees that user as a logged-in portal viewer (no app flag) in the user's language
    assert.equal(all.find((a) => a.id === 'viewer').title, `v${anna} true/true/undefined de`);
  });

  it('lang: explicit de/en, else the user\'s language setting', async () => {
    const name = (list) => list.find((a) => a.plugin === 'hello').pluginName;
    assert.equal(name(await listOk({ userId: bert })), 'Hello World');
    assert.equal(name(await listOk({ userId: bert, lang: 'de' })), 'Hallo Welt');
    assert.equal(name(await listOk({ userId: anna, lang: 'en' })), 'Hello World');
  });

  it('strict input: user id an existing, enabled account; lang de|en', async () => {
    const off = H.makeUser('pa-off', { enabled: 0 });
    for (const opts of [undefined, {}, { userId: String(anna) }, { userId: 0 }, { userId: -1 }, { userId: 1.5 }, { userId: anna, lang: 'fr' }, { userId: anna, lang: 7 }]) {
      await refused('list', opts, 'ERR_INVALID');
    }
    const r = await refused('list', { userId: off }, 'ERR_INVALID');
    assert.equal(r.error, 'unknown or disabled user');
    await refused('list', { userId: 999999 }, 'ERR_INVALID');
  });
});

describe('gc.actions.run', () => {
  before(() => hostApi._resetActionsBudgetForTest());

  it('runs as that user with automation: true and via: the caller; logs ids and ok only', async () => {
    await kv('hello', 'quick-result', null);
    const res = await runOk({ userId: anna, plugin: 'hello', id: 'light:3' });
    assert.deepEqual(res, { ok: true, message: 'ran light:3', state: 'on', unchanged: false });
    assert.deepEqual(await kvGet('hello', 'quick-last'), {
      id: 'light:3', lang: 'de', via: 'hello-auto', automation: true,
      user: { id: anna, name: 'pa-anna', role: 'user', portal: true, loggedIn: true, automation: true, via: 'hello-auto' },
    });
    const row = lastActivity();
    assert.equal(row.severity, 'info');
    assert.deepEqual(JSON.parse(row.details), { plugin: 'hello-auto', target: 'hello', action: 'light:3', userId: anna, ok: true });
    assert.equal(row.message, 'Plugin "hello-auto" ran quick action "light:3" of plugin "hello" (ok)');

    // any enabled user, an administrator too — the target plugin decides; lang passed on
    await runOk({ userId: admin, plugin: 'hello', id: 'light:3', lang: 'en' });
    const last = await kvGet('hello', 'quick-last');
    assert.equal(last.user.id, admin);
    assert.equal(last.lang, 'en');
  });

  it('the plugin\'s answer is sanitised and never reaches the activity log', async () => {
    await kv('hello', 'quick-result', { ok: false, message: 'Geheim\u0007 ' + 'x'.repeat(300), state: 'dim', extra: 'dropped' });
    try {
      const res = await runOk({ userId: anna, plugin: 'hello', id: 'light:3' });
      assert.deepEqual(Object.keys(res).sort(), ['message', 'ok', 'state', 'unchanged']);
      assert.equal(res.ok, false);
      assert.equal(res.state, null);
      assert.equal(res.message.length, 120);
      const row = lastActivity();
      assert.equal(JSON.parse(row.details).ok, false);
      assert.equal(row.severity, 'warning');
      assert.ok(!row.message.includes('Geheim') && !row.details.includes('Geheim'), 'no text of the plugin in the log');
    } finally { await kv('hello', 'quick-result', null); }
  });

  it('not listed / unknown / no portal permission / disabled target → ok: false with error not_found', async () => {
    const nf = { ok: false, message: null, state: null, unchanged: false, error: 'not_found' };
    assert.deepEqual(await runOk({ userId: anna, plugin: 'hello', id: 'light:4' }), nf);
    assert.deepEqual(await runOk({ userId: anna, plugin: 'nope', id: 'light:3' }), nf);
    assert.deepEqual(await runOk({ userId: anna, plugin: 'hello-np', id: 'np' }), nf);
    assert.equal(await kvGet('hello-np', 'quick-last'), null, 'never run');
    assert.deepEqual(JSON.parse(lastActivity().details), { plugin: 'hello-auto', target: 'hello-np', action: 'np', userId: anna, ok: false, error: 'not_found' });
    await agent.post(`${API}/hello-two/disable`).set('X-CSRF-Token', csrf).expect(200);
    try {
      assert.deepEqual(await runOk({ userId: anna, plugin: 'hello-two', id: 'scene:evening' }), nf);
      assert.ok(!(await listOk({ userId: anna })).some((a) => a.plugin === 'hello-two'));
    } finally {
      await agent.post(`${API}/hello-two/enable`).set('X-CSRF-Token', csrf).expect(200);
      assert.equal(await runtime.waitRunning('hello-two'), true);
    }
  });

  it('a failing or slow target → ok: false with error plugin_error / timeout', async () => {
    quickActions._setRunTimeoutForTest(1500);
    try {
      for (const [mode, error] of [['throw', 'plugin_error'], ['garbage', 'plugin_error'], ['slow', 'timeout']]) {
        await kv('hello', 'quick-run-mode', mode);
        assert.deepEqual(await runOk({ userId: anna, plugin: 'hello', id: 'light:3' }), { ok: false, message: null, state: null, unchanged: false, error }, mode);
      }
    } finally {
      quickActions._setRunTimeoutForTest(null);
      await kv('hello', 'quick-run-mode', null);
    }
  });

  it('strict input; never as an unknown or disabled user; never its own actions — nothing runs, nothing is logged', async () => {
    const off = H.makeUser('pa-off2', { enabled: 0 });
    await kv('hello', 'quick-last', null);
    const before = activityCount();
    const ok = { userId: anna, plugin: 'hello', id: 'light:3' };
    for (const opts of [
      undefined, {}, { ...ok, userId: String(anna) }, { ...ok, userId: 0 }, { ...ok, userId: null },
      { ...ok, plugin: 'Hello' }, { ...ok, plugin: 'h' }, { ...ok, plugin: 'x'.repeat(65) }, { ...ok, plugin: 7 }, { ...ok, plugin: undefined },
      { ...ok, id: 'bad id' }, { ...ok, id: 'x'.repeat(65) }, { ...ok, id: '' }, { ...ok, id: 3 },
      { ...ok, lang: 'fr' }, { ...ok, userId: off }, { ...ok, userId: 999999 },
      { userId: anna, plugin: 'hello-auto', id: 'own' },
    ]) await refused('run', opts, 'ERR_INVALID');
    assert.equal(await kvGet('hello', 'quick-last'), null, 'the target never ran');
    assert.equal(await kvGet('hello-auto', 'quick-last'), null, 'the caller never ran itself');
    assert.equal(activityCount(), before);
  });

  it('a user disabled after listing is refused at the run', async () => {
    const u = H.makeUser('pa-later');
    assert.ok((await listOk({ userId: u })).length > 0);
    H.db().prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(u);
    await refused('run', { userId: u, plugin: 'hello', id: 'light:3' }, 'ERR_INVALID');
    H.db().prepare('DELETE FROM users WHERE id = ?').run(u);
    await refused('run', { userId: u, plugin: 'hello', id: 'light:3' }, 'ERR_INVALID');
  });

  it('state: a targets toggle gets target; the fallback for other toggles (unchanged / flip / state_unknown); invalid_state', async () => {
    hostApi._resetActionsBudgetForTest();
    const VERBS = { on: 'Verriegeln', off: 'Entriegeln' };
    await kv('hello', 'quick-actions', [
      { id: 'lock:1', title: 'Schloss', kind: 'toggle', state: 'on', targets: true, verbs: VERBS },
      { id: 'lamp:on', title: 'Lampe', kind: 'toggle', state: 'on' },
      { id: 'lamp:unknown', title: 'Lampe 2', kind: 'toggle' },
      { id: 'scene', title: 'Szene' },
    ]);
    try {
      const all = await listOk({ userId: anna });
      assert.deepEqual(all.find((a) => a.id === 'lock:1'),
        { plugin: 'hello', pluginName: 'Hallo Welt', id: 'lock:1', title: 'Schloss', subtitle: null, kind: 'toggle', state: 'on', verbs: VERBS, targets: true });

      // targets: true → target in the payload, the plugin's answer
      await kv('hello', 'quick-result', { ok: true, message: 'Verriegelt', state: 'on' });
      assert.deepEqual(await runOk({ userId: anna, plugin: 'hello', id: 'lock:1', state: 'on' }), { ok: true, message: 'Verriegelt', state: 'on', unchanged: false });
      const last = await kvGet('hello', 'quick-last');
      assert.deepEqual([last.target, last.via, last.automation], ['on', 'hello-auto', true]);
      assert.deepEqual(JSON.parse(lastActivity().details), { plugin: 'hello-auto', target: 'hello', action: 'lock:1', userId: anna, ok: true, state: 'on' });
      await kv('hello', 'quick-result', null);

      // no targets, already there → not run, unchanged
      await kv('hello', 'quick-last', null);
      assert.deepEqual(await runOk({ userId: anna, plugin: 'hello', id: 'lamp:on', state: 'on' }), { ok: true, message: null, state: 'on', unchanged: true });
      assert.equal(await kvGet('hello', 'quick-last'), null, 'the target plugin was not asked to run');
      assert.deepEqual(JSON.parse(lastActivity().details), { plugin: 'hello-auto', target: 'hello', action: 'lamp:on', userId: anna, ok: true, state: 'on', unchanged: true });

      // no targets, the other state → the plain run (flip), no target
      assert.deepEqual(await runOk({ userId: anna, plugin: 'hello', id: 'lamp:on', state: 'off' }), { ok: true, message: 'ran lamp:on', state: 'on', unchanged: false });
      assert.ok(!('target' in await kvGet('hello', 'quick-last')));

      // no targets, no listed state → state_unknown; a button or a bad value → invalid_state
      await kv('hello', 'quick-last', null);
      const no = (error) => ({ ok: false, message: null, state: null, unchanged: false, error });
      assert.deepEqual(await runOk({ userId: anna, plugin: 'hello', id: 'lamp:unknown', state: 'off' }), no('state_unknown'));
      assert.deepEqual(JSON.parse(lastActivity().details), { plugin: 'hello-auto', target: 'hello', action: 'lamp:unknown', userId: anna, ok: false, state: 'off', error: 'state_unknown' });
      assert.deepEqual(await runOk({ userId: anna, plugin: 'hello', id: 'scene', state: 'on' }), no('invalid_state'));
      for (const state of ['ON', 'toggle', '', 1, true, ['on']]) {
        assert.deepEqual(await runOk({ userId: anna, plugin: 'hello', id: 'lock:1', state }), no('invalid_state'), JSON.stringify(state));
        assert.equal(JSON.parse(lastActivity().details).state, undefined, 'a bad state never reaches the log');
      }
      assert.equal(await kvGet('hello', 'quick-last'), null, 'nothing ran');

      // without state (or null): the plain run as before
      assert.deepEqual(await runOk({ userId: anna, plugin: 'hello', id: 'lock:1', state: null }), { ok: true, message: 'ran lock:1', state: 'on', unchanged: false });
      assert.ok(!('target' in await kvGet('hello', 'quick-last')));
    } finally {
      await kv('hello', 'quick-result', null);
      await kv('hello', 'quick-actions', [{ id: 'light:3', title: 'Licht', subtitle: 'Wohnzimmer', icon: 'M4 12h16', kind: 'toggle', state: 'off', confirm: true }]);
      hostApi._resetActionsBudgetForTest();
    }
  });

  it(`at most ${60} runs per hour per calling plugin (listing is not counted)`, async () => {
    assert.equal(hostApi.ACTIONS_PER_HOUR, 60);
    hostApi._resetActionsBudgetForTest();
    for (let i = 0; i < 60; i += 1) assert.equal((await runOk({ userId: anna, plugin: 'hello-two', id: 'scene:evening' })).ok, true, `run ${i}`);
    const before = activityCount();
    await refused('run', { userId: anna, plugin: 'hello-two', id: 'scene:evening' }, 'ERR_RATE_LIMIT');
    assert.equal(activityCount(), before, 'a refused run is not logged');
    assert.ok((await listOk({ userId: anna })).length > 0);
    hostApi._resetActionsBudgetForTest();
  });
});
