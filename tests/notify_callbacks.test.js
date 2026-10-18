'use strict';

// Callback buttons of plugin pushes (docs/plugins.md "Callback buttons",
// services/plugins/notifyActions.js):
//   * data.actions[] type callback { id [a-z0-9_-]{1,32}, label 1…24 } — strict
//     checks in gc.notify (ERR_INVALID), shape after sanitising, never from
//     the core or an administrator message
//   * the ack of the apps (state 'read', action = the callback id) calls the
//     sending plugin's notifyAction hook once per push and button — another
//     press, device or recipient changes nothing; data without the host's
//     fields; a failing hook never reaches the app
//   * migration 105 (notify_action_calls)

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { helloPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');

const API = '/api/v1/plugins';
const TOPICS = [{ id: 'reminder', label: { de: 'Erinnerung', en: 'Reminder' }, default: true }];

let app, agent, csrf, hostApi, manifest, registry, plugins, sanitize, notifyActions, hub;
let anna, annaDev, annaTab, ben, benDev;

function fakePlugin(id) {
  const v = manifest.validate({
    id, name: 'Erinnerungen', version: '1.0.0', publisher: 'Test', gatecontrol: '>=1.0.0', entry: 'server/index.js',
    permissions: { notify: { perHour: 120 } }, notifyTopics: TOPICS,
  });
  assert.ok(v.ok, JSON.stringify(v.errors));
  registry.upsert({ manifest: v.manifest, signature: 'trusted', enabled: true });
  return { id, name: 'Erinnerungen', manifest: v.manifest };
}
async function codeOf(plugin, notification) {
  try { await hostApi.handle(plugin, 'notify', { notification }); return null; } catch (e) { return e.code; }
}

const kv = (key, value) => agent.post(`${API}/hello/api/kv`).set('X-CSRF-Token', csrf).send({ key, value }).expect(200);
const kvGet = async (key) => (await agent.get(`${API}/hello/api/kv`).query({ key }).expect(200)).body.value;
const ack = (dev, seqs, state, action) => supertest(app).post('/api/v1/client/push/ack').set('X-API-Token', dev.raw).send({ seqs, state, action });
const seqOf = (notificationId, dev) => H.deliveries(notificationId).find((d) => d.token_id === dev.tokenId).seq;
const BUTTONS = [{ type: 'callback', id: 'done', label: 'Erledigt' }, { type: 'callback', id: 'snooze_1h', label: 'In 1 h' }];

/** gc.notify through the hello plugin's process → the notification id. */
async function push(data, users = [anna]) {
  const r = await agent.post(`${API}/hello/api/notify2`).set('X-CSRF-Token', csrf)
    .send({ topic: 'reminder', title: 'Fenster schließen', body: 'Es regnet gleich', users, data });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.pushed, true);
  return r.body.result.id;
}

/** Wait until the hook was called `n` times (kv "notify-actions"). */
async function hookCalls(n, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const calls = (await kvGet('notify-actions')) || [];
    if (calls.length >= n || Date.now() > end) return calls;
    await new Promise((r) => setTimeout(r, 50));
  }
}
/** Give a (wrongly started) background hook call time to land. */
const settle = () => new Promise((r) => setTimeout(r, 300));

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  hostApi = require('../src/services/plugins/hostApi');
  manifest = require('../src/services/plugins/manifest');
  registry = require('../src/services/plugins/registry');
  plugins = require('../src/services/plugins');
  sanitize = require('../src/services/notify/sanitize');
  notifyActions = require('../src/services/plugins/notifyActions');
  hub = require('../src/services/notify/hub');
  anna = H.makeUser('cb-anna');
  ben = H.makeUser('cb-ben');
  annaDev = H.makeDevice(anna, { name: 'cb-anna-phone' });
  annaTab = H.makeDevice(anna, { name: 'cb-anna-tab' });
  benDev = H.makeDevice(ben, { name: 'cb-ben-phone' });
  const ins = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream')
    .send(helloPackage({ overrides: { notifyTopics: TOPICS } })).expect(200);
  assert.equal(ins.body.canInstall, true, JSON.stringify(ins.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: ins.body.token, accept: true }).expect(200);
  assert.equal(await require('../src/services/plugins/runtime').waitRunning('hello'), true);
});
after(async () => { await plugins.stop(); teardown(); });
beforeEach(async () => {
  H.clearNotifications();
  await kv('notify-actions', null);
  await kv('notify-action-mode', null);
});

describe('migration 105', () => {
  it('notify_action_calls exists, keyed by notification + action, goes with the notification', () => {
    assert.equal(H.db().prepare('SELECT name FROM migration_history WHERE version = 105').get().name, 'notify_action_calls');
    const cols = H.db().prepare('PRAGMA table_info(notify_action_calls)').all().map((c) => c.name);
    assert.deepEqual(cols, ['notification_id', 'action', 'user_id', 'created_at']);
    const fk = H.db().prepare('PRAGMA foreign_key_list(notify_action_calls)').all();
    assert.deepEqual(fk.map((f) => [f.table, f.on_delete]), [['notifications', 'CASCADE']]);
  });
});

describe('data.actions[] type callback', () => {
  it('kept in a plugin push as { id, label, type }; the apps get it unchanged', async () => {
    const p = fakePlugin('cb-plugin-a');
    await hostApi.handle(p, 'notify', { notification: { topic: 'reminder', title: 'x', users: [anna], data: { actions: [
      { type: 'callback', id: 'done', label: '  Erledigt\u0007 ', plugin: 'whatever' },
      { type: 'callback', id: 'snooze_1h', label: 'In 1 h' },
      { type: 'done', label: 'Gelesen' },
    ] } } });
    const d = JSON.parse(H.lastNotification().data);
    assert.deepEqual(d.actions, [
      { id: 'done', label: 'Erledigt', type: 'callback' },
      { id: 'snooze_1h', label: 'In 1 h', type: 'callback' },
      { id: 'done', label: 'Gelesen', type: 'done' },
    ]);
    const item = (await supertest(app).get('/api/v1/client/push/inbox').set('X-API-Token', annaDev.raw).expect(200)).body.items[0];
    assert.deepEqual(item.data.actions, d.actions);
  });

  it('ERR_INVALID: bad id, label not 1…24, duplicate ids — nothing pushed; at most 4 actions as before', async () => {
    const p = fakePlugin('cb-plugin-b');
    const cb = (a) => ({ topic: 'reminder', title: 'x', data: { actions: [{ type: 'callback', id: 'done', label: 'Erledigt', ...a }] } });
    assert.equal(await codeOf(p, cb({})), null, 'the valid one');
    H.clearNotifications();
    for (const bad of [{ id: 'Done' }, { id: 'a b' }, { id: 'x'.repeat(33) }, { id: '' }, { id: 7 }, { id: undefined }, { id: 'a:b' },
      { label: '' }, { label: '  ' }, { label: 'x'.repeat(25) }, { label: 7 }, { label: undefined }]) {
      assert.equal(await codeOf(p, cb(bad)), 'ERR_INVALID', JSON.stringify(bad));
    }
    assert.equal(await codeOf(p, { topic: 'reminder', title: 'x', data: { actions: [BUTTONS[0], { ...BUTTONS[1], id: 'done' }] } }), 'ERR_INVALID');
    assert.equal(H.lastNotification(), null, 'nothing pushed');
    await hostApi.handle(p, 'notify', { notification: { topic: 'reminder', title: 'x', users: [anna], data: { actions: [
      ...BUTTONS, { type: 'callback', id: 'c3', label: 'Drei' }, { type: 'callback', id: 'c4', label: 'Vier' }, { type: 'callback', id: 'c5', label: 'Fünf' },
    ] } } });
    assert.deepEqual(JSON.parse(H.lastNotification().data).actions.map((a) => a.id), ['done', 'snooze_1h', 'c3', 'c4']);
  });

  it('never from the core or an administrator message (no plugin context): dropped', () => {
    assert.equal(sanitize.data({ actions: [BUTTONS[0]] }).data, null);
    assert.deepEqual(sanitize.data({ actions: [BUTTONS[0]] }, { plugin: 'cb-plugin-a' }).data.actions, [{ id: 'done', label: 'Erledigt', type: 'callback' }]);
  });
});

describe('ack with a callback id → notifyAction', () => {
  it('calls the sending plugin once with { userId, notificationId, action, data } (data without the host\'s fields)', async () => {
    const id = await push({ reminder: { ruleId: 7, key: 'sched:2026-10-18' }, facts: [{ label: 'Regen', value: 'ab 17:00' }], actions: BUTTONS });
    await ack(annaDev, [seqOf(id, annaDev)], 'read', 'done').expect(200);
    const calls = await hookCalls(1);
    assert.deepEqual(calls, [{ userId: anna, notificationId: id, action: 'done', data: { reminder: { ruleId: 7, key: 'sched:2026-10-18' } } }]);
    assert.equal(H.deliveries(id).find((d) => d.token_id === annaDev.tokenId).action, 'done');
    const row = H.db().prepare('SELECT * FROM notify_action_calls WHERE notification_id = ?').get(id);
    assert.deepEqual([row.action, row.user_id], ['done', anna]);
  });

  it('once per push and button: a second press, the person\'s other device or another recipient call nothing more', async () => {
    const id = await push({ actions: BUTTONS }, [anna, ben]);
    await ack(annaDev, [seqOf(id, annaDev)], 'read', 'done').expect(200);
    assert.equal((await hookCalls(1)).length, 1);
    await ack(annaDev, [seqOf(id, annaDev)], 'read', 'done').expect(200);
    await ack(annaTab, [seqOf(id, annaTab)], 'read', 'done').expect(200);
    await ack(benDev, [seqOf(id, benDev)], 'read', 'done').expect(200);
    await settle();
    assert.equal((await hookCalls(1)).length, 1);
    // another button of the same push is its own call — here by ben
    await ack(benDev, [seqOf(id, benDev)], 'read', 'snooze_1h').expect(200);
    const calls = await hookCalls(2);
    assert.deepEqual(calls.map((c) => [c.action, c.userId]), [['done', anna], ['snooze_1h', ben]]);
  });

  it('nothing for: an id that is no callback of that push, state other than read, someone else\'s delivery', async () => {
    const id = await push({ actions: [BUTTONS[0], { type: 'done', label: 'Gelesen' }] });
    const seq = seqOf(id, annaDev);
    await ack(annaDev, [seq], 'read', 'snooze_1h').expect(200);     // not in this push
    await ack(annaDev, [seq], 'delivered', 'done').expect(200);     // not a press
    await ack(annaDev, [seq], 'dismissed', 'done').expect(200);     // swiped away
    await ack(benDev, [seq], 'read', 'done').expect(200);           // not ben's delivery
    await settle();
    assert.equal(await kvGet('notify-actions'), null);
    assert.equal(H.db().prepare('SELECT COUNT(*) AS n FROM notify_action_calls').get().n, 0);
    // a push without callbacks: the builtin `done` stays a plain ack
    const plain = await push({ actions: [{ type: 'done', label: 'Gelesen' }] });
    await ack(annaDev, [seqOf(plain, annaDev)], 'read', 'done').expect(200);
    await settle();
    assert.equal(await kvGet('notify-actions'), null);
  });

  it('a core / administrator message never reaches a plugin', async () => {
    const r = hub.sendManual({ userId: anna, target: { type: 'users', ids: [anna] }, title: 'Hinweis', body: 'x', priority: 'normal' });
    const seq = seqOf(r.id, annaDev);
    H.db().prepare('UPDATE notifications SET data = ? WHERE id = ?').run(JSON.stringify({ actions: [{ id: 'done', label: 'x', type: 'callback' }] }), r.id);
    await ack(annaDev, [seq], 'read', 'done').expect(200);
    assert.equal(await notifyActions.onAck([{ notification_id: r.id, user_id: anna }], 'done'), 0);
    await settle();
    assert.equal(await kvGet('notify-actions'), null);
  });

  it('a failing hook is logged, never reported to the app — and still counts as called', async () => {
    await kv('notify-action-mode', 'throw');
    const id = await push({ actions: BUTTONS });
    const r = await ack(annaDev, [seqOf(id, annaDev)], 'read', 'done').expect(200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal((await hookCalls(1)).length, 1);
    await kv('notify-action-mode', null);
    await ack(annaDev, [seqOf(id, annaDev)], 'read', 'done').expect(200);
    await settle();
    assert.equal((await hookCalls(1)).length, 1);
  });

  it('the plugin not running: nothing recorded, so a later press still reaches it', async () => {
    const id = await push({ actions: BUTTONS });
    const realInfo = require('../src/services/plugins/runtime').info;
    const runtime = require('../src/services/plugins/runtime');
    runtime.info = (pid) => (pid === 'hello' ? { ...realInfo(pid), state: 'stopped' } : realInfo(pid));
    try {
      assert.equal(await notifyActions.onAck([{ notification_id: id, user_id: anna }], 'done'), 0);
    } finally { runtime.info = realInfo; }
    assert.equal(H.db().prepare('SELECT COUNT(*) AS n FROM notify_action_calls').get().n, 0);
    assert.equal(await notifyActions.onAck([{ notification_id: id, user_id: anna }], 'done'), 1);
    assert.equal((await hookCalls(1)).length, 1);
  });
});
