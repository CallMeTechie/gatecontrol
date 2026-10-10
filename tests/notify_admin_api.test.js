'use strict';

// Admin API of the notification center (/api/v1/notify) — exact response
// shapes the admin page relies on, licensing (email_alerts), CSRF, role —
// and the person's own API (/api/v1/me/notify).

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const argon2 = require('argon2');
const { setup, teardown } = require('./helpers/setup');
const H = require('./helpers/notify');

const PW = 'Plain!Pass1234';
let app, agent, csrf, hub, stream, license, adminId, anna, annaPhone, adminPhone, group, groupDev;

async function loginAs(username) {
  const a = supertest.agent(app);
  const page = await a.get('/login').expect(200);
  const c = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
  await a.post('/login').type('form').send({ username, password: PW, _csrf: c }).expect(302);
  const prof = await a.get('/profile');
  const m = prof.text.match(/csrfToken:\s*'([^']+)'/);
  return { a, csrf: m ? m[1] : '' };
}

before(async () => {
  ({ app, agent, csrfToken: csrf } = await setup());
  hub = require('../src/services/notify/hub');
  stream = require('../src/services/notify/stream');
  license = require('../src/services/license');
  adminId = H.db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  anna = Number(H.db().prepare("INSERT INTO users (username, password_hash, role, self_service_enabled, display_name, language) VALUES ('nc-anna', ?, 'user', 1, 'Anna', 'de')")
    .run(await argon2.hash(PW, require('../src/utils/argon2Options'))).lastInsertRowid);
  annaPhone = H.makeDevice(anna, { name: 'anna-phone' });
  adminPhone = H.makeDevice(adminId, { name: 'admin-phone' });
  group = H.makeGroup('Familie');
  groupDev = H.makeDevice(H.makeUser('carla'), { name: 'carla-tab', groupId: group });
  H.makeDevice(anna, { name: 'plain-peer', app: false });
});
after(() => { stream._resetForTest(); teardown(); });
beforeEach(() => { stream._resetForTest(); });

const get = (p) => agent.get(`/api/v1/notify${p}`);
const put = (p) => agent.put(`/api/v1/notify${p}`).set('X-CSRF-Token', csrf);
const post = (p) => agent.post(`/api/v1/notify${p}`).set('X-CSRF-Token', csrf);
const keys = (o) => Object.keys(o).sort();
function fakeConn(tokenId, userId, via = 'tunnel') {
  const res = { write: () => true, end() {}, once() {} };
  return stream.add({ tokenId, userId, via, res, connectedAt: new Date().toISOString() });
}
function withoutLicence(fn) {
  return async () => {
    license._overrideForTest({ email_alerts: false });
    try { await fn(); } finally { license._overrideForTest({ email_alerts: true }); }
  };
}

describe('access', () => {
  it('a member session and an API token get 403; CSRF is required', async () => {
    const m = await loginAs('nc-anna');
    await m.a.get('/api/v1/notify/rules').expect(403);
    const tok = require('../src/services/tokens').create({ name: 'full', scopes: ['full-access'], userId: adminId }, '127.0.0.1');
    await supertest(app).get('/api/v1/notify/rules').set('X-API-Token', tok.rawToken).expect(403);
    await agent.put('/api/v1/notify/settings').send({ keepalive_s: 30 }).expect(403);
  });
});

describe('GET /overview', () => {
  it('kpis, recent, hub, sources — exact shape', async () => {
    H.clearNotifications();
    fakeConn(adminPhone.tokenId, adminId, 'tunnel');
    hub.sendManual({ userId: adminId, target: { type: 'devices', ids: [adminPhone.tokenId, annaPhone.tokenId] }, title: 'Hallo', body: '', priority: 'normal', ttlS: null });
    const r = await get('/overview').expect(200);
    assert.deepEqual(keys(r.body), ['hub', 'kpis', 'ok', 'recent', 'sources']);
    assert.deepEqual(keys(r.body.kpis), ['delivered_24h', 'devices_connected', 'devices_total', 'direct', 'failed_7d', 'median_latency_ms', 'queued', 'queued_devices', 'read_24h', 'tunnel']);
    assert.equal(r.body.kpis.devices_connected, 1);
    assert.equal(r.body.kpis.tunnel, 1);
    assert.equal(r.body.kpis.direct, 0);
    assert.equal(r.body.kpis.queued, 1, 'anna is offline');
    assert.equal(r.body.kpis.queued_devices, 1);
    assert.ok(r.body.kpis.devices_total >= 3);
    assert.deepEqual(keys(r.body.recent[0]), ['created_at', 'delivered', 'event_id', 'id', 'priority', 'read', 'recipients_label', 'silent', 'source', 'title', 'topic', 'total']);
    assert.equal(r.body.recent[0].total, 2);
    assert.equal(r.body.recent[0].source, `manual:${adminId}`);
    assert.deepEqual(r.body.hub, { enabled: true, endpoint: '/api/v1/client/push', keepalive_s: 25, retention_h: 72, max_queue: 200, allow_direct: true });
    assert.deepEqual(r.body.sources.map((s) => s.id), ['security', 'devices', 'services', 'system', 'plugins']);
  });
});

describe('rules', () => {
  it('GET /rules: rules with labels, users, groups, webhooks_count, pro', async () => {
    const r = await get('/rules').set('Accept-Language', 'de').expect(200);
    assert.deepEqual(keys(r.body), ['groups', 'ok', 'pro', 'rules', 'users', 'webhooks_count']);
    const gw = r.body.rules.find((x) => x.event_id === 'gateway_state');
    assert.deepEqual(keys(gw), ['bundle_s', 'ch_app', 'ch_email', 'ch_webhook', 'delay_s', 'email_fallback_s', 'enabled', 'event_id', 'group', 'label', 'plugin_id', 'priority', 'recipients', 'recovery']);
    assert.equal(gw.group, 'peers');
    assert.equal(gw.plugin_id, null);
    assert.equal(typeof gw.label, 'string');
    assert.ok(gw.label.length > 0 && gw.label !== 'st.event.gateway_state');
    assert.deepEqual(gw.recipients, { admins: true, owner: false, subscribers: false, users: [], groups: [] });
    assert.ok(r.body.users.some((u) => u.id === anna && u.name === 'Anna'));
    assert.ok(r.body.groups.some((g) => g.id === group));
    assert.equal(r.body.pro, true);
    assert.equal(typeof r.body.webhooks_count, 'number');
  });

  it('PUT /rules/:eventId: partial update, validated, logged', async () => {
    const r = await put('/rules/gateway_state').send({ delay_s: 120, recipients: { admins: true, owner: true, users: [anna], groups: [group] } }).expect(200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.rule.delay_s, 120);
    assert.deepEqual(r.body.rule.recipients, { admins: true, owner: true, subscribers: false, users: [anna], groups: [group] });
    assert.equal(r.body.rule.priority, 'critical', 'untouched fields stay');
    const bad = await put('/rules/gateway_state').send({ priority: 'loud', bundle_s: 'x' }).expect(400);
    assert.deepEqual(keys(bad.body.fields), ['bundle_s', 'priority']);
    await put('/rules/nope').send({ enabled: false }).expect(404);
    const log = H.db().prepare("SELECT 1 FROM activity_log WHERE event_type = 'notify_rule_updated'").get();
    assert.ok(log);
    await put('/rules/gateway_state').send({ delay_s: 0, recipients: { admins: true } }).expect(200);
  });

  it('without email_alerts: users/groups recipients, non-free e-mail and plugin rules are 403; pro=false', withoutLicence(async () => {
    const r = await put('/rules/gateway_state').send({ recipients: { admins: true, users: [anna] } }).expect(403);
    assert.equal(r.body.feature, 'email_alerts');
    assert.ok(r.body.upgrade_url);
    await put('/rules/gateway_state').send({ recipients: { admins: true, groups: [group] } }).expect(403);
    await put('/rules/gateway_state').send({ ch_email: true }).expect(403);
    await put('/rules/route_state').send({ ch_email: true }).expect(200);
    await put('/rules/route_state').send({ ch_email: false }).expect(200);
    await put('/rules/gateway_state').send({ priority: 'high', recipients: { admins: true, owner: true } }).expect(200);
    await put('/rules/gateway_state').send({ priority: 'critical', recipients: { admins: true } }).expect(200);
    assert.equal((await get('/rules').expect(200)).body.pro, false);
  }));
});

describe('GET /devices', () => {
  it('every device with presence, queue and app state', async () => {
    H.clearNotifications();
    fakeConn(adminPhone.tokenId, adminId, 'direct');
    H.db().prepare('UPDATE notify_device_prefs SET restricted = 1 WHERE token_id = ?').run(groupDev.tokenId);
    hub.sendManual({ userId: adminId, target: { type: 'devices', ids: [annaPhone.tokenId] }, title: 'Q', body: '', priority: 'normal', ttlS: null });
    const r = await get('/devices').expect(200);
    const d = r.body.devices;
    assert.deepEqual(keys(d[0]), ['app_version', 'buffer_until', 'client_type', 'connected_since', 'last_ack_at', 'last_seen', 'name', 'platform', 'queued', 'state', 'token_id', 'user', 'via']);
    const by = Object.fromEntries(d.map((x) => [x.token_id, x]));
    assert.equal(by[adminPhone.tokenId].state, 'connected');
    assert.equal(by[adminPhone.tokenId].via, 'direct');
    assert.ok(by[adminPhone.tokenId].connected_since);
    assert.deepEqual(by[adminPhone.tokenId].user, { id: adminId, name: by[adminPhone.tokenId].user.name, role: 'admin' });
    assert.equal(by[annaPhone.tokenId].state, 'offline');
    assert.equal(by[annaPhone.tokenId].queued, 1);
    assert.ok(by[annaPhone.tokenId].buffer_until);
    assert.equal(by[annaPhone.tokenId].platform, 'android');
    assert.equal(by[groupDev.tokenId].state, 'offline', 'restricted shows while connected');
    assert.ok(d.some((x) => x.state === 'unsupported'), 'a plain WireGuard peer without app');
    assert.equal(d[0].state, 'connected', 'connected first');
    H.db().prepare('UPDATE notify_device_prefs SET restricted = 0 WHERE token_id = ?').run(groupDev.tokenId);
  });
});

describe('POST /send and /test', () => {
  it('sends to users, groups, devices or all; reports now/later; logs it', async () => {
    H.clearNotifications();
    fakeConn(adminPhone.tokenId, adminId);
    let r = await post('/send').send({ target: { type: 'all', ids: [] }, title: 'An alle', body: 'Text', priority: 'high', ttl_s: 3600 }).expect(200);
    assert.deepEqual(keys(r.body), ['devices_later', 'devices_now', 'notification_id', 'ok']);
    assert.equal(r.body.devices_now, 1);
    assert.ok(r.body.devices_later >= 2);
    const n = H.db().prepare('SELECT * FROM notifications WHERE id = ?').get(r.body.notification_id);
    assert.equal(n.topic, 'admin_notice');
    assert.equal(n.source, `manual:${adminId}`);
    assert.equal(n.priority, 'high');
    assert.ok(H.db().prepare("SELECT 1 FROM activity_log WHERE event_type = 'notify_manual_sent'").get());
    r = await post('/send').send({ target: { type: 'groups', ids: [group] }, title: 'Gruppe' }).expect(200);
    assert.deepEqual(H.deliveries(r.body.notification_id).map((x) => x.token_id), [groupDev.tokenId]);
    r = await post('/send').send({ target: { type: 'users', ids: [anna] }, title: 'Anna' }).expect(200);
    assert.deepEqual(H.deliveries(r.body.notification_id).map((x) => x.token_id), [annaPhone.tokenId]);
  });

  it('validation and licence', async () => {
    const bad = await post('/send').send({ target: { type: 'nobody' }, title: '', priority: 'x', ttl_s: 5 }).expect(400);
    assert.deepEqual(keys(bad.body.fields), ['priority', 'target', 'title', 'ttl_s']);
    await withoutLicence(async () => {
      const r = await post('/send').send({ target: { type: 'all' }, title: 'x' }).expect(403);
      assert.equal(r.body.feature, 'email_alerts');
    })();
  });

  it('POST /test → the calling admin’s own devices (free)', async () => {
    await withoutLicence(async () => {
      const r = await post('/test').send({}).expect(200);
      assert.deepEqual(r.body, { ok: true, devices: 1 });
    })();
  });
});

describe('history', () => {
  let manualId;
  before(() => {
    H.clearNotifications();
    manualId = hub.sendManual({ userId: adminId, target: { type: 'devices', ids: [annaPhone.tokenId, adminPhone.tokenId] }, title: 'Verlauf', body: 'b', priority: 'normal', ttlS: null }).id;
    require('../src/services/activity').log('account_locked', 'Account locked after 5 failed logins: x', { details: { identifier: 'x' } });
  });

  it('GET /history: items, filters, paging', async () => {
    let r = await get('/history').expect(200);
    assert.deepEqual(keys(r.body), ['items', 'next_before', 'ok']);
    assert.deepEqual(keys(r.body.items[0]), ['body', 'created_at', 'delivered', 'event_id', 'id', 'priority', 'read', 'recipients_label', 'silent', 'source', 'status', 'title', 'total']);
    assert.equal(r.body.items.length, 2);
    assert.equal(r.body.next_before, null);
    const m = r.body.items.find((i) => i.id === manualId);
    assert.equal(m.status, 'waiting');
    assert.equal(m.recipients_label.length > 0, true);
    r = await get('/history?filter=manual').expect(200);
    assert.deepEqual(r.body.items.map((i) => i.id), [manualId]);
    r = await get('/history?filter=important').expect(200);
    assert.deepEqual(r.body.items.map((i) => i.event_id), ['account_locked']);
    r = await get('/history?filter=plugins').expect(200);
    assert.deepEqual(r.body.items, []);
    r = await get('/history?limit=1').expect(200);
    assert.equal(r.body.items.length, 1);
    const next = await get(`/history?limit=1&before=${r.body.next_before}`).expect(200);
    assert.equal(next.body.items.length, 1);
    assert.notEqual(next.body.items[0].id, r.body.items[0].id);
    r = await get('/history?filter=undelivered').expect(200);
    assert.ok(r.body.items.some((i) => i.id === manualId));
  });

  it('GET /history/:id: notification, timeline, deliveries, email', async () => {
    const seq = H.deliveries(manualId).find((d) => d.token_id === annaPhone.tokenId).seq;
    require('../src/services/notify/store').ack(annaPhone.tokenId, [seq], 'read', 'details');
    const r = await get(`/history/${manualId}`).expect(200);
    assert.deepEqual(keys(r.body), ['deliveries', 'email', 'notification', 'ok', 'timeline']);
    assert.equal(r.body.notification.id, manualId);
    assert.deepEqual(keys(r.body.deliveries[0]), ['action', 'delivered_at', 'device_name', 'latency_ms', 'queued_at', 'read_at', 'sent_at', 'state', 'token_id', 'user_name', 'via']);
    const a = r.body.deliveries.find((d) => d.token_id === annaPhone.tokenId);
    assert.equal(a.state, 'read');
    assert.equal(a.action, 'details');
    assert.equal(a.user_name, 'Anna');
    assert.ok(Number.isInteger(a.latency_ms));
    assert.deepEqual(r.body.timeline.map((x) => x.kind).filter((k) => k === 'created' || k === 'read'), ['created', 'read']);
    for (const t of r.body.timeline) assert.deepEqual(keys(t), ['at', 'kind', 'text']);
    assert.deepEqual(r.body.email, { sent: false, at: null });
    await get('/history/999999').expect(404);
  });

  it('POST /history/:id/resend re-queues undelivered copies under new seqs', async () => {
    const before = H.deliveries(manualId).find((d) => d.token_id === adminPhone.tokenId).seq;
    await post(`/history/${manualId}/resend`).send({}).expect(200, { ok: true });
    const after = H.deliveries(manualId);
    assert.ok(after.find((d) => d.token_id === adminPhone.tokenId).seq > before);
    assert.equal(after.find((d) => d.token_id === annaPhone.tokenId).state, 'read', 'read copies stay');
    await post('/history/999999/resend').send({}).expect(404);
  });
});

describe('settings', () => {
  it('GET/PUT with ranges; push off closes every stream', async () => {
    let r = await get('/settings').expect(200);
    assert.deepEqual(r.body, { ok: true, enabled: true, retention_h: 72, history_days: 30, max_queue: 200, keepalive_s: 25, allow_direct: true, email_fallback_s: 600, max_streams: 500 });
    const bad = await put('/settings').send({ retention_h: 0, keepalive_s: 5, allow_direct: 'no' }).expect(400);
    assert.deepEqual(keys(bad.body.fields), ['allow_direct', 'keepalive_s', 'retention_h']);
    fakeConn(adminPhone.tokenId, adminId);
    r = await put('/settings').send({ enabled: false, retention_h: 48 }).expect(200);
    assert.equal(r.body.enabled, false);
    assert.equal(r.body.retention_h, 48);
    assert.equal(stream.count(), 0);
    await put('/settings').send({ enabled: true, retention_h: 72 }).expect(200);
  });
});

describe('/api/v1/me/notify (own settings)', () => {
  it('prefs: topics with lock, quiet hours, devices; PUT validates and stores', async () => {
    const m = await loginAs('nc-anna');
    let r = await m.a.get('/api/v1/me/notify/prefs').expect(200);
    assert.deepEqual(keys(r.body), ['critical_bypass', 'devices', 'ok', 'quiet_from', 'quiet_to', 'topics', 'tz']);
    assert.ok(!r.body.topics.some((t) => t.id === 'security'), 'security is admin-only');
    assert.deepEqual(r.body.topics.find((t) => t.id === 'admin_notice'), { id: 'admin_notice', label: 'Hinweise vom Admin', enabled: true, locked: true });
    assert.ok(r.body.devices.some((d) => d.token_id === annaPhone.tokenId && d.state === 'offline'));
    assert.ok(r.body.devices.every((d) => keys(d).join() === 'name,queued,state,token_id'));
    await m.a.put('/api/v1/me/notify/prefs').set('X-CSRF-Token', m.csrf).send({ quiet_from: '25:00' }).expect(400);
    await m.a.put('/api/v1/me/notify/prefs').set('X-CSRF-Token', m.csrf).send({ topics: [{ id: 'security', enabled: true }] }).expect(400);
    r = await m.a.put('/api/v1/me/notify/prefs').set('X-CSRF-Token', m.csrf)
      .send({ topics: [{ id: 'services', enabled: false }, { id: 'admin_notice', enabled: false }], quiet_from: '22:00', quiet_to: '07:00', tz: 'Europe/Berlin', critical_bypass: false }).expect(200);
    assert.equal(r.body.topics.find((t) => t.id === 'services').enabled, false);
    assert.equal(r.body.topics.find((t) => t.id === 'admin_notice').enabled, true, 'locked topics stay on');
    assert.equal(r.body.quiet_from, '22:00');
    assert.equal(r.body.tz, 'Europe/Berlin');
    assert.equal(r.body.critical_bypass, false);
    await m.a.put('/api/v1/me/notify/prefs').set('X-CSRF-Token', m.csrf).send({ topics: [{ id: 'services', enabled: true }], quiet_from: null, quiet_to: null, critical_bypass: true }).expect(200);
  });

  it('inbox, read (own only) and test', async () => {
    H.clearNotifications();
    const a = hub.sendManual({ userId: adminId, target: { type: 'users', ids: [anna] }, title: 'Für Anna', body: '', priority: 'normal', ttlS: null });
    hub.sendManual({ userId: adminId, target: { type: 'users', ids: [adminId] }, title: 'Für Admin', body: '', priority: 'normal', ttlS: null });
    const m = await loginAs('nc-anna');
    let r = await m.a.get('/api/v1/me/notify/inbox').expect(200);
    assert.deepEqual(r.body.items.map((i) => i.title), ['Für Anna']);
    assert.equal(r.body.unread, 1);
    await m.a.post('/api/v1/me/notify/read').set('X-CSRF-Token', m.csrf).send({ ids: 'x' }).expect(400);
    r = await m.a.post('/api/v1/me/notify/read').set('X-CSRF-Token', m.csrf).send({ ids: [a.id] }).expect(200);
    assert.equal(r.body.updated, 1);
    r = await m.a.get('/api/v1/me/notify/inbox').expect(200);
    assert.equal(r.body.items[0].state, 'read');
    assert.equal(r.body.unread, 0);
    r = await m.a.post('/api/v1/me/notify/read').set('X-CSRF-Token', m.csrf).send({ all: true }).expect(200);
    assert.equal(r.body.updated, 0);
    r = await m.a.post('/api/v1/me/notify/test').set('X-CSRF-Token', m.csrf).send({}).expect(200);
    assert.deepEqual(r.body, { ok: true, devices: 1 });
    const tok = require('../src/services/tokens').create({ name: 'me-tok', scopes: ['full-access'], userId: adminId }, '127.0.0.1');
    await supertest(app).get('/api/v1/me/notify/prefs').set('X-API-Token', tok.rawToken).expect(403);
  });
});

describe('live updates for the admin page', () => {
  it('a new notification publishes `notify` on the event bus', () => {
    const bus = require('../src/services/eventBus');
    const seen = [];
    const l = (evt) => { if (evt.type === 'notify') seen.push(evt.payload); };
    bus.subscribe(l);
    try {
      const r = hub.sendManual({ userId: adminId, target: { type: 'all' }, title: 'Bus', body: '', priority: 'info', ttlS: null });
      assert.deepEqual(seen[0], { id: r.id });
    } finally { bus.unsubscribe(l); }
  });
});
