'use strict';

// Chat notifications (docs/plugins.md "Chat notifications"): notifyTopics[].chat,
// gc.notify on such a topic with users, conversation, sender and the action
// types reply / mark_read; own budget (1200/h per plugin, 120/h per
// recipient), kind 'message' (not in the inbox, text hidden from the
// administrator, purged after the push retention), never mailed, never
// bundled or held back, no activity row with the text.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const supertest = require('supertest');
const { helloPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');

let app, agent, csrf, hostApi, manifest, registry, rules, plugins, store, hub, adminId, anna, annaDev, ben, benDev;

const TOPICS = [
  { id: 'message', label: { de: 'Nachrichten', en: 'Messages' }, chat: true },
  { id: 'news', label: 'Neuigkeiten' },
];

function fakePlugin(id, { app: withApp = true, topics = TOPICS } = {}) {
  const raw = {
    id, name: { de: 'Chats', en: 'Chats' }, version: '1.0.0', publisher: 'Test', gatecontrol: '>=1.0.0', entry: 'server/index.js',
    permissions: { notify: true, ...(withApp ? { app: true } : {}) }, notifyTopics: topics,
  };
  const v = manifest.validate(raw);
  assert.ok(v.ok, JSON.stringify(v.errors));
  registry.upsert({ manifest: v.manifest, signature: 'trusted', enabled: true });
  return { id, name: 'Chats', manifest: v.manifest };
}
const call = (plugin, notification) => hostApi.handle(plugin, 'notify', { notification });
const code = async (plugin, n) => { try { await call(plugin, n); return null; } catch (e) { return e.code; } };
const msg = (over = {}) => ({
  topic: 'message', title: 'Anna', body: 'Bist du schon unterwegs?', users: [ben],
  conversation: { id: 'c-12', title: null, isGroup: false }, sender: { id: anna, name: 'Anna', avatarUrl: null }, ...over,
});

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  hostApi = require('../src/services/plugins/hostApi');
  manifest = require('../src/services/plugins/manifest');
  registry = require('../src/services/plugins/registry');
  rules = require('../src/services/notify/rules');
  plugins = require('../src/services/plugins');
  store = require('../src/services/notify/store');
  hub = require('../src/services/notify/hub');
  adminId = H.db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  anna = H.makeUser('chat-anna');
  ben = H.makeUser('chat-ben');
  annaDev = H.makeDevice(anna, { name: 'chat-anna-phone' });
  benDev = H.makeDevice(ben, { name: 'chat-ben-phone' });
});
after(async () => { await plugins.stop(); teardown(); });
beforeEach(() => { H.clearNotifications(); hostApi._resetBudgetsForTest(); });

describe('plugin.json notifyTopics[].chat', () => {
  const base = { id: 'x-chat', name: 'X', version: '1.0.0', publisher: 'T', gatecontrol: '>=1.0.0', entry: 'server/index.js', permissions: { notify: true } };
  it('a boolean; kept only when true; never with allowCritical, never the default topic', () => {
    const v = manifest.validate({ ...base, notifyTopics: [{ id: 'message', label: 'Nachrichten', chat: true }, { id: 'news', label: 'News', chat: false }] });
    assert.deepEqual(v.manifest.notifyTopics, [
      { id: 'message', label: { de: 'Nachrichten', en: 'Nachrichten' }, default: true, chat: true },
      { id: 'news', label: { de: 'News', en: 'News' }, default: true },
    ]);
    assert.deepEqual(manifest.validate({ ...base, notifyTopics: [{ id: 'm', label: 'M', chat: 'yes' }] }).errors, ['notifyTopics: invalid']);
    assert.deepEqual(manifest.validate({ ...base, notifyTopics: [{ id: 'm', label: 'M', chat: true, allowCritical: true }] }).errors, ['notifyTopics: chat topic cannot be critical or default']);
    assert.deepEqual(manifest.validate({ ...base, notifyTopics: [{ id: 'default', label: 'M', chat: true }] }).errors, ['notifyTopics: chat topic cannot be critical or default']);
  });

  it('the install dialog names the chat topics', async () => {
    const PUI = require('../public/js/plugins-ui.js');
    const de = require('../src/i18n/de.json');
    const t = (k, p) => { let s = de[k] || k; for (const [a, b] of Object.entries(p || {})) s = s.split('{{' + a + '}}').join(String(b)); return s; };
    const rows = Object.fromEntries(PUI.permRows({ notify: true, notifyPerHour: 30, chatTopics: ['Nachrichten'], network: { internet: [], homeTargets: [] } }, t).map((r) => [r.label, r.value]));
    assert.match(rows['Chat-Mitteilungen'], /Antwortfeld senden \(Nachrichten\).*nie per E-Mail/);
  });
});

describe('gc.notify on a chat topic', () => {
  it('kind message: conversation and sender in data, a collapse key per chat, priority at most high, only the listed people', async () => {
    const p = fakePlugin('chat-one');
    const r = await call(p, msg({ priority: 'critical', users: [ben, ben], data: { msgId: 77 } }));
    assert.equal(r.pushed, true);
    assert.deepEqual(r.skipped, []);
    const n = H.lastNotification();
    assert.equal(n.id, r.id);
    assert.equal(n.kind, 'message');
    assert.equal(n.topic, 'plugin:chat-one:message');
    assert.equal(n.priority, 'high');
    assert.equal(n.collapse_key, 'plugin:chat-one:chat:c-12');
    assert.deepEqual(JSON.parse(n.data), {
      route: 'plg-chat-one', msgId: 77,
      conversation: { id: 'c-12', title: null, isGroup: false }, sender: { id: anna, name: 'Anna', avatarUrl: null },
    });
    assert.deepEqual(H.deliveries(n.id).map((d) => d.token_id), [benDev.tokenId]);
    const seq = H.deliveries(n.id)[0].seq;
    const payload = store.payload(store.deliveryRow(seq));
    assert.equal(payload.kind, 'message');
    assert.equal(payload.title, 'Anna');
    // a normal notification has no `kind` in its payload (unchanged contract)
    await call(p, { topic: 'news', title: 'Neu', users: [ben] });
    const plain = store.payload(store.deliveryRow(H.deliveries(H.lastNotification().id)[0].seq));
    assert.equal('kind' in plain, false);
    assert.equal(H.lastNotification().kind, null);
  });

  it('group chat, a numeric conversation id, avatarUrl of this server, an own collapse key', async () => {
    const p = fakePlugin('chat-two');
    await call(p, msg({ conversation: { id: 9, title: 'Familie', isGroup: true }, sender: { id: 'u-3', name: 'Ben', avatarUrl: '/avatars/abcdefghijklmnopqrstuvw.webp' }, collapseKey: 'grp:9' }));
    const n = H.lastNotification();
    assert.equal(n.collapse_key, 'plugin:chat-two:grp:9');
    const d = JSON.parse(n.data);
    assert.deepEqual(d.conversation, { id: '9', title: 'Familie', isGroup: true });
    assert.deepEqual(d.sender, { id: 'u-3', name: 'Ben', avatarUrl: '/avatars/abcdefghijklmnopqrstuvw.webp' });
    await call(p, msg({ sender: { id: anna, name: 'Anna', avatarUrl: '/plugin-media/' + 'a'.repeat(32) + '.1999999999.0.' + 'x'.repeat(22) } }));
  });

  it('refusals: users, conversation, sender, fields', async () => {
    const p = fakePlugin('chat-three');
    assert.equal(await code(p, msg({ users: undefined })), 'ERR_INVALID');
    assert.equal(await code(p, msg({ users: [] })), 'ERR_INVALID');
    assert.equal(await code(p, msg({ conversation: undefined })), 'ERR_INVALID');
    assert.equal(await code(p, msg({ conversation: { id: 'a b' } })), 'ERR_INVALID');
    assert.equal(await code(p, msg({ conversation: { id: 'c', isGroup: 'yes' } })), 'ERR_INVALID');
    assert.equal(await code(p, msg({ sender: undefined })), 'ERR_INVALID');
    assert.equal(await code(p, msg({ sender: { id: anna, name: '  ' } })), 'ERR_INVALID');
    assert.equal(await code(p, msg({ sender: { id: { x: 1 }, name: 'A' } })), 'ERR_INVALID');
    assert.equal(await code(p, msg({ sender: { id: anna, name: 'A', avatarUrl: 'https://evil.example/a.png' } })), 'ERR_INVALID');
    assert.equal(await code(p, msg({ title: '' })), 'ERR_INVALID');
    assert.equal(await code(p, msg({ priority: 'urgent' })), 'ERR_INVALID');
    assert.equal(await code(p, msg({ collapseKey: 'ä ö' })), 'ERR_INVALID');
    assert.equal(await code(p, msg({ data: [] })), 'ERR_INVALID');
    assert.equal(H.lastNotification(), null, 'nothing pushed');
  });

  it('reply / mark_read: a path of the plugin\'s client API (needs permissions.app), label ≤ 24, body ≤ 1 KB', async () => {
    const p = fakePlugin('chat-four');
    await call(p, msg({ data: { actions: [
      { type: 'reply', label: 'Antworten', path: '/conversations/c-12/messages', body: { replyTo: 77 } },
      { type: 'mark_read', id: 'read', label: 'Gelesen', path: 'conversations/c-12/read', body: { upTo: 77 } },
      { type: 'open_app_route', id: 'open', label: 'Öffnen', target: 'plg-chat-four' },
    ] } }));
    assert.deepEqual(JSON.parse(H.lastNotification().data).actions, [
      { id: 'reply', label: 'Antworten', type: 'reply', path: 'conversations/c-12/messages', body: { replyTo: 77 } },
      { id: 'read', label: 'Gelesen', type: 'mark_read', path: 'conversations/c-12/read', body: { upTo: 77 } },
      { id: 'open', label: 'Öffnen', type: 'open_app_route', target: 'plg-chat-four' },
    ]);
    const act = (a) => msg({ data: { actions: [a] } });
    assert.equal(await code(p, act({ type: 'reply', label: 'A', path: '../admin' })), 'ERR_INVALID');
    assert.equal(await code(p, act({ type: 'reply', label: 'A', path: '' })), 'ERR_INVALID');
    assert.equal(await code(p, act({ type: 'reply', label: 'x'.repeat(25), path: 'a' })), 'ERR_INVALID');
    assert.equal(await code(p, act({ type: 'mark_read', label: 'A', path: 'a', body: 'x' })), 'ERR_INVALID');
    assert.equal(await code(p, act({ type: 'mark_read', label: 'A', path: 'a', body: { x: 'y'.repeat(1100) } })), 'ERR_INVALID');
    const noApp = fakePlugin('chat-noapp', { app: false });
    assert.equal(await code(noApp, act({ type: 'reply', label: 'A', path: 'a' })), 'ERR_INVALID');
    // on a normal topic reply / mark_read are no action types: dropped like every unknown type
    await call(p, { topic: 'news', title: 'x', users: [ben], data: { actions: [{ type: 'reply', label: 'A', path: 'a' }] } });
    assert.equal(JSON.parse(H.lastNotification().data).actions, undefined);
  });

  it('no activity row with the text: one neutral line with the count per hour (flushChatSummary)', async () => {
    const p = fakePlugin('chat-five');
    await call(p, msg({ title: 'Geheimer Titel', body: 'geheimer Text' }));
    await call(p, msg({ title: 'Geheimer Titel', body: 'geheimer Text' }));
    assert.equal(H.db().prepare("SELECT COUNT(*) AS n FROM activity_log WHERE message LIKE '%Geheim%' OR message LIKE '%geheim%' OR details LIKE '%geheim%'").get().n, 0);
    hostApi.flushChatSummary();
    const row = H.db().prepare("SELECT message, details FROM activity_log WHERE event_type = 'plugin_notice' ORDER BY id DESC LIMIT 1").get();
    assert.equal(row.message, 'Chats: 2 chat notifications sent');
    assert.deepEqual(JSON.parse(row.details), { plugin: 'chat-five', chat: true, count: 2 });
    const before0 = H.db().prepare('SELECT COUNT(*) AS n FROM activity_log').get().n;
    hostApi.flushChatSummary();
    assert.equal(H.db().prepare('SELECT COUNT(*) AS n FROM activity_log').get().n, before0, 'nothing new → no line');
  });

  it('never mailed, never bundled, never held back (the rule\'s e-mail, bundle and delay do not apply)', async () => {
    const p = fakePlugin('chat-six');
    for (const t of ['message', 'news']) {
      rules.ensurePluginRule(`plugin:chat-six:${t}`);
      rules.update(`plugin:chat-six:${t}`, { ch_email: true, bundle_s: 300, delay_s: 0 });
    }
    await call(p, msg());
    const a = H.lastNotification();
    await call(p, msg({ body: 'zweite Nachricht' }));
    const b = H.lastNotification();
    assert.notEqual(a.id, b.id, 'two notifications, not a bundle');
    assert.deepEqual([a.count, b.count, b.title], [1, 1, 'Anna']);
    assert.equal(a.email_state, null);
    assert.equal(b.email_state, null);
    // the same rule on a normal topic bundles and mails as before
    await call(p, { topic: 'news', title: 'n1', users: [ben], collapseKey: 'k' });
    const c = H.lastNotification();
    assert.equal(c.email_state, 'sent');
    await call(p, { topic: 'news', title: 'n2', users: [ben], collapseKey: 'k' });
    assert.equal(H.lastNotification().id, c.id, 'bundled');
    rules.update('plugin:chat-six:message', { delay_s: 120 });
    await call(p, msg({ conversation: { id: 'other' } }));
    assert.equal(H.lastNotification().release_at, null, 'not held back');
  });

  it('budget: 120 per hour and recipient (over it: skipped), 1200 per hour and plugin', async () => {
    const p = fakePlugin('chat-seven');
    for (let i = 0; i < hostApi.CHAT_PER_USER_HOUR; i++) await call(p, msg({ users: [anna], body: `m${i}` }));
    assert.equal(await code(p, msg({ users: [anna] })), 'ERR_RATE_LIMIT', 'the only recipient is over its budget');
    const r = await call(p, msg({ users: [anna, ben] }));
    assert.deepEqual(r.skipped, [anna]);
    assert.deepEqual(H.deliveries(r.id).map((d) => d.token_id), [benDev.tokenId]);
    hostApi._resetBudgetsForTest();
    const many = [];
    for (let i = 0; i < 10; i++) many.push(H.makeUser(`chat-bulk-${i}`));
    for (let i = 0; i < hostApi.CHAT_PER_HOUR; i++) await call(p, msg({ users: [many[i % 10]] }));
    assert.equal(await code(p, msg({ users: [ben] })), 'ERR_RATE_LIMIT');
    // the budget of the normal topics is a different one
    await call(p, { topic: 'news', title: 'still', users: [ben] });
  });
});

describe('kind message outside the push', () => {
  it('not in the inbox of the apps and the portal, not counted as unread, not part of "alle gelesen"', async () => {
    const p = fakePlugin('chat-eight');
    H.makeDevice(adminId, { name: 'chat-admin-phone' });
    await call(p, msg({ users: [ben, adminId] }));
    const chatId = H.lastNotification().id;
    await call(p, { topic: 'news', title: 'Neuigkeit', users: [ben, adminId] });
    const newsId = H.lastNotification().id;
    const inbox = await supertest(app).get('/api/v1/client/push/inbox').set('X-API-Token', benDev.raw).expect(200);
    assert.deepEqual(inbox.body.items.map((x) => x.id), [newsId]);
    assert.equal(inbox.body.unread, 1);
    assert.equal(store.unreadCount(benDev.tokenId), 1);
    const own = await agent.get('/api/v1/me/notify/inbox').expect(200);
    assert.ok(own.body.items.some((x) => x.id === newsId));
    assert.ok(!own.body.items.some((x) => x.id === chatId));
    assert.equal(hub.markRead(ben, null), 1, 'only the news');
    assert.equal(H.deliveries(chatId).find((d) => d.user_id === ben).state, 'queued');
  });

  it('the administrator sees that a chat notification went out, never its text, sender or conversation', async () => {
    const p = fakePlugin('chat-nine');
    await call(p, msg({ title: 'Privat-Titel', body: 'Privat-Text' }));
    const id = H.lastNotification().id;
    const hist = await agent.get('/api/v1/notify/history').expect(200);
    const it2 = hist.body.items.find((x) => x.id === id);
    const HIDDEN = ['Chat-Nachricht (Inhalt privat)', 'Chat message (content private)'];
    assert.ok(HIDDEN.includes(it2.title), it2.title);
    assert.equal(it2.body, '');
    const det = await agent.get(`/api/v1/notify/history/${id}`).expect(200);
    assert.ok(HIDDEN.includes(det.body.notification.title));
    assert.equal(det.body.notification.data, null);
    assert.doesNotMatch(JSON.stringify(det.body), /Privat|Anna/);
    const ov = await agent.get('/api/v1/notify/overview').expect(200);
    assert.doesNotMatch(JSON.stringify(ov.body), /Privat-Titel/);
  });

  it('purged after the push retention (retention_h), not kept as history', async () => {
    const p = fakePlugin('chat-ten');
    await call(p, msg());
    const chatId = H.lastNotification().id;
    await call(p, { topic: 'news', title: 'bleibt', users: [ben] });
    const newsId = H.lastNotification().id;
    const old = new Date(Date.now() - 80 * 3600 * 1000).toISOString();
    H.db().prepare('UPDATE notifications SET created_at = ? WHERE id IN (?, ?)').run(old, chatId, newsId);
    const r = require('../src/services/notify/retention').run();
    assert.ok(r.purged >= 1);
    assert.equal(store.getNotification(chatId), null);
    assert.ok(store.getNotification(newsId), 'history_days for everything else');
  });
});

describe('end to end', () => {
  it('through the plugin process and the push stream: the device gets kind message with conversation, sender and reply', async () => {
    const API = '/api/v1/plugins';
    const perms = JSON.parse(require('node:fs').readFileSync(require('node:path').join(require('./helpers/plugins').HELLO, 'plugin.json'), 'utf8')).permissions;
    const buf = helloPackage({ overrides: { id: 'hello-chat', name: 'Hallo Chat', permissions: { ...perms, notify: true, app: true },
      notifyTopics: [{ id: 'message', label: 'Nachrichten', chat: true }] } });
    const ins = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
    assert.deepEqual(ins.body.plugin.permissions.chatTopics, ['Nachrichten']);
    await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: ins.body.token, accept: true }).expect(200);
    assert.equal(await require('../src/services/plugins/runtime').waitRunning('hello-chat'), true);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const benTab = H.makeDevice(ben, { name: 'chat-ben-tab' });
    const s = await H.openStream(server.address().port, benDev.raw);
    const s2 = await H.openStream(server.address().port, benTab.raw);
    try {
      await s.waitFor((e) => e.event === 'hello');
      await s2.waitFor((e) => e.event === 'hello');
      const r = await agent.post(`${API}/hello-chat/api/notify2`).set('X-CSRF-Token', csrf).send(msg({
        data: { actions: [{ type: 'reply', label: 'Antworten', path: 'conversations/c-12/messages' }, { type: 'mark_read', label: 'Gelesen', path: 'conversations/c-12/read' }] },
      })).expect(200);
      assert.equal(r.body.result.pushed, true);
      const ev = await s.waitFor((e) => e.event === 'notification');
      assert.equal(ev.data.kind, 'message');
      assert.equal(ev.data.topic, 'plugin:hello-chat:message');
      assert.equal(ev.data.collapse_key, 'plugin:hello-chat:chat:c-12');
      assert.deepEqual(ev.data.data.conversation, { id: 'c-12', title: null, isGroup: false });
      assert.deepEqual(ev.data.data.sender, { id: anna, name: 'Anna', avatarUrl: null });
      assert.deepEqual(ev.data.data.actions.map((a) => [a.type, a.path]), [['reply', 'conversations/c-12/messages'], ['mark_read', 'conversations/c-12/read']]);
      // the reply of the app: a POST to the plugin's client API with { clientId, kind, text }
      const reply = await supertest(app).post('/api/v1/client/plugins/hello-chat/api/ping').set('X-API-Token', benDev.raw)
        .send({ clientId: 'n-1', kind: 'text', text: 'Gleich da', source: 'notification' }).expect(200);
      assert.deepEqual(reply.body.body, { clientId: 'n-1', kind: 'text', text: 'Gleich da', source: 'notification' });
      // read on this device → the person's other devices get `read` (existing read-sync)
      await s2.waitFor((e) => e.event === 'notification');
      await supertest(app).post('/api/v1/client/push/ack').set('X-API-Token', benDev.raw).send({ seqs: [Number(ev.id)], state: 'read', action: 'read' }).expect(200);
      const rd = await s2.waitFor((e) => e.event === 'read');
      assert.deepEqual(rd.data, { ids: [ev.data.id] });
    } finally {
      s.close();
      s2.close();
      await new Promise((r) => server.close(r));
    }
  });
});
