'use strict';

// Device side of the notification center — the binding contract
// "Vertrag Gerät ↔ Server" (docs/feature-notification-center.md):
// GET /api/v1/client/push (SSE: hello, notification, read, revoke, ping;
// Last-Event-ID / ?since; one stream per token), POST /push/ack,
// GET /push/inbox, PUT /push/prefs, POST /push/test — auth, scope,
// ownership, push_disabled.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');
const H = require('./helpers/notify');

let app, agent, server, port, hub, stream, settings, pushRoute;
let adminId, anna, annaPhone, annaLaptop, ben, benPhone;

before(async () => {
  ({ app, agent } = await setup());
  server = app.listen(0);
  port = server.address().port;
  hub = require('../src/services/notify/hub');
  stream = require('../src/services/notify/stream');
  settings = require('../src/services/settings');
  pushRoute = require('../src/routes/api/client/push');
  adminId = H.db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  anna = H.makeUser('anna', { language: 'en' });
  ben = H.makeUser('ben');
  annaPhone = H.makeDevice(anna, { name: 'anna-phone' });
  annaLaptop = H.makeDevice(anna, { name: 'anna-laptop', platform: 'windows' });
  benPhone = H.makeDevice(ben, { name: 'ben-phone' });
});
after(() => {
  stream._resetForTest();
  server.close();
  teardown();
});
beforeEach(() => { stream._resetForTest(); H.clearNotifications(); });

const api = (method, path, dev) => supertest(app)[method](path).set('X-API-Token', dev.raw).set('X-Client-Platform', 'android').set('X-Client-Version', '2.0.0');
const send = (ids, title = 'Hallo', priority = 'normal') => hub.sendManual({ userId: adminId, target: { type: 'devices', ids }, title, body: 'Text', priority, ttlS: null });

describe('GET /api/v1/client/push — access', () => {
  it('401 without a token, 403 for a session and for a token without the client scope', async () => {
    await supertest(app).get('/api/v1/client/push').expect(401);
    const s = await agent.get('/api/v1/client/push').expect(403);
    assert.equal(s.body.error, 'token_required');
    // read-only may GET almost anything — but not the push stream
    const ro = H.makeDevice(adminId, { name: 'ro', scopes: ['read-only'] });
    const r = await supertest(app).get('/api/v1/client/push').set('X-API-Token', ro.raw).expect(403);
    assert.equal(r.body.error, 'scope_required');
    const other = H.makeDevice(anna, { name: 'peers-only', scopes: ['peers'] });
    await supertest(app).get('/api/v1/client/push').set('X-API-Token', other.raw).expect(403);
  });

  it('503 {"error":"push_disabled"} when push is off (stream and REST)', async () => {
    settings.set('notify.enabled', '0');
    try {
      const r = await api('get', '/api/v1/client/push', annaPhone).expect(503);
      assert.equal(r.body.error, 'push_disabled');
      await api('get', '/api/v1/client/push/inbox', annaPhone).expect(503);
      await api('post', '/api/v1/client/push/ack', annaPhone).send({ seqs: [1], state: 'read' }).expect(503);
    } finally { settings.set('notify.enabled', '1'); }
  });

  it('allow_direct=false: only streams from inside the WireGuard network', async () => {
    settings.set('notify.allow_direct', '0');
    try {
      const r = await api('get', '/api/v1/client/push', annaPhone).expect(403);
      assert.equal(r.body.error, 'direct_not_allowed');
      const s = await H.openStream(port, annaPhone.raw, { headers: { 'X-Forwarded-For': '10.8.0.77' } });
      assert.equal(s.status, 200);
      const hello = await s.waitFor((e) => e.event === 'hello');
      assert.equal(hello.data.via, 'tunnel');
      s.close();
    } finally { settings.set('notify.allow_direct', '1'); }
  });

  it('max_streams caps open streams (a token replacing its own stream is fine)', async () => {
    settings.set('notify.max_streams', '1');
    try {
      const a = await H.openStream(port, annaPhone.raw);
      await a.waitFor((e) => e.event === 'hello');
      const again = await H.openStream(port, annaPhone.raw);
      assert.equal(again.status, 200);
      const b = await api('get', '/api/v1/client/push', benPhone).expect(503);
      assert.equal(b.body.error, 'too_many_streams');
      again.close();
      a.close();
    } finally { settings.set('notify.max_streams', '500'); }
  });
});

describe('GET /api/v1/client/push — stream', () => {
  it('hello: server time, keepalive, retention, via, unread and the topics of the person', async () => {
    send([annaPhone.tokenId]);
    const s = await H.openStream(port, annaPhone.raw);
    assert.equal(s.status, 200);
    assert.match(s.headers['content-type'], /text\/event-stream/);
    assert.equal(s.headers['x-accel-buffering'], 'no');
    const hello = await s.waitFor((e) => e.event === 'hello');
    assert.deepEqual(Object.keys(hello.data).sort(), ['keepalive_s', 'retention_h', 'server_time', 'topics', 'unread', 'via']);
    assert.equal(hello.data.keepalive_s, 25);
    assert.equal(hello.data.retention_h, 72);
    assert.equal(hello.data.via, 'direct');
    assert.equal(hello.data.unread, 1);
    const ids = hello.data.topics.map((t) => t.id);
    assert.deepEqual(ids.slice(0, 3), ['devices', 'services', 'admin_notice']);
    assert.ok(!ids.includes('security'), 'security is admin-only');
    assert.equal(hello.data.topics.find((t) => t.id === 'devices').label, 'Devices & gateways', 'in the person’s language');
    s.close();
    // the device is now known as a push-capable app
    const row = H.db().prepare('SELECT platform, app_version FROM notify_device_prefs WHERE token_id = ?').get(annaPhone.tokenId);
    assert.deepEqual(row, { platform: 'android', app_version: '2.0.0' });
  });

  it('notification: replays the queue, then delivers live, framed with id = seq', async () => {
    const first = send([annaPhone.tokenId], 'Erste');
    const s = await H.openStream(port, annaPhone.raw);
    const ev1 = await s.waitFor((e) => e.event === 'notification');
    const seq1 = H.deliveries(first.id)[0].seq;
    assert.equal(ev1.id, String(seq1));
    assert.deepEqual(Object.keys(ev1.data).sort(),
      ['body', 'collapse_key', 'created_at', 'data', 'event_id', 'expires_at', 'id', 'priority', 'seq', 'silent', 'title', 'topic']);
    assert.equal(ev1.data.seq, seq1);
    assert.equal(ev1.data.id, first.id);
    assert.equal(ev1.data.title, 'Erste');
    assert.equal(ev1.data.topic, 'admin_notice');
    assert.equal(ev1.data.event_id, 'manual');
    assert.match(ev1.data.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(ev1.data.silent, false);
    assert.equal(H.deliveries(first.id)[0].state, 'sent');
    assert.equal(H.deliveries(first.id)[0].via, 'direct');

    const live = send([annaPhone.tokenId], 'Live');
    assert.equal(live.devices_now, 1);
    assert.equal(live.devices_later, 0);
    const ev2 = await s.waitFor((e) => e.event === 'notification' && e.data.title === 'Live');
    assert.ok(ev2.data.seq > seq1);
    s.close();
  });

  it('Last-Event-ID and ?since: only what came after', async () => {
    const a = send([annaPhone.tokenId], 'A');
    const b = send([annaPhone.tokenId], 'B');
    const seqA = H.deliveries(a.id)[0].seq;
    let s = await H.openStream(port, annaPhone.raw, { headers: { 'Last-Event-ID': String(seqA) } });
    await s.waitFor((e) => e.event === 'notification' && e.data.title === 'B');
    assert.ok(!s.events.some((e) => e.event === 'notification' && e.data.title === 'A'));
    s.close();
    // both are 'sent' now: a reconnect without id replays queued + sent
    s = await H.openStream(port, annaPhone.raw);
    await s.waitFor((e) => e.event === 'notification' && e.data.title === 'A');
    s.close();
    s = await H.openStream(port, annaPhone.raw, { query: `?since=${H.deliveries(b.id)[0].seq}` });
    await s.waitFor((e) => e.event === 'hello');
    await H.sleep(50);
    assert.ok(!s.events.some((e) => e.event === 'notification'));
    s.close();
  });

  it('one stream per token: a new stream ends the old one', async () => {
    const s1 = await H.openStream(port, annaPhone.raw);
    await s1.waitFor((e) => e.event === 'hello');
    const s2 = await H.openStream(port, annaPhone.raw);
    await s2.waitFor((e) => e.event === 'hello');
    await s1.waitEnd();
    assert.equal(stream.count(), 1);
    send([annaPhone.tokenId], 'Nur neu');
    await s2.waitFor((e) => e.event === 'notification');
    s2.close();
  });

  it('keepalive comment `: ping`, and a revoked token loses its stream', async () => {
    pushRoute._keepaliveMs = 40;
    try {
      const d = H.makeDevice(anna, { name: 'temp' });
      const s = await H.openStream(port, d.raw);
      await s.waitFor((e) => e.comment === 'ping');
      require('../src/services/tokens').revoke(d.tokenId, '127.0.0.1');
      await s.waitEnd();
    } finally { pushRoute._keepaliveMs = null; }
  });

  it('presence goes to the admin bus', async () => {
    const bus = require('../src/services/eventBus');
    const seen = [];
    const l = (evt) => { if (evt.type === 'push_presence') seen.push(evt.payload); };
    bus.subscribe(l);
    try {
      const s = await H.openStream(port, benPhone.raw);
      await s.waitFor((e) => e.event === 'hello');
      s.close();
      for (let i = 0; i < 40 && seen.length < 2; i++) await H.sleep(10);
    } finally { bus.unsubscribe(l); }
    assert.deepEqual(seen[0], { token_id: benPhone.tokenId, state: 'connected', via: 'direct' });
    assert.equal(seen[1].state, 'offline');
  });

  it('revoke: a recovery withdraws the alarm on connected devices', async () => {
    const rules = require('../src/services/notify/rules');
    rules.update('gateway_state', { recipients: { admins: false, owner: true }, delay_s: 0, bundle_s: 0, recovery: 'off' });
    try {
      const s = await H.openStream(port, annaPhone.raw);
      await s.waitFor((e) => e.event === 'hello');
      const activity = require('../src/services/activity');
      activity.log('gateway_down', 'Gateway gw is offline', { details: { peerId: annaPhone.peerId } });
      const n = await s.waitFor((e) => e.event === 'notification' && e.data.event_id === 'gateway_state');
      activity.log('gateway_alive', 'Gateway gw is online', { details: { peerId: annaPhone.peerId } });
      const rv = await s.waitFor((e) => e.event === 'revoke');
      assert.deepEqual(rv.data, { ids: [n.data.id] });
      s.close();
    } finally {
      rules.update('gateway_state', { recipients: { admins: true }, recovery: 'silent' });
    }
  });
});

describe('POST /api/v1/client/push/ack', () => {
  it('delivered/read on own seqs; read reaches the person’s other connected device', async () => {
    const laptop = await H.openStream(port, annaLaptop.raw);
    await laptop.waitFor((e) => e.event === 'hello');
    const r = hub.sendManual({ userId: adminId, target: { type: 'users', ids: [anna] }, title: 'Beide', body: '', priority: 'normal', ttlS: null });
    const ds = H.deliveries(r.id);
    const phoneSeq = ds.find((d) => d.token_id === annaPhone.tokenId).seq;
    await api('post', '/api/v1/client/push/ack', annaPhone).send({ seqs: [phoneSeq], state: 'delivered' }).expect(200, { ok: true });
    assert.equal(H.deliveries(r.id).find((d) => d.seq === phoneSeq).state, 'delivered');
    await api('post', '/api/v1/client/push/ack', annaPhone).send({ seqs: [phoneSeq], state: 'read', action: 'details' }).expect(200);
    const ev = await laptop.waitFor((e) => e.event === 'read');
    assert.deepEqual(ev.data, { ids: [r.id] });
    const after = H.deliveries(r.id);
    assert.equal(after.find((d) => d.seq === phoneSeq).action, 'details');
    assert.equal(after.find((d) => d.token_id === annaLaptop.tokenId).state, 'read', 'sibling marked read too');
    laptop.close();
  });

  it('a device cannot ack another device’s seq', async () => {
    const r = send([benPhone.tokenId]);
    const seq = H.deliveries(r.id)[0].seq;
    await api('post', '/api/v1/client/push/ack', annaPhone).send({ seqs: [seq], state: 'read' }).expect(200);
    assert.equal(H.deliveries(r.id)[0].state, 'queued');
  });

  it('validates the body', async () => {
    const bad = [{}, { seqs: [], state: 'read' }, { seqs: ['1'], state: 'read' }, { seqs: [1], state: 'gone' },
      { seqs: Array.from({ length: 201 }, (_, i) => i + 1), state: 'read' }, { seqs: [1], state: 'read', action: 'x y' }];
    for (const b of bad) await api('post', '/api/v1/client/push/ack', annaPhone).send(b).expect(400);
  });
});

describe('GET /api/v1/client/push/inbox', () => {
  it('own items newest first with state, unread count, before=<seq>', async () => {
    const a = send([annaPhone.tokenId], 'Eins');
    const b = send([annaPhone.tokenId], 'Zwei');
    send([benPhone.tokenId], 'Fremd');
    const seqA = H.deliveries(a.id)[0].seq;
    await api('post', '/api/v1/client/push/ack', annaPhone).send({ seqs: [seqA], state: 'read' }).expect(200);
    const r = await api('get', '/api/v1/client/push/inbox', annaPhone).expect(200);
    assert.deepEqual(r.body.items.map((i) => i.title), ['Zwei', 'Eins']);
    assert.deepEqual(r.body.items.map((i) => i.state), ['delivered', 'read']);
    assert.equal(r.body.unread, 1);
    const seqB = H.deliveries(b.id)[0].seq;
    const older = await api('get', `/api/v1/client/push/inbox?before=${seqB}&limit=5`, annaPhone).expect(200);
    assert.deepEqual(older.body.items.map((i) => i.title), ['Eins']);
  });

  it('expired notifications are not in the inbox', async () => {
    const a = send([annaPhone.tokenId], 'Alt');
    H.db().prepare("UPDATE notifications SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(a.id);
    const r = await api('get', '/api/v1/client/push/inbox', annaPhone).expect(200);
    assert.deepEqual(r.body.items, []);
  });
});

describe('PUT /api/v1/client/push/prefs', () => {
  it('stores enabled, mode, muted topics and the battery restriction', async () => {
    await api('put', '/api/v1/client/push/prefs', annaPhone)
      .send({ enabled: true, mode: 'vpn_only', muted_topics: ['services', 'plugin:skoda:charging'], restricted: true }).expect(200, { ok: true });
    const row = H.db().prepare('SELECT * FROM notify_device_prefs WHERE token_id = ?').get(annaPhone.tokenId);
    assert.equal(row.mode, 'vpn_only');
    assert.equal(row.restricted, 1);
    assert.deepEqual(JSON.parse(row.topics), ['services', 'plugin:skoda:charging']);
    // muted topic → not queued for this device
    const out = require('../src/services/notify/router').resolve({ users: [anna], topic: 'services', priority: 'normal' });
    assert.ok(!out.some((x) => x.tokenId === annaPhone.tokenId));
    await api('put', '/api/v1/client/push/prefs', annaPhone).send({ muted_topics: [], restricted: false, mode: 'always' }).expect(200);
  });

  it('rejects invalid values', async () => {
    for (const b of [{ enabled: 'yes' }, { mode: 'sometimes' }, { muted_topics: ['<script>'] }, { muted_topics: 'services' }, { restricted: 1 }]) {
      await api('put', '/api/v1/client/push/prefs', annaPhone).send(b).expect(400);
    }
  });
});

describe('POST /api/v1/client/push/test', () => {
  it('an info message only to this device, ignoring quiet hours and mutes; ≤ 5 per minute', async () => {
    H.db().prepare("UPDATE notify_device_prefs SET topics = '[\"admin_notice\"]' WHERE token_id = ?").run(benPhone.tokenId);
    const r = await api('post', '/api/v1/client/push/test', benPhone).expect(200);
    assert.equal(r.body.ok, true);
    assert.ok(Number.isInteger(r.body.seq));
    const row = H.db().prepare('SELECT d.token_id, n.priority, n.title, n.event_id FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE d.seq = ?').get(r.body.seq);
    assert.equal(row.token_id, benPhone.tokenId);
    assert.equal(row.priority, 'info');
    assert.equal(row.event_id, 'test');
    assert.equal(row.title, 'Testnachricht');
    for (let i = 0; i < 4; i++) await api('post', '/api/v1/client/push/test', benPhone).expect(200);
    await api('post', '/api/v1/client/push/test', benPhone).expect(429);
    H.db().prepare('UPDATE notify_device_prefs SET topics = NULL WHERE token_id = ?').run(benPhone.tokenId);
  });
});
