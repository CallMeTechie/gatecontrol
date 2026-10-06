'use strict';

// Settings redesign (server side):
//   range validation      out-of-range numbers → 400 + translated message per field
//   PUT /settings/alerts  one recipient, event rows / types, licence rules
//   webhooks              event allow-list, licence only for create / URL change,
//                         dispatcher sends only to subscribed hooks
//   resource alerts       activity → mail (ticked) + webhooks (subscribed)
//   lockout               account_locked once per lock
//   GET /settings         non-admin → /profile

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const argon2 = require('argon2');
const supertest = require('supertest');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let app, agent, csrf, db, license, settings, N;
before(async () => {
  ({ app } = await setup());
  agent = getAgent();
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  license = require('../src/services/license');
  settings = require('../src/services/settings');
  N = require('../src/services/notifications');
});
after(() => teardown());

const put = (url, body) => agent.put(url).set('X-CSRF-Token', csrf).send(body);
const post = (url, body) => agent.post(url).set('X-CSRF-Token', csrf).send(body);

describe('range validation → 400 with field messages', () => {
  it('PUT /settings/data: each out-of-range field is named, nothing is stored', async () => {
    const before = (await agent.get('/api/v1/settings/data').expect(200)).body.data;
    const res = await put('/api/v1/settings/data', { retention_traffic_days: 999, retention_activity_days: 'x', peer_online_timeout: 10 }).expect(400);
    assert.equal(res.body.ok, false);
    assert.deepEqual(Object.keys(res.body.fields).sort(), ['peer_online_timeout', 'retention_activity_days', 'retention_traffic_days']);
    assert.match(res.body.fields.retention_traffic_days, /1.*365/);
    const after = (await agent.get('/api/v1/settings/data').expect(200)).body.data;
    assert.equal(after.retention_traffic_days, before.retention_traffic_days);
    await put('/api/v1/settings/data', { retention_traffic_days: 60 }).expect(200);
    assert.equal((await agent.get('/api/v1/settings/data')).body.data.retention_traffic_days, 60);
  });
  it('PUT /settings/monitoring: interval 10–3600', async () => {
    const res = await put('/api/v1/settings/monitoring', { interval: 5 }).expect(400);
    assert.ok(res.body.fields.interval);
    await put('/api/v1/settings/monitoring', { interval: 60 }).expect(200);
  });
  it('PUT /settings/security: lockout and password ranges are prefixed field names', async () => {
    const res = await put('/api/v1/settings/security', { lockout: { max_attempts: 0, duration: 99999 }, password: { min_length: 2 } }).expect(400);
    assert.deepEqual(Object.keys(res.body.fields).sort(), ['lockout.duration', 'lockout.max_attempts', 'password.min_length']);
  });
  it('PUT /settings/alerts: thresholds 0–100; messages follow the language', async () => {
    const res = await put('/api/v1/settings/alerts', { resource_disk_threshold: 101 }).expect(400);
    assert.ok(res.body.fields.resource_disk_threshold);
    const de = require('../src/i18n/de.json');
    assert.ok(de['error.settings.range'] && de['error.settings.invalid_input']);
  });
});

describe('PUT /settings/alerts', () => {
  afterEach(() => license._overrideForTest({ email_alerts: true }));

  it('stores one recipient and the event rows; GET shows them', async () => {
    license._overrideForTest({ email_alerts: true });
    await put('/api/v1/settings/alerts', { email: 'ops@example.com, noc@example.com', events: ['login_failed', 'resources'], resource_disk_threshold: 90 }).expect(200);
    const d = (await agent.get('/api/v1/settings/alerts').expect(200)).body.data;
    assert.equal(d.email, 'ops@example.com, noc@example.com');
    assert.deepEqual(d.events.sort(), ['login_failed', 'resources']);
    assert.ok(d.email_events.split(',').includes('passkey_login_failed'));
    assert.equal(d.resource_disk_threshold, 90);
    assert.equal(typeof d.smtp.configured, 'boolean');
  });
  it('unknown rows / types and bad addresses → 400', async () => {
    let res = await put('/api/v1/settings/alerts', { events: ['login_failed', 'nope'] }).expect(400);
    assert.match(res.body.fields.events, /nope/);
    res = await put('/api/v1/settings/alerts', { email_events: 'peer_connected,evil_type' }).expect(400);
    assert.ok(res.body.fields.email_events);
    res = await put('/api/v1/settings/alerts', { email: 'not-an-address' }).expect(400);
    assert.ok(res.body.fields.email);
  });
  it('without email_alerts: recipient, route state and update rows are free; others are 403', async () => {
    license._overrideForTest({ email_alerts: false });
    const cur = N.eventsFromTypes(N.emailTypes());
    await put('/api/v1/settings/alerts', { email: 'free@example.com' }).expect(200);
    const freeRows = cur.filter((id) => id !== 'route_state').concat(['route_state']);
    await put('/api/v1/settings/alerts', { events: freeRows }).expect(200);
    const res = await put('/api/v1/settings/alerts', { events: freeRows.concat(['peer_expired']) }).expect(403);
    assert.equal(res.body.feature, 'email_alerts');
    await put('/api/v1/settings/alerts', { resource_cpu_threshold: 77 }).expect(403);
  });
});

describe('webhooks', () => {
  let id;
  it('create checks the event list against the catalogue', async () => {
    license._overrideForTest({ webhooks: true });
    let res = await post('/api/v1/webhooks', { url: 'https://hooks.example.com/a', events: 'login_failed,evil' }).expect(400);
    assert.equal(res.body.ok, false);
    // an explicit empty selection is an error ('' from old clients means all)
    res = await post('/api/v1/webhooks', { url: 'https://hooks.example.com/a', events: [] }).expect(400);
    await post('/api/v1/webhooks', { url: 'https://hooks.example.com/a', events: ['resource_alert', 'login_failed'], description: 'Ops' }).expect(201);
    const list = (await agent.get('/api/v1/webhooks').expect(200)).body.webhooks;
    const hook = list.find((h) => h.url === 'https://hooks.example.com/a');
    assert.ok(hook, 'created');
    assert.deepEqual(hook.events.split(',').sort(), ['login_failed', 'resource_alert']);
    id = hook.id;
  });
  it('the SSRF guard still applies', async () => {
    await post('/api/v1/webhooks', { url: 'http://169.254.169.254/latest', events: '*' }).expect(400);
  });
  it('without the licence: events/description editable, URL change → 403, create → 403', async () => {
    license._overrideForTest({ webhooks: false });
    await put('/api/v1/webhooks/' + id, { url: 'https://hooks.example.com/a', events: 'peer_connected', description: 'x' }).expect(200);
    const res = await put('/api/v1/webhooks/' + id, { url: 'https://hooks.example.com/other', events: 'peer_connected' }).expect(403);
    assert.equal(res.body.feature, 'webhooks');
    await post('/api/v1/webhooks', { url: 'https://hooks.example.com/b', events: '*' }).expect(403);
    license._overrideForTest({ webhooks: true });
  });
  it('a too long description is a 400', async () => {
    await put('/api/v1/webhooks/' + id, { url: 'https://hooks.example.com/a', events: 'peer_connected', description: 'x'.repeat(300) }).expect(400);
  });

  it('notify sends only to webhooks that subscribe to the type', async () => {
    const webhook = require('../src/services/webhook');
    db.prepare('DELETE FROM webhooks').run();
    webhook.create({ url: 'https://hooks.example.com/all', events: '*' });
    webhook.create({ url: 'https://hooks.example.com/res', events: 'resource_alert' });
    webhook.create({ url: 'https://hooks.example.com/login', events: 'login_failed' });
    const sent = [];
    const orig = webhook.deliver;
    webhook.deliver = async (url, payload) => { sent.push({ url, event: JSON.parse(payload).event }); return { status: 200 }; };
    try {
      await webhook.notify('resource_alert', 'Disk usage 95%', { resource: 'disk' });
      assert.deepEqual(sent.map((s) => s.url).sort(), ['https://hooks.example.com/all', 'https://hooks.example.com/res']);
      sent.length = 0;
      await webhook.notify('peer_created', 'x');
      assert.deepEqual(sent.map((s) => s.url), ['https://hooks.example.com/all']);
    } finally { webhook.deliver = orig; }
  });
});

describe('resource alert → mail + webhooks', () => {
  it('a disk alert is mailed to the recipient when the row is ticked and sent to subscribed webhooks', async () => {
    const webhook = require('../src/services/webhook');
    const email = require('../src/services/email');
    db.prepare('DELETE FROM webhooks').run();
    webhook.create({ url: 'https://hooks.example.com/res', events: 'resource_alert' });
    N.setRecipient('ops@example.com');
    N.setEventEmail('resources', true);
    const mails = [];
    const hooks = [];
    const orig = { deliver: webhook.deliver, send: email.sendMail, conf: email.isSmtpConfigured };
    webhook.deliver = async (url, payload) => { hooks.push(JSON.parse(payload)); return { status: 200 }; };
    email.sendMail = async (m) => { mails.push(m); };
    email.isSmtpConfigured = () => true;
    settings.set('alerts.resource_disk_threshold', '80');
    settings.set('alerts.check_state', '{}');
    try {
      const A = require('../src/services/alertChecks');
      await A.run({ now: 0, resources: async () => ({ disk: { percent: 93, used: 93, total: 100 } }), lastBackupAt: () => Date.now() });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(hooks.length, 1);
      assert.equal(hooks[0].event, 'resource_alert');
      assert.equal(hooks[0].details.resource, 'disk');
      assert.equal(mails.length, 1);
      assert.equal(mails[0].to, 'ops@example.com');
      assert.match(mails[0].subject, /Disk usage 93%/);
      // the row off → no mail, webhook still
      N.setEventEmail('resources', false);
      settings.set('alerts.check_state', '{}');
      await A.run({ now: 0, resources: async () => ({ disk: { percent: 93, used: 93, total: 100 } }), lastBackupAt: () => Date.now() });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(mails.length, 1);
      assert.equal(hooks.length, 2);
    } finally {
      webhook.deliver = orig.deliver; email.sendMail = orig.send; email.isSmtpConfigured = orig.conf;
      settings.set('alerts.resource_disk_threshold', '0');
    }
  });
});

describe('lockout: account_locked', () => {
  it('is logged once, when the attempt reaches the limit', () => {
    const lockout = require('../src/services/lockout');
    settings.set('security.lockout.enabled', 'true');
    settings.set('security.lockout.max_attempts', '4');
    const cfg = { maxAttempts: 4 };
    const count = () => db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'account_locked' AND message LIKE '%lock-me%'").get().n;
    for (let i = 0; i < cfg.maxAttempts - 1; i++) lockout.recordFailedAttempt('lock-me', 'admin', '203.0.113.9');
    assert.equal(count(), 0);
    lockout.recordFailedAttempt('lock-me', 'admin', '203.0.113.9');
    assert.equal(count(), 1);
    lockout.recordFailedAttempt('lock-me', 'admin', '203.0.113.9');
    assert.equal(count(), 1);
  });
});

describe('GET /settings', () => {
  it('a non-admin session is sent to /me', async () => {
    const hash = await argon2.hash('Plain!Pass1234');
    db.prepare('INSERT INTO users (username, password_hash, role, self_service_enabled) VALUES (?, ?, ?, 1)').run('settings-plain', hash, 'user');
    const a = supertest.agent(app);
    const page = await a.get('/login').expect(200);
    const token = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
    await a.post('/login').type('form').send({ username: 'settings-plain', password: 'Plain!Pass1234', _csrf: token }).expect(302);
    const res = await a.get('/settings').expect(302);
    assert.equal(res.headers.location, '/me');
  });
  it('the admin page carries the catalogue and the string table', async () => {
    const res = await agent.get('/settings').expect(200);
    assert.match(res.text, /<script type="application\/json" id="st-catalogue"/);
    assert.match(res.text, /id="st-i18n"/);
    assert.match(res.text, /data-section="benachrichtigungen"/);
  });
});
