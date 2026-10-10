'use strict';

// Notification center core (docs/feature-notification-center.md): migration
// v93, rule seeding from CATALOGUE, recipient resolution and filters (owner,
// admins, subscribers, muted topics, quiet hours), delay / bundling /
// recovery, the e-mail fallback and the clean-up job.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const H = require('./helpers/notify');

let rules, router, hub, store, notify, settings, notifications, retention, activity, email;
let admin1;

before(async () => {
  await setup();
  rules = require('../src/services/notify/rules');
  router = require('../src/services/notify/router');
  hub = require('../src/services/notify/hub');
  store = require('../src/services/notify/store');
  notify = require('../src/services/notify');
  settings = require('../src/services/settings');
  notifications = require('../src/services/notifications');
  retention = require('../src/services/notify/retention');
  activity = require('../src/services/activity');
  email = require('../src/services/email');
  admin1 = H.db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
});
after(() => teardown());
afterEach(() => { store._setClock(null); hub._resetForTest(); });

describe('migration v93', () => {
  it('creates the tables and the queue index', () => {
    const db = H.db();
    for (const t of ['notify_rules', 'notifications', 'notification_deliveries', 'notify_subscriptions', 'notify_user_prefs', 'notify_device_prefs']) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t);
    }
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_nd_token_state'").get());
    const cols = db.prepare('PRAGMA table_info(notification_deliveries)').all().map((c) => c.name);
    for (const c of ['seq', 'notification_id', 'token_id', 'user_id', 'state', 'via', 'action', 'queued_at', 'sent_at', 'delivered_at', 'read_at']) assert.ok(cols.includes(c), c);
    const row = db.prepare("SELECT version, name FROM migration_history WHERE version = 93").get();
    assert.equal(row && row.name, 'notification_center');
  });
});

describe('rules', () => {
  it('one rule per catalogue row, seeded with the documented defaults', () => {
    const list = rules.list().filter((r) => !r.plugin_id);
    assert.deepEqual(list.map((r) => r.event_id), notifications.EVENTS.map((e) => e.id));
    const by = Object.fromEntries(list.map((r) => [r.event_id, r]));
    assert.equal(by.gateway_state.priority, 'critical');
    assert.equal(by.account_locked.priority, 'critical');
    assert.equal(by.login_failed.priority, 'high');
    assert.equal(by.peer_expired.priority, 'normal');
    assert.equal(by.route_state.priority, 'high');
    assert.equal(by.update.priority, 'info');
    assert.equal(by.resources.priority, 'high');
    assert.equal(by.backup_problem.priority, 'high');
    assert.deepEqual(by.gateway_state.recipients, { admins: true, owner: false, subscribers: false, users: [], groups: [] });
    assert.equal(by.gateway_state.ch_app, true);
    assert.equal(by.gateway_state.ch_webhook, true);
    assert.equal(by.gateway_state.email_fallback_s, 600);
    assert.equal(by.peer_connection.email_fallback_s, null);
    assert.equal(by.peer_connection.ch_app, false, 'device connect/disconnect must not push by default');
    assert.equal(by.login_failed.bundle_s, 300);
  });

  it('ch_email follows alerts.email_events and writes back to it', () => {
    notifications.setEmailTypes(['backup_reminder', 'autobackup_failed']);
    assert.equal(rules.get('backup_problem').ch_email, true);
    assert.equal(rules.get('peer_expired').ch_email, false);
    rules.update('peer_expired', { ch_email: true });
    assert.ok(notifications.emailTypes().includes('peer_expired'));
    rules.update('backup_problem', { ch_email: false });
    assert.ok(!notifications.emailTypes().includes('backup_reminder'));
    notifications.setEmailTypes([]);
  });

  it('maps every raw type to its row and topic', () => {
    assert.deepEqual(rules.eventForType('gateway_down'), { eventId: 'gateway_state', group: 'peers', topic: 'devices' });
    assert.equal(rules.eventForType('route_up').topic, 'services');
    assert.equal(rules.eventForType('account_locked').topic, 'security');
    assert.equal(rules.eventForType('resource_alert').topic, 'system');
    assert.equal(rules.eventForType('plugin_notice'), null);
    for (const ev of notifications.EVENTS) for (const t of ev.types) assert.equal(rules.eventForType(t).eventId, ev.id, t);
  });

  it('validates partial updates', () => {
    const bad = rules.validatePatch('gateway_state', { priority: 'urgent', delay_s: -1, recovery: 'loud', recipients: { users: ['x'] } });
    assert.deepEqual(Object.keys(bad.errors).sort(), ['delay_s', 'priority', 'recipients', 'recovery']);
    assert.equal(rules.validatePatch('gateway_state', { recipients: { users: [999999] } }).errors.recipients, 'unknown_user');
    assert.equal(rules.validatePatch('plugin:x:default', { priority: 'critical' }).errors.priority, 'priority_capped');
    const ok = rules.validatePatch('gateway_state', { delay_s: 60, email_fallback_s: null, enabled: false });
    assert.deepEqual(ok.errors, {});
    assert.deepEqual(ok.values, { delay_s: 60, email_fallback_s: null, enabled: false });
  });
});

describe('router: recipients and filters', () => {
  let anna, ben, admin2, annaDev, benDev, adminDev, plainDev;
  before(() => {
    anna = H.makeUser('anna');
    ben = H.makeUser('ben');
    admin2 = H.makeUser('admin2', { role: 'admin' });
    annaDev = H.makeDevice(anna);
    benDev = H.makeDevice(ben);
    adminDev = H.makeDevice(admin2);
    plainDev = H.makeDevice(ben, { app: false });
  });
  const tokensOf = (list) => list.map((x) => x.tokenId).sort((a, b) => a - b);

  it('admins → the app devices of every enabled admin, never plain peers', () => {
    const out = router.resolve({ recipients: { admins: true }, topic: 'devices', priority: 'normal' });
    assert.ok(tokensOf(out).includes(adminDev.tokenId));
    assert.ok(!tokensOf(out).includes(annaDev.tokenId));
    assert.ok(!tokensOf(out).includes(plainDev.tokenId));
  });

  it('owner → the person the peer belongs to', () => {
    const out = router.resolve({ recipients: { owner: true }, peerId: annaDev.peerId, topic: 'devices', priority: 'normal' });
    assert.deepEqual(tokensOf(out), [annaDev.tokenId]);
  });

  it('subscribers: core topics default on, admin-only topics only for admins, opt-out wins', () => {
    let out = router.resolve({ recipients: { subscribers: true }, topic: 'services', priority: 'normal' });
    assert.ok(tokensOf(out).includes(annaDev.tokenId) && tokensOf(out).includes(benDev.tokenId));
    out = router.resolve({ recipients: { subscribers: true }, topic: 'security', priority: 'normal' });
    assert.ok(!tokensOf(out).includes(annaDev.tokenId));
    assert.ok(tokensOf(out).includes(adminDev.tokenId));
    H.db().prepare('INSERT INTO notify_subscriptions (user_id, topic, enabled) VALUES (?, ?, 0)').run(ben, 'services');
    out = router.resolve({ recipients: { subscribers: true }, topic: 'services', priority: 'normal' });
    assert.ok(!tokensOf(out).includes(benDev.tokenId));
    // an opt-out also removes the person when named explicitly — but not for critical
    out = router.resolve({ users: [ben], topic: 'services', priority: 'high' });
    assert.deepEqual(out, []);
    out = router.resolve({ users: [ben], topic: 'services', priority: 'critical' });
    assert.deepEqual(tokensOf(out), [benDev.tokenId]);
  });

  it('users/groups recipients only with the licence; groups = devices in the group', () => {
    const g = H.makeGroup('family');
    const carla = H.makeUser('carla');
    const carlaDev = H.makeDevice(carla, { groupId: g });
    H.makeDevice(carla); // not in the group
    let out = router.resolve({ recipients: { groups: [g], users: [anna] }, topic: 'devices', priority: 'normal', licensed: false });
    assert.deepEqual(out, []);
    out = router.resolve({ recipients: { groups: [g], users: [anna] }, topic: 'devices', priority: 'normal', licensed: true });
    assert.deepEqual(tokensOf(out), [annaDev.tokenId, carlaDev.tokenId].sort((a, b) => a - b));
  });

  it('device prefs: switched off or topic muted → skipped (critical ignores the mute)', () => {
    const d = H.makeDevice(anna);
    H.db().prepare("UPDATE notify_device_prefs SET topics = '[\"devices\"]' WHERE token_id = ?").run(d.tokenId);
    let out = router.resolve({ users: [anna], topic: 'devices', priority: 'high' });
    assert.ok(!tokensOf(out).includes(d.tokenId));
    out = router.resolve({ users: [anna], topic: 'devices', priority: 'critical' });
    assert.ok(tokensOf(out).includes(d.tokenId));
    H.db().prepare('UPDATE notify_device_prefs SET enabled = 0 WHERE token_id = ?').run(d.tokenId);
    out = router.resolve({ users: [anna], topic: 'services', priority: 'normal' });
    assert.ok(!tokensOf(out).includes(d.tokenId));
    out = router.resolve({ tokenIds: [d.tokenId], topic: 'admin_notice', priority: 'info', bypass: true });
    assert.deepEqual(tokensOf(out), [d.tokenId], 'tests bypass every filter');
  });

  it('quiet hours: silent delivery, critical rings unless the person turned that off', () => {
    const dora = H.makeUser('dora');
    const dev = H.makeDevice(dora);
    H.db().prepare("INSERT INTO notify_user_prefs (user_id, quiet_from, quiet_to, tz, critical_bypass) VALUES (?, '22:00', '07:00', 'Europe/Berlin', 1)").run(dora);
    const night = Date.parse('2026-01-15T23:30:00Z'); // 00:30 in Berlin
    const day = Date.parse('2026-01-15T11:00:00Z');
    assert.equal(router.resolve({ users: [dora], topic: 'devices', priority: 'high', now: night })[0].silent, true);
    assert.equal(router.resolve({ users: [dora], topic: 'devices', priority: 'high', now: day })[0].silent, false);
    assert.equal(router.resolve({ users: [dora], topic: 'devices', priority: 'critical', now: night })[0].silent, false);
    H.db().prepare('UPDATE notify_user_prefs SET critical_bypass = 0 WHERE user_id = ?').run(dora);
    assert.equal(router.resolve({ users: [dora], topic: 'devices', priority: 'critical', now: night })[0].silent, true);
    assert.equal(dev.tokenId > 0, true);
  });

  it('quiet-hours math: windows across midnight and same-day windows', () => {
    const at = (iso) => Date.parse(iso);
    const p = { quiet_from: '22:00', quiet_to: '07:00', tz: 'UTC' };
    assert.equal(router.inQuietHours(p, at('2026-03-01T23:00:00Z')), true);
    assert.equal(router.inQuietHours(p, at('2026-03-01T06:59:00Z')), true);
    assert.equal(router.inQuietHours(p, at('2026-03-01T07:00:00Z')), false);
    assert.equal(router.inQuietHours({ quiet_from: '12:00', quiet_to: '13:00', tz: 'UTC' }, at('2026-03-01T12:30:00Z')), true);
    assert.equal(router.inQuietHours({ quiet_from: '12:00', quiet_to: '12:00', tz: 'UTC' }, at('2026-03-01T12:00:00Z')), false);
    assert.equal(router.inQuietHours({ quiet_from: 'x', quiet_to: '07:00' }, Date.now()), false);
  });
});

describe('hub: core events', () => {
  let adminDev;
  before(() => {
    adminDev = H.makeDevice(admin1, { name: 'admin-phone' });
  });
  beforeEach(() => {
    H.clearNotifications();
    rules.update('gateway_state', { delay_s: 0, bundle_s: 0, recovery: 'silent', enabled: true, ch_app: true });
  });

  it('activity.log → a notification for the admins with a translated title and collapse key', () => {
    const gw = H.makeDevice(admin1, { name: 'gw-home', app: false });
    activity.log('gateway_down', 'Gateway home is offline', { details: { peerId: gw.peerId }, severity: 'warn' });
    const n = H.lastNotification();
    assert.equal(n.event_id, 'gateway_state');
    assert.equal(n.event_type, 'gateway_down');
    assert.equal(n.topic, 'devices');
    assert.equal(n.priority, 'critical');
    assert.equal(n.collapse_key, `gateway:${gw.peerId}`);
    assert.match(n.title, /gw-home/);
    assert.equal(n.body, 'Gateway home is offline');
    const data = JSON.parse(n.data);
    assert.equal(data.route, 'gateways');
    assert.deepEqual(data.actions.map((a) => a.type), ['open_app_route', 'mute_1h']);
    const ds = H.deliveries(n.id);
    assert.ok(ds.some((d) => d.token_id === adminDev.tokenId && d.state === 'queued'));
  });

  it('types outside the catalogue and disabled rules create nothing', () => {
    activity.log('token_created', 'x');
    assert.equal(H.lastNotification(), null);
    rules.update('gateway_state', { enabled: false });
    activity.log('gateway_down', 'Gateway x is offline', { details: { peerId: 1 } });
    assert.equal(H.lastNotification(), null);
  });

  it('push switched off → nothing is queued', () => {
    settings.set('notify.enabled', '0');
    try {
      activity.log('peer_expired', 'Peer "x" expired', { details: { peerId: 1 } });
      assert.equal(H.lastNotification(), null);
    } finally { settings.set('notify.enabled', '1'); }
  });

  it('bundling: same collapse key inside bundle_s updates the notification and re-queues it', () => {
    activity.log('login_failed', 'Failed login for user: a');
    const first = H.lastNotification();
    const seq1 = H.deliveries(first.id).find((d) => d.token_id === adminDev.tokenId).seq;
    activity.log('login_2fa_failed', 'Failed second-factor attempt for user: b');
    activity.log('login_failed', 'Failed login for user: c');
    const all = H.db().prepare('SELECT * FROM notifications').all();
    assert.equal(all.length, 1);
    assert.equal(all[0].count, 3);
    assert.match(all[0].title, /^3× /);
    assert.equal(all[0].body, 'Failed login for user: c');
    const seq2 = H.deliveries(first.id).find((d) => d.token_id === adminDev.tokenId).seq;
    assert.ok(seq2 > seq1, 'new seq so the app replaces the shown notification');
  });

  it('bundle window over → a new notification', () => {
    const t0 = Date.parse('2026-05-01T10:00:00Z');
    store._setClock(() => t0);
    activity.log('waf_ip_banned', 'IP 1.2.3.4 banned', { details: { ip: '1.2.3.4' } });
    store._setClock(() => t0 + 301 * 1000);
    activity.log('waf_ip_banned', 'IP 1.2.3.5 banned', { details: { ip: '1.2.3.5' } });
    assert.equal(H.db().prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 2);
  });

  it('delay: a recovery inside the delay cancels both', () => {
    rules.update('gateway_state', { delay_s: 120 });
    const t0 = Date.parse('2026-05-01T10:00:00Z');
    store._setClock(() => t0);
    activity.log('gateway_down', 'Gateway x is offline', { details: { peerId: 4242 } });
    const n = H.lastNotification();
    assert.ok(n.release_at);
    assert.equal(H.deliveries(n.id).length, 0, 'held: no queue yet');
    store._setClock(() => t0 + 60 * 1000);
    activity.log('gateway_alive', 'Gateway x is online', { details: { peerId: 4242 } });
    assert.equal(H.db().prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0);
  });

  it('delay: without a recovery the message is released after delay_s', () => {
    rules.update('gateway_state', { delay_s: 120 });
    const t0 = Date.parse('2026-05-01T10:00:00Z');
    store._setClock(() => t0);
    activity.log('gateway_down', 'Gateway x is offline', { details: { peerId: 4243 } });
    const n = H.lastNotification();
    store._setClock(() => t0 + 60 * 1000);
    assert.equal(hub.releaseHeld(), 0);
    store._setClock(() => t0 + 121 * 1000);
    assert.equal(hub.releaseHeld(), 1);
    assert.equal(store.getNotification(n.id).release_at, null);
    assert.ok(H.deliveries(n.id).some((d) => d.token_id === adminDev.tokenId));
  });

  it('recovery: the alarm is revoked and a silent "back online" follows', () => {
    activity.log('gateway_down', 'Gateway x is offline', { details: { peerId: 4244 } });
    const alarm = H.lastNotification();
    activity.log('gateway_alive', 'Gateway x is online', { details: { peerId: 4244 } });
    assert.ok(store.getNotification(alarm.id).revoked_at);
    assert.ok(H.deliveries(alarm.id).every((d) => d.state === 'expired'), 'undelivered copies expire');
    const back = H.lastNotification();
    assert.notEqual(back.id, alarm.id);
    assert.equal(back.silent, 1);
    assert.equal(back.priority, 'info');
    assert.equal(back.collapse_key, alarm.collapse_key);
    // a second recovery (gateway_recovered) finds no open alarm
    activity.log('gateway_recovered', 'Gateway x is back online', { details: { peer_id: 4244 } });
    assert.equal(H.lastNotification().id, back.id);
  });

  it('recovery off: only the revoke; a recovery without an alarm sends nothing', () => {
    rules.update('gateway_state', { recovery: 'off' });
    activity.log('gateway_alive', 'Gateway y is online', { details: { peerId: 4245 } });
    assert.equal(H.lastNotification(), null);
    activity.log('gateway_down', 'Gateway y is offline', { details: { peerId: 4245 } });
    const alarm = H.lastNotification();
    activity.log('gateway_alive', 'Gateway y is online', { details: { peerId: 4245 } });
    assert.equal(H.lastNotification().id, alarm.id);
    assert.ok(store.getNotification(alarm.id).revoked_at);
  });

  it('the rule switches the webhook channel', () => {
    rules.update('peer_expired', { ch_webhook: false });
    assert.equal(notify.webhookAllowed('peer_expired'), false);
    rules.update('peer_expired', { ch_webhook: true });
    assert.equal(notify.webhookAllowed('peer_expired'), true);
    assert.equal(notify.webhookAllowed('something_else'), true);
  });
});

describe('e-mail fallback', () => {
  const sent = [];
  let orig;
  let adminDev;
  before(() => {
    orig = { sendMail: email.sendMail, isSmtpConfigured: email.isSmtpConfigured, sendMonitoringAlert: email.sendMonitoringAlert };
    email.sendMail = async (m) => { sent.push(m); };
    email.sendMonitoringAlert = async (m) => { sent.push({ monitoring: m }); };
    email.isSmtpConfigured = () => true;
    notifications.setRecipient('ops@example.com');
    adminDev = H.makeDevice(admin1, { name: 'fallback-phone' });
  });
  after(() => { Object.assign(email, orig); notifications.setEmailTypes([]); });
  beforeEach(() => {
    sent.length = 0;
    H.clearNotifications();
    notifications.setEmailTypes(['account_locked', 'peer_expired']);
    rules.update('account_locked', { email_fallback_s: 600 });
  });
  const flush = () => new Promise((r) => setImmediate(r));

  it('critical rule with an app device: no mail now, mail after 600 s without a confirmation', async () => {
    const t0 = Date.parse('2026-05-02T10:00:00Z');
    store._setClock(() => t0);
    activity.log('account_locked', 'Account locked after 5 failed logins: eve', { details: { identifier: 'eve' } });
    await flush();
    assert.equal(sent.length, 0);
    const n = H.lastNotification();
    assert.equal(n.email_state, 'pending');
    store._setClock(() => t0 + 300 * 1000);
    await hub.sweepEmail();
    assert.equal(sent.length, 0);
    store._setClock(() => t0 + 601 * 1000);
    await hub.sweepEmail();
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /Account locked/);
    assert.equal(store.getNotification(n.id).email_state, 'sent');
  });

  it('a device confirmed in time → the mail is skipped', async () => {
    const t0 = Date.parse('2026-05-02T11:00:00Z');
    store._setClock(() => t0);
    activity.log('account_locked', 'Account locked after 5 failed logins: eve', { details: { identifier: 'eve' } });
    const n = H.lastNotification();
    const d = H.deliveries(n.id).find((x) => x.token_id === adminDev.tokenId);
    store.ack(adminDev.tokenId, [d.seq], 'delivered', null);
    store._setClock(() => t0 + 700 * 1000);
    await hub.sweepEmail();
    assert.equal(sent.length, 0);
    assert.equal(store.getNotification(n.id).email_state, 'skipped');
  });

  it('rule without fallback → mailed at once, as before', async () => {
    activity.log('peer_expired', 'Peer "x" expired and was disabled', { details: { peerId: 1 } });
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(H.lastNotification().email_state, 'sent');
  });

  it('no app device to wait for → mailed at once', async () => {
    H.db().prepare('UPDATE notify_device_prefs SET enabled = 0').run();
    try {
      activity.log('account_locked', 'Account locked after 5 failed logins: zed', { details: { identifier: 'zed' } });
      await flush();
      assert.equal(sent.length, 1);
    } finally { H.db().prepare('UPDATE notify_device_prefs SET enabled = 1').run(); }
  });

  it('push off → the generic mail goes out exactly as before', async () => {
    settings.set('notify.enabled', '0');
    try {
      activity.log('account_locked', 'Account locked after 5 failed logins: q', { details: { identifier: 'q' } });
      await flush();
      assert.equal(sent.length, 1);
    } finally { settings.set('notify.enabled', '1'); }
  });
});

describe('clean-up job', () => {
  let dev;
  before(() => { dev = H.makeDevice(admin1, { name: 'retention-phone' }); });
  beforeEach(() => H.clearNotifications());

  it('expires undelivered copies after retention_h and purges history after history_days', () => {
    const t0 = Date.parse('2026-06-01T10:00:00Z');
    store._setClock(() => t0);
    const r = hub.sendManual({ userId: admin1, target: { type: 'devices', ids: [dev.tokenId] }, title: 'Hallo', body: '', priority: 'normal', ttlS: null });
    store._setClock(() => t0 + 73 * 3600 * 1000);
    const out = retention.run();
    assert.ok(out.expired >= 1);
    assert.equal(H.deliveries(r.id)[0].state, 'expired');
    store._setClock(() => t0 + 31 * 24 * 3600 * 1000);
    assert.ok(retention.run().purged >= 1);
    assert.equal(store.getNotification(r.id), null);
    assert.equal(H.deliveries(r.id).length, 0, 'deliveries go with their notification');
  });

  it('caps the queue per device, dropping the oldest info messages first', () => {
    settings.set('notify.max_queue', '10');
    try {
      const ids = [];
      for (let i = 0; i < 12; i++) {
        const prio = i < 3 ? 'normal' : 'info';
        ids.push(hub.sendManual({ userId: admin1, target: { type: 'devices', ids: [dev.tokenId] }, title: `m${i}`, body: '', priority: prio, ttlS: null }).id);
      }
      const out = retention.run();
      assert.equal(out.capped, 2);
      const st = (id) => H.deliveries(id)[0].state;
      assert.equal(st(ids[0]), 'queued', 'oldest normal kept');
      assert.equal(st(ids[3]), 'expired', 'oldest info dropped first');
      assert.equal(st(ids[4]), 'expired');
      assert.equal(st(ids[5]), 'queued');
    } finally { settings.set('notify.max_queue', '200'); }
  });

  it('queues of deleted tokens expire, their device rows go', () => {
    const gone = H.makeDevice(admin1, { name: 'gone' });
    const r = hub.sendManual({ userId: admin1, target: { type: 'devices', ids: [gone.tokenId] }, title: 'x', body: '', priority: 'normal', ttlS: null });
    H.db().prepare('DELETE FROM api_tokens WHERE id = ?').run(gone.tokenId);
    retention.run();
    assert.equal(H.deliveries(r.id)[0].state, 'expired');
    assert.equal(store.devicePrefs(gone.tokenId), null);
  });

  it('revoking a token expires its queue at once', () => {
    const d = H.makeDevice(admin1, { name: 'revoked' });
    const r = hub.sendManual({ userId: admin1, target: { type: 'devices', ids: [d.tokenId] }, title: 'x', body: '', priority: 'normal', ttlS: null });
    require('../src/services/tokens').revoke(d.tokenId, '127.0.0.1');
    assert.equal(H.deliveries(r.id)[0].state, 'expired');
  });
});

describe('payload sanitising', () => {
  const S = () => require('../src/services/notify/sanitize');
  it('strips control characters and cuts title/body', () => {
    assert.equal(S().title('a\u0000b‮c\nd' + 'x'.repeat(200)).length, 120);
    assert.equal(S().title('a\u0007b'), 'a b');
    assert.equal(S().body('line1\r\nline2\u0000').includes('\n'), true);
    assert.equal(S().body('y'.repeat(5000)).length, 1000);
  });
  it('data: action whitelist, app routes, portal paths, 4 KB', () => {
    const r = S().data({ route: 'evil://x', actions: [
      { id: 'a', type: 'open_app_route', target: 'gateways' },
      { id: 'b', type: 'open_url', target: 'https://evil.example' },
      { id: 'c', type: 'open_portal', target: '//evil.example' },
      { id: 'd', type: 'open_portal', target: '/portal/devices' },
    ] });
    assert.equal(r.ok, true);
    assert.equal(r.data.route, undefined);
    assert.deepEqual(r.data.actions.map((a) => a.id), ['a', 'd']);
    assert.equal(S().data({ blob: 'z'.repeat(900), more: 'z'.repeat(900), x: 'z'.repeat(900), y: 'z'.repeat(900), w: 'z'.repeat(900) }).ok, false);
    assert.equal(S().data([1, 2]).ok, false);
  });
});

describe('i18n (push.*)', () => {
  const de = require('../src/i18n/de.json');
  const en = require('../src/i18n/en.json');
  const pushKeys = (o) => Object.keys(o).filter((k) => k.startsWith('push.')).sort();
  it('DE and EN have the same push.* keys, none empty', () => {
    assert.deepEqual(pushKeys(de), pushKeys(en));
    for (const k of pushKeys(de)) assert.ok(de[k] && en[k], k);
  });
  it('every catalogue type has a title; every core topic a label', () => {
    for (const ev of notifications.EVENTS) for (const t of ev.types) assert.ok(de[`push.type.${t}`] && en[`push.type.${t}`], t);
    for (const t of require('../src/services/notify/constants').CORE_TOPICS) assert.ok(de[`push.topic.${t}`], t);
  });
  it('the push.* block sits directly before the first plugins.* key', () => {
    for (const lang of ['de', 'en']) {
      const keys = Object.keys(lang === 'de' ? de : en);
      const firstPlugins = keys.findIndex((k) => k.startsWith('plugins.'));
      const block = keys.filter((k) => k.startsWith('push.'));
      assert.deepEqual(keys.slice(firstPlugins - block.length, firstPlugins), block, lang);
    }
  });
});
