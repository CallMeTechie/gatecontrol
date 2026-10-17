'use strict';

// Profile pictures and favourite colours (docs/feature-avatars.md):
//   * services/avatars.js: image validation (PNG / JPEG / WebP headers,
//     square, 64…512 px, ≤ 96 KB, no animation), palette, default colour
//   * migration 101 (user_avatars, users.avatar_color, cascade with the user)
//   * capability URL /avatars/<id>.<ext>: rotation, 404 after delete, cache
//     headers, served on the admin and the portal host
//   * client API /api/v1/client/me/* (NO_USER, rate limit, colour validation)
//   * admin API /api/v1/users/:id/{avatar,color} (CSRF), own profile
//     /api/v1/profile/{avatar,color}, list / detail fields
//   * portal: viewer fields, /api/v1/portal/me/*, kiosk devices refused
//   * gc.users fields and the frame CSP of plugins with permissions.users
//   * activity log (never the image), backup export / restore

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');
const config = require('../config/default');

const HOME = `home.${config.dns.domain}`;
const PLUGINS = '/api/v1/plugins';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const URL_RE = /^\/avatars\/[A-Za-z0-9_-]{22,64}\.(png|jpg|webp)$/;

let app, agent, csrf, avatars, runtime, plugins, adminId;

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
function jpeg(w, h = w, { sof = 0xc0 } = {}) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const dht = Buffer.from([0xff, 0xc4, 0x00, 0x04, 0x00, 0x00]);
  const frame = Buffer.alloc(19);
  frame[0] = 0xff; frame[1] = sof;
  frame.writeUInt16BE(17, 2);
  frame[4] = 8;
  frame.writeUInt16BE(h, 5);
  frame.writeUInt16BE(w, 7);
  frame[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dht, frame, Buffer.from([0xff, 0xda, 0x00, 0x02, 1, 2, 3, 0xff, 0xd9])]);
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
function webpLossy(w, h = w) {
  const p = Buffer.alloc(20);
  p[3] = 0x9d; p[4] = 0x01; p[5] = 0x2a;
  p.writeUInt16LE(w, 6);
  p.writeUInt16LE(h, 8);
  return riff('VP8 ', p);
}
function webpLossless(w, h = w) {
  const p = Buffer.alloc(16);
  p[0] = 0x2f;
  p.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 1);
  return riff('VP8L', p);
}
function webpExtended(w, h = w, { animated = false } = {}) {
  const p = Buffer.alloc(18);
  p[0] = animated ? 0x02 : 0x00;
  p.writeUIntLE(w - 1, 4, 3);
  p.writeUIntLE(h - 1, 7, 3);
  return riff('VP8X', p);
}

function reasonOf(buf) {
  try { avatars.validateImage(buf); return 'ok'; } catch (e) { assert.equal(e.code, 'ERR_INVALID'); return e.reason; }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const client = (dev) => ({
  get: (p) => supertest(app).get(p).set('X-API-Token', dev.raw),
  put: (p) => supertest(app).put(p).set('X-API-Token', dev.raw),
  del: (p) => supertest(app).delete(p).set('X-API-Token', dev.raw),
});
const upload = (req, buf, type = 'image/png') => req.set('Content-Type', type).send(buf);

function portalAgent(ip) {
  const a = supertest.agent(app);
  const prep = (r) => r.set('Host', HOME).set('X-GC-Portal-Peer-IP', ip);
  return { get: (p) => prep(a.get(p)), put: (p) => prep(a.put(p)), del: (p) => prep(a.delete(p)), post: (p) => prep(a.post(p)) };
}
function ctxOf(html) {
  const m = html.match(/id="portal-ctx"[^>]*>([^<]*)</);
  return m ? JSON.parse(m[1]) : null;
}
async function signedIn(dev) {
  const r = await supertest(app).post('/api/v1/client/portal-link').set('Authorization', `Bearer ${dev.raw}`).send({}).expect(200);
  const p = portalAgent(dev.ip);
  await p.get('/auto?t=' + new URL(r.body.url).searchParams.get('t')).expect(302);
  const page = await p.get('/portal').expect(200);
  return { p, html: page.text, ctx: ctxOf(page.text) };
}

async function install(buf) {
  const r = await agent.post(PLUGINS + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(PLUGINS + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}

function activityOf(type, userId) {
  return H.db().prepare("SELECT * FROM activity_log WHERE event_type = ? AND json_extract(details, '$.userId') = ? ORDER BY id").all(type, userId);
}

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  avatars = require('../src/services/avatars');
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  adminId = H.db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  await install(helloPackage());
  await install(helloPackage({ overrides: { id: 'hello-kiosk', name: 'Hallo Kiosk', permissions: { ...helloManifest.permissions, kiosk: true } } }));
  for (const id of ['hello', 'hello-kiosk']) assert.equal(await runtime.waitRunning(id), true, id);
});
after(async () => { await plugins.stop(); teardown(); });

// ─── Service ─────────────────────────────────────────────────────────────

describe('validateImage', () => {
  it('accepts square PNG, JPEG (baseline and progressive) and WebP (VP8, VP8L, VP8X)', () => {
    assert.deepEqual(avatars.validateImage(png(256)), { mime: 'image/png', ext: 'png', size: 256, width: 256, height: 256, bytes: png(256).length });
    assert.equal(avatars.validateImage(jpeg(128)).mime, 'image/jpeg');
    assert.equal(avatars.validateImage(jpeg(128)).ext, 'jpg');
    assert.equal(avatars.validateImage(jpeg(200, 200, { sof: 0xc2 })).size, 200);
    for (const b of [webpLossy(256), webpLossless(256), webpExtended(256)]) {
      const r = avatars.validateImage(b);
      assert.equal(r.mime, 'image/webp');
      assert.equal(r.ext, 'webp');
      assert.equal(r.size, 256);
    }
    assert.equal(avatars.validateImage(png(64)).size, 64);
    assert.equal(avatars.validateImage(webpLossless(512)).size, 512);
  });

  it('refuses wrong magic, non-square, too small, too big, too large, animated, empty, truncated', () => {
    assert.equal(reasonOf(Buffer.from('GIF89a' + 'x'.repeat(40))), 'format');
    assert.equal(reasonOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'format');
    assert.equal(reasonOf(Buffer.alloc(0)), 'empty');
    assert.equal(reasonOf(null), 'empty');
    assert.equal(reasonOf(png(256, 128)), 'not_square');
    assert.equal(reasonOf(jpeg(300, 200)), 'not_square');
    assert.equal(reasonOf(webpLossy(256, 255)), 'not_square');
    assert.equal(reasonOf(png(63)), 'too_small');
    assert.equal(reasonOf(webpExtended(32)), 'too_small');
    assert.equal(reasonOf(png(513)), 'too_big');
    assert.equal(reasonOf(jpeg(1024)), 'too_big');
    assert.equal(reasonOf(png(256, 256, { pad: 96 * 1024 })), 'too_large');
    assert.equal(reasonOf(png(256, 256, { animated: true })), 'animated');
    assert.equal(reasonOf(webpExtended(256, 256, { animated: true })), 'animated');
    assert.equal(reasonOf(png(256).subarray(0, 20)), 'format');
    assert.equal(reasonOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), 'format');
    const badVp8 = webpLossy(256);
    badVp8[23] = 0;
    assert.equal(reasonOf(badVp8), 'format');
  });

  it('palette: ten colours, no red; default colour from the user id', () => {
    assert.equal(avatars.PALETTE.length, 10);
    assert.deepEqual(avatars.PALETTE.map((c) => c.key), ['blue', 'teal', 'green', 'lime', 'yellow', 'orange', 'pink', 'purple', 'indigo', 'slate']);
    assert.ok(!avatars.PALETTE.some((c) => /red/i.test(c.key) || c.hex.toUpperCase() === avatars.AWAY_HEX));
    assert.equal(avatars.AWAY_HEX, '#E5484D');
    for (const c of avatars.PALETTE) assert.match(c.hex, /^#[0-9A-F]{6}$/);
    assert.equal(avatars.colorOf({ id: 13, avatar_color: null }), avatars.PALETTE[3].key);
    assert.equal(avatars.colorOf({ id: 13, avatar_color: 'pink' }), 'pink');
    assert.equal(avatars.colorOf({ id: 13, avatar_color: 'red' }), avatars.PALETTE[3].key);
    assert.equal(avatars.initialsOf('Anna Berg'), 'AB');
    assert.equal(avatars.initialsOf('anna'), 'AN');
  });
});

describe('migration 101', () => {
  it('adds user_avatars and users.avatar_color; detect recognises it', () => {
    const { migrations } = require('../src/db/migrationList');
    const m = migrations.find((x) => x.version === 101);
    assert.equal(m.name, 'user_avatars');
    assert.equal(m.detect(H.db()), true);
    const cols = H.db().prepare('PRAGMA table_info(user_avatars)').all().map((c) => c.name);
    assert.deepEqual(cols, ['user_id', 'avatar_id', 'mime', 'data', 'updated_at']);
    assert.ok(H.db().prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'avatar_color'));
    assert.equal(H.db().prepare("SELECT version FROM migration_history WHERE version = 101").get().version, 101);
  });

  it('the picture goes with the user (ON DELETE CASCADE)', () => {
    const u = H.makeUser('av-gone');
    avatars.set(u, png(128));
    assert.equal(H.db().prepare('SELECT COUNT(*) AS c FROM user_avatars WHERE user_id = ?').get(u).c, 1);
    require('../src/services/users').remove(u);
    assert.equal(H.db().prepare('SELECT COUNT(*) AS c FROM user_avatars WHERE user_id = ?').get(u).c, 0);
  });
});

// ─── Capability URL ──────────────────────────────────────────────────────

describe('GET /avatars/<id>.<ext>', () => {
  it('serves the picture with immutable caching on the admin and the portal host; new URL on every change; 404 after delete', async () => {
    const u = H.makeUser('av-url');
    const buf = png(128);
    const first = avatars.set(u, buf).avatarUrl;
    assert.match(first, URL_RE);
    assert.ok(first.split('/').pop().split('.')[0].length >= 22);
    for (const host of [null, HOME]) {
      const req = supertest(app).get(first);
      if (host) req.set('Host', host);
      const r = await req.buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
      assert.equal(r.headers['content-type'], 'image/png');
      assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['cross-origin-resource-policy'], 'cross-origin');
      assert.equal(r.headers['set-cookie'], undefined);
      assert.ok(Buffer.compare(r.body, buf) === 0);
    }
    const second = avatars.set(u, jpeg(128)).avatarUrl;
    assert.notEqual(second, first);
    assert.match(second, /\.jpg$/);
    await supertest(app).get(first).expect(404);
    const r2 = await supertest(app).get(second).expect(200);
    assert.equal(r2.headers['content-type'], 'image/jpeg');
    // the extension must match the stored type
    await supertest(app).get(second.replace(/\.jpg$/, '.png')).expect(404);
    assert.equal(avatars.remove(u), true);
    assert.equal(avatars.remove(u), false);
    await supertest(app).get(second).expect(404);
    for (const bad of ['/avatars/x.png', '/avatars/' + 'a'.repeat(30) + '.gif', '/avatars/' + 'a'.repeat(30), '/avatars/..%2f..%2fetc.png']) {
      await supertest(app).get(bad).expect(404);
    }
  });
});

// ─── Client API ──────────────────────────────────────────────────────────

describe('client API /api/v1/client/me/*', () => {
  let anna, phone;
  before(() => {
    anna = H.makeUser('av-anna');
    H.db().prepare("UPDATE users SET display_name = 'Anna Berg' WHERE id = ?").run(anna);
    phone = H.makeDevice(anna, { name: 'av-phone' });
  });

  it('GET me/profile: user and palette (no red), default colour from the id', async () => {
    const r = await client(phone).get('/api/v1/client/me/profile').expect(200);
    const def = avatars.PALETTE[anna % 10];
    assert.deepEqual(r.body, {
      ok: true,
      user: { id: anna, name: 'Anna Berg', initials: 'AB', color: def.key, colorHex: def.hex, avatarUrl: null },
      palette: avatars.PALETTE.map((c) => ({ key: c.key, hex: c.hex })),
    });
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  it('PUT / DELETE me/avatar and PUT me/color', async () => {
    const put = await upload(client(phone).put('/api/v1/client/me/avatar'), webpLossy(256), 'image/webp').expect(200);
    assert.equal(put.body.ok, true);
    assert.match(put.body.avatarUrl, URL_RE);
    assert.match(put.body.avatarUrl, /\.webp$/);
    await supertest(app).get(put.body.avatarUrl).expect(200);
    let prof = (await client(phone).get('/api/v1/client/me/profile').expect(200)).body;
    assert.equal(prof.user.avatarUrl, put.body.avatarUrl);

    const c = await client(phone).put('/api/v1/client/me/color').send({ color: 'green' }).expect(200);
    assert.deepEqual(c.body, { ok: true, color: 'green', colorHex: '#22C55E' });
    const red = await client(phone).put('/api/v1/client/me/color').send({ color: 'red' }).expect(400);
    assert.equal(red.body.code, 'INVALID_COLOR');
    assert.equal(red.body.field, 'color');
    assert.equal(red.body.ok, false);
    assert.ok(red.body.error);
    for (const bad of [{ color: '#ff0000' }, { color: 7 }, {}, { color: 'Blue' }]) {
      assert.equal((await client(phone).put('/api/v1/client/me/color').send(bad).expect(400)).body.code, 'INVALID_COLOR', JSON.stringify(bad));
    }
    const reset = await client(phone).put('/api/v1/client/me/color').send({ color: null }).expect(200);
    assert.equal(reset.body.color, avatars.PALETTE[anna % 10].key);

    const del = await client(phone).del('/api/v1/client/me/avatar').expect(200);
    assert.deepEqual(del.body, { ok: true });
    await supertest(app).get(put.body.avatarUrl).expect(404);
    prof = (await client(phone).get('/api/v1/client/me/profile').expect(200)).body;
    assert.equal(prof.user.avatarUrl, null);
  });

  it('wrong type 415, over 96 KB 413, broken or non-square image 400 with the reason', async () => {
    const t = await upload(client(phone).put('/api/v1/client/me/avatar'), Buffer.from('GIF89a'), 'image/gif').expect(415);
    assert.equal(t.body.code, 'UNSUPPORTED_TYPE');
    const j = await client(phone).put('/api/v1/client/me/avatar').send({ image: 'x' }).expect(415);
    assert.equal(j.body.code, 'UNSUPPORTED_TYPE');
    const big = await upload(client(phone).put('/api/v1/client/me/avatar'), png(256, 256, { pad: 100 * 1024 })).expect(413);
    assert.equal(big.body.code, 'TOO_LARGE');
    const sq = await upload(client(phone).put('/api/v1/client/me/avatar'), png(256, 200)).expect(400);
    assert.deepEqual([sq.body.code, sq.body.reason], ['INVALID_IMAGE', 'not_square']);
    const fake = await upload(client(phone).put('/api/v1/client/me/avatar'), jpeg(128), 'image/png').expect(200);
    assert.match(fake.body.avatarUrl, /\.jpg$/, 'the type comes from the bytes, not from the header');
    const anim = await upload(client(phone).put('/api/v1/client/me/avatar'), png(128, 128, { animated: true })).expect(400);
    assert.equal(anim.body.reason, 'animated');
  });

  it('a token without a person gets NO_USER; a session or a token without the client scope is refused', async () => {
    const peerId = Number(H.db().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES (?, ?, '10.8.9.9/32', 1, 'regular')")
      .run(H.uniq('av-machine'), crypto.randomBytes(16).toString('base64')).lastInsertRowid);
    const t = require('../src/services/tokens').create({ name: H.uniq('av-machine'), scopes: ['client'], userId: null, peerId }, '127.0.0.1');
    const machine = { raw: t.rawToken };
    for (const r of [
      await client(machine).get('/api/v1/client/me/profile'),
      await upload(client(machine).put('/api/v1/client/me/avatar'), png(128)),
      await client(machine).del('/api/v1/client/me/avatar'),
      await client(machine).put('/api/v1/client/me/color').send({ color: 'blue' }),
    ]) {
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'NO_USER');
    }
    await agent.get('/api/v1/client/me/profile').expect(403);
    const ro = H.makeDevice(anna, { name: 'av-ro', scopes: ['read-only'] });
    await client(ro).get('/api/v1/client/me/profile').expect(403);
  });

  it('writes: 30 per hour and token (429 RATE_LIMITED), reading is not limited by it', async () => {
    const other = H.makeDevice(anna, { name: 'av-rate' });
    for (let i = 0; i < 30; i += 1) await client(other).put('/api/v1/client/me/color').send({ color: i % 2 ? 'blue' : 'teal' }).expect(200);
    const r = await client(other).put('/api/v1/client/me/color').send({ color: 'blue' }).expect(429);
    assert.deepEqual([r.body.ok, r.body.code], [false, 'RATE_LIMITED']);
    await upload(client(other).put('/api/v1/client/me/avatar'), png(128)).expect(429);
    await client(other).get('/api/v1/client/me/profile').expect(200);
    await client(phone).put('/api/v1/client/me/color').send({ color: 'blue' }).expect(200);
  });

  it('activity log: avatar_changed / avatar_removed / avatar_color_changed — never the image', () => {
    const changed = activityOf('avatar_changed', anna);
    assert.ok(changed.length >= 1);
    assert.ok(activityOf('avatar_removed', anna).length >= 1);
    assert.ok(activityOf('avatar_color_changed', anna).length >= 1);
    for (const row of H.db().prepare("SELECT details FROM activity_log WHERE event_type LIKE 'avatar_%'").all()) {
      assert.ok(String(row.details).length < 300, row.details);
      assert.doesNotMatch(String(row.details), /data|base64|UklGR|iVBOR/);
    }
  });
});

// ─── Admin ───────────────────────────────────────────────────────────────

describe('admin API /api/v1/users/:id/{avatar,color}', () => {
  let ben;
  before(() => { ben = H.makeUser('av-ben'); });

  it('needs the CSRF token; sets, recolours and removes; list and detail carry the fields', async () => {
    await upload(agent.put(`/api/v1/users/${ben}/avatar`), png(200)).expect(403);
    const put = await upload(agent.put(`/api/v1/users/${ben}/avatar`).set('X-CSRF-Token', csrf), png(200)).expect(200);
    assert.match(put.body.avatarUrl, URL_RE);
    const col = await agent.put(`/api/v1/users/${ben}/color`).set('X-CSRF-Token', csrf).send({ color: 'purple' }).expect(200);
    assert.deepEqual(col.body, { ok: true, color: 'purple', colorHex: '#A855F7' });
    assert.equal((await agent.put(`/api/v1/users/${ben}/color`).set('X-CSRF-Token', csrf).send({ color: 'red' }).expect(400)).body.code, 'INVALID_COLOR');

    const list = (await agent.get('/api/v1/users').expect(200)).body.users;
    const row = list.find((u) => u.id === ben);
    assert.deepEqual([row.avatarUrl, row.color, row.colorHex], [put.body.avatarUrl, 'purple', '#A855F7']);
    const admin = list.find((u) => u.id === adminId);
    assert.equal(admin.avatarUrl, null);
    assert.equal(admin.color, avatars.PALETTE[adminId % 10].key);
    const detail = (await agent.get(`/api/v1/users/${ben}`).expect(200)).body.user;
    assert.deepEqual([detail.avatarUrl, detail.color, detail.colorHex], [put.body.avatarUrl, 'purple', '#A855F7']);

    await agent.delete(`/api/v1/users/${ben}/avatar`).expect(403);
    await agent.delete(`/api/v1/users/${ben}/avatar`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal((await agent.get(`/api/v1/users/${ben}`).expect(200)).body.user.avatarUrl, null);
    const changed = activityOf('avatar_changed', ben);
    assert.equal(JSON.parse(changed[changed.length - 1].details).actorId, adminId);
  });

  it('unknown user 404; API tokens are refused', async () => {
    const r = await upload(agent.put('/api/v1/users/999999/avatar').set('X-CSRF-Token', csrf), png(128)).expect(404);
    assert.equal(r.body.code, 'NOT_FOUND');
    await agent.put('/api/v1/users/999999/color').set('X-CSRF-Token', csrf).send({ color: 'blue' }).expect(404);
    const dev = H.makeDevice(ben, { name: 'av-ben-phone' });
    await supertest(app).put(`/api/v1/users/${ben}/color`).set('X-API-Token', dev.raw).send({ color: 'blue' }).expect(403);
  });

  it('own profile: /api/v1/profile/avatar and /color (session + CSRF)', async () => {
    let r = await agent.get('/api/v1/profile/avatar').expect(200);
    assert.equal(r.body.user.id, adminId);
    assert.equal(r.body.palette.length, 10);
    await upload(agent.put('/api/v1/profile/avatar'), png(96)).expect(403);
    const put = await upload(agent.put('/api/v1/profile/avatar').set('X-CSRF-Token', csrf), png(96)).expect(200);
    await agent.put('/api/v1/profile/color').set('X-CSRF-Token', csrf).send({ color: 'orange' }).expect(200);
    r = await agent.get('/api/v1/profile/avatar').expect(200);
    assert.deepEqual([r.body.user.avatarUrl, r.body.user.color, r.body.user.colorHex], [put.body.avatarUrl, 'orange', '#F97316']);
    // the topbar shows it on every page
    const page = await agent.get('/profile').expect(200);
    assert.match(page.text, /class="topbar-avatar av-c-orange has-img" id="profile-btn"[^>]*>\s*<img class="av-img" src="\/avatars\/[A-Za-z0-9_-]+\.png" alt="">/);
    assert.ok(page.text.includes('/js/avatar-edit.js'));
    assert.ok(page.text.includes('id="pf-look"'));
    const island = JSON.parse(page.text.match(/id="pf-pin-i18n"[^>]*>([^<]*)</)[1]);
    assert.ok(island['avatar.change'] && island['avatar.color_help']);
    await agent.delete('/api/v1/profile/avatar').set('X-CSRF-Token', csrf).expect(200);
    assert.doesNotMatch((await agent.get('/profile').expect(200)).text, /id="profile-btn"[^>]*>\s*<img/);
    const tokenOnly = H.makeDevice(adminId, { name: 'av-admin-phone' });
    await supertest(app).get('/api/v1/profile/avatar').set('X-API-Token', tokenOnly.raw).expect(403);
  });

  it('the user pages load the editor and its strings', async () => {
    const page = await agent.get(`/users/${ben}`).expect(200);
    assert.ok(page.text.indexOf('/js/avatar-edit.js') < page.text.indexOf('/js/users.js'));
    const island = JSON.parse(page.text.match(/id="us-i18n"[^>]*>([^<]*)</)[1]);
    assert.ok(['Farbe des Rings, wenn du zu Hause bist', 'Colour of the ring when you are at home'].includes(island['avatar.color_help']));
  });
});

// ─── Portal ──────────────────────────────────────────────────────────────

describe('portal', () => {
  let cara, phone;
  before(() => {
    cara = H.makeUser('av-cara');
    phone = H.makeDevice(cara, { name: 'av-cara-phone' });
  });

  it('the viewer carries avatarUrl / color / colorHex; the header shows initials on the colour, then the picture', async () => {
    let s = await signedIn(phone);
    const color = avatars.PALETTE[cara % 10].key;
    assert.match(s.html, new RegExp(`<span class="pt-avatar av-c-${color}" id="pt-avatar" aria-hidden="true">AC</span>`));
    assert.equal(s.ctx.canEditLook, true);
    assert.ok(s.html.includes('id="pt-look"'));
    assert.ok(s.html.includes('/js/avatar-edit.js'));
    const prof = await s.p.get('/api/v1/portal/me/profile').expect(200);
    assert.equal(prof.body.user.id, cara);
    // own change with the portal session — CSRF required
    await upload(s.p.put('/api/v1/portal/me/avatar'), png(128)).expect(403);
    const put = await upload(s.p.put('/api/v1/portal/me/avatar').set('X-CSRF-Token', s.ctx.csrf), png(128)).expect(200);
    await s.p.put('/api/v1/portal/me/color').set('X-CSRF-Token', s.ctx.csrf).send({ color: 'indigo' }).expect(200);
    s = await signedIn(phone);
    assert.ok(s.html.includes(`<span class="pt-avatar av-c-indigo has-img" id="pt-avatar" aria-hidden="true"><img class="av-img" src="${put.body.avatarUrl}" alt=""></span>`));
    // the portal host serves the picture as well
    await s.p.get(put.body.avatarUrl).expect(200);
    await s.p.del('/api/v1/portal/me/avatar').set('X-CSRF-Token', s.ctx.csrf).expect(200);
    assert.equal(avatars.info(cara).avatarUrl, null);
  });

  it('without a portal session nothing can be changed; the strings are in the island', async () => {
    const anon = portalAgent(phone.ip);
    const page = await anon.get('/portal').expect(200);
    assert.ok(!page.text.includes('id="pt-look"'));
    await anon.get('/api/v1/portal/me/profile').expect(401);
    await upload(anon.put('/api/v1/portal/me/avatar'), png(128)).expect(401);
    const { html } = await signedIn(phone);
    const i18n = JSON.parse(html.match(/id="portal-i18n"[^>]*>([^<]*)</)[1]);
    assert.ok(i18n['avatar.change'] && i18n['avatar.remove'] && i18n['avatar.color.blue']);
  });

  it('a kiosk device may not change the picture or the colour (kiosk allow-list)', async () => {
    const ks = require('../src/middleware/kioskSession');
    for (const [m, p] of [['GET', '/api/v1/portal/me/profile'], ['PUT', '/api/v1/portal/me/avatar'], ['DELETE', '/api/v1/portal/me/avatar'], ['PUT', '/api/v1/portal/me/color']]) {
      assert.equal(ks.kioskAllowed(m, p), false, `${m} ${p}`);
    }
    // a paired wall tablet
    const wall = H.makeUser('av-wall');
    const allow = await agent.post(`${PLUGINS}/hello-kiosk/api/kiosk`).set('X-CSRF-Token', csrf).send({ userId: wall, allowed: true });
    assert.equal(allow.status, 200, JSON.stringify(allow.body));
    const code = await agent.post(`/api/v1/users/${wall}/kiosk/pair`).set('X-CSRF-Token', csrf).send({ name: 'Flur' }).expect(201);
    const t = supertest.agent(app);
    const prep = (r) => r.set('Host', HOME).set('X-Forwarded-For', '198.51.100.77');
    const pairPage = await prep(t.get('/portal/kiosk?code=' + encodeURIComponent(code.body.code))).expect(200);
    const formCsrf = pairPage.text.match(/name="_csrf" value="([^"]*)"/)[1];
    await prep(t.post('/portal/kiosk')).type('form').send({ code: code.body.code, _csrf: formCsrf }).expect(303);
    const page = await prep(t.get('/portal')).expect(200);
    const ctx = ctxOf(page.text);
    assert.equal(ctx.kiosk, true);
    assert.equal(ctx.canEditLook, false);
    assert.ok(!page.text.includes('id="pt-look"'));
    assert.match(page.text, /class="pt-avatar av-c-[a-z]+"/, 'the kiosk header still shows the person');
    const r = await upload(prep(t.put('/api/v1/portal/me/avatar')).set('X-CSRF-Token', ctx.csrf), png(128)).expect(403);
    assert.equal(r.body.code, 'kiosk_forbidden');
    assert.equal((await prep(t.put('/api/v1/portal/me/color')).set('X-CSRF-Token', ctx.csrf).send({ color: 'blue' }).expect(403)).body.code, 'kiosk_forbidden');
    assert.equal(avatars.info(wall).avatarUrl, null);
  });

  it('"Wer bist du?" shows the pictures of the people of a shared device', async () => {
    const svc = require('../src/services/portalDevices');
    const owner = H.makeUser('av-share');
    const dev = H.makeDevice(owner, { name: 'av-shared' });
    H.db().prepare("UPDATE api_tokens SET device_usage = 'multi' WHERE id = ?").run(dev.tokenId);
    const url = avatars.set(owner, png(128)).avatarUrl;
    const me = svc.peopleForPicker(dev.peerId).find((p) => p.id === owner);
    assert.equal(me.avatarUrl, url);
    assert.equal(me.color, avatars.colorOf({ id: owner }));
    const page = await portalAgent(dev.ip).get('/portal/who').expect(200);
    assert.ok(page.text.includes(`<span class="pt-person-avatar av-c-${me.color} has-img" aria-hidden="true"><img class="av-img" src="${url}" alt=""></span>`));
  });
});

// ─── Plugins ─────────────────────────────────────────────────────────────

describe('plugins: gc.users and the frame CSP', () => {
  it('gc.users.list carries avatarUrl, color, colorHex, initials', async () => {
    const dora = H.makeUser('av-dora');
    H.db().prepare("UPDATE users SET display_name = 'Dora Ernst' WHERE id = ?").run(dora);
    const url = avatars.set(dora, webpLossless(128)).avatarUrl;
    avatars.setColor(dora, 'lime');
    const r = await agent.get(`${PLUGINS}/hello/api/users`).expect(200);
    const u = r.body.users.find((x) => x.id === dora);
    assert.deepEqual(u, { id: dora, name: 'Dora Ernst', role: 'user', avatarUrl: url, color: 'lime', colorHex: '#84CC16', initials: 'DE' });
    const one = await agent.get(`${PLUGINS}/hello/api/user`).query({ id: dora }).expect(200);
    assert.deepEqual(one.body.user, u, 'gc.users.get has the same fields');
    const admin = r.body.users.find((x) => x.id === adminId);
    assert.ok(admin.color && admin.colorHex && admin.initials);
    assert.ok(admin.avatarUrl === null || URL_RE.test(admin.avatarUrl));
  });

  it('every plugin frame (admin page, portal tab) may load /avatars/ of this origin, nothing else of it', async () => {
    const frame = require('../src/services/plugins/frame');
    const r = await agent.get('/plugins/hello/frame/main').set('Host', 'gc.example.com:8443').expect(200);
    const csp = r.headers['content-security-policy'];
    assert.ok(csp.split('; ').includes('img-src data: http://gc.example.com:8443/avatars/'), csp);
    assert.match(csp, /connect-src 'none'/);
    assert.doesNotMatch(csp, /img-src[^;]*'self'/);
    assert.equal(csp, frame.cspFor({ avatars: true, origin: 'http://gc.example.com:8443' }));
    const portal = await agent.get('/portal/plugins/hello/frame').set('Host', HOME).expect(200);
    assert.ok(portal.headers['content-security-policy'].split('; ').includes(`img-src data: http://${HOME}/avatars/`), portal.headers['content-security-policy']);
    // a Host header that is not a plain host: no origin, no pictures
    const bad = await agent.get('/plugins/hello/frame/main').set('Host', 'evil.example;img-src *').expect(200);
    assert.equal(bad.headers['content-security-policy'], frame.CSP);
    // maps frames keep their sources and add the pictures
    assert.ok(frame.cspFor({ maps: true, avatars: true, origin: 'https://gc.example.com' }).split('; ')
      .includes('img-src data: https://tile.openstreetmap.org https://gc.example.com/plugins/_shared/leaflet/images/ https://gc.example.com/plugins/_shared/tiles/ https://gc.example.com/avatars/'));
  });
});

// ─── Backup (last: a restore replaces the users) ─────────────────────────

describe('backup', () => {
  it('pictures and colours survive export and restore (same URL, same bytes)', async () => {
    const backup = require('../src/services/backup');
    const eve = H.makeUser('av-eve');
    const buf = jpeg(256);
    const url = avatars.set(eve, buf).avatarUrl;
    avatars.setColor(eve, 'yellow');
    const username = H.db().prepare('SELECT username FROM users WHERE id = ?').get(eve).username;
    const data = JSON.parse(JSON.stringify(backup.createBackup()));
    const entry = data.data.user_avatars.find((a) => a.user_name === username);
    assert.equal(entry.mime, 'image/jpeg');
    assert.equal(Buffer.from(entry.data, 'base64').compare(buf), 0);
    assert.equal(backup.getBackupSummary(data).user_avatars, data.data.user_avatars.length);
    // a broken picture in the backup is skipped, the rest is restored
    data.data.user_avatars.push({ user_name: 'admin', avatar_id: 'x'.repeat(24), mime: 'image/png', data: Buffer.from('nope').toString('base64') });
    avatars.remove(eve);
    await backup.restoreBackup(data);
    const id = H.db().prepare('SELECT id FROM users WHERE username = ?').get(username).id;
    const look = avatars.info(id);
    assert.deepEqual([look.avatarUrl, look.color], [url, 'yellow']);
    const r = await supertest(app).get(url).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    assert.equal(r.body.compare(buf), 0);
    assert.equal(H.db().prepare("SELECT COUNT(*) AS c FROM user_avatars WHERE avatar_id = ?").get('x'.repeat(24)).c, 0);
  });
});

describe('strings', () => {
  it('every avatar.* string exists in both languages', () => {
    const de = require('../src/i18n/de.json');
    const en = require('../src/i18n/en.json');
    const keys = (o) => Object.keys(o).filter((k) => k.startsWith('avatar.')).sort();
    assert.deepEqual(keys(de), keys(en));
    for (const c of avatars.PALETTE) assert.ok(de[`avatar.color.${c.key}`] && en[`avatar.color.${c.key}`], c.key);
    for (const r of ['empty', 'too_large', 'format', 'animated', 'not_square', 'too_small', 'too_big', 'color', 'type', 'no_user', 'rate_limited', 'failed']) {
      assert.ok(de[`avatar.err.${r}`] && en[`avatar.err.${r}`], r);
    }
    assert.equal(de['avatar.color_help'], 'Farbe des Rings, wenn du zu Hause bist');
  });
});
