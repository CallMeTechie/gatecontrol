'use strict';

// Plugin media (docs/plugins.md "Media", src/services/plugins/media.js):
// plugin.json `media`, the uploads of the apps (PUT /api/v1/client/plugins/
// <id>/media), the portal and the admin frames (PUT …/plugins/<id>/media), the
// apps' download with Range (GET …/media/<mediaId>, hook mediaAccess), the
// signed capability URLs of frames (/plugin-media/<token>, gc.media.url),
// gc.media.info/claim/delete/usage, encryption at rest, quota, the clean-up
// of unclaimed files, the frame CSP / microphone, backups.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const supertest = require('supertest');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');
const PUI = require('../public/js/plugins-ui.js');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

let app, agent, csrf, runtime, plugins, manifest, media, server, port, anna, annaDev, ben, benDev, adminId, inspected;
const API = '/api/v1/plugins';
const CLIENT = '/api/v1/client/plugins';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const MEDIA = { maxBytes: 512 * 1024, types: ['image/png', 'audio/ogg', 'application/pdf'], quotaDefault: '10MB' };

function mediaOverrides(id = 'hello-media') {
  return { id, name: { de: 'Hallo Medien', en: 'Hello media' }, permissions: { ...clone(helloManifest.permissions), app: true, events: true }, media: MEDIA };
}

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  return r.body;
}
const kv = (id, key, value) => agent.post(`${API}/${id}/api/kv`).set('X-CSRF-Token', csrf).send({ key, value }).expect(200);
const gcMedia = (id, body) => agent.post(`${API}/${id}/api/media`).set('X-CSRF-Token', csrf).send(body);
const put = (dev, plugin, buf, type = 'image/png') => supertest(app).put(`${CLIENT}/${plugin}/media`).set('X-API-Token', dev.raw).set('Content-Type', type).send(buf);
const get = (dev, plugin, id) => supertest(app).get(`${CLIENT}/${plugin}/media/${id}`).set('X-API-Token', dev.raw);
const db = () => H.db();
const randomBytes = (n) => crypto.randomBytes(n);

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  manifest = require('../src/services/plugins/manifest');
  media = require('../src/services/plugins/media');
  adminId = db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  anna = H.makeUser('media-anna');
  ben = H.makeUser('media-ben');
  annaDev = H.makeDevice(anna, { name: 'media-anna-phone' });
  benDev = H.makeDevice(ben, { name: 'media-ben-phone' });
  inspected = await install(helloPackage({ overrides: mediaOverrides() }));
  await install(helloPackage({ overrides: { id: 'hello-plain', name: 'Ohne Medien', permissions: { ...clone(helloManifest.permissions), app: true } } }));
  for (const id of ['hello-media', 'hello-plain']) assert.equal(await runtime.waitRunning(id), true, id);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => {
  media._accessMs = null;
  await new Promise((r) => server.close(r));
  await plugins.stop();
  teardown();
});

describe('plugin.json media', () => {
  const base = () => clone(helloManifest);
  const check = (mediaDecl) => { const m = base(); m.media = mediaDecl; return manifest.validate(m); };

  it('is normalised: types lower case without duplicates, quotaDefault in bytes (default 1 GB)', () => {
    let r = check({ maxBytes: 26214400, types: ['image/JPEG', 'image/jpeg', ' audio/ogg '], quotaDefault: '10GB' });
    assert.equal(r.ok, true, r.errors.join(', '));
    assert.deepEqual(r.manifest.media, { maxBytes: 26214400, types: ['image/jpeg', 'audio/ogg'], quotaDefault: 10 * 1024 ** 3 });
    r = check({ maxBytes: 4096, types: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] });
    assert.equal(r.manifest.media.quotaDefault, 1024 ** 3);
    assert.equal(check({ maxBytes: 4096, types: ['image/png'], quotaDefault: 50 * 1024 * 1024 }).manifest.media.quotaDefault, 50 * 1024 * 1024);
    assert.equal(check({ maxBytes: 4096, types: ['image/png'], quotaDefault: '500 MB' }).manifest.media.quotaDefault, 500 * 1024 * 1024);
    assert.equal(manifest.validate(base()).manifest.media, null, 'without the key: null');
  });

  it('refuses bad declarations with stable codes', () => {
    const errs = (d) => check(d).errors;
    assert.deepEqual(errs('yes'), ['media: invalid']);
    assert.deepEqual(errs({ maxBytes: 4096, types: ['image/png'], extra: 1 }), ['media: invalid']);
    for (const maxBytes of [0, 1023, 100 * 1024 * 1024 + 1, 1.5, '1000']) assert.deepEqual(errs({ maxBytes, types: ['image/png'] }), ['media.maxBytes: invalid'], String(maxBytes));
    for (const types of [[], 'image/png', ['image'], ['text/html'], ['image/svg+xml'], ['application/json'], ['application/xhtml+xml'], ['text/javascript'],
      ['application/ld+json'], ['multipart/form-data'], new Array(33).fill(0).map((_, i) => `image/x-${i}`)]) {
      assert.deepEqual(errs({ maxBytes: 4096, types }), ['media.types: invalid'], JSON.stringify(types));
    }
    for (const quotaDefault of ['10 XB', 'ten', 512 * 1024, '2TB', 1024]) assert.deepEqual(errs({ maxBytes: 4096, types: ['image/png'], quotaDefault }), ['media.quotaDefault: invalid'], String(quotaDefault));
    assert.deepEqual(errs({ maxBytes: 50 * 1024 * 1024, types: ['image/png'], quotaDefault: '10MB' }), ['media.quotaDefault: invalid'], 'quota below maxBytes');
  });

  it('the install dialog names the media (size, quota, types) and the live events', () => {
    const perm = inspected.plugin.permissions;
    assert.deepEqual(perm.media, { maxBytes: 512 * 1024, types: ['image/png', 'audio/ogg', 'application/pdf'], quotaDefault: 10 * 1024 * 1024 });
    assert.equal(perm.events, true);
    const t = (k, p) => { let s = de[k] || k; for (const [a, b] of Object.entries(p || {})) s = s.split('{{' + a + '}}').join(String(b)); return s; };
    const rows = Object.fromEntries(PUI.permRows(perm, t).map((r) => [r.label, r.value]));
    assert.match(rows.Medien, /bis 512\.0 KB je Datei, Kontingent 10\.0 MB\): PNG, OGG, PDF/);
    assert.match(rows.Medien, /Mikrofon/);
    assert.equal(rows['Live-Ereignisse'], de['plugins.perm.events_on']);
    for (const k of ['plugins.perm.media', 'plugins.perm.media_v', 'plugins.perm.events', 'plugins.perm.events_on', 'plugins.media.usage', 'plugins.sec.backup_media']) assert.ok(de[k] && en[k], k);
    const plain = PUI.permRows({ storage: true, network: { internet: [], homeTargets: [] } }, t).map((r) => r.label);
    assert.ok(!plain.includes('Medien') && !plain.includes('Live-Ereignisse'), 'nothing new for plugins without the keys');
  });
});

describe('media service (units)', () => {
  it('parseRange: one range, suffix, open end, unsatisfiable → false, garbage → whole file', () => {
    assert.deepEqual(media.parseRange('bytes=0-9', 100), { start: 0, end: 9 });
    assert.deepEqual(media.parseRange('bytes=90-', 100), { start: 90, end: 99 });
    assert.deepEqual(media.parseRange('bytes=-10', 100), { start: 90, end: 99 });
    assert.deepEqual(media.parseRange('bytes=50-500', 100), { start: 50, end: 99 });
    assert.deepEqual(media.parseRange('bytes=-500', 100), { start: 0, end: 99 });
    assert.equal(media.parseRange('bytes=100-', 100), false);
    assert.equal(media.parseRange('bytes=9-5', 100), false);
    assert.equal(media.parseRange('bytes=-0', 100), false);
    for (const h of [undefined, '', 'bytes=0-1,5-6', 'items=0-1', 'bytes=-']) assert.equal(media.parseRange(h, 100), null, String(h));
  });

  it('sealedSize: header + bytes + one tag per 64 KiB chunk', () => {
    assert.equal(media.sealedSize(1), 12 + 1 + 16);
    assert.equal(media.sealedSize(64 * 1024), 12 + 64 * 1024 + 16);
    assert.equal(media.sealedSize(64 * 1024 + 1), 12 + 64 * 1024 + 1 + 32);
  });

  it('mayRead: no hook → the uploader only; an error → no', async () => {
    const r = { id: 'a'.repeat(32), owner_user_id: 7, mime: 'image/png' };
    const m = mock.method(runtime, 'call', async () => ({ allowed: null }));
    try {
      assert.equal(await media.mayRead('x', { id: 7 }, r), true);
      assert.equal(await media.mayRead('x', { id: 8 }, r), false);
      assert.equal(await media.mayRead('x', { id: 7 }, { ...r, owner_user_id: null }), false);
      m.mock.mockImplementation(async () => { throw new Error('down'); });
      assert.equal(await media.mayRead('x', { id: 7 }, r), false);
      m.mock.mockImplementation(async () => ({ allowed: 'yes' }));
      assert.equal(await media.mayRead('x', { id: 7 }, r), false, 'only a real true');
    } finally { m.mock.restore(); }
  });
});

describe('uploads and downloads of the apps', () => {
  let big;
  let id;
  before(() => { big = randomBytes(200 * 1024 + 123); });

  it('PUT: streamed to disk encrypted, an unclaimed row of the uploader → { mediaId, mime, bytes }', async () => {
    const r = await put(annaDev, 'hello-media', big).expect(200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.body.ok, true);
    assert.match(r.body.mediaId, /^[0-9a-f]{32}$/);
    assert.deepEqual([r.body.mime, r.body.bytes], ['image/png', big.length]);
    id = r.body.mediaId;
    const row = db().prepare('SELECT * FROM plugin_media WHERE id = ?').get(id);
    assert.deepEqual([row.plugin, row.owner_user_id, row.ref_count, row.mime, row.bytes], ['hello-media', anna, 0, 'image/png', big.length]);
    assert.equal(row.sha256, crypto.createHash('sha256').update(big).digest('hex'));
    const file = path.join(process.env.GC_DATA_DIR, 'plugin-media', 'hello-media', id.slice(0, 2), id);
    const disk = fs.readFileSync(file);
    assert.equal(disk.length, media.sealedSize(big.length));
    assert.equal(disk.subarray(0, 4).toString(), 'GCM1');
    assert.equal(disk.includes(big.subarray(1000, 1064)), false, 'no plaintext on disk');
    assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  });

  it('GET: the hook mediaAccess decides (it gets the app viewer); 404 otherwise', async () => {
    await kv('hello-media', 'media-access', null);
    await get(annaDev, 'hello-media', id).expect(404);
    const last = await (await agent.get(`${API}/hello-media/api/kv`).query({ key: 'media-access-last' }).expect(200)).body.value;
    assert.deepEqual(last, { user: { id: anna, name: 'media-anna', role: 'user', portal: true, loggedIn: true, app: true }, mediaId: id, owner: anna, mime: 'image/png' });
    await kv('hello-media', 'media-access', [anna]);
    const r = await get(annaDev, 'hello-media', id).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    assert.ok(Buffer.compare(r.body, big) === 0, 'the whole file, decrypted');
    assert.equal(r.headers['content-type'], 'image/png');
    assert.equal(r.headers['accept-ranges'], 'bytes');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['content-security-policy'], "default-src 'none'; sandbox");
    assert.equal(r.headers['cache-control'], 'private, max-age=86400, immutable');
    assert.equal(r.headers['content-disposition'], undefined, 'pictures inline');
    await get(benDev, 'hello-media', id).expect(404);
    await get(annaDev, 'hello-plain', id).expect(404);
    await get(annaDev, 'hello-media', 'f'.repeat(32)).expect(404);
    await get(annaDev, 'hello-media', 'nope').expect(404);
  });

  it('Range: across chunk boundaries, suffix, unsatisfiable (416), HEAD', async () => {
    const bin = (req) => req.buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    for (const [a, b] of [[0, 9], [65530, 65545], [131071, 131073], [100, 199999], [big.length - 5, big.length - 1]]) {
      const r = await bin(get(annaDev, 'hello-media', id).set('Range', `bytes=${a}-${b}`)).expect(206);
      assert.equal(r.headers['content-range'], `bytes ${a}-${b}/${big.length}`);
      assert.equal(Number(r.headers['content-length']), b - a + 1);
      assert.ok(Buffer.compare(r.body, big.subarray(a, b + 1)) === 0, `${a}-${b}`);
    }
    const s = await bin(get(annaDev, 'hello-media', id).set('Range', 'bytes=-100')).expect(206);
    assert.ok(Buffer.compare(s.body, big.subarray(big.length - 100)) === 0);
    const u = await get(annaDev, 'hello-media', id).set('Range', `bytes=${big.length}-`).expect(416);
    assert.equal(u.headers['content-range'], `bytes */${big.length}`);
    const h = await supertest(app).head(`${CLIENT}/hello-media/media/${id}`).set('X-API-Token', annaDev.raw).expect(200);
    assert.equal(Number(h.headers['content-length']), big.length);
  });

  it('a plugin without the hook mediaAccess: only the uploader reads a file', async () => {
    const bare = new Map([['server/bare.js', "'use strict';\nmodule.exports = { async request() { return { json: { ok: true } }; } };\n"]]);
    await install(helloPackage({ overrides: { ...mediaOverrides('hello-bare-media'), entry: 'server/bare.js' }, extra: bare }));
    assert.equal(await runtime.waitRunning('hello-bare-media'), true);
    const up = (await put(annaDev, 'hello-bare-media', randomBytes(500)).expect(200)).body.mediaId;
    await get(annaDev, 'hello-bare-media', up).expect(200);
    await get(benDev, 'hello-bare-media', up).expect(404);
  });

  it('a failing or slow hook denies', async () => {
    await kv('hello-media', 'media-access-mode', 'throw');
    await get(annaDev, 'hello-media', id).expect(404);
    media._accessMs = 300;
    await kv('hello-media', 'media-access-mode', 'slow');
    await get(annaDev, 'hello-media', id).expect(404);
    media._accessMs = null;
    await new Promise((r) => setTimeout(r, 2000));
    await kv('hello-media', 'media-access-mode', null);
    await get(annaDev, 'hello-media', id).expect(200);
  });

  it('refusals: type, size, length, quota, no media, no token', async () => {
    let r = await put(annaDev, 'hello-media', Buffer.from('<html>'), 'text/html').expect(415);
    assert.deepEqual(r.body, { ok: false, code: 'unsupported_type' });
    r = await put(annaDev, 'hello-media', randomBytes(512 * 1024 + 1)).expect(413);
    assert.equal(r.body.code, 'too_large');
    r = await put(annaDev, 'hello-media', Buffer.alloc(0)).expect(411);
    assert.equal(r.body.code, 'length_required');
    await put(annaDev, 'hello-plain', randomBytes(10)).expect(404);
    await put(annaDev, 'nope-plugin', randomBytes(10)).expect(404);
    await agent.put(`${CLIENT}/hello-media/media`).set('X-CSRF-Token', csrf).set('Content-Type', 'image/png').send(randomBytes(10)).expect(403);
    // the type parameter is ignored, the base type counts
    r = await put(annaDev, 'hello-media', Buffer.from('%PDF-1.4'), 'application/PDF; charset=binary').expect(200);
    assert.equal(r.body.mime, 'application/pdf');
    await kv('hello-media', 'media-access', true);
    const pdf = await get(annaDev, 'hello-media', r.body.mediaId).expect(200);
    assert.equal(pdf.headers['content-disposition'], `attachment; filename="${r.body.mediaId}"`, 'documents as a download');

    // chunked upload without Content-Length → 411
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: `${CLIENT}/hello-media/media`,
        headers: { 'X-API-Token': annaDev.raw, 'Content-Type': 'image/png', 'Transfer-Encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.write(randomBytes(100));
      req.end();
    });
    assert.equal(status, 411);
  });

  it('an aborted upload leaves neither a row nor a file', async () => {
    const before0 = db().prepare('SELECT COUNT(*) AS n FROM plugin_media').get().n;
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: `${CLIENT}/hello-media/media`,
        headers: { 'X-API-Token': annaDev.raw, 'Content-Type': 'image/png', 'Content-Length': 300000 } });
      req.on('error', () => resolve());
      req.write(randomBytes(70000));
      setTimeout(() => { req.destroy(); resolve(); }, 150);
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(db().prepare('SELECT COUNT(*) AS n FROM plugin_media').get().n, before0);
    const dir = path.join(process.env.GC_DATA_DIR, 'plugin-media', 'hello-media');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('.tmp-')), []);
  });

  it('quota: the administrator sets it (GET/PUT …/media/settings); uploads beyond it → 507', async () => {
    let r = await agent.get(`${API}/hello-media/media/settings`).expect(200);
    assert.equal(r.body.media.quota, 10 * 1024 * 1024);
    assert.equal(r.body.media.quotaDefault, 10 * 1024 * 1024);
    assert.ok(r.body.media.usage.count >= 2);
    await agent.put(`${API}/hello-media/media/settings`).set('X-CSRF-Token', csrf).send({ quotaBytes: 12 }).expect(400);
    await agent.put(`${API}/hello-media/media/settings`).set('X-CSRF-Token', csrf).send({ quotaBytes: 'big' }).expect(400);
    await agent.put(`${API}/hello-media/media/settings`).set('X-CSRF-Token', csrf).send({}).expect(400);
    await agent.get(`${API}/hello-plain/media/settings`).expect(404);
    r = await agent.put(`${API}/hello-media/media/settings`).set('X-CSRF-Token', csrf).send({ quotaBytes: 1024 * 1024 }).expect(200);
    assert.equal(r.body.media.quota, 1024 * 1024);
    const used = r.body.media.usage.bytes;
    const room = 1024 * 1024 - used;
    if (room > 0) await put(annaDev, 'hello-media', randomBytes(Math.min(room, 512 * 1024))).expect(200);
    r = await put(annaDev, 'hello-media', randomBytes(Math.min(512 * 1024, Math.max(1, 1024 * 1024 - media.usage('hello-media').bytes + 1)))).expect(507);
    assert.equal(r.body.code, 'quota_exceeded');
    r = await agent.put(`${API}/hello-media/media/settings`).set('X-CSRF-Token', csrf).send({ quotaBytes: null }).expect(200);
    assert.equal(r.body.media.quota, 10 * 1024 * 1024, 'back to the declared default');
    assert.ok(db().prepare("SELECT 1 FROM activity_log WHERE event_type = 'plugin_media_quota'").get());
  });
});

describe('uploads of the frames (portal, admin page)', () => {
  it('portal: a signed-in viewer with CSRF; no login → 403', async () => {
    const r = await agent.put('/api/v1/portal/plugins/hello-media/media').set('X-CSRF-Token', csrf).set('Content-Type', 'audio/ogg').send(randomBytes(2000)).expect(200);
    assert.equal(r.body.mime, 'audio/ogg');
    assert.equal(db().prepare('SELECT owner_user_id FROM plugin_media WHERE id = ?').get(r.body.mediaId).owner_user_id, adminId);
    await agent.put('/api/v1/portal/plugins/hello-media/media').set('Content-Type', 'audio/ogg').send(randomBytes(20)).expect(403);
    const anon = await supertest(app).put('/api/v1/portal/plugins/hello-media/media').set('Content-Type', 'audio/ogg').send(randomBytes(20));
    assert.ok([401, 403].includes(anon.status), String(anon.status));
    await agent.put('/api/v1/portal/plugins/hello-plain/media').set('X-CSRF-Token', csrf).set('Content-Type', 'audio/ogg').send(randomBytes(20)).expect(404);
  });

  it('admin page: the administrator\'s session with CSRF', async () => {
    const r = await agent.put(`${API}/hello-media/media`).set('X-CSRF-Token', csrf).set('Content-Type', 'image/png').send(randomBytes(1000)).expect(200);
    assert.equal(r.body.bytes, 1000);
    await agent.put(`${API}/hello-media/media`).set('Content-Type', 'image/png').send(randomBytes(10)).expect(403);
    await agent.put(`${API}/hello-plain/media`).set('X-CSRF-Token', csrf).set('Content-Type', 'image/png').send(randomBytes(10)).expect(404);
  });
});

describe('gc.media through the plugin process', () => {
  let id;
  before(async () => {
    id = (await put(annaDev, 'hello-media', randomBytes(3000)).expect(200)).body.mediaId;
  });

  it('info, claim (idempotent), usage', async () => {
    let r = await gcMedia('hello-media', { op: 'info', id }).expect(200);
    assert.deepEqual(Object.keys(r.body.result).sort(), ['bytes', 'claimed', 'createdAt', 'mediaId', 'mime', 'owner', 'sha256']);
    assert.deepEqual([r.body.result.mediaId, r.body.result.bytes, r.body.result.owner, r.body.result.claimed], [id, 3000, anna, false]);
    r = await gcMedia('hello-media', { op: 'claim', id }).expect(200);
    assert.equal(r.body.result.claimed, true);
    await gcMedia('hello-media', { op: 'claim', id }).expect(200);
    assert.equal(db().prepare('SELECT ref_count FROM plugin_media WHERE id = ?').get(id).ref_count, 1);
    r = await gcMedia('hello-media', { op: 'usage' }).expect(200);
    assert.deepEqual(Object.keys(r.body.result).sort(), ['bytes', 'count', 'maxBytes', 'quota', 'types']);
    assert.equal(r.body.result.maxBytes, 512 * 1024);
    assert.equal(r.body.result.count, media.usage('hello-media').count);
    assert.equal((await gcMedia('hello-media', { op: 'info', id: 'f'.repeat(32) }).expect(200)).body.result, null);
  });

  it('refusals: bad ids, unknown ids for claim/url, bad ttl, no media declared', async () => {
    const code = async (id2, body) => (await gcMedia(id2, body).expect(400)).body.code;
    assert.equal(await code('hello-media', { op: 'info', id: 'x' }), 'ERR_INVALID');
    assert.equal(await code('hello-media', { op: 'claim', id: 'f'.repeat(32) }), 'ERR_INVALID');
    assert.equal(await code('hello-media', { op: 'url', id: 'f'.repeat(32) }), 'ERR_INVALID');
    assert.equal(await code('hello-media', { op: 'url', id, opts: { ttlS: 10 } }), 'ERR_INVALID');
    assert.equal(await code('hello-media', { op: 'url', id, opts: { user: 'x' } }), 'ERR_INVALID');
    assert.equal(await code('hello-plain', { op: 'info', id }), 'ERR_MEDIA_DENIED');
    assert.equal(await code('hello-plain', { op: 'usage' }), 'ERR_MEDIA_DENIED');
    // another plugin's file does not exist for this one
    assert.equal(media.row('hello-plain', id), null);
  });

  it('url → /plugin-media/<token>: served without a session, Range, signed and bounded in time', async () => {
    const r = await gcMedia('hello-media', { op: 'url', id, opts: { user: anna, ttlS: 600 } }).expect(200);
    const url = r.body.result;
    assert.match(url, new RegExp(`^/plugin-media/${id}\\.\\d+\\.${anna}\\.[A-Za-z0-9_-]{22}$`));
    const exp = Number(url.split('.')[1]);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(exp > now + 590 && exp <= now + 600 + 300 && exp % 300 === 0, 'rounded up to 5 minutes');
    assert.equal((await gcMedia('hello-media', { op: 'url', id, opts: { user: anna, ttlS: 600 } })).body.result, url, 'the same URL again (cache)');
    const f = await supertest(app).get(url).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    assert.equal(f.body.length, 3000);
    assert.equal(f.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.equal(f.headers['content-security-policy'], "default-src 'none'; sandbox");
    assert.match(f.headers['cache-control'], /^private, max-age=\d+, immutable$/);
    const part = await supertest(app).get(url).set('Range', 'bytes=0-99').expect(206);
    assert.equal(part.headers['content-range'], 'bytes 0-99/3000');
    const tampered = url.slice(0, -1) + (url.endsWith('A') ? 'B' : 'A');
    await supertest(app).get(tampered).expect(404);
    await supertest(app).get(url.replace(`.${anna}.`, `.${ben}.`)).expect(404);
    const old = media.url('hello-media', id, { user: anna, ttlS: 60, now: Date.now() - 3600 * 1000 });
    await supertest(app).get(old).expect(404);
    const farFuture = media.url('hello-media', id, { ttlS: 60, now: Date.now() + 3 * 86400 * 1000 });
    await supertest(app).get(farFuture).expect(404);
    const forged = media.url('hello-plain', id, { ttlS: 600 });
    await supertest(app).get(forged).expect(404);
    await supertest(app).get('/plugin-media/garbage').expect(404);
  });

  it('delete removes row and file', async () => {
    const file = media.fileOf('hello-media', id);
    assert.ok(fs.existsSync(file));
    assert.equal((await gcMedia('hello-media', { op: 'delete', id }).expect(200)).body.result, true);
    assert.equal((await gcMedia('hello-media', { op: 'delete', id }).expect(200)).body.result, false);
    assert.equal(fs.existsSync(file), false);
    assert.equal((await gcMedia('hello-media', { op: 'info', id }).expect(200)).body.result, null);
  });
});

describe('clean-up, frames, backup, uninstall', () => {
  it('cleanup(): unclaimed files older than 24 h and stale upload leftovers go, claimed files stay', async () => {
    const a = (await put(annaDev, 'hello-media', randomBytes(100)).expect(200)).body.mediaId;
    const b = (await put(annaDev, 'hello-media', randomBytes(100)).expect(200)).body.mediaId;
    const c = (await put(annaDev, 'hello-media', randomBytes(100)).expect(200)).body.mediaId;
    await gcMedia('hello-media', { op: 'claim', id: b }).expect(200);
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    db().prepare('UPDATE plugin_media SET created_at = ? WHERE id IN (?, ?)').run(old, a, b);
    const tmp = path.join(process.env.GC_DATA_DIR, 'plugin-media', 'hello-media', '.tmp-stale');
    fs.writeFileSync(tmp, 'x');
    fs.utimesSync(tmp, new Date(Date.now() - 2 * 3600 * 1000), new Date(Date.now() - 2 * 3600 * 1000));
    const n = media.cleanup();
    assert.ok(n >= 2);
    assert.equal(media.row('hello-media', a), null);
    assert.equal(fs.existsSync(media.fileOf('hello-media', a)), false);
    assert.ok(media.row('hello-media', b), 'claimed');
    assert.ok(media.row('hello-media', c), 'young');
    assert.equal(fs.existsSync(tmp), false);
  });

  it('frames of a media plugin: img-src and media-src for /plugin-media/, the iframe may use the microphone', async () => {
    const fr = await agent.get('/plugins/hello-media/frame/main').expect(200);
    const csp = fr.headers['content-security-policy'];
    assert.match(csp, /img-src data: http:\/\/127\.0\.0\.1:\d+\/avatars\/ http:\/\/127\.0\.0\.1:\d+\/plugin-media\/;/);
    assert.match(csp, /media-src http:\/\/127\.0\.0\.1:\d+\/plugin-media\/;/);
    const plain = (await agent.get('/plugins/hello-plain/frame/main').expect(200)).headers['content-security-policy'];
    assert.doesNotMatch(plain, /media-src|plugin-media/);
    const page = (await agent.get('/plugins/hello-media').expect(200)).text;
    assert.match(page, /<iframe class="pg-frame"[^>]*allow="microphone \*"[^>]*data-plugin-events/);
    assert.doesNotMatch((await agent.get('/plugins/hello-plain').expect(200)).text, /allow="microphone/);
    const portal = (await agent.get('/portal').expect(200)).text;
    assert.match(portal, /src="\/portal\/plugins\/hello-media\/frame"[^>]*allow="microphone \*"[^>]*data-plugin-events/);
    assert.match(portal, /src="\/portal\/plugins\/hello-plain\/frame" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" loading="lazy"\s+data-plugin-frame data-plugin-id="hello-plain" data-plugin-api="\/api\/v1\/portal\/plugins\/hello-plain\/api\/" data-plugin-pages="\[\]"><\/iframe>/);
    const fc = (await agent.get('/portal/plugins/hello-media/frame').expect(200)).headers['content-security-policy'];
    assert.match(fc, /media-src http:\/\/127\.0\.0\.1:\d+\/plugin-media\//);
  });

  it('backup: off by default (no media); on → the claimed files travel encrypted with their key as a backup secret; restore brings them back', async () => {
    const pbackup = require('../src/services/plugins/backup');
    let entry = pbackup.exportAll().find((e) => e.id === 'hello-media');
    assert.equal(entry.media, undefined, 'option off');
    let r = await agent.get(API).expect(200);
    assert.equal(r.body.backupMedia, false);
    await agent.put(API + '/policy').set('X-CSRF-Token', csrf).send({ backupMedia: 'yes' }).expect(400);
    r = await agent.put(API + '/policy').set('X-CSRF-Token', csrf).send({ backupMedia: true }).expect(200);
    assert.equal(r.body.backupMedia, true);
    assert.equal(r.body.allowUnsigned, false, 'the other switch untouched');
    assert.ok(db().prepare("SELECT 1 FROM activity_log WHERE event_type = 'plugin_media_backup'").get());
    const id = (await put(annaDev, 'hello-media', randomBytes(70000)).expect(200)).body.mediaId;
    await gcMedia('hello-media', { op: 'claim', id }).expect(200);
    entry = pbackup.exportAll().find((e) => e.id === 'hello-media');
    const f = entry.media.find((x) => x.id === id);
    assert.ok(f && /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/.test(f.key), 'the key in the backup secret form');
    assert.equal(Buffer.from(f.data, 'base64').length, media.sealedSize(70000));
    assert.ok(entry.media.every((x) => db().prepare('SELECT ref_count FROM plugin_media WHERE id = ?').get(x.id).ref_count === 1), 'claimed files only');
    assert.deepEqual(pbackup.validate([entry]), []);
    assert.deepEqual(pbackup.validate([{ id: 'x-y', media: 'nope' }]), ['Plugin "x-y": invalid media']);
    const before0 = fs.readFileSync(media.fileOf('hello-media', id));
    const sha = media.row('hello-media', id).sha256;
    media.remove('hello-media', id);
    assert.equal(media.importPlugin('hello-media', [f, { id: 'bad' }, { ...f, id: 'e'.repeat(32), data: 'AAAA' }]), 1);
    assert.equal(media.row('hello-media', id).sha256, sha);
    assert.equal(Buffer.compare(fs.readFileSync(media.fileOf('hello-media', id)), before0), 0);
    await kv('hello-media', 'media-access', true);
    const back = await get(annaDev, 'hello-media', id).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    assert.equal(crypto.createHash('sha256').update(back.body).digest('hex'), sha);
    // the restore's decrypt check knows the media keys
    const bk = require('../src/services/backup');
    const full = bk.createBackup();
    assert.ok(full.data.plugins.find((e) => e.id === 'hello-media').media.length >= 1);
    assert.deepEqual(bk.validateBackup(full), []);
    full.data.plugins.find((e) => e.id === 'hello-media').media[0].key = '00'.repeat(12) + ':' + '00'.repeat(16) + ':abcd';
    await assert.rejects(async () => bk.restoreBackup(full), /plugin "hello-media" media #1: cannot decrypt/, 'refused before anything is replaced');
    await agent.put(API + '/policy').set('X-CSRF-Token', csrf).send({ backupMedia: false }).expect(200);
  });

  it('uninstall "Alles löschen" removes the media, "Daten behalten" keeps them', async () => {
    await install(helloPackage({ overrides: mediaOverrides('hello-gone') }));
    assert.equal(await runtime.waitRunning('hello-gone'), true);
    const id = (await put(annaDev, 'hello-gone', randomBytes(100)).expect(200)).body.mediaId;
    await agent.post(`${API}/hello-gone/uninstall`).set('X-CSRF-Token', csrf).send({ mode: 'keep' }).expect(200);
    assert.ok(media.row('hello-gone', id), 'kept');
    await install(helloPackage({ overrides: mediaOverrides('hello-gone') }));
    await agent.post(`${API}/hello-gone/uninstall`).set('X-CSRF-Token', csrf).send({ mode: 'wipe', confirm: 'Hallo Medien' }).expect(200);
    assert.equal(media.row('hello-gone', id), null);
    assert.equal(fs.existsSync(path.join(process.env.GC_DATA_DIR, 'plugin-media', 'hello-gone')), false);
  });
});
