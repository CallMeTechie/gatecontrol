'use strict';

// services/notifications.js — the one recipient, the event list (CSV in
// alerts.email_events), the webhook event selection, plus migration 87
// (notification_recipient) on a bare settings table.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { setup, teardown } = require('./helpers/setup');

let N, settings, db;
before(async () => {
  await setup();
  N = require('../src/services/notifications');
  settings = require('../src/services/settings');
  db = require('../src/db/connection').getDb();
});
after(() => teardown());

const clearKeys = (...keys) => db.prepare(`DELETE FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`).run(...keys);

describe('catalogue', () => {
  it('every row has an id, at least one type, and no type belongs to two rows', () => {
    const seen = new Set();
    for (const ev of N.EVENTS) {
      assert.match(ev.id, /^[a-z0-9_]+$/);
      assert.ok(ev.types.length > 0, ev.id);
      for (const t of ev.types) { assert.ok(!seen.has(t), t); seen.add(t); }
    }
    assert.ok(N.ALLOWED_TYPES.has('resource_alert'));
    assert.ok(N.ALLOWED_TYPES.has('account_locked'));
  });
  it('route state and the update mails are free, everything else needs email_alerts', () => {
    assert.ok(N.FREE_TYPES.has('route_down') && N.FREE_TYPES.has('update_failed'));
    assert.ok(!N.FREE_TYPES.has('login_failed'));
    assert.deepEqual(N.licensedChanges('route_down,route_up', 'route_down,route_up,update_failed'), []);
    assert.deepEqual(N.licensedChanges('', 'login_failed'), ['login_failed']);
    assert.deepEqual(N.licensedChanges('login_failed', 'login_failed'), []);
  });
  it('rows ↔ types round-trip', () => {
    const types = N.typesFromEvents(['login_failed', 'resources']);
    assert.ok(types.includes('login_2fa_failed') && types.includes('resource_recovered'));
    assert.deepEqual(N.eventsFromTypes(types).sort(), ['login_failed', 'resources']);
    // a row counts as ticked when any of its types is in the list (old CSVs)
    assert.deepEqual(N.eventsFromTypes(['gateway_down']), ['gateway_state']);
    assert.deepEqual(N.unknownTypes('peer_connected,nope'), ['nope']);
  });
});

describe('recipient', () => {
  beforeEach(() => clearKeys(N.K_RECIPIENT, 'alerts.email', 'monitoring.alert_email'));

  it('merges the two old keys once, stores the result and drops the old keys', () => {
    settings.set('alerts.email', 'ops@example.com');
    settings.set('monitoring.alert_email', 'noc@example.com');
    assert.equal(N.recipient(), 'ops@example.com, noc@example.com');
    assert.equal(settings.get(N.K_RECIPIENT), 'ops@example.com, noc@example.com');
    assert.equal(settings.get('alerts.email', null), null);
    assert.equal(settings.get('monitoring.alert_email', null), null);
    // only once: an old key showing up later is ignored
    settings.set('alerts.email', 'late@example.com');
    assert.equal(N.recipient(), 'ops@example.com, noc@example.com');
  });
  it('the same address twice is kept once (case-insensitive)', () => {
    settings.set('alerts.email', 'Ops@example.com');
    settings.set('monitoring.alert_email', 'ops@example.com');
    assert.equal(N.recipient(), 'Ops@example.com');
  });
  it('nothing set → empty string, and stays empty', () => {
    assert.equal(N.recipient(), '');
    assert.equal(settings.get(N.K_RECIPIENT), '');
  });
  it('setRecipient normalises the list', () => {
    assert.equal(N.setRecipient(' a@example.com ,b@example.com,, a@example.com'), 'a@example.com, b@example.com');
    assert.equal(N.recipient(), 'a@example.com, b@example.com');
  });
});

describe('event e-mail selection', () => {
  beforeEach(() => settings.set(N.K_EVENTS, ''));
  it('setEventEmail adds and removes every type of a row', () => {
    N.setEventEmail('gateway_state', true);
    assert.ok(N.wantsEmail('gateway_down') && N.wantsEmail('gateway_recovered'));
    assert.equal(N.eventEmailOn('gateway_state'), true);
    N.setEventEmail('gateway_state', false);
    assert.equal(N.wantsEmail('gateway_down'), false);
    assert.throws(() => N.setEventEmail('nope', true));
  });
  it('generic activity mails skip the types that have their own mail', () => {
    N.setEmailTypes('route_down,update_failed,login_failed');
    assert.equal(N.genericMailFor('route_down'), false);
    assert.equal(N.genericMailFor('update_failed'), false);
    assert.equal(N.genericMailFor('login_failed'), true);
    assert.equal(N.genericMailFor('peer_created'), false);
  });
});

describe('webhook event selection', () => {
  it('undefined → "*", "*" anywhere wins, list is sorted and deduplicated', () => {
    assert.equal(N.parseWebhookEvents(undefined), '*');
    assert.equal(N.parseWebhookEvents('login_failed,*'), '*');
    const v = N.parseWebhookEvents(['resource_alert', 'login_failed', 'login_failed']);
    assert.deepEqual(v.split(',').sort(), ['login_failed', 'resource_alert']);
  });
  it('empty selection and unknown types are rejected', () => {
    assert.throws(() => N.parseWebhookEvents(''), /Invalid webhook events: empty selection/);
    assert.throws(() => N.parseWebhookEvents('login_failed,evil'), (e) => e instanceof N.EventListError && e.invalid.join() === 'evil');
  });
  it('webhookReceives filters by type', () => {
    assert.equal(N.webhookReceives('*', 'anything'), true);
    assert.equal(N.webhookReceives('login_failed,resource_alert', 'resource_alert'), true);
    assert.equal(N.webhookReceives('login_failed', 'resource_alert'), false);
    assert.equal(N.webhookReceives('', 'login_failed'), false);
  });
});

describe('migration 87 notification_recipient', () => {
  const mig = () => require('../src/db/migrationList').migrations.find((m) => m.name === 'notification_recipient');
  function fresh(rows) {
    const d = new Database(':memory:');
    d.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')))");
    const ins = d.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(rows)) ins.run(k, v);
    return d;
  }
  const get = (d, k) => { const r = d.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : null; };

  it('merges both recipients and folds the old switches into the event list', () => {
    const d = fresh({
      'alerts.email': 'ops@example.com', 'monitoring.alert_email': 'noc@example.com',
      'monitoring.email_alerts': 'true', 'alerts.email_events': 'peer_connected', 'notify.update_email': 'false',
    });
    assert.equal(mig().detect(d), false);
    d.exec(mig().sql);
    assert.equal(get(d, 'notifications.email'), 'ops@example.com, noc@example.com');
    assert.deepEqual(get(d, 'alerts.email_events').split(','), ['peer_connected', 'route_down', 'route_up', 'autobackup_failed']);
    for (const k of ['alerts.email', 'monitoring.alert_email', 'monitoring.email_alerts', 'notify.update_email']) assert.equal(get(d, k), null, k);
    assert.equal(mig().detect(d), true);
  });
  it('update mails stay on by default; one recipient only; empty install', () => {
    const d = fresh({ 'monitoring.alert_email': 'noc@example.com' });
    d.exec(mig().sql);
    assert.equal(get(d, 'notifications.email'), 'noc@example.com');
    assert.equal(get(d, 'alerts.email_events'), 'update_installed,update_rolled_back,update_failed');
    const e = fresh({});
    e.exec(mig().sql);
    assert.equal(get(e, 'notifications.email'), '');
    assert.equal(get(e, 'alerts.email_events'), 'update_installed,update_rolled_back,update_failed');
  });
  it('identical addresses are not doubled', () => {
    const d = fresh({ 'alerts.email': 'ops@example.com', 'monitoring.alert_email': 'OPS@example.com' });
    d.exec(mig().sql);
    assert.equal(get(d, 'notifications.email'), 'ops@example.com');
  });
});
