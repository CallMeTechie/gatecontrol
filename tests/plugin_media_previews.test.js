'use strict';

// Previews of plugin media (docs/plugins.md "Previews", plugin.json
// `media.previews`, src/services/plugins/mediaPreviews.js): the server's
// previews of pictures (upright by EXIF, JPEG, two sizes, made on request and
// in the background after a claim, sealed on disk, gone with the file), the
// device's preview of a file the server cannot read (HEIC, video), the apps'
// endpoint and the frames' /plugin-media/<token>/preview, gc.media.previews.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const sharp = require('sharp');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');

let app, agent, csrf, runtime, plugins, manifest, media, previews, anna, annaDev, ben, benDev;
const API = '/api/v1/plugins';
const CLIENT = '/api/v1/client/plugins';
const PID = 'hello-previews';
const PLAIN = 'hello-nopreviews';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const MEDIA = { maxBytes: 20 * 1024 * 1024, types: ['image/*', 'video/mp4', 'application/pdf'], quotaDefault: '1GB', previews: true };

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  return r.body;
}
const kv = (id, key, value) => agent.post(`${API}/${id}/api/kv`).set('X-CSRF-Token', csrf).send({ key, value }).expect(200);
const gc = async (plugin, fn, ...args) => (await agent.post(`${API}/${plugin}/api/gc`).set('X-CSRF-Token', csrf).send({ fn, args })).body;
const binary = (r) => r.buffer(true).parse((res, cb) => {
  const parts = [];
  res.on('data', (c) => parts.push(c));
  res.on('end', () => {
    const buf = Buffer.concat(parts);
    if (!/json/.test(String(res.headers['content-type']))) return cb(null, buf);
    try { return cb(null, JSON.parse(buf.toString('utf8'))); } catch (e) { return cb(e); }
  });
});
const upload = async (dev, buf, type, plugin = PID) => (await supertest(app).put(`${CLIENT}/${plugin}/media`).set('X-API-Token', dev.raw)
  .set('Content-Type', type).send(buf).expect(200)).body.mediaId;
const preview = (dev, id, size, plugin = PID) => binary(supertest(app).get(`${CLIENT}/${plugin}/media/${id}/preview${size ? `?size=${size}` : ''}`).set('X-API-Token', dev.raw));
const putPreview = (dev, id, buf, type = 'image/jpeg') => supertest(app).put(`${CLIENT}/${PID}/media/${id}/preview`).set('X-API-Token', dev.raw).set('Content-Type', type).send(buf);
const filesOf = (id, plugin = PID) => ['.ps', '.pl', '.pc', '.px'].filter((s) => fs.existsSync(media.fileOf(plugin, id) + s));

/** A picture of w × h (JPEG unless `format`), optionally with an EXIF orientation. */
function picture(w, h, { format = 'jpeg', orientation = null, color = { r: 200, g: 40, b: 40 } } = {}) {
  let s = sharp({ create: { width: w, height: h, channels: 3, background: color } });
  if (orientation) s = s.withMetadata({ orientation });
  return s.toFormat(format).toBuffer();
}

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  manifest = require('../src/services/plugins/manifest');
  media = require('../src/services/plugins/media');
  previews = require('../src/services/plugins/mediaPreviews');
  anna = H.makeUser('previews-anna');
  ben = H.makeUser('previews-ben');
  annaDev = H.makeDevice(anna, { name: 'previews-anna-phone' });
  benDev = H.makeDevice(ben, { name: 'previews-ben-phone' });
  const perms = { ...clone(helloManifest.permissions), app: true };
  const inspected = await install(helloPackage({ overrides: { id: PID, name: { de: 'Hallo Vorschau', en: 'Hello previews' }, permissions: perms, media: MEDIA } }));
  assert.equal(inspected.plugin.permissions.media.previews, true, 'the install dialog names the previews');
  const plainMedia = { ...MEDIA };
  delete plainMedia.previews;
  await install(helloPackage({ overrides: { id: PLAIN, name: { de: 'Ohne Vorschau', en: 'No previews' }, permissions: perms, media: plainMedia } }));
  for (const id of [PID, PLAIN]) assert.equal(await runtime.waitRunning(id), true, id);
  // the uploader reads; ben only where the hook says so
  await kv(PID, 'media-access', [anna]);
  await kv(PLAIN, 'media-access', [anna]);
});
after(async () => {
  previews._waitMs = null;
  await previews.idle();
  await plugins.stop();
  teardown();
});

describe('plugin.json media.previews', () => {
  const check = (decl) => { const m = clone(helloManifest); m.media = decl; return manifest.validate(m); };
  it('is a boolean, kept only when true', () => {
    assert.equal(check({ maxBytes: 4096, types: ['image/png'], previews: true }).manifest.media.previews, true);
    assert.equal('previews' in check({ maxBytes: 4096, types: ['image/png'], previews: false }).manifest.media, false);
    assert.equal('previews' in check({ maxBytes: 4096, types: ['image/png'] }).manifest.media, false);
    for (const previews of ['yes', 1, null]) assert.deepEqual(check({ maxBytes: 4096, types: ['image/png'], previews }).errors, ['media.previews: invalid'], String(previews));
  });
});

describe('server previews (apps)', () => {
  it('a photo: small and large JPEG, upright by its EXIF orientation, no metadata, cached for good', async () => {
    // 600 × 400 stored with orientation 6 (turn 90° right): upright it is 400 × 600
    const id = await upload(annaDev, await picture(600, 400, { orientation: 6 }), 'image/jpeg');
    const r = await preview(annaDev, id).expect(200);
    assert.equal(r.headers['content-type'], 'image/jpeg');
    assert.equal(r.headers['cache-control'], 'private, max-age=31536000, immutable');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.ok(r.headers.etag);
    let meta = await sharp(r.body).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.deepEqual([meta.width, meta.height], [213, 320]);
    assert.equal(meta.orientation, undefined, 'no EXIF left');
    meta = await sharp((await preview(annaDev, id, 'large').expect(200)).body).metadata();
    assert.deepEqual([meta.width, meta.height], [400, 600], 'never enlarged');
    assert.equal((await preview(annaDev, id, 'huge').expect(400)).body.code, 'invalid_size');
    assert.equal((await supertest(app).head(`${CLIENT}/${PID}/media/${id}/preview`).set('X-API-Token', annaDev.raw).expect(200)).headers['content-type'], 'image/jpeg');
    // sealed on disk, next to the file
    assert.deepEqual(filesOf(id), ['.ps', '.pl']);
    const onDisk = fs.readFileSync(media.fileOf(PID, id) + '.ps');
    assert.equal(onDisk.subarray(0, 4).toString('latin1'), 'GCP1');
    assert.equal(onDisk.indexOf(Buffer.from([0xff, 0xd8, 0xff])), -1, 'not a plain JPEG');
  });

  it('PNG with transparency, WebP and GIF; the largest side fits 320 / 1280', async () => {
    const png = await sharp({ create: { width: 3000, height: 1500, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    for (const [buf, type] of [[png, 'image/png'], [await picture(500, 500, { format: 'webp' }), 'image/webp'], [await picture(64, 32, { format: 'gif' }), 'image/gif']]) {
      const id = await upload(annaDev, buf, type);
      const small = await sharp((await preview(annaDev, id).expect(200)).body).metadata();
      const large = await sharp((await preview(annaDev, id, 'large').expect(200)).body).metadata();
      assert.ok(Math.max(small.width, small.height) <= 320 && Math.max(large.width, large.height) <= 1280, type);
      if (type === 'image/png') {
        assert.deepEqual([small.width, small.height, large.width, large.height], [320, 160, 1280, 640]);
        const px = await sharp((await preview(annaDev, id).expect(200)).body).raw().toBuffer();
        assert.ok(px[0] > 240 && px[1] > 240 && px[2] > 240, 'transparency on white');
      }
    }
  });

  it('the same access as the file: the hook, else 404; HEIC, videos and documents have none of the server', async () => {
    const id = await upload(annaDev, await picture(100, 100), 'image/jpeg');
    assert.equal((await preview(benDev, id).expect(404)).body.code, 'not_found');
    await kv(PID, 'media-access', [anna, ben]);
    await preview(benDev, id).expect(200);
    await kv(PID, 'media-access', [anna]);
    for (const type of ['image/heic', 'video/mp4', 'application/pdf']) {
      const other = await upload(annaDev, crypto.randomBytes(2048), type);
      assert.equal((await preview(annaDev, other).expect(404)).body.code, 'not_found', type);
      assert.deepEqual(filesOf(other), [], type);
    }
    assert.equal((await preview(annaDev, 'f'.repeat(32)).expect(404)).body.code, 'not_found');
  });

  it('a plugin without media.previews has none', async () => {
    const id = await upload(annaDev, await picture(100, 100), 'image/jpeg', PLAIN);
    await preview(annaDev, id, null, PLAIN).expect(404);
    assert.equal((await gc(PLAIN, 'media.previews', [id])).code, 'ERR_MEDIA_DENIED');
    assert.equal((await gc(PLAIN, 'media.usage')).result.previews, false);
    assert.equal((await gc(PID, 'media.usage')).result.previews, true);
  });

  it('bytes that are no picture of an allowed kind (whatever the type says) are marked and never tried again', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100"/></svg>');
    for (const buf of [svg, crypto.randomBytes(4096), await picture(50, 50, { format: 'tiff' })]) {
      const id = await upload(annaDev, buf, 'image/png');
      assert.equal((await preview(annaDev, id).expect(404)).body.code, 'not_found');
      assert.deepEqual(filesOf(id), ['.px']);
      assert.equal((await gc(PID, 'media.previews', [id])).result[id], null);
    }
  });

  it('while it is being made: 503 preview_pending with Retry-After; then 200', async () => {
    const id = await upload(annaDev, await picture(2400, 1800), 'image/jpeg');
    previews._waitMs = 1;
    try {
      const r = await preview(annaDev, id).expect(503);
      assert.equal(r.body.code, 'preview_pending');
      assert.equal(r.headers['retry-after'], '3');
      assert.equal(r.headers['cache-control'], 'no-store');
    } finally { previews._waitMs = null; }
    await previews.idle();
    await preview(annaDev, id).expect(200);
  });

  it('made in the background once the plugin claims the file', async () => {
    const id = await upload(annaDev, await picture(800, 600), 'image/jpeg');
    assert.deepEqual(filesOf(id), []);
    assert.deepEqual((await gc(PID, 'media.previews', [id])).result[id].ready, false);
    assert.equal((await gc(PID, 'media.claim', id)).ok, true);
    await previews.idle();
    assert.deepEqual(filesOf(id), ['.ps', '.pl']);
    assert.equal((await gc(PID, 'media.previews', [id])).result[id].ready, true);
  });
});

describe('previews from the device (HEIC, video)', () => {
  it('the uploader sends a JPEG / WebP / PNG ≤ 512 KB; it is decoded and encoded again', async () => {
    const id = await upload(annaDev, crypto.randomBytes(4096), 'image/heic');
    assert.equal((await gc(PID, 'media.previews', [id])).result[id], null);
    const r = await putPreview(annaDev, id, await picture(1000, 750, { format: 'webp', orientation: 8 }), 'image/webp').expect(200);
    assert.deepEqual(r.body, { ok: true, ready: true, source: 'client' });
    assert.deepEqual(filesOf(id), ['.ps', '.pl', '.pc']);
    const small = await sharp((await preview(annaDev, id).expect(200)).body).metadata();
    assert.deepEqual([small.format, small.width, small.height], ['jpeg', 240, 320], 'upright, re-encoded');
    const st = (await gc(PID, 'media.previews', [id])).result[id];
    assert.equal(st.ready, true);
    assert.equal(st.source, 'client');
    // sending again replaces it
    await putPreview(annaDev, id, await picture(200, 200)).expect(200);
    assert.deepEqual((await sharp((await preview(annaDev, id, 'large').expect(200)).body).metadata()).width, 200);
    // a video too
    const video = await upload(annaDev, crypto.randomBytes(8192), 'video/mp4');
    await putPreview(annaDev, video, await picture(320, 180, { format: 'png' }), 'image/png').expect(200);
    await preview(annaDev, video).expect(200);
  });

  it('refusals: not the uploader, a picture the server reads itself, type, size, bytes', async () => {
    const id = await upload(annaDev, crypto.randomBytes(4096), 'video/mp4');
    const jpeg = await picture(100, 100);
    assert.equal((await putPreview(benDev, id, jpeg).expect(404)).body.code, 'not_found');
    assert.equal((await putPreview(annaDev, 'e'.repeat(32), jpeg).expect(404)).body.code, 'not_found');
    const photo = await upload(annaDev, jpeg, 'image/jpeg');
    assert.equal((await putPreview(annaDev, photo, jpeg).expect(409)).body.code, 'preview_by_server');
    assert.equal((await putPreview(annaDev, id, jpeg, 'image/gif').expect(415)).body.code, 'unsupported_type');
    assert.equal((await putPreview(annaDev, id, crypto.randomBytes(512 * 1024 + 1)).expect(413)).body.code, 'too_large');
    assert.equal((await putPreview(annaDev, id, crypto.randomBytes(2048)).expect(400)).body.code, 'invalid_image');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    assert.equal((await putPreview(annaDev, id, svg, 'image/png').expect(400)).body.code, 'invalid_image');
    const huge = await sharp({ create: { width: 4097, height: 4097, channels: 3, background: '#000' } }).png({ compressionLevel: 9 }).toBuffer();
    assert.ok(huge.length <= 512 * 1024);
    assert.equal((await putPreview(annaDev, id, huge, 'image/png').expect(400)).body.code, 'invalid_image', 'over 4096 × 4096');
    assert.deepEqual(filesOf(id), []);
    // a picture the server could not read takes the device's preview
    const odd = await upload(annaDev, crypto.randomBytes(4096), 'image/jpeg');
    await preview(annaDev, odd).expect(404);
    await putPreview(annaDev, odd, jpeg).expect(200);
    await preview(annaDev, odd).expect(200);
    assert.deepEqual(filesOf(odd), ['.ps', '.pl', '.pc']);
  });
});

describe('gc.media.previews and the frames', () => {
  it('states, signed frame URLs and the apps\' URL; bad arguments', async () => {
    const photo = await upload(annaDev, await picture(300, 200), 'image/jpeg');
    const doc = await upload(annaDev, crypto.randomBytes(1000), 'application/pdf');
    const r = await gc(PID, 'media.previews', [photo, doc, 'a'.repeat(32), photo], { user: anna, ttlS: 600 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(Object.keys(r.result).sort(), [photo, doc, 'a'.repeat(32)].sort());
    assert.equal(r.result[doc], null);
    assert.equal(r.result['a'.repeat(32)], null);
    const p = r.result[photo];
    assert.equal(p.ready, false);
    assert.equal(p.source, 'server');
    assert.equal(p.appUrl, `${CLIENT}/${PID}/media/${photo}/preview`);
    assert.match(p.url, new RegExp(`^/plugin-media/${photo}\\.\\d+\\.${anna}\\.[A-Za-z0-9_-]{22}/preview$`));
    // the frame loads it without a session
    const f = await binary(supertest(app).get(p.url)).expect(200);
    assert.equal(f.headers['content-type'], 'image/jpeg');
    assert.match(f.headers['cache-control'], /^private, max-age=\d+, immutable$/);
    assert.equal((await sharp((await binary(supertest(app).get(p.url + '?size=large')).expect(200)).body).metadata()).width, 300);
    await supertest(app).get(p.url.replace(/\.[A-Za-z0-9_-]{22}\/preview$/, '.AAAAAAAAAAAAAAAAAAAAAA/preview')).expect(404);
    await supertest(app).get(`/plugin-media/${photo}.1.0.AAAAAAAAAAAAAAAAAAAAAA/preview`).expect(404);
    // the frame URL of a file of a plugin without previews
    const plain = await upload(annaDev, await picture(50, 50), 'image/jpeg', PLAIN);
    const plainUrl = (await gc(PLAIN, 'media.url', plain)).result;
    await supertest(app).get(plainUrl).expect(200);
    await supertest(app).get(plainUrl + '/preview').expect(404);
    assert.deepEqual((await gc(PID, 'media.previews', 'nope')).result, {}, 'not a list: nothing');
    for (const args of [[[photo, 'x']], [new Array(1001).fill(photo)], [[photo], { user: -1 }], [[photo], { ttlS: 5 }]]) {
      assert.equal((await gc(PID, 'media.previews', ...args)).code, 'ERR_INVALID', JSON.stringify(args).slice(0, 80));
    }
  });

  it('previews go with their file: delete, the clean-up of unclaimed files, a hand-over links them', async () => {
    const id = await upload(annaDev, await picture(100, 100), 'image/jpeg');
    await preview(annaDev, id).expect(200);
    assert.deepEqual(filesOf(id), ['.ps', '.pl']);
    assert.equal((await gc(PID, 'media.delete', id)).result, true);
    assert.deepEqual(filesOf(id), []);

    const old = await upload(annaDev, crypto.randomBytes(4096), 'video/mp4');
    await putPreview(annaDev, old, await picture(100, 100)).expect(200);
    H.db().prepare('UPDATE plugin_media SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 25 * 3600 * 1000).toISOString(), old);
    media.cleanup();
    assert.deepEqual(filesOf(old), []);

    const src = await upload(annaDev, crypto.randomBytes(4096), 'video/mp4');
    await putPreview(annaDev, src, await picture(100, 100)).expect(200);
    const out = await media.handOver(plugins.get(PID), src, plugins.get(PLAIN), { owner: anna });
    assert.deepEqual(filesOf(out.mediaId, PLAIN), ['.ps', '.pl', '.pc']);
    // sealed under the same file key: readable under the new id
    const r = media.row(PLAIN, out.mediaId);
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(s) { this.code = s; return this; }, json(b) { this.body = b; return this; }, end(b) { this.body = b; return this; } };
    const pluginWithPreviews = { ...plugins.get(PLAIN), manifest: { ...plugins.get(PLAIN).manifest, media: { ...plugins.get(PLAIN).manifest.media, previews: true } } };
    await previews.send({ method: 'GET', query: {} }, res, pluginWithPreviews, r, 'private');
    assert.equal(res.code, 200);
    assert.equal((await sharp(res.body).metadata()).width, 100);
  });
});
