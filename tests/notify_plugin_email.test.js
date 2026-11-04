'use strict';

// E-mail channel of plugin topics (since 1.225.0, docs/plugins.md
// "Notifications by e-mail", services/notify/personMail.js): a plugin push
// also goes by e-mail through the server's SMTP to the account address of
// each person it reaches — per person and topic switchable in the portal and
// the app, on by default for a topic declared with `email: true`. Never to an
// address a plugin names. SMTP is faked like in notify_center.test.js.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');

let app, agent, csrf, hostApi, manifest, registry, license, plugins, email, personMail, hub;
let adminId, anna, ben, carl, benDev;
const sent = [];
let orig;

const TOPICS = [
  { id: 'booking', label: { de: 'Buchungsanfragen', en: 'Booking requests' }, email: true },
  { id: 'sync', label: { de: 'Abgleich', en: 'Sync' } },
  { id: 'alarm', label: 'Alarm', email: true, allowCritical: true },
  { id: 'talk', label: 'Chat', chat: true },
];

function fakePlugin(id, { topics = TOPICS, devices = false } = {}) {
  const raw = {
    id, name: { de: 'Mail', en: 'Mail' }, version: '1.0.0', publisher: 'Test', gatecontrol: '>=1.0.0', entry: 'server/index.js',
    permissions: { notify: true, ...(devices ? { devices: true } : {}) }, notifyTopics: topics,
  };
  const v = manifest.validate(raw);
  assert.ok(v.ok, JSON.stringify(v.errors));
  registry.upsert({ manifest: v.manifest, signature: 'trusted', enabled: true });
  return { id, name: 'Mail', manifest: v.manifest };
}
const call = (plugin, notification) => hostApi.handle(plugin, 'notify', { notification });
const flush = () => new Promise((r) => setImmediate(r));
const setEmail = (uid, addr) => H.db().prepare('UPDATE users SET email = ? WHERE id = ?').run(addr, uid);
const recipients = () => sent.map((m) => m.to).sort();

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  hostApi = require('../src/services/plugins/hostApi');
  manifest = require('../src/services/plugins/manifest');
  registry = require('../src/services/plugins/registry');
  license = require('../src/services/license');
  plugins = require('../src/services/plugins');
  email = require('../src/services/email');
  personMail = require('../src/services/notify/personMail');
  hub = require('../src/services/notify/hub');
  adminId = H.db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  anna = H.makeUser('anna');
  ben = H.makeUser('ben', { language: 'en' });
  carl = H.makeUser('carl');
  H.makeDevice(anna);
  benDev = H.makeDevice(ben);
  setEmail(anna, 'anna@example.com');
  setEmail(ben, 'ben@example.com');
  setEmail(adminId, 'admin@example.com');
  // carl: no address
  orig = { sendMail: email.sendMail, isSmtpConfigured: email.isSmtpConfigured };
  email.sendMail = async (m) => { sent.push(m); };
  email.isSmtpConfigured = () => true;
});
after(async () => { Object.assign(email, orig); await plugins.stop(); teardown(); });
beforeEach(() => {
  sent.length = 0;
  H.clearNotifications();
  personMail._resetForTest();
  H.db().prepare('DELETE FROM notify_email_subscriptions').run();
  H.db().prepare('DELETE FROM notify_subscriptions').run();
});

describe('plugin.json notifyTopics[].email', () => {
  const base = { id: 'x-mail', name: 'X', version: '1.0.0', publisher: 'T', gatecontrol: '>=1.0.0', entry: 'server/index.js', permissions: { notify: true } };

  it('a boolean, stored only when true; a chat topic is never mailed', () => {
    const v = manifest.validate({ ...base, notifyTopics: [{ id: 'a', label: 'A', email: true }, { id: 'b', label: 'B', email: false }] });
    assert.equal(v.ok, true, v.errors.join(', '));
    assert.deepEqual(v.manifest.notifyTopics, [{ id: 'a', label: { de: 'A', en: 'A' }, default: true, email: true }, { id: 'b', label: { de: 'B', en: 'B' }, default: true }]);
    assert.deepEqual(manifest.validate({ ...base, notifyTopics: [{ id: 'a', label: 'A', email: 'yes' }] }).errors, ['notifyTopics: invalid']);
    assert.deepEqual(manifest.validate({ ...base, notifyTopics: [{ id: 'a', label: 'A', chat: true, email: true }] }).errors, ['notifyTopics: chat topic cannot be mailed']);
  });

  it('the install dialog names the topics mailed by default', () => {
    const p = fakePlugin('mail-perm');
    const perm = plugins.list('de').find((x) => x.id === 'mail-perm').permissions;
    assert.deepEqual(perm.emailTopics, ['Buchungsanfragen', 'Alarm']);
    const de = require('../src/i18n/de.json');
    const PUI = require('../public/js/plugins-ui.js');
    const rows = PUI.permRows(perm, (k, x) => de[k].replace(/\{\{(\w+)\}\}/g, (_, n) => String(x[n])));
    assert.ok(rows.some((r) => r.label === 'Meldungen per E-Mail' && r.value.includes('Buchungsanfragen, Alarm')));
    registry.remove(p.id);
  });
});

describe('mailing a plugin push', () => {
  it('a topic declared email:true: one mail per person to the account address, in their language', async () => {
    const p = fakePlugin('mail-one');
    const r = await call(p, { topic: 'booking', title: 'Raum A angefragt', body: 'Mo 10:00 – 11:00', users: [anna, ben, carl] });
    assert.equal(r.pushed, true);
    assert.equal(r.mailed, undefined, 'the plugin learns nothing about the mails');
    await flush();
    assert.deepEqual(recipients(), ['anna@example.com', 'ben@example.com'], 'carl has no address');
    for (const m of sent) {
      assert.equal(typeof m.to, 'string');
      assert.equal(m.subject, '[GateControl] Raum A angefragt');
      assert.match(m.text, /^Raum A angefragt\n\nMo 10:00 – 11:00\n/);
    }
    assert.match(sent.find((m) => m.to === 'anna@example.com').text, /Mail über GateControl – du bekommst Mitteilungen zu „Mail · Buchungsanfragen“ auch per E-Mail\./);
    assert.match(sent.find((m) => m.to === 'ben@example.com').text, /Mail via GateControl – you get notifications about “Mail · Booking requests” by e-mail as well\./);
  });

  it('without users: the rule\'s recipients (the subscribers) get it', async () => {
    const p = fakePlugin('mail-subs');
    await call(p, { topic: 'booking', title: 'Neue Anfrage' });
    await flush();
    assert.deepEqual(recipients(), ['admin@example.com', 'anna@example.com', 'ben@example.com']);
  });

  it('a topic without email: off by default — a person may switch it on', async () => {
    const p = fakePlugin('mail-opt');
    await call(p, { topic: 'sync', title: 'Abgleich fertig', users: [anna, ben] });
    await flush();
    assert.equal(sent.length, 0);
    personMail.setEmail(anna, 'plugin:mail-opt:sync', true);
    await call(p, { topic: 'sync', title: 'Abgleich fertig', users: [anna, ben] });
    await flush();
    assert.deepEqual(recipients(), ['anna@example.com']);
  });

  it('a person who switched the e-mail or the whole topic off gets no mail; critical ignores the topic switch', async () => {
    const p = fakePlugin('mail-off');
    personMail.setEmail(anna, 'plugin:mail-off:booking', false);
    H.db().prepare("INSERT INTO notify_subscriptions (user_id, topic, enabled) VALUES (?, 'plugin:mail-off:booking', 0)").run(ben);
    await call(p, { topic: 'booking', title: 'x', users: [anna, ben] });
    await flush();
    assert.equal(sent.length, 0);
    H.db().prepare("INSERT INTO notify_subscriptions (user_id, topic, enabled) VALUES (?, 'plugin:mail-off:alarm', 0)").run(ben);
    await call(p, { topic: 'alarm', title: 'Alarm', priority: 'critical', users: [ben] });
    await flush();
    assert.deepEqual(recipients(), ['ben@example.com']);
  });

  it('never: chat topics, silent data pushes, pushes to single devices, disabled accounts, without SMTP or licence', async () => {
    const p = fakePlugin('mail-never', { devices: true });
    await call(p, { topic: 'talk', title: 'Hallo', body: 'Wie geht es?', users: [anna], conversation: { id: 'c1', title: 'Anna' } }).catch(() => {});
    await call(p, { topic: 'booking', title: 'Daten', silent: true, users: [anna] });
    await call(p, { topic: 'booking', title: 'Nur Handy', users: [ben], devices: [benDev.tokenId] });
    await flush();
    assert.equal(sent.length, 0);
    H.db().prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(anna);
    try {
      await call(p, { topic: 'booking', title: 'x', users: [anna] });
      await flush();
      assert.equal(sent.length, 0);
    } finally { H.db().prepare('UPDATE users SET enabled = 1 WHERE id = ?').run(anna); }
    email.isSmtpConfigured = () => false;
    try {
      await call(p, { topic: 'booking', title: 'x', users: [anna] });
      await flush();
      assert.equal(sent.length, 0);
    } finally { email.isSmtpConfigured = () => true; }
    license._overrideForTest({ email_alerts: false });
    try {
      await call(p, { topic: 'booking', title: 'x', users: [anna] });
      await flush();
      assert.equal(sent.length, 0);
    } finally { license._overrideForTest({ email_alerts: true }); }
  });

  it('at most MAIL_PER_HOUR mails per plugin and hour', async () => {
    fakePlugin('mail-many');
    const n = { topic: 'plugin:mail-many:booking', title: 'x', users: [anna, ben] };
    let total = 0;
    for (let i = 0; i < personMail.MAIL_PER_HOUR; i++) total += personMail.send('mail-many', n, null);
    await flush();
    assert.equal(total, personMail.MAIL_PER_HOUR);
    assert.equal(sent.length, personMail.MAIL_PER_HOUR);
    fakePlugin('mail-other');
    assert.equal(personMail.send('mail-other', { ...n, topic: 'plugin:mail-other:booking' }, null), 2, 'per plugin');
  });

  it('the hub reports how many mails went out', () => {
    fakePlugin('mail-hub');
    const r = hub.emitPlugin('mail-hub', { topic: 'booking', title: 'x', users: [anna, ben] });
    assert.equal(r.mailed, 2);
  });
});

describe('the person\'s choice', () => {
  it('portal / web: GET /me/notify/prefs shows the channel, PUT switches it', async () => {
    fakePlugin('mail-pref');
    let r = await agent.get('/api/v1/me/notify/prefs').expect(200);
    const t = (id) => r.body.topics.find((x) => x.id === id);
    assert.equal(t('plugin:mail-pref:booking').email, true);
    assert.equal(t('plugin:mail-pref:sync').email, false);
    assert.equal(t('plugin:mail-pref:default').email, false);
    assert.equal(t('plugin:mail-pref:talk').email, null, 'a chat topic has no e-mail channel');
    assert.equal(t('services').email, null, 'core topics have no such channel');
    assert.equal(r.body.email_to, 'admin@example.com');
    assert.equal(r.body.email_ready, true);
    r = await agent.put('/api/v1/me/notify/prefs').set('X-CSRF-Token', csrf)
      .send({ topics: [{ id: 'plugin:mail-pref:booking', email: false }, { id: 'plugin:mail-pref:sync', email: true }] }).expect(200);
    assert.equal(t('plugin:mail-pref:booking').email, false);
    assert.equal(t('plugin:mail-pref:booking').enabled, true, 'the topic itself stays on');
    assert.equal(t('plugin:mail-pref:sync').email, true);
    for (const bad of [[{ id: 'services', email: true }], [{ id: 'plugin:mail-pref:booking', email: 'yes' }], [{ id: 'plugin:mail-pref:booking' }]]) {
      await agent.put('/api/v1/me/notify/prefs').set('X-CSRF-Token', csrf).send({ topics: bad }).expect(400);
    }
  });

  it('app: GET / PUT /client/push/prefs email_topics (the token owner)', async () => {
    fakePlugin('mail-app');
    const api = (method) => supertest(app)[method]('/api/v1/client/push/prefs').set('X-API-Token', benDev.raw).set('X-Client-Platform', 'android').set('X-Client-Version', '2.0.0');
    let r = await api('get').expect(200);
    assert.deepEqual(r.body.email_topics.filter((x) => x.id.startsWith('plugin:mail-app:')),
      [{ id: 'plugin:mail-app:default', label: 'Mail', enabled: false }, { id: 'plugin:mail-app:booking', label: 'Mail · Booking requests', enabled: true },
        { id: 'plugin:mail-app:sync', label: 'Mail · Sync', enabled: false }, { id: 'plugin:mail-app:alarm', label: 'Mail · Alarm', enabled: true }]);
    assert.equal(r.body.email_to, 'ben@example.com');
    assert.equal(r.body.email_ready, true);
    await api('put').send({ email_topics: [{ id: 'plugin:mail-app:booking', enabled: false }] }).expect(200);
    assert.equal(personMail.emailOn(ben, 'plugin:mail-app:booking'), false);
    r = await api('put').send({ email_topics: [{ id: 'security', enabled: true }] }).expect(400);
    assert.equal(r.body.error, 'invalid_email_topics');
    await api('put').send({ email_topics: [{ id: 'plugin:mail-app:talk', enabled: true }] }).expect(400);
  });
});
