'use strict';

// Notifications in chats (docs/plugins.md "Notifications in chats",
// services/notify/chatRoutes.js):
//   * migration 107 (notify_routes, notify_family_routes), permissions.notifySink
//   * routing split after the recipients are resolved: household family route
//     → everyone to the sink as `family`; a person's 'own' → `own`; the rest
//     → inbox exactly as before
//   * the sink's deliverNotice hook: covered people get no inbox delivery and
//     no core push; error, timeout or not covered → inbox afterwards (never
//     lost, never doubled)
//   * locked topics (security, admin_notice) and chat topics never leave the
//     inbox; without a (running) sink nothing changes
//   * gc.notify `card` validation
//   * GET / PUT /api/v1/me/notify/routes and /api/v1/client/push/routes,
//     family permission (admin, the sink's mayRouteToFamily, else 403)

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');

const API = '/api/v1/plugins';
const SCHOOL_TOPICS = [
  { id: 'messages', label: { de: 'Nachrichten der Schule', en: 'School messages' }, default: true },
  { id: 'talk', label: { de: 'Chat', en: 'Chat' }, default: true, chat: true },
];

let app, agent, csrf, hostApi, manifest, registry, plugins, hub, chatRoutes, runtime, text;
let adminId, anna, annaDev, ben, benDev, carl, carlDev, school;

function fakePlugin(id, { topics = SCHOOL_TOPICS, name = { de: 'Schule', en: 'School' }, perms = {} } = {}) {
  const v = manifest.validate({
    id, name, version: '1.0.0', publisher: 'Test', gatecontrol: '>=1.0.0', entry: 'server/index.js',
    permissions: { notify: { perHour: 120 }, ...perms }, notifyTopics: topics,
  });
  assert.ok(v.ok, JSON.stringify(v.errors));
  registry.upsert({ manifest: v.manifest, signature: 'trusted', enabled: true });
  return { id, name: name.de, manifest: v.manifest };
}

const kv = (key, value) => agent.post(`${API}/hello/api/kv`).set('X-CSRF-Token', csrf).send({ key, value }).expect(200);
const kvGet = async (key) => (await agent.get(`${API}/hello/api/kv`).query({ key }).expect(200)).body.value;
const notices = async () => (await kvGet('sink-notices')) || [];
const deliveredTo = (id) => H.deliveries(id).map((d) => d.token_id).sort((a, b) => a - b);
const sorted = (a) => [...a].sort((x, y) => x - y);
const TOPIC = 'plugin:rt-school:messages';

/** gc.notify of the school plugin → notification id. */
async function send(extra = {}, users = [anna, ben]) {
  const r = await hostApi.handle(school, 'notify', { notification: { topic: 'messages', title: 'Elternbrief', body: 'Bitte lesen', users, ...extra } });
  assert.equal(r.pushed, true);
  return r.id;
}
async function codeOf(notification) {
  try { await hostApi.handle(school, 'notify', { notification }); return null; } catch (e) { return e.code; }
}
function setOwn(userId, topic = TOPIC) {
  H.db().prepare("INSERT OR REPLACE INTO notify_routes (user_id, topic, dest, updated_at) VALUES (?, ?, 'own', ?)").run(userId, topic, new Date().toISOString());
}
function setFamily(topic = TOPIC, by = adminId) {
  H.db().prepare('INSERT OR REPLACE INTO notify_family_routes (topic, set_by, set_at) VALUES (?, ?, ?)').run(topic, by, new Date().toISOString());
}
async function withRuntime(stateFor, fn) {
  const realInfo = runtime.info;
  runtime.info = (pid) => (pid === 'hello' ? { ...realInfo(pid), state: stateFor } : realInfo(pid));
  try { return await fn(); } finally { runtime.info = realInfo; }
}
async function withoutSink(fn) {
  registry.setEnabled('hello', false);
  try { return await fn(); } finally { registry.setEnabled('hello', true); }
}

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  hostApi = require('../src/services/plugins/hostApi');
  manifest = require('../src/services/plugins/manifest');
  registry = require('../src/services/plugins/registry');
  plugins = require('../src/services/plugins');
  hub = require('../src/services/notify/hub');
  chatRoutes = require('../src/services/notify/chatRoutes');
  runtime = require('../src/services/plugins/runtime');
  text = require('../src/services/notify/text');
  adminId = H.db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  anna = H.makeUser('rt-anna');
  ben = H.makeUser('rt-ben');
  carl = H.makeUser('rt-carl');
  annaDev = H.makeDevice(anna, { name: 'rt-anna-phone' });
  benDev = H.makeDevice(ben, { name: 'rt-ben-phone' });
  carlDev = H.makeDevice(carl, { name: 'rt-carl-phone' });
  school = fakePlugin('rt-school');
  const perms = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8')).permissions;
  const ins = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream')
    .send(helloPackage({ overrides: { permissions: { ...perms, notifySink: true } } })).expect(200);
  assert.equal(ins.body.canInstall, true, JSON.stringify(ins.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: ins.body.token, accept: true }).expect(200);
  assert.equal(await runtime.waitRunning('hello'), true);
});
after(async () => { await chatRoutes.settled(); await plugins.stop(); teardown(); });
beforeEach(async () => {
  await chatRoutes.settled();
  H.clearNotifications();
  H.db().prepare('DELETE FROM notify_routes').run();
  H.db().prepare('DELETE FROM notify_family_routes').run();
  chatRoutes._hookMs = null;
  chatRoutes._askMs = null;
  await kv('sink-notices', null);
  await kv('sink-cover', null);
  await kv('sink-parents', null);
});

describe('migration 107 and permissions.notifySink', () => {
  it('notify_routes and notify_family_routes exist', () => {
    assert.equal(H.db().prepare('SELECT name FROM migration_history WHERE version = 107').get().name, 'notify_routes');
    assert.deepEqual(H.db().prepare('PRAGMA table_info(notify_routes)').all().map((c) => c.name), ['user_id', 'topic', 'dest', 'updated_at']);
    assert.deepEqual(H.db().prepare('PRAGMA table_info(notify_family_routes)').all().map((c) => c.name), ['topic', 'set_by', 'set_at']);
    assert.throws(() => H.db().prepare("INSERT INTO notify_routes (user_id, topic, dest, updated_at) VALUES (?, 'x', 'family', 'now')").run(anna));
  });

  it('a boolean, shown in the install dialog', () => {
    const base = { id: 'rt-sink', name: 'Sink', version: '1.0.0', publisher: 'T', gatecontrol: '>=1.0.0', entry: 'server/index.js' };
    assert.equal(manifest.validate(base).manifest.permissions.notifySink, false);
    assert.equal(manifest.validate({ ...base, permissions: { notifySink: true } }).manifest.permissions.notifySink, true);
    assert.equal(manifest.validate({ ...base, permissions: { notifySink: 'yes' } }).ok, false);
    for (const l of ['de', 'en']) {
      const j = require(`../src/i18n/${l}.json`);
      assert.ok(j['plugins.perm.notify_sink'] && j['plugins.perm.notify_sink_on'], l);
    }
    assert.equal(require('../src/i18n/de.json')['plugins.perm.notify_sink'], 'Mitteilungen in Chats zustellen');
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'plugins-ui.js'), 'utf8'), /perm\.notifySink/);
  });

  it('the first enabled sink that may run is the active one', () => {
    assert.equal(chatRoutes.activeSink().id, 'hello');
    registry.setEnabled('hello', false);
    try { assert.equal(chatRoutes.activeSink(), null); } finally { registry.setEnabled('hello', true); }
  });
});

describe('routing split', () => {
  it('no route: inbox exactly as before, the sink is not called', async () => {
    const id = await send();
    assert.deepEqual(deliveredTo(id), sorted([annaDev.tokenId, benDev.tokenId]));
    await chatRoutes.settled();
    assert.deepEqual(await notices(), []);
  });

  it("'own': that person goes to the sink (no inbox delivery, no push), the others to the inbox", async () => {
    setOwn(anna);
    const id = await send({ data: { messageId: 12 } });
    assert.deepEqual(deliveredTo(id), [benDev.tokenId], 'anna has no delivery right away');
    await chatRoutes.settled();
    assert.deepEqual(deliveredTo(id), [benDev.tokenId], 'covered → still none');
    const [p] = await notices();
    const n = H.db().prepare('SELECT * FROM notifications WHERE id = ?').get(id);
    assert.deepEqual(p, {
      id, topic: TOPIC, source: 'plugin:rt-school', sourceLabel: text.loc({ de: 'Schule', en: 'School' }, text.serverLang()),
      topicLabel: text.loc(SCHOOL_TOPICS[0].label, text.serverLang()), title: 'Elternbrief', body: 'Bitte lesen', priority: 'normal',
      createdAt: n.created_at.replace(/\.\d{3}Z$/, 'Z'), data: { route: 'plg-rt-school', messageId: 12 },
      family: [], own: [anna], lang: text.serverLang(),
    });
    assert.deepEqual(JSON.parse(n.meta).chat.covered, [anna]);
  });

  it('household family route: every recipient goes to the sink as family (wins over own)', async () => {
    setFamily();
    setOwn(anna);
    const id = await send({}, [anna, ben, carl]);
    assert.deepEqual(deliveredTo(id), []);
    await chatRoutes.settled();
    assert.deepEqual(deliveredTo(id), []);
    const [p] = await notices();
    assert.deepEqual(sorted(p.family), sorted([anna, ben, carl]));
    assert.deepEqual(p.own, []);
  });

  it('a core topic routes too (source core, GateControl)', async () => {
    setOwn(anna, 'devices');
    const r = hub.publish({ eventId: 'peer_lifecycle', eventType: 'peer_created', topic: 'devices', source: 'system', priority: 'info',
      title: 'Neues Gerät', body: 'x', data: { route: 'vpn' }, collapseKey: null }, { route: { users: [anna, ben] } });
    assert.deepEqual(deliveredTo(r.id), [benDev.tokenId]);
    await chatRoutes.settled();
    const [p] = await notices();
    assert.equal(p.source, 'core');
    assert.equal(p.sourceLabel, 'GateControl');
    assert.equal(p.topicLabel, text.topicLabel('devices', text.serverLang()));
    assert.deepEqual(p.own, [anna]);
  });

  it('not covered → the inbox afterwards, only for those (never doubled)', async () => {
    setFamily();
    await kv('sink-cover', [anna, 999999]);
    const id = await send({}, [anna, ben]);
    assert.deepEqual(deliveredTo(id), []);
    await chatRoutes.settled();
    assert.deepEqual(deliveredTo(id), [benDev.tokenId]);
    assert.equal(H.deliveries(id).length, 1);
    assert.deepEqual(JSON.parse(H.lastNotification().meta).chat.covered, [anna]);
  });

  it('hook error → everyone diverted gets the inbox delivery', async () => {
    setOwn(anna);
    setOwn(ben);
    await kv('sink-cover', 'throw');
    const id = await send({}, [anna, ben, carl]);
    assert.deepEqual(deliveredTo(id), [carlDev.tokenId]);
    await chatRoutes.settled();
    assert.deepEqual(deliveredTo(id), sorted([annaDev.tokenId, benDev.tokenId, carlDev.tokenId]));
    assert.equal(H.deliveries(id).length, 3);
    assert.equal(H.deliveries(id).every((d) => d.state === 'queued'), true);
  });

  it('hook timeout → inbox; the late answer changes nothing', async () => {
    chatRoutes._hookMs = 300;
    setOwn(anna);
    await kv('sink-cover', 'slow');
    const id = await send({}, [anna]);
    assert.deepEqual(deliveredTo(id), []);
    await chatRoutes.settled();
    assert.deepEqual(deliveredTo(id), [annaDev.tokenId]);
    await H.sleep(2200);
    assert.equal(H.deliveries(id).length, 1);
  });

  it('an open stream gets the fallback delivery pushed', async () => {
    const server = app.listen(0);
    try {
      const s = await H.openStream(server.address().port, annaDev.raw);
      await s.waitFor((e) => e.event === 'hello');
      setOwn(anna);
      await kv('sink-cover', []);
      const id = await send({}, [anna]);
      await chatRoutes.settled();
      const ev = await s.waitFor((e) => e.event === 'notification' && e.data.id === id);
      assert.equal(ev.data.title, 'Elternbrief');
      assert.equal(ev.data.card, undefined);
      s.close();
    } finally { server.close(); }
  });

  it('sink not running → inbox right away, no hook call', async () => {
    setOwn(anna);
    await withRuntime('stopped', async () => {
      const id = await send();
      assert.deepEqual(deliveredTo(id), sorted([annaDev.tokenId, benDev.tokenId]));
    });
    await chatRoutes.settled();
    assert.deepEqual(await notices(), []);
  });

  it('no sink → unchanged behaviour (routes dormant)', async () => {
    setOwn(anna);
    setFamily('plugin:rt-school:messages');
    await withoutSink(async () => {
      const id = await send();
      assert.deepEqual(deliveredTo(id), sorted([annaDev.tokenId, benDev.tokenId]));
    });
    await chatRoutes.settled();
    assert.deepEqual(await notices(), []);
  });

  it('locked topics (security, admin_notice) always go to the inbox', async () => {
    setFamily('security');
    setFamily('admin_notice');
    setOwn(anna, 'security');
    const sec = hub.publish({ eventId: 'login_failed', eventType: 'login_failed', topic: 'security', source: 'system', priority: 'high',
      title: 'Anmeldung fehlgeschlagen', body: 'x', data: null, collapseKey: null }, { route: { users: [anna] } });
    assert.deepEqual(deliveredTo(sec.id), [annaDev.tokenId]);
    const man = hub.sendManual({ userId: adminId, target: { type: 'users', ids: [anna, ben] }, title: 'Hinweis', body: 'x', priority: 'normal' });
    assert.deepEqual(deliveredTo(man.id), sorted([annaDev.tokenId, benDev.tokenId]));
    await chatRoutes.settled();
    assert.deepEqual(await notices(), []);
  });

  it('chat topics never leave the inbox path', async () => {
    setOwn(anna, 'plugin:rt-school:talk');
    setFamily('plugin:rt-school:talk');
    const r = hub.emitPlugin('rt-school', { topic: 'talk', title: 'Anna', body: 'Hallo', users: [anna, ben], chat: true,
      data: { conversation: { id: '1', title: null, isGroup: false }, sender: { id: 2, name: 'B' } } });
    assert.deepEqual(deliveredTo(r.id), sorted([annaDev.tokenId, benDev.tokenId]));
    await chatRoutes.settled();
    assert.deepEqual(await notices(), []);
  });

  it('a bundled notification goes to the sink again, the inbox people get the update', async () => {
    const rules = require('../src/services/notify/rules');
    rules.ensurePluginRule(TOPIC);
    rules.update(TOPIC, { bundle_s: 600 });
    try {
      setOwn(anna);
      const a = await send({ collapseKey: 'letter' });
      await chatRoutes.settled();
      const b = await send({ collapseKey: 'letter', title: 'Elternbrief 2' });
      assert.equal(a, b);
      await chatRoutes.settled();
      const list = await notices();
      assert.equal(list.length, 2);
      assert.deepEqual(list.map((p) => [p.id, p.own]), [[a, [anna]], [a, [anna]]]);
      assert.match(list[1].title, /Elternbrief/);
      assert.notEqual(list[1].title, list[0].title, 'the bundled title');
      assert.deepEqual(deliveredTo(a), [benDev.tokenId]);
    } finally { rules.update(TOPIC, { bundle_s: 0 }); }
  });
});

describe('gc.notify card', () => {
  it('kept (cut to its limits), handed to the sink, never in the device payload', async () => {
    setOwn(anna);
    const id = await send({
      card: {
        text: 'Liebe Eltern,\n\n\n\nbitte …' + 'x'.repeat(5000),
        link: { label: 'Ganze Nachricht lesen – mit einer sehr langen Beschriftung', route: 'plg-rt-school' },
        actions: [{ type: 'open_app_route', label: 'Öffnen', target: 'plg-rt-school' }, { type: 'nope', label: 'x' }, { type: 'callback', id: 'ok', label: 'Gelesen' }],
      },
    });
    await chatRoutes.settled();
    const [p] = await notices();
    assert.equal(p.card.text.length, 4000);
    assert.ok(p.card.text.startsWith('Liebe Eltern,\n\nbitte'));
    assert.deepEqual(p.card.link, { label: 'Ganze Nachricht lesen – mit einer sehr l', route: 'plg-rt-school' });
    assert.deepEqual(p.card.actions, [
      { id: 'open_app_route', label: 'Öffnen', type: 'open_portal', target: '/portal#plg-rt-school' },
      { id: 'ok', label: 'Gelesen', type: 'callback' },
    ]);
    const item = (await supertest(app).get('/api/v1/client/push/inbox').set('X-API-Token', benDev.raw).expect(200)).body.items.find((x) => x.id === id);
    assert.ok(item);
    assert.equal(item.card, undefined);
    assert.equal(JSON.stringify(item).includes('Liebe Eltern'), false);
  });

  it('ERR_INVALID for a bad card; nothing pushed', async () => {
    for (const card of ['x', [], {}, { text: '' }, { text: '  ' }, { text: 7 },
      { text: 'a', link: 'x' }, { text: 'a', link: { route: 'plg-rt-school' } }, { text: 'a', link: { label: 'L', route: 'https://evil' } },
      { text: 'a', link: { label: 'L' } }, { text: 'a', actions: 'x' },
      { text: 'a', actions: [{ type: 'quick_action', plugin: 'other', id: 'x', label: 'Q' }] },
      { text: 'a', actions: [{ type: 'callback', id: 'Bad id', label: 'C' }] }]) {
      assert.equal(await codeOf({ topic: 'messages', title: 't', users: [anna], card }), 'ERR_INVALID', JSON.stringify(card));
    }
    assert.equal(H.lastNotification(), null);
    assert.equal(await codeOf({ topic: 'messages', title: 't', users: [anna], card: { text: 'ok' } }), null);
    assert.deepEqual(JSON.parse(H.lastNotification().meta).card, { text: 'ok' });
  });
});

describe('API', () => {
  const web = () => agent.get('/api/v1/me/notify/routes').expect(200);
  const webPut = (body) => agent.put('/api/v1/me/notify/routes').set('X-CSRF-Token', csrf).send(body);
  const appGet = (dev) => supertest(app).get('/api/v1/client/push/routes').set('X-API-Token', dev.raw);
  const appPut = (dev, body) => supertest(app).put('/api/v1/client/push/routes').set('X-API-Token', dev.raw).send(body);
  const topicOf = (body, id) => body.groups.flatMap((g) => g.topics).find((t) => t.id === id);

  it('GET (web, admin): groups per source, locked topics, chat topics left out', async () => {
    const { body } = await web();
    assert.equal(body.ok, true);
    assert.equal(body.sink, true);
    assert.equal(body.canFamily, true);
    assert.equal(body.groups[0].source, 'core');
    assert.equal(body.groups[0].label, 'GateControl');
    assert.deepEqual(body.groups[0].topics.map((t) => t.id), ['security', 'devices', 'services', 'system', 'admin_notice']);
    // labels in the session's language (the admin agent: English)
    assert.deepEqual(topicOf(body, 'security'), { id: 'security', label: text.topicLabel('security', 'en'), dest: 'inbox', locked: true, familySetBy: null });
    const g = body.groups.find((x) => x.source === 'plugin:rt-school');
    assert.equal(g.label, 'School');
    // the plugin's default topic (gc.notify(message)) is named like the plugin
    assert.deepEqual(g.topics, [
      { id: 'plugin:rt-school:default', label: 'School', dest: 'inbox', locked: false, familySetBy: null },
      { id: TOPIC, label: 'School messages', dest: 'inbox', locked: false, familySetBy: null },
    ]);
    assert.equal(topicOf(body, 'plugin:rt-school:talk'), undefined);
  });

  it('PUT (web): own, family (familySetBy), back to inbox; locked 409, unknown 404, bad dest 400', async () => {
    let r = await webPut({ topic: TOPIC, dest: 'own' }).expect(200);
    assert.equal(topicOf(r.body, TOPIC).dest, 'own');
    r = await webPut({ topic: TOPIC, dest: 'family' }).expect(200);
    const adminName = H.db().prepare('SELECT COALESCE(display_name, username) AS n FROM users WHERE id = ?').get(adminId).n;
    assert.deepEqual(topicOf(r.body, TOPIC), { id: TOPIC, label: 'School messages', dest: 'family', locked: false, familySetBy: adminName });
    // the household route is the same for everyone
    assert.equal(topicOf((await appGet(annaDev).expect(200)).body, TOPIC).dest, 'family');
    r = await webPut({ topic: TOPIC, dest: 'inbox' }).expect(200);
    assert.equal(topicOf(r.body, TOPIC).dest, 'inbox', 'family lifted, own setting inbox');
    assert.equal(H.db().prepare('SELECT COUNT(*) AS n FROM notify_family_routes').get().n, 0);
    assert.equal((await webPut({ topic: 'security', dest: 'own' }).expect(409)).body.error, 'locked');
    assert.equal((await webPut({ topic: 'admin_notice', dest: 'inbox' }).expect(409)).body.error, 'locked');
    assert.equal((await webPut({ topic: 'plugin:rt-school:talk', dest: 'own' }).expect(404)).body.error, 'unknown_topic');
    assert.equal((await webPut({ topic: 'plugin:nope:x', dest: 'own' }).expect(404)).body.error, 'unknown_topic');
    assert.equal((await webPut({ topic: TOPIC, dest: 'chat' }).expect(400)).body.error, 'invalid_dest');
    assert.equal((await webPut({ dest: 'own' }).expect(400)).body.error, 'invalid_topic');
  });

  it('client API: same shape; a member may choose own, not family (403); a member of admin-only topics sees none', async () => {
    const { body } = await appGet(annaDev).expect(200);
    assert.equal(body.sink, true);
    assert.equal(body.canFamily, false);
    assert.deepEqual(body.groups[0].topics.map((t) => t.id), ['devices', 'services', 'admin_notice']);
    assert.equal((await appPut(annaDev, { topic: 'security', dest: 'own' }).expect(404)).body.error, 'unknown_topic');
    assert.equal((await appPut(annaDev, { topic: TOPIC, dest: 'family' }).expect(403)).body.error, 'family_not_allowed');
    const r = await appPut(annaDev, { topic: TOPIC, dest: 'own' }).expect(200);
    assert.equal(topicOf(r.body, TOPIC).dest, 'own');
    assert.equal(topicOf((await appGet(benDev).expect(200)).body, TOPIC).dest, 'inbox', 'own is per person');
    // the household route set by someone else: a member cannot lift it
    setFamily();
    assert.equal((await appPut(annaDev, { topic: TOPIC, dest: 'inbox' }).expect(403)).body.error, 'family_not_allowed');
    assert.equal((await appPut(annaDev, { topic: TOPIC, dest: 'own' }).expect(403)).body.error, 'family_not_allowed');
    assert.equal(H.db().prepare('SELECT COUNT(*) AS n FROM notify_family_routes').get().n, 1);
  });

  it("family permission: the sink's mayRouteToFamily (a parent) — it gets { user }", async () => {
    await kv('sink-parents', [ben]);
    const { body } = await appGet(benDev).expect(200);
    assert.equal(body.canFamily, true);
    const r = await appPut(benDev, { topic: TOPIC, dest: 'family' }).expect(200);
    assert.deepEqual(topicOf(r.body, TOPIC), { id: TOPIC, label: 'Nachrichten der Schule', dest: 'family', locked: false, familySetBy: 'rt-ben' });
    assert.equal(topicOf((await appGet(annaDev).expect(200)).body, TOPIC).familySetBy, 'rt-ben');
    // a parent may lift it again
    await appPut(benDev, { topic: TOPIC, dest: 'own' }).expect(200);
    assert.equal(H.db().prepare('SELECT COUNT(*) AS n FROM notify_family_routes').get().n, 0);
    assert.equal(topicOf((await appGet(benDev).expect(200)).body, TOPIC).dest, 'own');
    assert.equal(await chatRoutes.mayRouteToFamily(ben), true);
    // the hook failing or too slow → no
    await kv('sink-parents', 'throw');
    assert.equal(await chatRoutes.mayRouteToFamily(ben), false);
    chatRoutes._askMs = 300;
    await kv('sink-parents', 'slow');
    assert.equal(await chatRoutes.mayRouteToFamily(ben), false);
    assert.equal(await chatRoutes.mayRouteToFamily(adminId), true, 'admins always');
  });

  it('no sink: sink false, everything inbox, own / family → 409 no_sink, inbox allowed', async () => {
    setOwn(anna);
    await withoutSink(async () => {
      const { body } = await appGet(annaDev).expect(200);
      assert.equal(body.sink, false);
      assert.equal(body.canFamily, false);
      assert.equal(body.groups.flatMap((g) => g.topics).every((t) => t.dest === 'inbox'), true);
      assert.equal((await appPut(annaDev, { topic: TOPIC, dest: 'own' }).expect(409)).body.error, 'no_sink');
      assert.equal((await webPut({ topic: TOPIC, dest: 'family' }).expect(409)).body.error, 'no_sink');
      await appPut(annaDev, { topic: TOPIC, dest: 'inbox' }).expect(200);
    });
    assert.equal(H.db().prepare('SELECT COUNT(*) AS n FROM notify_routes').get().n, 0);
  });

  it('gc.notify.routes (sink only): get / set like the API, refusals as HostApiError codes', async () => {
    const call = async (body) => {
      const r = await agent.post(`${API}/hello/api/notify-routes`).set('X-CSRF-Token', csrf).send(body);
      return r.body.ok ? r.body.result : { code: r.body.code, message: r.body.message };
    };
    const got = await call({ op: 'get', userId: anna, lang: 'de' });
    assert.deepEqual(got, (await appGet(annaDev).expect(200)).body);
    assert.equal(got.canFamily, false);
    const set = await call({ op: 'set', userId: anna, topic: TOPIC, dest: 'own' });
    assert.equal(topicOf(set, TOPIC).dest, 'own');
    assert.equal(H.db().prepare('SELECT dest FROM notify_routes WHERE user_id = ? AND topic = ?').get(anna, TOPIC).dest, 'own');
    assert.deepEqual(await call({ op: 'set', userId: anna, topic: TOPIC, dest: 'family' }), { code: 'ERR_FORBIDDEN', message: 'family_not_allowed' });
    assert.deepEqual(await call({ op: 'set', userId: anna, topic: 'admin_notice', dest: 'inbox' }), { code: 'ERR_CONFLICT', message: 'locked' });
    assert.deepEqual(await call({ op: 'set', userId: anna, topic: 'security', dest: 'own' }), { code: 'ERR_NOT_FOUND', message: 'unknown_topic' });
    assert.deepEqual(await call({ op: 'set', userId: anna, topic: TOPIC, dest: 'x' }), { code: 'ERR_INVALID', message: 'invalid_dest' });
    assert.deepEqual(await call({ op: 'get', userId: 99999999 }), { code: 'ERR_INVALID', message: 'invalid_user' });
    assert.deepEqual(await call({ op: 'get', userId: 'x' }), { code: 'ERR_INVALID', message: 'invalid_user' });
    // a parent (the sink's own hook) may set the family route for the household
    await kv('sink-parents', [ben]);
    const fam = await call({ op: 'set', userId: ben, topic: TOPIC, dest: 'family' });
    assert.equal(topicOf(fam, TOPIC).familySetBy, 'rt-ben');
    // the lang option
    assert.equal((await call({ op: 'get', userId: anna, lang: 'en' })).groups.find((g) => g.source === 'plugin:rt-school').label, 'School');
    await withoutSink(async () => {
      assert.deepEqual(await call({ op: 'set', userId: anna, topic: TOPIC, dest: 'own' }), { code: 'ERR_CONFLICT', message: 'no_sink' });
    });
    // a plugin without permissions.notifySink
    await assert.rejects(hostApi.handle(school, 'notify.routes.get', { userId: anna }), (e) => e.code === 'ERR_NOTIFY_SINK_DENIED');
    await assert.rejects(hostApi.handle(school, 'notify.routes.set', { userId: anna, topic: TOPIC, dest: 'inbox' }), (e) => e.code === 'ERR_NOTIFY_SINK_DENIED');
  });

  it('client API: token without an owner → 403 no_user; no token → 403', async () => {
    const t = require('../src/services/tokens').create({ name: H.uniq('rt-ownerless'), scopes: ['client'], userId: null, peerId: null }, '127.0.0.1');
    assert.equal((await supertest(app).get('/api/v1/client/push/routes').set('X-API-Token', t.rawToken).expect(403)).body.error, 'no_user');
    await supertest(app).get('/api/v1/client/push/routes').expect((res) => assert.ok([401, 403].includes(res.status)));
  });
});
