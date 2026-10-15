'use strict';

// Push pictures and notification quick actions of plugins (docs/plugins.md
// "Notifications", docs/feature-notification-center.md):
//   * services/notify/media.js: image validation (PNG / JPEG / WebP headers,
//     any aspect ratio, 32…2560 px a side, ≤ 300 KB, no animation, declared
//     mime = detected), lifetime (ttl, 24 h default, 7 days at most)
//   * migration 102 (notify_media, notifications.image_url / image_expires_at)
//   * gc.notify({ image }) → imageUrl in the stream payload, the device inbox
//     and the portal inbox; never in the activity log; bundling
//   * capability URL /notify-media/<id>.<ext>: headers, every host, 404 once
//     expired or unknown, clean-up of the notification center
//   * data.actions[] type quick_action: the plugin's own id only, strict
//     checks (ERR_INVALID), shape after sanitising; never from the core

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');
const H = require('./helpers/notify');
const config = require('../config/default');

const HOME = `home.${config.dns.domain}`;
const URL_RE = /^\/notify-media\/[A-Za-z0-9_-]{22,64}\.(png|jpg|webp)$/;
const HOUR = 3600 * 1000;

let app, hostApi, manifest, registry, rules, license, plugins, media, store, retention, sanitize;
let anna, annaDev;

// ─── Image headers (only the header is parsed by the server) ─────────────

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}
function png(w, h = w, { animated = false, pad = 0 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (animated) parts.push(chunk('acTL', Buffer.alloc(8)));
  parts.push(chunk('IDAT', Buffer.alloc(16 + pad, 7)), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
function jpeg(w, h = w) {
  const frame = Buffer.alloc(19);
  frame[0] = 0xff; frame[1] = 0xc0;
  frame.writeUInt16BE(17, 2);
  frame[4] = 8;
  frame.writeUInt16BE(h, 5);
  frame.writeUInt16BE(w, 7);
  frame[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), frame, Buffer.from([0xff, 0xda, 0x00, 0x02, 1, 2, 3, 0xff, 0xd9])]);
}
function riff(fourcc, payload) {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(payload.length, 4);
  const body = Buffer.concat([head, payload]);
  const r = Buffer.alloc(12);
  r.write('RIFF', 0, 'latin1');
  r.writeUInt32LE(body.length + 4, 4);
  r.write('WEBP', 8, 'latin1');
  return Buffer.concat([r, body]);
}
function webpExtended(w, h = w, { animated = false } = {}) {
  const p = Buffer.alloc(18);
  p[0] = animated ? 0x02 : 0x00;
  p.writeUIntLE(w - 1, 4, 3);
  p.writeUIntLE(h - 1, 7, 3);
  return riff('VP8X', p);
}
const img = (buf, mime) => ({ data: buf.toString('base64'), mime });

function reasonOf(image) {
  try { media.validate(image); return 'ok'; } catch (e) { assert.equal(e.code, 'ERR_INVALID'); return e.reason; }
}

// ─── Plugins ─────────────────────────────────────────────────────────────

const TOPICS = [{ id: 'doorbell', label: { de: 'Klingel', en: 'Doorbell' }, default: true }];

function fakePlugin(id) {
  const v = manifest.validate({
    id, name: { de: 'Tür', en: 'Door' }, version: '1.0.0', publisher: 'Test', gatecontrol: '>=1.0.0', entry: 'server/index.js',
    permissions: { notify: { perHour: 120 }, portal: true }, notifyTopics: TOPICS,
  });
  assert.ok(v.ok, JSON.stringify(v.errors));
  registry.upsert({ manifest: v.manifest, signature: 'trusted', enabled: true });
  return { id, name: 'Tür', manifest: v.manifest };
}
const call = (plugin, notification) => hostApi.handle(plugin, 'notify', { notification });
async function codeOf(plugin, notification) {
  try { await call(plugin, notification); return null; } catch (e) { return e.code; }
}

const inbox = (dev) => supertest(app).get('/api/v1/client/push/inbox').set('X-API-Token', dev.raw).expect(200);

before(async () => {
  ({ app } = await setup());
  hostApi = require('../src/services/plugins/hostApi');
  manifest = require('../src/services/plugins/manifest');
  registry = require('../src/services/plugins/registry');
  rules = require('../src/services/notify/rules');
  license = require('../src/services/license');
  plugins = require('../src/services/plugins');
  media = require('../src/services/notify/media');
  store = require('../src/services/notify/store');
  retention = require('../src/services/notify/retention');
  sanitize = require('../src/services/notify/sanitize');
  anna = H.makeUser('nm-anna');
  annaDev = H.makeDevice(anna);
});
after(async () => { store._setClock(null); await plugins.stop(); teardown(); });
beforeEach(() => { store._setClock(null); H.clearNotifications(); });

describe('media.validate', () => {
  it('PNG, JPEG and WebP of any aspect ratio, 32…2560 px a side, ≤ 300 KB', () => {
    assert.equal(reasonOf(img(png(640, 360), 'image/png')), 'ok');
    assert.equal(reasonOf(img(jpeg(360, 640), 'image/jpeg')), 'ok');
    assert.equal(reasonOf(img(webpExtended(2560, 32), 'image/webp')), 'ok');
    assert.equal(reasonOf(img(png(32), 'image/png')), 'ok');
    const v = media.validate(img(jpeg(1280, 720), 'image/jpeg'));
    assert.deepEqual({ mime: v.mime, ext: v.ext, width: v.width, height: v.height }, { mime: 'image/jpeg', ext: 'jpg', width: 1280, height: 720 });
    assert.ok(Buffer.isBuffer(v.buf));
    // a data: URL of the same type is accepted
    assert.equal(reasonOf({ data: 'data:image/png;base64,' + png(64).toString('base64'), mime: 'image/png' }), 'ok');
    // exactly 300 KB is fine, one byte more is not
    const base = png(64);
    const exact = png(64, 64, { pad: media.MAX_BYTES - base.length });
    assert.equal(exact.length, media.MAX_BYTES);
    assert.equal(reasonOf(img(exact, 'image/png')), 'ok');
    assert.equal(reasonOf(img(png(64, 64, { pad: media.MAX_BYTES - base.length + 1 }), 'image/png')), 'too_large');
  });

  it('refuses everything else with a reason', () => {
    assert.equal(reasonOf(img(png(31, 64), 'image/png')), 'too_small');
    assert.equal(reasonOf(img(png(64, 2561), 'image/png')), 'too_big');
    assert.equal(reasonOf(img(png(64, 64, { animated: true }), 'image/png')), 'animated');
    assert.equal(reasonOf(img(webpExtended(64, 64, { animated: true }), 'image/webp')), 'animated');
    assert.equal(reasonOf(img(png(64), 'image/jpeg')), 'mime_mismatch');
    assert.equal(reasonOf(img(png(64), 'image/gif')), 'mime');
    assert.equal(reasonOf(img(png(64), 'image/svg+xml')), 'mime');
    assert.equal(reasonOf({ data: png(64).toString('base64') }), 'mime');
    assert.equal(reasonOf(img(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png')), 'format');
    assert.equal(reasonOf({ data: 'not base64 at all!', mime: 'image/png' }), 'format');
    assert.equal(reasonOf({ data: '', mime: 'image/png' }), 'empty');
    assert.equal(reasonOf({ data: ['a'], mime: 'image/png' }), 'empty');
    assert.equal(reasonOf({ data: 'A'.repeat(600 * 1024), mime: 'image/png' }), 'too_large');
    for (const bad of [null, 'x', [], 7]) assert.equal(reasonOf(bad), 'invalid');
  });

  it('lifetime: the ttl, 24 h by default, 7 days at most', () => {
    assert.equal(media.ttlOf(null), 24 * 3600);
    assert.equal(media.ttlOf(3600), 3600);
    assert.equal(media.ttlOf(30 * 86400), 7 * 86400);
  });
});

describe('migration 102', () => {
  it('creates notify_media and the image columns of notifications', () => {
    const { migrations } = require('../src/db/migrationList');
    const m = migrations.find((x) => x.version === 102);
    assert.equal(m.name, 'notify_media');
    assert.equal(m.detect(H.db()), true);
    const cols = H.db().prepare('PRAGMA table_info(notify_media)').all().map((c) => c.name);
    assert.deepEqual(cols, ['id', 'mime', 'data', 'created_at', 'expires_at']);
  });
});

describe('gc.notify({ image })', () => {
  it('stores the picture, imageUrl in the stream payload and both inboxes; the activity log never has it', async () => {
    const p = fakePlugin('door-a');
    const pic = jpeg(640, 480);
    const r = await call(p, { topic: 'doorbell', title: 'Es klingelt', users: [anna], image: img(pic, 'image/jpeg') });
    assert.equal(r.pushed, true);
    const n = H.lastNotification();
    assert.match(n.image_url, URL_RE);
    assert.ok(n.image_url.endsWith('.jpg'));
    const row = H.db().prepare('SELECT * FROM notify_media WHERE id = ?').get(n.image_url.slice('/notify-media/'.length, -4));
    assert.equal(row.mime, 'image/jpeg');
    assert.ok(Buffer.from(row.data).equals(pic), 'stored as sent');
    assert.equal(row.id.length >= 22, true);
    const life = Date.parse(row.expires_at) - Date.parse(row.created_at);
    assert.ok(Math.abs(life - 24 * HOUR) < 2000, 'default 24 h');
    assert.equal(n.image_expires_at, row.expires_at);

    const seq = H.deliveries(n.id)[0].seq;
    assert.equal(store.payload(store.deliveryRow(seq)).imageUrl, n.image_url, 'stream payload');
    const items = (await inbox(annaDev)).body.items;
    assert.equal(items[0].id, n.id);
    assert.equal(items[0].imageUrl, n.image_url, 'device inbox');

    const act = H.db().prepare("SELECT message, details FROM activity_log WHERE event_type = 'plugin_notice' ORDER BY id DESC LIMIT 1").get();
    assert.equal(act.message, 'Tür: Es klingelt');
    assert.ok(!act.details.includes(pic.toString('base64').slice(0, 40)), 'no image in the activity log');
    assert.ok(!act.details.includes('notify-media'), 'not even its URL');
    assert.deepEqual(JSON.parse(act.details), { plugin: 'door-a', topic: 'doorbell' });

    // a push without a picture: imageUrl null
    await call(p, { topic: 'doorbell', title: 'Ohne Bild', users: [anna] });
    assert.equal((await inbox(annaDev)).body.items[0].imageUrl, null);
  });

  it('expires_at follows the ttl (7 days at most); expired pictures disappear from the inbox and are cleaned up', async () => {
    const p = fakePlugin('door-b');
    await call(p, { topic: 'doorbell', title: 'Eine Stunde', users: [anna], ttl: 3600, image: img(png(100, 50), 'image/png') });
    const hour = H.lastNotification();
    assert.ok(Math.abs(Date.parse(hour.image_expires_at) - Date.parse(hour.created_at) - HOUR) < 2000);
    // default: 24 h (the notification itself lives for the retention, 72 h)
    await call(p, { topic: 'doorbell', title: 'Standard', users: [anna], image: img(png(100, 50), 'image/png') });
    const day = H.lastNotification();
    await call(p, { topic: 'doorbell', title: 'Lang', users: [anna], ttl: 20 * 86400, image: img(png(100, 50), 'image/png') });
    const long = H.lastNotification();
    assert.ok(Math.abs(Date.parse(long.image_expires_at) - Date.parse(long.created_at) - 7 * 24 * HOUR) < 2000);

    const res = await supertest(app).get(day.image_url).expect(200);
    assert.equal(res.headers['content-type'], 'image/png');

    const t0 = Date.now();
    store._setClock(() => t0 + 25 * HOUR);
    try {
      await supertest(app).get(hour.image_url).expect(404);
      await supertest(app).get(day.image_url).expect(404);
      await supertest(app).get(long.image_url).expect(200);
      const items = (await inbox(annaDev)).body.items;
      assert.equal(items.find((x) => x.id === day.id).imageUrl, null, 'no dead link in the inbox');
      assert.equal(items.find((x) => x.id === long.id).imageUrl, long.image_url);
      const out = retention.run();
      assert.ok(out.media >= 2);
      const left = (u) => H.db().prepare('SELECT COUNT(*) AS n FROM notify_media WHERE id = ?').get(u.slice('/notify-media/'.length, -4)).n;
      assert.equal(left(hour.image_url), 0);
      assert.equal(left(day.image_url), 0);
      assert.equal(left(long.image_url), 1);
    } finally { store._setClock(null); }
  });

  it('an invalid picture is ERR_INVALID: nothing pushed, nothing stored, no budget used', async () => {
    const p = fakePlugin('door-c');
    const media0 = H.db().prepare('SELECT COUNT(*) AS n FROM notify_media').get().n;
    for (const image of [img(png(16), 'image/png'), img(png(64), 'image/webp'), img(png(64, 64, { animated: true }), 'image/png'), { data: 'x' }, 'data', ['a']]) {
      assert.equal(await codeOf(p, { topic: 'doorbell', title: 'x', image }), 'ERR_INVALID', JSON.stringify(image).slice(0, 60));
    }
    assert.equal(H.lastNotification(), null);
    assert.equal(H.db().prepare('SELECT COUNT(*) AS n FROM notify_media').get().n, media0);
  });

  it('without the licence (no push) no picture is stored', async () => {
    const p = fakePlugin('door-d');
    const media0 = H.db().prepare('SELECT COUNT(*) AS n FROM notify_media').get().n;
    license._overrideForTest({ email_alerts: false });
    try {
      const r = await call(p, { topic: 'doorbell', title: 'x', image: img(png(64), 'image/png') });
      assert.equal(r.pushed, false);
    } finally { license._overrideForTest({ email_alerts: true }); }
    assert.equal(H.db().prepare('SELECT COUNT(*) AS n FROM notify_media').get().n, media0);
  });

  it('bundling: the picture follows the newest event', async () => {
    const p = fakePlugin('door-e');
    rules.ensurePluginRule('plugin:door-e:doorbell');
    rules.update('plugin:door-e:doorbell', { bundle_s: 300 });
    await call(p, { topic: 'doorbell', title: 'Ring 1', users: [anna], collapseKey: 'cam:1', image: img(png(64), 'image/png') });
    const first = H.lastNotification();
    await call(p, { topic: 'doorbell', title: 'Ring 2', users: [anna], collapseKey: 'cam:1', image: img(jpeg(64), 'image/jpeg') });
    const second = H.db().prepare('SELECT * FROM notifications WHERE id = ?').get(first.id);
    assert.equal(second.count, 2);
    assert.match(second.image_url, /\.jpg$/);
    assert.notEqual(second.image_url, first.image_url);
    await call(p, { topic: 'doorbell', title: 'Ring 3', users: [anna], collapseKey: 'cam:1' });
    const third = H.db().prepare('SELECT * FROM notifications WHERE id = ?').get(first.id);
    assert.equal(third.count, 3);
    assert.equal(third.image_url, null, 'no picture of an older ring');
  });
});

describe('GET /notify-media/<id>.<ext>', () => {
  it('serves the picture without login on the admin and the portal host, like /avatars/; 404 for unknown ids or the wrong extension', async () => {
    const p = fakePlugin('door-f');
    const pic = webpExtended(320, 240);
    await call(p, { topic: 'doorbell', title: 'x', users: [anna], image: img(pic, 'image/webp') });
    const url = H.lastNotification().image_url;
    assert.match(url, /\.webp$/);
    for (const host of [null, HOME]) {
      const req = supertest(app).get(url);
      if (host) req.set('Host', host);
      const res = await req.buffer(true).parse((r, cb) => { const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); }).expect(200);
      assert.ok(res.body.equals(pic));
      assert.equal(res.headers['content-type'], 'image/webp');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['content-security-policy'], "default-src 'none'");
      assert.equal(res.headers['cross-origin-resource-policy'], 'cross-origin');
      const m = /^private, max-age=(\d+), immutable$/.exec(res.headers['cache-control']);
      assert.ok(m, res.headers['cache-control']);
      assert.ok(Number(m[1]) > 23 * 3600 && Number(m[1]) <= 24 * 3600, 'cached for its remaining lifetime at most');
    }
    for (const bad of [url.replace('.webp', '.png'), '/notify-media/' + 'A'.repeat(24) + '.webp', '/notify-media/short.webp', '/notify-media/' + url.slice(14, -5)]) {
      const r = await supertest(app).get(bad).expect(404);
      assert.equal(r.headers['cache-control'], 'no-store');
    }
  });
});

describe('data.actions[] type quick_action', () => {
  it('kept for the plugin\'s own quick actions, in the contract shape', async () => {
    const p = fakePlugin('door-g');
    await call(p, { topic: 'doorbell', title: 'Es klingelt', users: [anna], data: { actions: [
      { type: 'quick_action', label: 'Tür öffnen', plugin: 'door-g', id: 'front:open', confirm: true, auth: 'device' },
      { type: 'quick_action', label: 'Zusperren', plugin: 'door-g', id: 'front:lock' },
      { type: 'open_app_route', id: 'view', label: 'Ansehen', target: 'plg-door-g' },
    ] } });
    const d = JSON.parse(H.lastNotification().data);
    assert.deepEqual(d.actions, [
      { id: 'front:open', label: 'Tür öffnen', type: 'quick_action', plugin: 'door-g', confirm: true, auth: 'device' },
      { id: 'front:lock', label: 'Zusperren', type: 'quick_action', plugin: 'door-g', confirm: false },
      { id: 'view', label: 'Ansehen', type: 'open_portal', target: '/portal#plg-door-g' },
    ]);
    const item = (await inbox(annaDev)).body.items[0];
    assert.deepEqual(item.data.actions[0], d.actions[0], 'reaches the apps unchanged');
  });

  it('ERR_INVALID: another plugin, bad id, label not 1…24, confirm not boolean, auth not device', async () => {
    const p = fakePlugin('door-h');
    const qa = (a) => ({ topic: 'doorbell', title: 'x', data: { actions: [{ type: 'quick_action', label: 'Öffnen', plugin: 'door-h', id: 'front:open', ...a }] } });
    assert.equal(await codeOf(p, qa({})), null, 'the valid one');
    H.clearNotifications();
    for (const bad of [{ plugin: 'door-g' }, { plugin: undefined }, { plugin: ['door-h'] }, { id: 'bad id' }, { id: 'x'.repeat(65) }, { id: 7 },
      { label: '' }, { label: '   ' }, { label: 'x'.repeat(25) }, { label: ['Öffnen'] }, { confirm: 'yes' }, { confirm: 1 },
      { auth: 'pin' }, { auth: true }]) {
      assert.equal(await codeOf(p, qa(bad)), 'ERR_INVALID', JSON.stringify(bad));
    }
    assert.equal(H.lastNotification(), null, 'nothing pushed');
  });

  it('never from the core or an administrator message (no plugin context): dropped', () => {
    const qa = { type: 'quick_action', label: 'Öffnen', plugin: 'door-g', id: 'front:open' };
    assert.equal(sanitize.data({ actions: [qa] }).data, null);
    assert.equal(sanitize.data({ actions: [qa] }, { plugin: 'other' }).data, null);
    assert.deepEqual(sanitize.data({ actions: [qa] }, { plugin: 'door-g' }).data.actions, [
      { id: 'front:open', label: 'Öffnen', type: 'quick_action', plugin: 'door-g', confirm: false },
    ]);
  });

  it('the ack of the apps may name a quick action id as action (≤ 64 characters)', async () => {
    const p = fakePlugin('door-i');
    await call(p, { topic: 'doorbell', title: 'x', users: [anna] });
    const seq = H.deliveries(H.lastNotification().id)[0].seq;
    const ack = (action) => supertest(app).post('/api/v1/client/push/ack').set('X-API-Token', annaDev.raw).send({ seqs: [seq], state: 'read', action });
    await ack('lock-' + 'x'.repeat(59)).expect(200);
    assert.equal(H.deliveries(H.lastNotification().id)[0].action, 'lock-' + 'x'.repeat(59));
    await ack('x'.repeat(65)).expect(400);
  });
});
