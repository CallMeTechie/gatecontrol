'use strict';

// Read-sync of the notification center (docs/feature-notification-center.md
// "Gelesen-Abgleich"): only a real `read` reaches the person's other devices
// (stored as read_via 'device' / 'portal'), a `dismissed` (swiped away) stays
// on the device that sent it. The admin read models count only what the device
// itself confirmed: "zugestellt" = delivered_at, "gelesen" = read on the
// device, "Bestätigt" = the device's own last ack; a row read elsewhere is
// "Anderswo gelesen". Migration 144 classifies existing rows.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');
const H = require('./helpers/notify');

let app, agent, hub, stream, store, admin, adminId, anna, annaPhone, annaLaptop;

before(async () => {
  ({ app, agent } = await setup());
  hub = require('../src/services/notify/hub');
  stream = require('../src/services/notify/stream');
  store = require('../src/services/notify/store');
  admin = require('../src/services/notify/admin');
  adminId = H.db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  anna = H.makeUser('anna', { language: 'de' });
  annaPhone = H.makeDevice(anna, { name: 'anna-phone' });
  annaLaptop = H.makeDevice(anna, { name: 'anna-laptop', platform: 'windows' });
});
after(() => { stream._resetForTest(); teardown(); });
beforeEach(() => { stream._resetForTest(); H.clearNotifications(); });

const ack = (dev, seqs, state, action) => {
  const r = supertest(app).post('/api/v1/client/push/ack').set('X-API-Token', dev.raw)
    .set('X-Client-Platform', 'android').set('X-Client-Version', '2.0.0');
  return r.send({ seqs, state, ...(action ? { action } : {}) }).expect(200, { ok: true });
};
/** An open stream of `dev` that records what the server writes. */
function fakeConn(dev, userId) {
  const out = [];
  const res = { write: (s) => { out.push(String(s)); return true; }, end() {}, once() {} };
  stream.add({ tokenId: dev.tokenId, userId, via: 'tunnel', res, connectedAt: new Date().toISOString() });
  return { readEvents: () => out.filter((s) => /^event: read$/m.test(s)) };
}
const toAnna = (title = 'Hallo') => hub.sendManual({ userId: adminId, target: { type: 'users', ids: [anna] }, title, body: 'Text', priority: 'normal', ttlS: null });
const row = (id, dev) => H.deliveries(id).find((d) => d.token_id === dev.tokenId);
const t = (key, vars) => `${key}${vars ? JSON.stringify(vars) : ''}`;

describe('dismissed stays on the device', () => {
  it('swiping away on the phone leaves the laptop unread and sends no read event', async () => {
    const laptop = fakeConn(annaLaptop, anna);
    const r = toAnna();
    const phoneSeq = row(r.id, annaPhone).seq;
    await ack(annaPhone, [phoneSeq], 'dismissed');
    const phone = row(r.id, annaPhone);
    assert.equal(phone.state, 'dismissed');
    assert.equal(phone.read_via, 'self');
    assert.ok(phone.delivered_at && phone.read_at);
    const lap = row(r.id, annaLaptop);
    assert.equal(lap.state, 'sent', 'the laptop keeps it');
    assert.equal(lap.read_at, null);
    assert.equal(lap.read_via, null);
    assert.deepEqual(laptop.readEvents(), []);
    // the laptop still counts it as unread and gets it in its inbox as such
    assert.equal(store.unreadCount(annaLaptop.tokenId), 1);
    assert.deepEqual(store.inbox(annaLaptop.tokenId).map((i) => i.state), ['delivered']);
  });

  it('an offline device still gets a dismissed notification when it reconnects', async () => {
    const r = toAnna();
    await ack(annaPhone, [row(r.id, annaPhone).seq], 'dismissed');
    assert.deepEqual(store.pendingForToken(annaLaptop.tokenId).map((p) => p.notification_id), [r.id]);
  });
});

describe('read reaches the other devices, marked as read elsewhere', () => {
  it('a read on the phone: laptop row read with read_via device, no delivered_at, read event', async () => {
    const laptop = fakeConn(annaLaptop, anna);
    const r = toAnna();
    await ack(annaPhone, [row(r.id, annaPhone).seq], 'read');
    const phone = row(r.id, annaPhone);
    assert.equal(phone.state, 'read');
    assert.equal(phone.read_via, 'self');
    const lap = row(r.id, annaLaptop);
    assert.equal(lap.state, 'read');
    assert.equal(lap.read_via, 'device');
    assert.equal(lap.delivered_at, null, 'the laptop never confirmed it');
    assert.ok(lap.read_at);
    assert.equal(laptop.readEvents().length, 1);
    assert.match(laptop.readEvents()[0], new RegExp(`"ids":\\[${r.id}\\]`));
    // the apps keep seeing it as read and do not get it again
    assert.deepEqual(store.inbox(annaLaptop.tokenId).map((i) => i.state), ['read']);
    assert.equal(store.unreadCount(annaLaptop.tokenId), 0);
    assert.deepEqual(store.pendingForToken(annaLaptop.tokenId), []);
  });

  it('a dismiss after a read keeps the origin of read_at', async () => {
    const r = toAnna();
    await ack(annaPhone, [row(r.id, annaPhone).seq], 'read');
    const before0 = row(r.id, annaLaptop);
    await ack(annaLaptop, [before0.seq], 'dismissed');
    const lap = row(r.id, annaLaptop);
    assert.equal(lap.state, 'dismissed');
    assert.equal(lap.read_via, 'device');
    assert.equal(lap.read_at, before0.read_at);
    assert.ok(lap.delivered_at, 'any ack of the device confirms it has the notification');
  });

  it('opened on the laptop after it was read elsewhere: its own read from then on', async () => {
    const r = toAnna();
    await ack(annaPhone, [row(r.id, annaPhone).seq], 'read');
    await ack(annaLaptop, [row(r.id, annaLaptop).seq], 'read');
    const lap = row(r.id, annaLaptop);
    assert.equal(lap.state, 'read');
    assert.equal(lap.read_via, 'self');
    assert.ok(lap.delivered_at);
  });

  it('a late "delivered" of the laptop records the delivery, the state stays read', async () => {
    const r = toAnna();
    await ack(annaPhone, [row(r.id, annaPhone).seq], 'read');
    await ack(annaLaptop, [row(r.id, annaLaptop).seq], 'delivered');
    const lap = row(r.id, annaLaptop);
    assert.equal(lap.state, 'read');
    assert.equal(lap.read_via, 'device');
    assert.ok(lap.delivered_at);
    const st = admin.statsFor([r.id]).get(r.id);
    assert.equal(st.delivered, 2);
    assert.equal(st.elsewhere, 0);
    assert.equal(st.read, 1);
  });

  it('portal "gelesen" marks every device with read_via portal', () => {
    const r = toAnna();
    assert.equal(hub.markRead(anna, [r.id]), 1);
    for (const dev of [annaPhone, annaLaptop]) {
      const d = row(r.id, dev);
      assert.equal(d.state, 'read');
      assert.equal(d.read_via, 'portal');
      assert.equal(d.delivered_at, null);
    }
  });
});

describe('admin read models', () => {
  it('statsFor / statusOf: read elsewhere is neither delivered nor missing', async () => {
    const r = toAnna();
    await ack(annaPhone, [row(r.id, annaPhone).seq], 'read');
    const st = admin.statsFor([r.id]).get(r.id);
    assert.equal(st.total, 2);
    assert.equal(st.delivered, 1, 'only the phone confirmed it');
    assert.equal(st.read, 1, 'read on one device');
    assert.equal(st.elsewhere, 1);
    assert.equal(st.read_elsewhere, 1);
    assert.equal(admin.statusOf(store.getNotification(r.id), st), 'ok');
    const h = admin.history({ filter: 'all' }, t).items.find((i) => i.id === r.id);
    assert.deepEqual([h.delivered, h.total, h.read, h.elsewhere, h.status], [1, 2, 1, 1, 'ok']);
    assert.equal(admin.history({ filter: 'undelivered' }, t).items.some((i) => i.id === r.id), false);
  });

  it('a device that neither got nor read it is still partial / waiting', async () => {
    const r = toAnna();
    await ack(annaPhone, [row(r.id, annaPhone).seq], 'dismissed');
    const st = admin.statsFor([r.id]).get(r.id);
    assert.deepEqual([st.delivered, st.read, st.elsewhere], [1, 1, 0]);
    assert.equal(admin.statusOf(store.getNotification(r.id), st), 'waiting');
    H.db().prepare("UPDATE notifications SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(r.id);
    assert.equal(admin.statusOf(store.getNotification(r.id), st), 'partial');
  });

  it('overview: read_24h counts only reads on the device itself', async () => {
    const r = toAnna();
    await ack(annaPhone, [row(r.id, annaPhone).seq], 'read');
    const k = admin.overview(t).kpis;
    assert.equal(k.delivered_24h, 1);
    assert.equal(k.read_24h, 1);
    const recent = admin.overview(t).recent.find((i) => i.id === r.id);
    assert.deepEqual([recent.delivered, recent.read, recent.elsewhere], [1, 1, 1]);
  });

  it('detail: read_via per delivery and a timeline entry "anderswo gelesen"', async () => {
    const r = toAnna();
    await ack(annaPhone, [row(r.id, annaPhone).seq], 'read');
    const res = await agent.get(`/api/v1/notify/history/${r.id}`).expect(200);
    const byToken = new Map(res.body.deliveries.map((d) => [d.token_id, d]));
    assert.equal(byToken.get(annaPhone.tokenId).read_via, 'self');
    assert.equal(byToken.get(annaLaptop.tokenId).read_via, 'device');
    assert.equal(byToken.get(annaLaptop.tokenId).delivered_at, null);
    assert.equal(byToken.get(annaLaptop.tokenId).state, 'read', 'the stored state is unchanged');
    const tl = new Map(res.body.timeline.map((x) => [x.kind, x]));
    // the admin session speaks English
    assert.equal(tl.get('delivered').text, 'Delivered to 1 devices');
    assert.equal(tl.get('read').text, 'Read on 1 devices');
    assert.equal(tl.get('read_elsewhere').text, 'Read elsewhere: 1 devices marked as read');
    assert.equal(tl.get('read').at, byToken.get(annaPhone.tokenId).read_at);
    // unread rows: read_via null
    const r2 = toAnna('Zwei');
    const res2 = await agent.get(`/api/v1/notify/history/${r2.id}`).expect(200);
    assert.ok(res2.body.deliveries.every((d) => d.read_via === null));
    assert.equal(res2.body.timeline.some((x) => x.kind === 'read_elsewhere'), false);
  });

  it('devices: "Bestätigt" is the last ack the device itself sent', async () => {
    const r = toAnna();
    await ack(annaPhone, [row(r.id, annaPhone).seq], 'read');
    const list = admin.devices();
    const phone = list.find((d) => d.token_id === annaPhone.tokenId);
    const lap = list.find((d) => d.token_id === annaLaptop.tokenId);
    assert.equal(phone.last_ack_at, row(r.id, annaPhone).read_at);
    assert.equal(lap.last_ack_at, null, 'read on the phone is no ack of the laptop');
    hub.markRead(anna, null);
    assert.equal(admin.devices().find((d) => d.token_id === annaLaptop.tokenId).last_ack_at, null, 'nor is the portal');
    await ack(annaLaptop, [row(r.id, annaLaptop).seq], 'delivered');
    assert.equal(admin.devices().find((d) => d.token_id === annaLaptop.tokenId).last_ack_at, row(r.id, annaLaptop).delivered_at);
  });
});

describe('admin page helpers', () => {
  const N = require('../public/js/notifications.js');
  it('deliveryState / readKey', () => {
    assert.equal(N.deliveryState({ state: 'read', read_at: 'x', read_via: 'self' }), 'read');
    assert.equal(N.deliveryState({ state: 'read', read_at: 'x', read_via: null }), 'read', 'rows without origin: read on the device');
    for (const via of ['device', 'portal', 'elsewhere']) {
      assert.equal(N.deliveryState({ state: 'read', read_at: 'x', read_via: via }), 'read_elsewhere');
      assert.equal(N.readKey({ read_at: 'x', read_via: via }), 'notify.proto.read_' + via);
    }
    assert.equal(N.deliveryState({ state: 'dismissed', read_at: 'x', read_via: 'device' }), 'dismissed');
    assert.equal(N.readKey({ read_at: 'x', read_via: 'self' }), 'notify.proto.read_at');
    assert.equal(N.readElsewhere(null), false);
  });
  it('statusOf / histStatusOf with rows read elsewhere', () => {
    assert.deepEqual(N.histStatusOf({ total: 2, delivered: 1, read: 1, elsewhere: 1, status: 'ok' }),
      { key: 'notify.hist.status_elsewhere', params: { delivered: 1, total: 2, n: 1 }, tone: 'good' });
    assert.equal(N.histStatusOf({ total: 3, delivered: 1, elsewhere: 1, status: 'waiting' }).params.n, 1);
    assert.deepEqual(N.statusOf({ total: 2, delivered: 1, read: 1, elsewhere: 1 }),
      { key: 'notify.status.delivered', params: { delivered: 1, total: 2 }, tone: 'good' });
  });
  it('the new texts exist in DE and EN', () => {
    const de = require('../src/i18n/de.json');
    const en = require('../src/i18n/en.json');
    const keys = ['notify.dstate.read_elsewhere', 'notify.proto.not_delivered', 'notify.proto.read_device', 'notify.proto.read_portal',
      'notify.proto.read_elsewhere', 'notify.hist.status_elsewhere', 'notify.tl.read_elsewhere', 'push.timeline.read_elsewhere'];
    for (const k of keys) { assert.ok(de[k], 'de ' + k); assert.ok(en[k], 'en ' + k); }
    assert.equal(de['notify.dstate.read_elsewhere'], 'Anderswo gelesen');
    assert.equal(en['notify.dstate.read_elsewhere'], 'Read elsewhere');
  });
});

describe('migration 144 (notify_read_via)', () => {
  it('existing read rows without delivered_at become "elsewhere", the other read rows "self"', () => {
    const Database = require('better-sqlite3');
    const m = require('../src/db/migrationList').migrations.find((x) => x.version === 144);
    assert.equal(m.name, 'notify_read_via');
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE notification_deliveries (seq INTEGER PRIMARY KEY AUTOINCREMENT, notification_id INTEGER NOT NULL,
        token_id INTEGER NOT NULL, user_id INTEGER, state TEXT NOT NULL DEFAULT 'queued', via TEXT, action TEXT,
        silent INTEGER NOT NULL DEFAULT 0, queued_at TEXT, sent_at TEXT, delivered_at TEXT, read_at TEXT, UNIQUE (notification_id, token_id))`);
      const ins = db.prepare('INSERT INTO notification_deliveries (notification_id, token_id, state, delivered_at, read_at) VALUES (?, ?, ?, ?, ?)');
      ins.run(1, 1, 'read', '2026-11-01T10:00:00.000Z', '2026-11-01T10:01:00.000Z'); // read on the device
      ins.run(1, 2, 'read', null, '2026-11-01T10:01:00.000Z'); // synced: never reached the device
      ins.run(1, 3, 'dismissed', '2026-11-01T10:00:00.000Z', '2026-11-01T10:02:00.000Z'); // swiped away on the device
      ins.run(1, 4, 'dismissed', null, '2026-11-01T10:01:00.000Z'); // synced, swiped later
      ins.run(1, 5, 'delivered', '2026-11-01T10:00:00.000Z', null);
      ins.run(1, 6, 'queued', null, null);
      ins.run(1, 7, 'expired', null, null);
      assert.equal(m.detect(db), false);
      db.exec(m.sql);
      assert.equal(m.detect(db), true);
      const via = db.prepare('SELECT token_id, read_via FROM notification_deliveries ORDER BY token_id').all().map((r) => r.read_via);
      assert.deepEqual(via, ['self', 'elsewhere', 'self', 'elsewhere', null, null, null]);
    } finally { db.close(); }
  });

  it('is applied on the test database', () => {
    assert.equal(H.db().prepare('SELECT name FROM migration_history WHERE version = 144').get().name, 'notify_read_via');
  });
});
