'use strict';

// GateDrop host APIs (docs/plugins.md, since 1.193.0):
//   * media.maxBytes up to 2 GB, families in media.types ("image/*"),
//     media.resumable (PUT …/media?uploadId&offset + Content-Range, HEAD/GET
//     …/media/uploads/<id>), media.handOverMaxBytes;
//   * permissions.publicLinks + the administrator's switch, gc.publicLinks.*,
//     the public routes /s/<token>[/unlock|/f/<n>|/zip] (PIN, expiry,
//     downloads, revocation, ZIP), hook publicLinkEvent;
//   * permissions.devices: gc.devices.list, user.device on app requests,
//     gc.notify devices / silent (kind 'data');
//   * gc.media.handOver between plugins;
//   * gc.net.uploadTarget (target.upload): multipart streamed to a home target;
//   * the request deadline of bodies (middleware/requestDeadline.js).

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const supertest = require('supertest');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');
const PUI = require('../public/js/plugins-ui.js');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

let app, agent, csrf, runtime, plugins, manifest, media, links, hostApi, netPolicy, config, savedBase;
let anna, annaDev, annaPc, ben, benDev, inspected;
const API = '/api/v1/plugins';
const CLIENT = '/api/v1/client/plugins';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const GB = 1024 ** 3;
const CHUNK = 64 * 1024;

const DROP = {
  id: 'gd-drop', name: { de: 'GateDrop', en: 'GateDrop' },
  permissions: { ...clone(helloManifest.permissions), app: true, publicLinks: true, devices: true, services: ['gd-msg:send_file'] },
  notifyTopics: [{ id: 'received', label: { de: 'Empfangen', en: 'Received' } }],
  media: { maxBytes: 2 * GB, types: ['image/*', 'application/*', 'text/plain'], quotaDefault: '10GB', resumable: true },
};
const MSG = {
  id: 'gd-msg', name: 'Messenger',
  permissions: { ...clone(helloManifest.permissions), app: true },
  services: { provides: { send_file: { label: 'Datei senden' } } },
  media: { maxBytes: 64 * 1024, types: ['image/png', 'application/pdf'], quotaDefault: '10MB', handOverMaxBytes: 1024 * 1024 },
};
const PLAIN = {
  id: 'gd-plain', name: 'Ohne',
  permissions: { ...clone(helloManifest.permissions), app: true },
  media: { maxBytes: 512 * 1024, types: ['application/pdf'], quotaDefault: '10MB' },
};

async function install(overrides) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(helloPackage({ overrides })).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  return r.body;
}
/** a gc function of a plugin by its dotted path (fixture route /gc) */
const gcCall = (plugin, fn, ...args) => agent.post(`${API}/${plugin}/api/gc`).set('X-CSRF-Token', csrf).send({ fn, args });
const kv = (id, key, value) => agent.post(`${API}/${id}/api/kv`).set('X-CSRF-Token', csrf).send({ key, value }).expect(200);
const kvGet = async (id, key) => (await agent.get(`${API}/${id}/api/kv`).query({ key }).expect(200)).body.value;
const put = (dev, plugin, buf, type = 'application/pdf') => supertest(app).put(`${CLIENT}/${plugin}/media`).set('X-API-Token', dev.raw).set('Content-Type', type).send(buf);
const binary = (res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };
const db = () => H.db();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Upload + claim a file of `plugin` (owner `dev`'s user) → media id. */
async function storedFile(plugin, dev, buf, type = 'application/pdf') {
  const r = await put(dev, plugin, buf, type).expect(200);
  await gcCall(plugin, 'media.claim', r.body.mediaId).expect(200);
  return r.body.mediaId;
}

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  manifest = require('../src/services/plugins/manifest');
  media = require('../src/services/plugins/media');
  links = require('../src/services/plugins/publicLinks');
  hostApi = require('../src/services/plugins/hostApi');
  netPolicy = require('../src/services/plugins/netPolicy');
  config = require('../config/default');
  savedBase = config.app.baseUrl;
  config.app.baseUrl = 'https://gc.home-test.net';
  anna = H.makeUser('gd-anna');
  ben = H.makeUser('gd-ben');
  annaDev = H.makeDevice(anna, { name: 'gd-anna-phone', platform: 'android' });
  annaPc = H.makeDevice(anna, { name: 'gd-anna-pc', platform: 'windows' });
  benDev = H.makeDevice(ben, { name: 'gd-ben-phone' });
  inspected = await install(DROP);
  await install(MSG);
  await install(PLAIN);
  for (const id of ['gd-drop', 'gd-msg', 'gd-plain']) assert.equal(await runtime.waitRunning(id), true, id);
});
after(async () => {
  config.app.baseUrl = savedBase;
  netPolicy._setTestPrivateForTest(null);
  await plugins.stop();
  teardown();
});

// ─── plugin.json ────────────────────────────────

describe('plugin.json (1.193.0)', () => {
  const base = () => clone(helloManifest);
  const check = (mediaDecl, perms) => { const m = base(); if (mediaDecl) m.media = mediaDecl; if (perms) Object.assign(m.permissions, perms); return manifest.validate(m); };

  it('media: maxBytes up to 2 GB, families, resumable, handOverMaxBytes', () => {
    const r = check({ maxBytes: 2 * GB, types: ['video/*', 'IMAGE/*', 'text/plain'], quotaDefault: '10GB', resumable: true, handOverMaxBytes: GB });
    assert.equal(r.ok, true, r.errors.join(', '));
    assert.deepEqual(r.manifest.media, { maxBytes: 2 * GB, types: ['video/*', 'image/*', 'text/plain'], quotaDefault: 10 * GB, uploads: true, resumable: true, handOverMaxBytes: GB });
    assert.equal(check({ maxBytes: 4096, types: ['image/png'] }).manifest.media.handOverMaxBytes, 4096, 'default: maxBytes');
    const errs = (d) => check(d).errors;
    assert.deepEqual(errs({ maxBytes: 2 * GB + 1, types: ['image/png'], quotaDefault: '10GB' }), ['media.maxBytes: invalid']);
    for (const types of [['text/*'], ['*/*'], ['image/x*'], ['multipart/*']]) assert.deepEqual(errs({ maxBytes: 4096, types }), ['media.types: invalid'], JSON.stringify(types));
    assert.deepEqual(errs({ maxBytes: 4096, types: ['image/png'], resumable: 'yes' }), ['media.resumable: invalid']);
    for (const h of [100, 3 * GB, '1MB']) assert.deepEqual(errs({ maxBytes: 4096, types: ['image/png'], handOverMaxBytes: h }), ['media.handOverMaxBytes: invalid'], String(h));
    assert.deepEqual(errs({ maxBytes: 4096, types: ['image/png'], quotaDefault: '1MB', handOverMaxBytes: 2 * 1024 * 1024 }), ['media.handOverMaxBytes: invalid'], 'above the quota');
  });

  it('a family never admits the denied types', () => {
    const fam = ['image/*', 'application/*', 'video/*'];
    for (const t of ['image/png', 'image/heic', 'application/zip', 'application/vnd.android.package-archive', 'video/mp4']) assert.equal(manifest.typeAllowed(fam, t), true, t);
    for (const t of ['image/svg+xml', 'application/json', 'application/xhtml+xml', 'application/javascript', 'application/ld+json', 'text/plain', 'audio/ogg', '', 'image/']) {
      assert.equal(manifest.typeAllowed(fam, t), false, t);
    }
  });

  it('permissions.publicLinks / devices: booleans, shown in the install dialog (public links sensitive)', () => {
    let r = check(null, { publicLinks: true, devices: true });
    assert.equal(r.ok, true);
    assert.equal(r.manifest.permissions.publicLinks, true);
    assert.equal(r.manifest.permissions.devices, true);
    r = check(null, {});
    assert.deepEqual([r.manifest.permissions.publicLinks, r.manifest.permissions.devices], [false, false]);
    assert.deepEqual(check(null, { publicLinks: 'yes' }).errors, ['permissions.publicLinks: invalid']);
    assert.deepEqual(check(null, { devices: 1 }).errors, ['permissions.devices: invalid']);
    const perm = inspected.plugin.permissions;
    assert.deepEqual([perm.publicLinks, perm.devices], [true, true]);
    const t = (k, p) => { let s = de[k] || k; for (const [a, b] of Object.entries(p || {})) s = s.split('{{' + a + '}}').join(String(b)); return s; };
    const rows = Object.fromEntries(PUI.permRows(perm, t).map((x) => [x.label, x.value]));
    assert.equal(rows['Öffentliche Links'], de['plugins.perm.public_links_on']);
    assert.equal(rows['Geräte'], de['plugins.perm.devices_on']);
    assert.ok(PUI.sensitivePerms(perm).includes('plugins.perm.public_links'));
    assert.match(rows.Medien, /image\/\*/);
    for (const k of Object.keys(de).filter((x) => x.startsWith('public_link.') || x.startsWith('plugins.pl.') || x.startsWith('plugins.perm.public') || x.startsWith('plugins.perm.devices'))) {
      assert.ok(en[k], 'en ' + k);
    }
  });
});

// ─── Resumable uploads ──────────────────────────

describe('resumable uploads', () => {
  const total = 3 * CHUNK + 1234;
  let file;
  before(() => { file = crypto.randomBytes(total); });
  const part = (dev, plugin, uploadId, start, end, opts = {}) => supertest(app).put(`${CLIENT}/${plugin}/media`)
    .query({ uploadId, offset: start }).set('X-API-Token', dev.raw).set('Content-Type', opts.type || 'application/pdf')
    .set('Content-Range', `bytes ${start}-${end}/${opts.total || total}`).send(file.subarray(start, end + 1));
  const status = (dev, plugin, uploadId) => supertest(app).get(`${CLIENT}/${plugin}/media/uploads/${uploadId}`).set('X-API-Token', dev.raw);

  it('parts in order → the whole file, encrypted, unclaimed, of the uploader', async () => {
    let r = await part(annaDev, 'gd-drop', 'up-aaaaaaaa', 0, 2 * CHUNK - 1).expect(200);
    assert.deepEqual(r.body, { ok: true, complete: false, uploadId: 'up-aaaaaaaa', offset: 2 * CHUNK, total });
    r = await status(annaDev, 'gd-drop', 'up-aaaaaaaa').expect(200);
    assert.deepEqual(r.body, { ok: true, uploadId: 'up-aaaaaaaa', offset: 2 * CHUNK, total, mime: 'application/pdf' });
    assert.equal(r.headers['upload-offset'], String(2 * CHUNK));
    const head = await supertest(app).head(`${CLIENT}/gd-drop/media/uploads/up-aaaaaaaa`).set('X-API-Token', annaDev.raw).expect(200);
    assert.equal(head.headers['upload-offset'], String(2 * CHUNK));
    assert.equal(head.headers['upload-length'], String(total));
    // another person never sees (or continues) it
    await status(benDev, 'gd-drop', 'up-aaaaaaaa').expect(404);
    r = await part(benDev, 'gd-drop', 'up-aaaaaaaa', 2 * CHUNK, total - 1).expect(409);
    assert.deepEqual(r.body, { ok: false, code: 'offset_mismatch', offset: 0 });
    // a wrong offset says where to go on
    r = await part(annaDev, 'gd-drop', 'up-aaaaaaaa', CHUNK, total - 1).expect(409);
    assert.deepEqual(r.body, { ok: false, code: 'offset_mismatch', offset: 2 * CHUNK });
    r = await part(annaDev, 'gd-drop', 'up-aaaaaaaa', 2 * CHUNK, total - 1).expect(200);
    assert.equal(r.body.complete, true);
    assert.equal(r.body.bytes, total);
    const row = db().prepare('SELECT * FROM plugin_media WHERE id = ?').get(r.body.mediaId);
    assert.deepEqual([row.plugin, row.owner_user_id, row.ref_count, row.mime, row.bytes], ['gd-drop', anna, 0, 'application/pdf', total]);
    assert.equal(row.sha256, crypto.createHash('sha256').update(file).digest('hex'));
    const disk = fs.readFileSync(media.fileOf('gd-drop', row.id));
    assert.equal(disk.length, media.sealedSize(total));
    assert.equal(disk.includes(file.subarray(100, 164)), false, 'no plaintext on disk');
    const back = [];
    for await (const p of media.readRange(row, 0, total - 1)) back.push(p);
    assert.ok(Buffer.concat(back).equals(file));
    await status(annaDev, 'gd-drop', 'up-aaaaaaaa').expect(404);
  });

  it('an aborted part keeps its whole chunks; the rest continues from the offset', async (t) => {
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    // send 1.5 chunks of a 3-chunk part, then cut the connection
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'PUT', path: `${CLIENT}/gd-drop/media?uploadId=up-bbbbbbbb&offset=0`,
        headers: { 'X-API-Token': annaDev.raw, 'Content-Type': 'application/pdf', 'Content-Length': String(3 * CHUNK), 'Content-Range': `bytes 0-${3 * CHUNK - 1}/${total}` } });
      req.on('error', () => resolve());
      req.on('response', () => resolve());
      req.write(file.subarray(0, CHUNK + CHUNK / 2), () => setTimeout(() => { req.destroy(); resolve(); }, 300));
    });
    await sleep(200);
    const r = await status(annaDev, 'gd-drop', 'up-bbbbbbbb').expect(200);
    assert.equal(r.body.offset, CHUNK, 'the half chunk is dropped');
    const done = await part(annaDev, 'gd-drop', 'up-bbbbbbbb', CHUNK, total - 1).expect(200);
    assert.equal(done.body.complete, true);
    assert.equal(db().prepare('SELECT sha256 FROM plugin_media WHERE id = ?').get(done.body.mediaId).sha256, crypto.createHash('sha256').update(file).digest('hex'));
  });

  it('refusals: not resumable, bad id / range, type, size, another type mid-way', async () => {
    let r = await part(annaDev, 'gd-plain', 'up-cccccccc', 0, CHUNK - 1).expect(400);
    assert.equal(r.body.code, 'not_resumable');
    r = await part(annaDev, 'gd-drop', 'bad id', 0, CHUNK - 1).expect(400);
    assert.equal(r.body.code, 'invalid_upload_id');
    r = await supertest(app).put(`${CLIENT}/gd-drop/media`).query({ uploadId: 'up-cccccccc' }).set('X-API-Token', annaDev.raw)
      .set('Content-Type', 'application/pdf').send(file.subarray(0, 10)).expect(400);
    assert.equal(r.body.code, 'range_required');
    r = await supertest(app).put(`${CLIENT}/gd-drop/media`).query({ uploadId: 'up-cccccccc' }).set('X-API-Token', annaDev.raw)
      .set('Content-Type', 'application/pdf').set('Content-Range', `bytes 0-19/${total}`).send(file.subarray(0, 10)).expect(400);
    assert.equal(r.body.code, 'invalid_range');
    r = await part(annaDev, 'gd-drop', 'up-cccccccc', 0, CHUNK - 1, { type: 'image/svg+xml' }).expect(415);
    r = await part(annaDev, 'gd-drop', 'up-cccccccc', 0, CHUNK - 1, { total: 2 * GB + 1 }).expect(413);
    await part(annaDev, 'gd-drop', 'up-cccccccc', 0, CHUNK - 1).expect(200);
    r = await part(annaDev, 'gd-drop', 'up-cccccccc', CHUNK, 2 * CHUNK - 1, { type: 'image/png' }).expect(409);
    assert.deepEqual(r.body, { ok: false, code: 'upload_mismatch', offset: CHUNK });
  });

  it('left for 24 h → removed by the clean-up', async () => {
    await part(annaDev, 'gd-drop', 'up-dddddddd', 0, CHUNK - 1).expect(200);
    const n = media.cleanup(Date.now() + media.UPLOAD_TTL_MS + 1000);
    assert.ok(n >= 1);
    await status(annaDev, 'gd-drop', 'up-dddddddd').expect(404);
  });

  it('a plain upload of a family type still works (whole body)', async () => {
    const r = await put(annaDev, 'gd-drop', crypto.randomBytes(5000), 'application/zip').expect(200);
    assert.equal(r.body.mime, 'application/zip');
    await put(annaDev, 'gd-drop', crypto.randomBytes(50), 'application/json').expect(415);
  });
});

// ─── Public links ───────────────────────────────

/** Parse a ZIP (stored entries) → [{ name, data }], checking CRCs and the directory. */
function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, 'end record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header');
    const flags = buf.readUInt16LE(p + 8);
    assert.equal(flags & 0x0808, 0x0808, 'descriptor + UTF-8');
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    assert.equal(buf.readUInt32LE(off), 0x04034b50, 'local header');
    const lnl = buf.readUInt16LE(off + 26);
    const data = buf.subarray(off + 30 + lnl, off + 30 + lnl + size);
    assert.equal(zlib.crc32(data), crc, 'crc ' + name);
    assert.equal(buf.readUInt32LE(off + 30 + lnl + size), 0x08074b50, 'data descriptor');
    out.push({ name, data });
    p += 46 + nlen + xlen;
  }
  return out;
}

describe('public links', () => {
  let a;
  let b;
  let fileA;
  let fileB;
  const day = 24 * 3600 * 1000;
  const create = (opts) => gcCall('gd-drop', 'publicLinks.create', { ownerUserId: anna, title: 'Urlaubsfotos', files: [{ mediaId: a, name: 'Strand.pdf' }], expiresAt: Date.now() + day, ...opts });
  const allow = (on) => agent.put(`${API}/gd-drop/public-links`).set('X-CSRF-Token', csrf).send({ allowed: on }).expect(200);
  const pub = () => supertest(app);
  const tokenOf = (url) => url.split('/s/')[1];

  // the tests send more than the per-address budget of the public routes in a minute
  beforeEach(() => {
    const { publicLinkLimiter } = require('../src/middleware/rateLimit');
    for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) publicLinkLimiter.resetKey(`public-link:${require('express-rate-limit').ipKeyGenerator(ip)}`);
  });

  before(async () => {
    fileA = crypto.randomBytes(CHUNK + 777);
    fileB = crypto.randomBytes(3000);
    a = await storedFile('gd-drop', annaDev, fileA);
    b = await storedFile('gd-drop', annaDev, fileB);
  });

  it('off by default: ERR_PUBLIC_LINKS_DISABLED until the administrator allows them; the switch is per plugin', async () => {
    let r = await create().expect(400);
    assert.equal(r.body.code, 'ERR_PUBLIC_LINKS_DISABLED');
    r = await agent.get(`${API}/gd-drop/public-links`).expect(200);
    assert.deepEqual(r.body.publicLinks, { allowed: false, unlimited: false, publicUrl: 'https://gc.home-test.net', active: 0 });
    await agent.get(`${API}/gd-plain/public-links`).expect(404);
    await agent.put(`${API}/gd-plain/public-links`).set('X-CSRF-Token', csrf).send({ allowed: true }).expect(400);
    await agent.put(`${API}/gd-drop/public-links`).set('X-CSRF-Token', csrf).send({ allowed: 'yes' }).expect(400);
    r = await allow(true);
    assert.equal(r.body.publicLinks.allowed, true);
    const act = db().prepare("SELECT * FROM activity_log WHERE event_type = 'plugin_public_links' ORDER BY id DESC LIMIT 1").get();
    assert.ok(act && /allowed/.test(act.message));
    r = await gcCall('gd-plain', 'publicLinks.list', {}).expect(400);
    assert.equal(r.body.code, 'ERR_PUBLIC_LINKS_DISABLED', 'without the permission');
  });

  it('needs a public https URL (ERR_NO_PUBLIC_URL) and checks every argument', async () => {
    for (const bad of ['http://gc.home-test.net', 'https://localhost:3000', 'https://10.0.0.5', 'https://gc.lan', 'not a url']) {
      config.app.baseUrl = bad;
      assert.equal((await create().expect(400)).body.code, 'ERR_NO_PUBLIC_URL', bad);
    }
    config.app.baseUrl = 'https://gc.home-test.net';
    const code = async (o) => (await create(o).expect(400)).body.code;
    assert.equal(await code({ ownerUserId: 999999 }), 'ERR_INVALID');
    assert.equal(await code({ title: 'x'.repeat(121) }), 'ERR_INVALID');
    assert.equal(await code({ note: 'x'.repeat(501) }), 'ERR_INVALID');
    assert.equal(await code({ expiresAt: Date.now() + 31 * day }), 'ERR_INVALID');
    assert.equal(await code({ expiresAt: Date.now() - 1000 }), 'ERR_INVALID');
    assert.equal(await code({ pin: '12' }), 'ERR_INVALID');
    assert.equal(await code({ pin: 1234 }), 'ERR_INVALID');
    assert.equal(await code({ maxDownloads: 0 }), 'ERR_INVALID');
    assert.equal(await code({ files: [] }), 'ERR_INVALID');
    assert.equal(await code({ files: new Array(21).fill({ mediaId: a }) }), 'ERR_INVALID');
    const unclaimed = (await put(annaDev, 'gd-drop', crypto.randomBytes(100)).expect(200)).body.mediaId;
    let r = await create({ files: [{ mediaId: unclaimed }] }).expect(400);
    assert.match(r.body.error, /claimed/);
    const foreign = await storedFile('gd-plain', annaDev, crypto.randomBytes(100));
    r = await create({ files: [{ mediaId: foreign }] }).expect(400);
    assert.match(r.body.error, /unknown media/, "another plugin's file");
  });

  it('create → { token, url }; the page, a file (Range, UTF-8 name), the ZIP; counters, hook, list / get', async () => {
    await kv('gd-drop', 'public-link-events', []);
    const r = await create({ files: [{ mediaId: a, name: 'Strand Ä.pdf' }, { mediaId: b, name: '../../etc/passwd' }], note: 'Viel Spaß!\nAnna' }).expect(200);
    const { token, url, expiresAt } = r.body.result;
    assert.match(token, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(url, `https://gc.home-test.net/s/${token}`);
    assert.ok(expiresAt > Date.now());
    const row = db().prepare('SELECT * FROM plugin_public_links WHERE plugin = ? ORDER BY created_at DESC LIMIT 1').get('gd-drop');
    assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
    assert.ok(!JSON.stringify(row).includes(token), 'the token is not stored in clear');

    let p = await pub().get(`/s/${token}`).set('Accept-Language', 'de-DE,de;q=0.9').expect(200);
    assert.match(p.text, /Urlaubsfotos/);
    assert.match(p.text, /Geteilt von gd-anna/);
    assert.match(p.text, /Strand Ä\.pdf/);
    assert.match(p.text, /passwd/);
    assert.ok(!p.text.includes('../'), 'names are cleaned');
    assert.match(p.text, /Viel Spaß!/);
    assert.match(p.text, /Alle als ZIP/);
    assert.ok(!/<script/i.test(p.text), 'no scripts');
    assert.equal(p.headers['cache-control'], 'no-store');
    assert.equal(p.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
    assert.equal(p.headers['referrer-policy'], 'no-referrer');
    assert.match(p.headers['content-security-policy'], /default-src 'none'.*frame-ancestors 'none'/);
    assert.ok(!/script-src/.test(p.headers['content-security-policy']));
    p = await pub().get(`/s/${token}`).set('Accept-Language', 'en-US').expect(200);
    assert.match(p.text, /Shared by gd-anna/);
    assert.match(p.text, /Download all as ZIP/);

    let f = await pub().get(`/s/${token}/f/1`).buffer(true).parse(binary).expect(200);
    assert.ok(f.body.equals(fileA));
    assert.equal(f.headers['content-disposition'], `attachment; filename="Strand _.pdf"; filename*=UTF-8''Strand%20%C3%84.pdf`);
    assert.equal(f.headers['x-content-type-options'], 'nosniff');
    assert.equal(f.headers['cache-control'], 'no-store');
    // the counted download hands out the resume cookie of that file; with it a Range is a free continuation
    const resume = f.headers['set-cookie'][0].split(';')[0];
    assert.match(f.headers['set-cookie'][0], new RegExp(`^gc_pr=\\d+\\.[A-Za-z0-9_-]{43}; Path=/s/${token}/f/1; Max-Age=21600; HttpOnly; SameSite=Lax; Secure$`));
    f = await pub().get(`/s/${token}/f/1`).set('Cookie', resume).set('Range', `bytes=${CHUNK - 10}-${CHUNK + 9}`).buffer(true).parse(binary).expect(206);
    assert.equal(f.headers['set-cookie'], undefined, 'a continuation is not counted');
    assert.ok(f.body.equals(fileA.subarray(CHUNK - 10, CHUNK + 10)));
    await pub().get(`/s/${token}/f/3`).expect(404);
    await pub().get(`/s/${token}/f/0`).expect(404);
    await pub().get(`/s/${token}/f/..%2f1`).expect(404);
    await sleep(300); // the plugin records the hook events one after the other

    const z = await pub().get(`/s/${token}/zip`).buffer(true).parse(binary).expect(200);
    assert.equal(z.headers['content-type'], 'application/zip');
    assert.equal(Number(z.headers['content-length']), z.body.length, 'exact length');
    assert.match(z.headers['content-disposition'], /^attachment; filename="Urlaubsfotos\.zip"/);
    const entries = unzip(z.body);
    assert.deepEqual(entries.map((e) => e.name), ['Strand Ä.pdf', 'passwd']);
    assert.ok(entries[0].data.equals(fileA) && entries[1].data.equals(fileB));

    await sleep(300);
    const events = await kvGet('gd-drop', 'public-link-events');
    assert.deepEqual(events.map((e) => [e.token, e.event, e.zip, e.file && e.file.id]), [[token, 'download', false, '1'], [token, 'download', true, null]], 'the Range from the middle is not counted');
    const got = (await gcCall('gd-drop', 'publicLinks.get', token).expect(200)).body.result;
    assert.equal(got.state, 'active');
    assert.equal(got.downloads, 3);
    assert.deepEqual(got.files.map((x) => [x.id, x.mediaId, x.name, x.downloads]), [['1', a, 'Strand Ä.pdf', 2], ['2', b, 'passwd', 1]]);
    assert.deepEqual([got.pin, got.title, got.note, got.ownerUserId, got.url], [false, 'Urlaubsfotos', 'Viel Spaß!\nAnna', anna, url]);
    const list = (await gcCall('gd-drop', 'publicLinks.list', { ownerUserId: anna }).expect(200)).body.result;
    assert.ok(list.some((x) => x.token === token));
    assert.deepEqual((await gcCall('gd-drop', 'publicLinks.list', { ownerUserId: ben }).expect(200)).body.result, []);
    assert.equal((await gcCall('gd-plain', 'publicLinks.get', token).expect(400)).body.code, 'ERR_PUBLIC_LINKS_DISABLED');
  });

  it('unknown tokens: 404 everywhere, the same page for every kind of miss', async () => {
    const miss = await pub().get(`/s/${'A'.repeat(24)}`).expect(404);
    assert.match(miss.text, /Link nicht gefunden|Link not found/);
    await pub().get('/s/short').expect(404);
    await pub().get(`/s/${'A'.repeat(24)}/f/1`).expect(404);
    await pub().get(`/s/${'A'.repeat(24)}/zip`).expect(404);
    await pub().post(`/s/${'A'.repeat(24)}/unlock`).send({ pin: '1234' }).expect(404);
  });

  it('maxDownloads per file: a new download after the last one → 410; only the downloading client resumes', async () => {
    const { token } = (await create({ maxDownloads: 1, files: [{ mediaId: a }, { mediaId: b }] }).expect(200)).body.result;
    const first = await pub().get(`/s/${token}/f/1`).expect(200);
    const resume = first.headers['set-cookie'][0].split(';')[0];
    await pub().get(`/s/${token}/f/1`).expect(410);
    await pub().get(`/s/${token}/f/1`).set('Cookie', resume).expect(410); // from 0 always counts, cookie or not
    // the downloading client resumes (any later start, within 6 h)…
    let r = await pub().get(`/s/${token}/f/1`).set('Cookie', resume).set('Range', 'bytes=100-').buffer(true).parse(binary).expect(206);
    assert.ok(r.body.equals(fileA.subarray(100)));
    await pub().get(`/s/${token}/f/1`).set('Cookie', resume).set('Range', 'bytes=1-').expect(206);
    // …a fresh client with the URL does not, nor with another file's or a forged cookie
    await pub().get(`/s/${token}/f/1`).set('Range', 'bytes=1-').expect(410);
    await pub().get(`/s/${token}/f/1`).set('Range', 'bytes=100-200').expect(410);
    const linkRow = db().prepare('SELECT * FROM plugin_public_links WHERE token_hash = ?').get(links.hashToken(token));
    const other = links.resumeCookie(linkRow, token, { idx: 2 }).split(';')[0];
    await pub().get(`/s/${token}/f/1`).set('Cookie', other).set('Range', 'bytes=1-').expect(410); // file 2's cookie does not open file 1
    await pub().get(`/s/${token}/f/1`).set('Cookie', resume.replace(/.$/, (x) => (x === 'A' ? 'B' : 'A'))).set('Range', 'bytes=1-').expect(410);
    const expired = (() => { const [n, v] = resume.split('='); const [, sig] = v.split('.'); return `${n}=1.${sig}`; })();
    await pub().get(`/s/${token}/f/1`).set('Cookie', expired).set('Range', 'bytes=1-').expect(410);
    assert.equal(db().prepare('SELECT downloads FROM plugin_public_link_files WHERE token_hash = ? AND idx = 1').get(links.hashToken(token)).downloads, 1);
    // the resume window ends after 6 h
    const realNow = Date.now;
    Date.now = () => realNow() + links.RESUME_WINDOW_MS + 60000;
    try { await pub().get(`/s/${token}/f/1`).set('Cookie', resume).set('Range', 'bytes=1-').expect(410); } finally { Date.now = realNow; }
    // file 2 is still there: a Range request of a fresh client is a new, counted download
    r = await pub().get(`/s/${token}/f/2`).set('Range', 'bytes=1-').expect(206);
    assert.match(r.headers['set-cookie'][0], new RegExp(`^gc_pr=.*; Path=/s/${token}/f/2;`));
    await pub().get(`/s/${token}/f/2`).set('Range', 'bytes=1-').expect(410);
    const page0 = await pub().get(`/s/${token}`).set('Accept-Language', 'de').expect(410);
    assert.match(page0.text, /Bereits heruntergeladen/);
  });

  it('maxDownloads 3: every download from 0 and every Range without the resume cookie counts, continuations do not', async () => {
    const { token } = (await create({ maxDownloads: 3, files: [{ mediaId: a }, { mediaId: b }] }).expect(200)).body.result;
    const count = () => db().prepare('SELECT idx, downloads FROM plugin_public_link_files WHERE token_hash = ? ORDER BY idx').all(links.hashToken(token)).map((x) => x.downloads);
    const one = await pub().get(`/s/${token}/f/1`).expect(200);
    const c1 = one.headers['set-cookie'][0].split(';')[0];
    await pub().get(`/s/${token}/f/1`).set('Cookie', c1).set('Range', 'bytes=10-').expect(206);
    await pub().get(`/s/${token}/f/1`).set('Cookie', c1).set('Range', 'bytes=20-').expect(206);
    assert.deepEqual(count(), [1, 0]);
    await pub().head(`/s/${token}/f/1`).expect(200);
    assert.deepEqual(count(), [1, 0], 'HEAD never counts');
    await pub().get(`/s/${token}/f/1`).set('Range', 'bytes=10-').expect(206);
    assert.deepEqual(count(), [2, 0], 'a Range of a fresh client counts');
    await pub().get(`/s/${token}/zip`).expect(200);
    assert.deepEqual(count(), [3, 1], 'the ZIP counts each file');
    await pub().get(`/s/${token}/zip`).expect(410);
    assert.deepEqual(count(), [3, 1], 'a refused ZIP counts nothing');
    await pub().get(`/s/${token}/f/1`).expect(410);
    await pub().get(`/s/${token}/f/1`).set('Cookie', c1).set('Range', 'bytes=30-').expect(206);
    await pub().get(`/s/${token}/f/2`).expect(200);
    await pub().get(`/s/${token}/f/2`).expect(200);
    await pub().get(`/s/${token}/f/2`).expect(410);
    assert.deepEqual(count(), [3, 3]);
    // parallel requests for the last download: exactly one wins
    const { token: t2 } = (await create({ maxDownloads: 1, files: [{ mediaId: b }] }).expect(200)).body.result;
    const res = await Promise.all([1, 2, 3, 4].map(() => pub().get(`/s/${t2}/f/1`)));
    assert.deepEqual(res.map((x) => x.status).sort(), [200, 410, 410, 410]);
  });

  it('maxDownloads 1 with two files: the ZIP and the single files share the budget', async () => {
    const { token } = (await create({ maxDownloads: 1, files: [{ mediaId: a }, { mediaId: b }] }).expect(200)).body.result;
    await pub().get(`/s/${token}/f/1`).expect(200);
    const page = await pub().get(`/s/${token}`).expect(200);
    assert.ok(!page.text.includes(`/s/${token}/zip`), 'no ZIP once a file is used up');
    await pub().get(`/s/${token}/zip`).expect(410);
    await pub().get(`/s/${token}/f/2`).expect(200);
    const ended = await pub().get(`/s/${token}`).set('Accept-Language', 'de').expect(410);
    assert.match(ended.text, /Bereits heruntergeladen/);
    const fresh = (await create({ maxDownloads: 1, files: [{ mediaId: a }] }).expect(200)).body.result.token;
    // a Range from the middle as the first request is that client's (counted) download — once
    await pub().get(`/s/${fresh}/f/1`).set('Range', 'bytes=100-').expect(206);
    await pub().get(`/s/${fresh}/f/1`).set('Range', 'bytes=100-').expect(410);
  });

  it('PIN: hashed, form first, cookie for that link only, 5 wrong PINs lock it (hook "locked")', async () => {
    await kv('gd-drop', 'public-link-events', []);
    const { token } = (await create({ pin: '4711', files: [{ mediaId: a, name: 'geheim.pdf' }] }).expect(200)).body.result;
    const row = db().prepare('SELECT pin_hash FROM plugin_public_links WHERE token_hash = ?').get(links.hashToken(token));
    assert.match(row.pin_hash, /^scrypt\$16384\$8\$1\$/);
    assert.ok(!row.pin_hash.includes('4711'));
    let p = await pub().get(`/s/${token}`).set('Accept-Language', 'de').expect(200);
    assert.match(p.text, /name="pin"/);
    assert.ok(!p.text.includes('geheim.pdf'), 'no file names before the PIN');
    await pub().get(`/s/${token}/f/1`).expect(403);
    await pub().get(`/s/${token}/zip`).expect(403);
    // a foreign Origin never tries PINs
    await pub().post(`/s/${token}/unlock`).set('Origin', 'https://evil.example').type('form').send({ pin: '4711' }).expect(403);
    p = await pub().post(`/s/${token}/unlock`).type('form').send({ pin: '0000' }).set('Accept-Language', 'de').expect(403);
    assert.match(p.text, /Falsche PIN\. Noch 4 Versuche/);
    let j = await pub().post(`/s/${token}/unlock`).set('Accept', 'application/json').send({ pin: '1111' }).expect(403);
    assert.deepEqual(j.body, { ok: false, code: 'wrong_pin', left: 3 });
    // right PIN: 303 back, a cookie for /s/<token> only
    p = await pub().post(`/s/${token}/unlock`).type('form').send({ pin: '4711' }).expect(303);
    assert.equal(p.headers.location, `/s/${token}`);
    const cookie = p.headers['set-cookie'][0];
    assert.match(cookie, new RegExp(`^gc_pl=\\d+\\.[A-Za-z0-9_-]{43}; Path=/s/${token}; Max-Age=3600; HttpOnly; SameSite=Lax; Secure$`));
    const c = cookie.split(';')[0];
    p = await pub().get(`/s/${token}`).set('Cookie', c).expect(200);
    assert.match(p.text, /geheim\.pdf/);
    await pub().get(`/s/${token}/f/1`).set('Cookie', c).expect(200);
    // the cookie of one link opens no other
    const other = (await create({ pin: '4711' }).expect(200)).body.result.token;
    await pub().get(`/s/${other}/f/1`).set('Cookie', c).expect(403);
    await pub().get(`/s/${token}/f/1`).set('Cookie', c.replace(/.$/, (x) => (x === 'A' ? 'B' : 'A'))).expect(403);
    // the failures were reset by the right PIN: five more wrong ones lock the link
    for (let i = 0; i < 4; i++) await pub().post(`/s/${token}/unlock`).set('Accept', 'application/json').send({ pin: '9999' }).expect(403);
    j = await pub().post(`/s/${token}/unlock`).set('Accept', 'application/json').send({ pin: '9999' }).expect(410);
    assert.deepEqual(j.body, { ok: false, code: 'locked' });
    await pub().get(`/s/${token}/f/1`).set('Cookie', c).expect(410);
    p = await pub().get(`/s/${token}`).set('Accept-Language', 'de').expect(410);
    assert.match(p.text, /Link gesperrt/);
    await pub().post(`/s/${token}/unlock`).type('form').send({ pin: '4711' }).expect(410);
    await sleep(300);
    const events = await kvGet('gd-drop', 'public-link-events');
    assert.ok(events.some((e) => e.token === token && e.event === 'locked'));
    assert.equal((await gcCall('gd-drop', 'publicLinks.get', token).expect(200)).body.result.state, 'locked');
  });

  it('revoke, deleting a file, expiry (hook "expired"), the switch off, the plugin gone', async () => {
    const t1 = (await create().expect(200)).body.result.token;
    assert.equal((await gcCall('gd-drop', 'publicLinks.revoke', t1).expect(200)).body.result, true);
    assert.equal((await gcCall('gd-drop', 'publicLinks.revoke', t1).expect(200)).body.result, false);
    await pub().get(`/s/${t1}`).expect(410);
    await pub().get(`/s/${t1}/f/1`).expect(410);

    const tmp = await storedFile('gd-drop', annaDev, crypto.randomBytes(500));
    const t2 = (await create({ files: [{ mediaId: tmp }] }).expect(200)).body.result.token;
    await pub().get(`/s/${t2}/f/1`).expect(200);
    await gcCall('gd-drop', 'media.delete', tmp).expect(200);
    await pub().get(`/s/${t2}/f/1`).expect(410);
    assert.equal((await gcCall('gd-drop', 'publicLinks.get', t2).expect(200)).body.result.state, 'revoked');

    await kv('gd-drop', 'public-link-events', []);
    const t3 = (await create().expect(200)).body.result.token;
    db().prepare('UPDATE plugin_public_links SET expires_at = ? WHERE token_hash = ?').run(new Date(Date.now() - 1000).toISOString(), links.hashToken(t3));
    const ended = await pub().get(`/s/${t3}`).set('Accept-Language', 'en').expect(410);
    assert.match(ended.text, /Link expired/);
    await pub().get(`/s/${t3}/zip`).expect(410);
    assert.ok(links.sweep().expired >= 1);
    await sleep(300);
    assert.ok((await kvGet('gd-drop', 'public-link-events')).some((e) => e.token === t3 && e.event === 'expired'));
    // ended for more than 30 days → gone
    links.sweep(Date.now() + 31 * day);
    assert.equal(db().prepare('SELECT COUNT(*) AS n FROM plugin_public_links WHERE token_hash = ?').get(links.hashToken(t3)).n, 0);

    const t4 = (await create().expect(200)).body.result.token;
    await allow(false);
    await pub().get(`/s/${t4}`).expect(404);
    await pub().get(`/s/${t4}/f/1`).expect(404);
    await allow(true);
    await pub().get(`/s/${t4}/f/1`).expect(200);
    links.removeAll('gd-drop'); // what uninstalling does (plugins/index.js removeInstalled)
    await pub().get(`/s/${t4}`).expect(404);
  });

  it('per-address rate limit on the public routes', async () => {
    let limited = false;
    for (let i = 0; i < 130 && !limited; i++) {
      const r = await pub().get(`/s/${'B'.repeat(24)}`);
      if (r.status === 429) limited = true;
    }
    assert.ok(limited);
  });
});

// ─── ZIP (units) ────────────────────────────────

describe('zip stream', () => {
  const { zipStream, zipLength, crc32 } = require('../src/services/plugins/zipStream');
  it('crc32 matches zlib; duplicate names get a number; ZIP64 records once offsets pass 4 GiB', async () => {
    const buf = crypto.randomBytes(1000);
    assert.equal(crc32(buf.subarray(500), crc32(buf.subarray(0, 500))), zlib.crc32(buf));
    const entries = [{ name: 'a.txt', size: 3, read: async function* r() { yield Buffer.from('abc'); } }, { name: 'a.txt', size: 1, read: async function* r() { yield Buffer.from('d'); } }];
    const parts = [];
    for await (const p of zipStream(entries)) parts.push(p);
    const z = Buffer.concat(parts);
    assert.equal(z.length, zipLength(entries));
    assert.deepEqual(unzip(z).map((e) => [e.name, e.data.toString()]), [['a.txt', 'abc'], ['a (2).txt', 'd']]);
    const big = (n) => ({ name: `f${n}.bin`, size: 2 * GB, read: null });
    const one = zipLength([big(1)]);
    const two = zipLength([big(1), big(2)]);
    const three = zipLength([big(1), big(2), big(3)]);
    // two entries: the directory lies beyond 4 GiB → the ZIP64 end records (+76)
    assert.equal(two - one, 30 + 6 + 2 * GB + 16 + 46 + 6 + 56 + 20);
    // three: the third local header lies beyond 4 GiB too → its central entry gets the ZIP64 extra field (+12)
    assert.equal(three - two, 30 + 6 + 2 * GB + 16 + 46 + 6 + 12);
  });
});

// ─── Devices ────────────────────────────────────

describe('devices', () => {
  it('gc.devices.list: the person\'s client apps, online from the push stream', async () => {
    const stream = require('../src/services/notify/stream');
    const conn = stream.add({ tokenId: annaPc.tokenId, userId: anna, via: 'direct', net: 'lan', res: { write: () => true, end: () => {}, once: () => {} }, connectedAt: new Date().toISOString() });
    try {
      const r = await gcCall('gd-drop', 'devices.list', { userId: anna }).expect(200);
      const list = r.body.result;
      assert.deepEqual(list.map((d) => d.id).sort(), [String(annaDev.tokenId), String(annaPc.tokenId)].sort());
      const pc = list.find((d) => d.id === String(annaPc.tokenId));
      const phone = list.find((d) => d.id === String(annaDev.tokenId));
      assert.deepEqual(Object.keys(pc).sort(), ['appVersion', 'clientType', 'id', 'lastSeen', 'name', 'online', 'platform', 'via']);
      assert.deepEqual([pc.platform, pc.online, pc.via], ['windows', true, 'lan']);
      assert.deepEqual([phone.platform, phone.online, phone.via], ['android', false, null]);
    } finally { stream.close(conn, 'test'); }
    // an admin / automation token of the person is no device
    const adminTok = H.makeDevice(anna, { name: 'gd-anna-admin', scopes: ['full-access'] });
    const ids = (await gcCall('gd-drop', 'devices.list', { userId: anna }).expect(200)).body.result.map((d) => d.id);
    assert.ok(!ids.includes(String(adminTok.tokenId)));
    const conn2 = require('../src/db/connection').getDb();
    // a Windows app set up with an all-access token: it identified itself on the push stream → a device
    const fullApp = H.makeDevice(anna, { name: 'gd-anna-surface', scopes: ['full-access'], platform: 'windows' });
    conn2.prepare("UPDATE notify_device_prefs SET client_type = 'pro', app_version = '1.38.0' WHERE token_id = ?").run(fullApp.tokenId);
    // an app token that never opened the push stream (notifications off) but registered its peer → a device
    const quiet = H.makeDevice(anna, { name: 'gd-anna-laptop', app: false });
    conn2.prepare("UPDATE peers SET client_platform = 'windows', client_product = 'community', client_seen_at = ? WHERE id = ?").run(new Date().toISOString(), quiet.peerId);
    // an app token nobody ever used → no device yet
    const unused = H.makeDevice(anna, { name: 'gd-anna-unused', app: false });
    const all = (await gcCall('gd-drop', 'devices.list', { userId: anna }).expect(200)).body.result;
    const byId = new Map(all.map((d) => [d.id, d]));
    assert.ok(byId.has(String(fullApp.tokenId)));
    assert.equal(byId.get(String(fullApp.tokenId)).platform, 'windows');
    assert.ok(byId.has(String(quiet.tokenId)));
    assert.deepEqual([byId.get(String(quiet.tokenId)).platform, byId.get(String(quiet.tokenId)).clientType, byId.get(String(quiet.tokenId)).online], ['windows', 'community', true]);
    assert.ok(!byId.has(String(unused.tokenId)));
    assert.ok(!byId.has(String(adminTok.tokenId)));
    for (const t of [fullApp, quiet, unused]) {
      conn2.prepare('DELETE FROM notify_device_prefs WHERE token_id = ?').run(t.tokenId);
      conn2.prepare('DELETE FROM api_tokens WHERE id = ?').run(t.tokenId);
    }
    assert.equal((await gcCall('gd-drop', 'devices.list', { userId: 999999 }).expect(400)).body.code, 'ERR_INVALID');
    assert.equal((await gcCall('gd-plain', 'devices.list', { userId: anna }).expect(400)).body.code, 'ERR_DEVICES_DENIED');
  });

  it('app requests carry user.device for plugins with permissions.devices only', async () => {
    let r = await supertest(app).get(`${CLIENT}/gd-drop/api/ping`).set('X-API-Token', annaPc.raw).set('X-Client-Platform', 'win32').expect(200);
    assert.deepEqual(r.body.user.device, { id: String(annaPc.tokenId), platform: 'windows' });
    r = await supertest(app).get(`${CLIENT}/gd-drop/api/ping`).set('X-API-Token', annaDev.raw).expect(200);
    assert.deepEqual(r.body.user.device, { id: String(annaDev.tokenId), platform: 'android' });
    r = await supertest(app).get(`${CLIENT}/gd-plain/api/ping`).set('X-API-Token', annaDev.raw).expect(200);
    assert.equal(r.body.user.device, undefined);
  });

  it('gc.notify devices: only those devices, which must belong to the listed users', async () => {
    H.clearNotifications();
    let r = await gcCall('gd-drop', 'notify', { topic: 'received', title: 'Neue Datei', users: [anna], devices: [String(annaPc.tokenId)] }).expect(200);
    assert.equal(r.body.result.pushed, true);
    assert.deepEqual(H.deliveries(r.body.result.id).map((d) => d.token_id), [annaPc.tokenId]);
    r = await gcCall('gd-drop', 'notify', { topic: 'received', title: 'x', users: [anna], devices: [benDev.tokenId] }).expect(400);
    assert.equal(r.body.code, 'ERR_INVALID');
    r = await gcCall('gd-drop', 'notify', { topic: 'received', title: 'x', devices: [annaPc.tokenId] }).expect(400);
    assert.equal(r.body.code, 'ERR_INVALID', 'devices need users');
    r = await gcCall('gd-drop', 'notify', { topic: 'received', title: 'x', users: [anna], devices: ['nope'] }).expect(400);
    assert.equal(r.body.code, 'ERR_INVALID');
  });

  it('gc.notify silent: a data push (kind data, silent), not in the inbox, no activity row, no title needed', async () => {
    H.clearNotifications();
    const store = require('../src/services/notify/store');
    const before = db().prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'plugin_notice'").get().n;
    const r = await gcCall('gd-drop', 'notify', { topic: 'received', silent: true, users: [anna], devices: [annaDev.tokenId], data: { gatedrop: { transfer: 't1' } } }).expect(200);
    assert.equal(r.body.result.pushed, true);
    const rows = H.deliveries(r.body.result.id);
    assert.deepEqual(rows.map((d) => d.token_id), [annaDev.tokenId]);
    const payload = store.payload(store.deliveryRow(rows[0].seq));
    assert.equal(payload.kind, 'data');
    assert.equal(payload.silent, true);
    assert.deepEqual(payload.data.gatedrop, { transfer: 't1' });
    assert.equal(store.inbox(annaDev.tokenId).some((x) => x.id === r.body.result.id), false);
    assert.equal(db().prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'plugin_notice'").get().n, before);
    assert.equal((await gcCall('gd-drop', 'notify', { topic: 'received', silent: 'yes', users: [anna] }).expect(400)).body.code, 'ERR_INVALID');
    assert.equal((await gcCall('gd-plain', 'notify', { title: 'x', silent: true, users: [anna] }).expect(400)).body.code, 'ERR_DEVICES_DENIED');
    // the administrator's history never shows a data push's data
    const d = require('../src/services/notify/admin').detail(r.body.result.id, (k) => k);
    assert.equal(d.notification.data, null);
    assert.equal(d.notification.body, '');
  });
});

// ─── Hand-over ──────────────────────────────────

describe('gc.media.handOver', () => {
  it('to a plugin whose service the caller may use: a new unclaimed file there, same bytes, same sealed file', async () => {
    const buf = crypto.randomBytes(200 * 1024);
    const id = await storedFile('gd-drop', annaDev, buf);
    const r = await gcCall('gd-drop', 'media.handOver', id, { toPlugin: 'gd-msg', user: anna }).expect(200);
    const out = r.body.result;
    assert.match(out.mediaId, /^[0-9a-f]{32}$/);
    assert.notEqual(out.mediaId, id);
    assert.deepEqual([out.mime, out.bytes], ['application/pdf', buf.length]);
    const row = db().prepare('SELECT * FROM plugin_media WHERE id = ?').get(out.mediaId);
    assert.deepEqual([row.plugin, row.owner_user_id, row.ref_count], ['gd-msg', anna, 0]);
    const back = [];
    for await (const p of media.readRange(row, 0, row.bytes - 1)) back.push(p);
    assert.ok(Buffer.concat(back).equals(buf));
    const st1 = fs.statSync(media.fileOf('gd-drop', id));
    const st2 = fs.statSync(media.fileOf('gd-msg', out.mediaId));
    assert.ok(st1.ino === st2.ino || st1.size === st2.size, 'hard link (or a copy)');
    // the source can go; the target keeps its file
    await gcCall('gd-drop', 'media.delete', id).expect(200);
    assert.ok(fs.existsSync(media.fileOf('gd-msg', out.mediaId)));
    const act = db().prepare("SELECT * FROM activity_log WHERE event_type = 'plugin_media_handover' ORDER BY id DESC LIMIT 1").get();
    assert.ok(act && /gd-msg/.test(act.message));
  });

  it('refusals: no service listed, type, size (handOverMaxBytes), unknown ids, itself', async () => {
    const pdf = await storedFile('gd-drop', annaDev, crypto.randomBytes(1000));
    const code = async (args, plugin = 'gd-drop') => (await gcCall(plugin, 'media.handOver', ...args).expect(400)).body.code;
    assert.equal(await code([pdf, { toPlugin: 'gd-plain' }]), 'ERR_SERVICES_DENIED');
    const own = await storedFile('gd-plain', annaDev, crypto.randomBytes(100));
    assert.equal(await code([own, { toPlugin: 'gd-msg' }], 'gd-plain'), 'ERR_SERVICES_DENIED');
    const zip = (await put(annaDev, 'gd-drop', crypto.randomBytes(100), 'application/zip').expect(200)).body.mediaId;
    assert.equal(await code([zip, { toPlugin: 'gd-msg' }]), 'ERR_MEDIA_TYPE');
    const huge = (await put(annaDev, 'gd-drop', crypto.randomBytes(1024 * 1024 + 1)).expect(200)).body.mediaId;
    assert.equal(await code([huge, { toPlugin: 'gd-msg' }]), 'ERR_MEDIA_TOO_LARGE');
    assert.equal(await code(['f'.repeat(32), { toPlugin: 'gd-msg' }]), 'ERR_INVALID');
    assert.equal(await code([pdf, { toPlugin: 'gd-nope' }]), 'ERR_SERVICE_UNAVAILABLE');
    assert.equal(await code([pdf, { toPlugin: 'gd-drop' }]), 'ERR_INVALID');
    assert.equal(await code([pdf, { toPlugin: 'gd-msg', user: 999999 }]), 'ERR_INVALID');
    // more than 64 KB is fine through the hand-over (handOverMaxBytes 1 MB) although maxBytes is 64 KB
    const mid = await storedFile('gd-drop', annaDev, crypto.randomBytes(100 * 1024));
    await gcCall('gd-drop', 'media.handOver', mid, { toPlugin: 'gd-msg' }).expect(200);
  });
});

// ─── Upload to a home target ────────────────────

describe('gc.net.uploadTarget (target.upload)', () => {
  let srv;
  let seen;
  let rid;
  before(async () => {
    seen = [];
    srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
        res.setHeader('content-type', 'application/json');
        res.end('{"success":true}');
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    netPolicy._setTestPrivateForTest(['127.0.0.1']);
    rid = Number(db().prepare("INSERT INTO routes (route_type, domain, target_ip, target_port, enabled) VALUES ('http', 'nas.home.example', '127.0.0.1', ?, 1)").run(srv.address().port).lastInsertRowid);
    for (const id of ['gd-drop', 'gd-msg']) await agent.put(`${API}/${id}/targets/gateway`).set('X-CSRF-Token', csrf).send({ assigned: [{ kind: 'route', routeId: rid }] }).expect(200);
  });
  after(() => { netPolicy._setTestPrivateForTest(null); srv.close(); });

  /** multipart body → { fields, file: { name, filename, type, data } } */
  function parseMultipart(h, body) {
    const boundary = /boundary=(.+)$/.exec(h['content-type'])[1];
    const out = { fields: {}, file: null };
    const sep = Buffer.from(`--${boundary}`);
    let i = body.indexOf(sep);
    while (i >= 0) {
      const next = body.indexOf(sep, i + sep.length);
      if (next < 0) break;
      const part = body.subarray(i + sep.length + 2, next - 2);
      const he = part.indexOf('\r\n\r\n');
      const head = part.subarray(0, he).toString('utf8');
      const data = part.subarray(he + 4);
      const name = /name="([^"]*)"/.exec(head)[1];
      const fn = /filename="([^"]*)"/.exec(head);
      if (fn) out.file = { name, filename: fn[1], type: /Content-Type: (.+)/.exec(head)[1].trim(), data };
      else out.fields[name] = data.toString('utf8');
      i = next;
    }
    return out;
  }

  it('streams the file as multipart/form-data, answer like fetchTarget', async () => {
    const buf = crypto.randomBytes(150 * 1024);
    const id = await storedFile('gd-drop', annaDev, buf);
    const r = await gcCall('gd-drop', 'net.uploadTarget', 'gateway', '/webapi/entry.cgi', {
      query: { api: 'SYNO.FileStation.Upload', version: 2 }, headers: { 'X-Test': 'yes', 'Content-Type': 'text/evil' },
      form: { fields: { path: '/home/Drop', create_parents: true, overwrite: 'false' }, file: { field: 'file', mediaId: id, name: 'Bericht "final" ü.pdf' } },
    }).expect(200);
    assert.equal(r.body.result.status, 200);
    assert.equal(r.body.result.body, '{"success":true}');
    const s = seen.pop();
    assert.equal(s.method, 'POST');
    assert.equal(s.url, '/webapi/entry.cgi?api=SYNO.FileStation.Upload&version=2');
    assert.equal(s.headers['x-test'], 'yes');
    assert.equal(Number(s.headers['content-length']), s.body.length);
    const m = parseMultipart(s.headers, s.body);
    assert.deepEqual(m.fields, { path: '/home/Drop', create_parents: 'true', overwrite: 'false' });
    assert.deepEqual([m.file.name, m.file.filename, m.file.type], ['file', 'Bericht %22final%22 ü.pdf', 'application/pdf']);
    assert.ok(m.file.data.equals(buf));
  });

  it('mediaFrom: a file of a plugin that may hand over to the caller; refusals', async () => {
    // gd-drop lists gd-msg:send_file → gd-msg may stream gd-drop's file
    const buf = crypto.randomBytes(3000);
    const id = await storedFile('gd-drop', annaDev, buf);
    await gcCall('gd-msg', 'net.uploadTarget', 'gateway', '/up', { form: { file: { field: 'f' } }, mediaFrom: { plugin: 'gd-drop', mediaId: id } }).expect(200);
    assert.ok(parseMultipart(seen.at(-1).headers, seen.at(-1).body).file.data.equals(buf));
    // gd-msg lists nothing of gd-drop: the other way is refused
    const own = await storedFile('gd-msg', annaDev, crypto.randomBytes(100), 'image/png');
    let r = await gcCall('gd-drop', 'net.uploadTarget', 'gateway', '/up', { form: { file: { field: 'f' } }, mediaFrom: { plugin: 'gd-msg', mediaId: own } }).expect(400);
    assert.equal(r.body.code, 'ERR_MEDIA_DENIED');
    r = await gcCall('gd-drop', 'net.uploadTarget', 'gateway', '/up', { form: { file: { field: 'f', mediaId: own } } }).expect(400);
    assert.match(r.body.error, /unknown media/, "another plugin's id without mediaFrom");
    r = await gcCall('gd-drop', 'net.uploadTarget', 'gateway', '//evil.example/x', { form: { file: { field: 'f', mediaId: id } } }).expect(400);
    assert.match(r.body.error, /leaves the target/);
    r = await gcCall('gd-drop', 'net.uploadTarget', 'device', '/up', { form: { file: { field: 'f', mediaId: id } } }).expect(400);
    assert.equal(r.body.code, 'ERR_NET_DENIED');
    r = await gcCall('gd-drop', 'net.uploadTarget', 'gateway', '/up', { form: { file: { field: 'bad"name', mediaId: id } } }).expect(400);
    assert.equal(r.body.code, 'ERR_INVALID');
    r = await gcCall('gd-drop', 'net.uploadTarget', 'gateway', '/up', { method: 'DELETE', form: { file: { field: 'f', mediaId: id } } }).expect(400);
    assert.equal(r.body.code, 'ERR_INVALID');
    assert.equal(hostApi.callTimeout('target.upload', { opts: { timeoutMs: 20 * 60 * 1000 } }), 20 * 60 * 1000 + 5000);
    assert.equal(hostApi.callTimeout('target.upload', { opts: { timeoutMs: 99 * 60 * 1000 } }), 30 * 60 * 1000 + 5000);
  });
});

// ─── Request deadline ───────────────────────────

describe('request deadline', () => {
  const rd = require('../src/middleware/requestDeadline');
  it('media uploads are the long route; other bodies still end after the deadline', async (t) => {
    const isUp = (method, p) => rd.isMediaUpload({ method, path: p });
    assert.equal(isUp('PUT', '/api/v1/client/plugins/gd-drop/media'), true);
    assert.equal(isUp('PUT', '/api/v1/portal/plugins/gd-drop/media'), true);
    assert.equal(isUp('PUT', '/api/v1/plugins/gd-drop/media'), true);
    assert.equal(isUp('POST', '/api/v1/client/plugins/gd-drop/media'), false);
    assert.equal(isUp('PUT', '/api/v1/client/plugins/gd-drop/media/x'), false);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => { rd._bodyDeadlineMs = null; server.close(); });
    rd._bodyDeadlineMs = 300;
    const closed = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/api/v1/plugins/gd-drop/api/ping',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '100' } });
      const timer = setTimeout(() => { req.destroy(); resolve(false); }, 3000);
      req.on('error', () => { clearTimeout(timer); resolve(true); });
      req.on('response', (res) => { clearTimeout(timer); res.resume(); resolve(res.statusCode >= 400 ? 'answered' : false); });
      req.write('{"a":');
    });
    assert.ok(closed === true || closed === 'answered', 'a body that never ends is cut');
  });
});
