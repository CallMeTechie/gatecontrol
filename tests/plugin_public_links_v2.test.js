'use strict';

// Links v2 (docs/plugins.md "Public links", since 1.206.0): folder links
// (an area + path, always its current content: sub folders, gallery, view
// inline, download, ZIP of a folder), upload links (limits reserved
// atomically, types, the visitor's own uploads, conflict names, the hook),
// mode 'view' (nothing to download), links without an end (only while the
// administrator's second switch is on), the log with shortened addresses and
// gc.publicLinks.events / uploads.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const supertest = require('supertest');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');

let app, agent, csrf, runtime, plugins, links, config, savedBase, anna;
const API = '/api/v1/plugins';
const CLIENT = '/api/v1/client/plugins';
const PID = 'pl-drive';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const MB = 1024 * 1024;
const day = 24 * 3600 * 1000;

async function install(overrides) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(helloPackage({ overrides })).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}
const gcCall = (fn, ...args) => agent.post(`${API}/${PID}/api/gc`).set('X-CSRF-Token', csrf).send({ fn, args });
const gc = async (fn, ...args) => (await gcCall(fn, ...args)).body;
const kv = (key, value) => agent.post(`${API}/${PID}/api/kv`).set('X-CSRF-Token', csrf).send({ key, value }).expect(200);
const kvGet = async (key) => (await agent.get(`${API}/${PID}/api/kv`).query({ key }).expect(200)).body.value;
const binary = (res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };
const pub = () => supertest(app);
const tokenOf = (url) => url.split('/s/')[1];
const db = () => H.db();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setLinks = (body) => agent.put(`${API}/${PID}/public-links`).set('X-CSRF-Token', csrf).send(body).expect(200);
/** "name=value" of a Set-Cookie header of `res` (Secure cookies are not sent back over http by supertest's agent) */
const cookieOf = (res, name) => (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '='));

let dev;
/** a file of the plugin in area `area` under `p` → media id */
async function addFile(buf, area, p, type = 'application/octet-stream') {
  const r = await supertest(app).put(`${CLIENT}/${PID}/media`).set('X-API-Token', dev.raw).set('Content-Type', type).send(buf).expect(200);
  const c = await gc('media.claim', r.body.mediaId, { area, path: p });
  assert.equal(c.ok, true, JSON.stringify(c));
  return r.body.mediaId;
}
const create = async (opts) => {
  const r = await gc('publicLinks.create', { ownerUserId: anna, title: 'Fotos', expiresAt: Date.now() + day, ...opts });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.result;
};
const createCode = async (opts) => (await gc('publicLinks.create', { ownerUserId: anna, expiresAt: Date.now() + day, ...opts })).code;

/** Parse a ZIP (stored entries) → [{ name, data }]. */
function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, 'end record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnl = buf.readUInt16LE(off + 26);
    const data = buf.subarray(off + 30 + lnl, off + 30 + lnl + size);
    assert.equal(zlib.crc32(data), crc, 'crc ' + name);
    out.push({ name, data });
    p += 46 + nlen + xlen;
  }
  return out;
}

const files = {};
before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  links = require('../src/services/plugins/publicLinks');
  config = require('../config/default');
  savedBase = config.app.baseUrl;
  config.app.baseUrl = 'https://gc.home-test.net';
  anna = H.makeUser('pl-anna');
  dev = H.makeDevice(anna, { name: 'pl-anna-phone' });
  await install({
    id: PID, name: { de: 'Drive-Test', en: 'Drive test' },
    permissions: { ...clone(helloManifest.permissions), app: true, publicLinks: true },
    media: { maxBytes: 2 * MB, types: ['image/*', 'video/*', 'application/pdf', 'text/plain'], quotaDefault: '1GB', areas: true },
  });
  assert.equal(await runtime.waitRunning(PID), true);
  await gc('storage.set', 'media-access', true);
  await setLinks({ allowed: true });
  await gc('media.areas.ensure', 'docs', { label: 'Dokumente' });
  files.a = crypto.randomBytes(5000);
  files.b = crypto.randomBytes(3000);
  files.c = crypto.randomBytes(2000);
  files.r = crypto.randomBytes(1000);
  files.aId = await addFile(files.a, 'docs', 'Fotos/a.jpg', 'image/jpeg');
  files.bId = await addFile(files.b, 'docs', 'Fotos/Urlaub/b.png', 'image/png');
  files.cId = await addFile(files.c, 'docs', 'Fotos/c.pdf', 'application/pdf');
  files.rId = await addFile(files.r, 'docs', 'Rechnungen/r.pdf', 'application/pdf');
});
after(async () => {
  config.app.baseUrl = savedBase;
  await plugins.stop();
  teardown();
});

// the tests send more than the per-address budget of the public routes in a minute
beforeEach(() => {
  const rl = require('../src/middleware/rateLimit');
  const { ipKeyGenerator } = require('express-rate-limit');
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {
    rl.publicLinkLimiter.resetKey(`public-link:${ipKeyGenerator(ip)}`);
    rl.publicLinkMediaLimiter.resetKey(`public-link-media:${ipKeyGenerator(ip)}`);
    rl.publicLinkUploadLimiter.resetKey(`public-link-upload:${ipKeyGenerator(ip)}`);
  }
});

describe('creating v2 links', () => {
  it('checks kind, mode, the folder and the upload limits', async () => {
    assert.equal(await createCode({ kind: 'bogus', area: 'docs' }), 'ERR_INVALID');
    assert.equal(await createCode({ kind: 'folder', mode: 'stream', area: 'docs' }), 'ERR_INVALID');
    assert.equal(await createCode({ kind: 'folder' }), 'ERR_INVALID', 'no area');
    assert.equal(await createCode({ kind: 'folder', area: 'nope' }), 'ERR_INVALID', 'unknown area');
    assert.equal(await createCode({ kind: 'folder', area: 'docs', path: '../x' }), 'ERR_INVALID', 'path outside');
    assert.equal(await createCode({ kind: 'folder', area: 'docs', files: [{ mediaId: files.aId }] }), 'ERR_INVALID', 'files belong to kind files');
    assert.equal(await createCode({ kind: 'folder', area: 'docs', maxDownloads: 3 }), 'ERR_INVALID', 'maxDownloads only for kind files');
    assert.equal(await createCode({ kind: 'folder', area: 'docs', expiresAt: null }), 'ERR_INVALID', 'no end only with the switch');
    assert.equal(await createCode({ kind: 'upload', area: 'docs', maxFiles: 0 }), 'ERR_INVALID');
    assert.equal(await createCode({ kind: 'upload', area: 'docs', maxBytes: 1000 }), 'ERR_INVALID');
    assert.equal(await createCode({ kind: 'upload', area: 'docs', types: ['bad type'] }), 'ERR_INVALID');
    assert.equal(await createCode({ kind: 'upload', area: 'docs', types: [] }), 'ERR_INVALID');
    const l = await create({ kind: 'upload', area: 'docs', path: 'Eingang' });
    const got = (await gc('publicLinks.get', l.token)).result;
    assert.deepEqual([got.kind, got.mode, got.area, got.path], ['upload', 'download', 'docs', 'Eingang']);
    assert.deepEqual(got.upload, { maxFiles: 500, maxBytes: 5 * 1024 ** 3, types: null, files: 0, bytes: 0 });
    assert.deepEqual(got.files, []);
  });
});

describe('folder links', () => {
  let token, link;
  before(async () => {
    link = await create({ kind: 'folder', area: 'docs', path: 'Fotos', title: 'Urlaub 2026', note: 'Viel Spaß' });
    token = tokenOf(link.url);
    await kv('public-link-events', []);
  });

  it('the page: sub folders, the gallery, the other files — nothing outside the folder', async () => {
    const r = await pub().get(`/s/${token}`).set('Accept-Language', 'de').expect(200);
    assert.match(r.text, /Urlaub 2026/);
    assert.ok(r.text.includes(`/s/${token}?p=Urlaub`), 'the sub folder');
    assert.ok(r.text.includes(`/s/${token}/m/${files.aId}?view=1`), 'the picture inline');
    assert.ok(r.text.includes(`/s/${token}/m/${files.cId}`), 'the PDF');
    assert.ok(!r.text.includes(`/m/${files.cId}?view=1`), 'a PDF is no preview');
    assert.ok(!r.text.includes(files.rId) && !r.text.includes('Rechnungen'), 'outside the folder');
    assert.ok(!r.text.includes(files.bId), 'files of sub folders on their own page');
    assert.ok(r.text.includes(`/s/${token}/zip`), 'the folder as ZIP');
    assert.ok(cookieOf(r, links.VISITOR_COOKIE), 'a visitor id');
    const csp = r.headers['content-security-policy'];
    assert.ok(!/script-src/.test(csp), 'no scripts on a folder page');
    assert.match(csp, /media-src 'self'/);

    const sub = await pub().get(`/s/${token}`).query({ p: 'Urlaub' }).expect(200);
    assert.ok(sub.text.includes(`/m/${files.bId}?view=1`));
    assert.ok(!sub.text.includes(`/m/${files.aId}`));
    assert.ok(sub.text.includes(`/s/${token}/zip?p=Urlaub`));
    await pub().get(`/s/${token}`).query({ p: '../Rechnungen' }).expect(404);
  });

  it('always the current content: a file added later is listed', async () => {
    const id = await addFile(Buffer.from('neu'), 'docs', 'Fotos/neu.txt', 'text/plain');
    const r = await pub().get(`/s/${token}`).expect(200);
    assert.ok(r.text.includes(`/m/${id}`));
    assert.equal((await gc('media.delete', id)).ok, true);
    assert.ok(!(await pub().get(`/s/${token}`).expect(200)).text.includes(`/m/${id}`), 'gone again');
  });

  it('files: inline only for previews, downloads below the folder only', async () => {
    let r = await pub().get(`/s/${token}/m/${files.aId}`).query({ view: 1 }).buffer(true).parse(binary).expect(200);
    assert.ok(r.body.equals(files.a));
    assert.ok(!/attachment/.test(r.headers['content-disposition'] || ''), 'inline');
    await pub().get(`/s/${token}/m/${files.cId}`).query({ view: 1 }).expect(403);
    r = await pub().get(`/s/${token}/m/${files.cId}`).buffer(true).parse(binary).expect(200);
    assert.ok(r.body.equals(files.c));
    assert.match(r.headers['content-disposition'], /^attachment; filename="c\.pdf"/);
    r = await pub().get(`/s/${token}/m/${files.bId}`).set('Range', 'bytes=10-19').buffer(true).parse(binary).expect(206);
    assert.ok(r.body.equals(files.b.subarray(10, 20)), 'a continuation');
    await pub().get(`/s/${token}/m/${files.rId}`).expect(404);
    await pub().get(`/s/${token}/m/${'0'.repeat(32)}`).expect(404);
    await pub().get(`/s/${token}/m/nothex`).expect(404);
    await pub().get(`/s/${token}/f/1`).expect(404); // no numbered files
  });

  it('the ZIP of the folder and of a sub folder', async () => {
    let z = await pub().get(`/s/${token}/zip`).buffer(true).parse(binary).expect(200);
    assert.equal(Number(z.headers['content-length']), z.body.length);
    assert.match(z.headers['content-disposition'], /filename="Fotos\.zip"/);
    let e = unzip(z.body);
    assert.deepEqual(e.map((x) => x.name), ['Urlaub/b.png', 'a.jpg', 'c.pdf']);
    assert.ok(e[0].data.equals(files.b) && e[1].data.equals(files.a) && e[2].data.equals(files.c));
    z = await pub().get(`/s/${token}/zip`).query({ p: 'Urlaub' }).buffer(true).parse(binary).expect(200);
    assert.match(z.headers['content-disposition'], /filename="Urlaub\.zip"/);
    e = unzip(z.body);
    assert.deepEqual(e.map((x) => x.name), ['b.png']);
    await pub().get(`/s/${token}/zip`).query({ p: 'Leer' }).expect(404);
  });

  it('the log (shortened addresses), the counters and the hook', async () => {
    await sleep(300);
    const ev = (await gc('publicLinks.events', token)).result;
    const kinds = ev.map((x) => x.kind).reverse();
    assert.equal(kinds[0], 'open');
    assert.equal(kinds.filter((k) => k === 'open').length, 4, 'without the cookie every visit is a new visitor; the miss (404) is none');
    assert.deepEqual(kinds.filter((k) => k !== 'open'), ['download', 'zip', 'zip']);
    for (const x of ev) assert.ok(x.ip === '127.0.0.0' || x.ip === '0:0:0::', x.ip);
    const dl = ev.find((x) => x.kind === 'download');
    assert.deepEqual([dl.name, dl.mediaId, dl.bytes], ['c.pdf', files.cId, files.c.length]);
    const page = (await gc('publicLinks.events', token, { limit: 1 })).result;
    assert.equal(page.length, 1);
    const older = (await gc('publicLinks.events', token, { limit: 2, before: page[0].id })).result;
    assert.ok(older.every((x) => x.id < page[0].id));
    const got = (await gc('publicLinks.get', token)).result;
    assert.deepEqual([got.kind, got.mode, got.area, got.path, got.downloads, got.state], ['folder', 'download', 'docs', 'Fotos', 3, 'active']);
    assert.equal(got.opens, 4);
    const hook = await kvGet('public-link-events');
    assert.deepEqual(hook.map((h) => [h.event, h.zip, h.path]), [['download', false, 'Fotos/c.pdf'], ['download', true, 'Fotos'], ['download', true, 'Fotos/Urlaub']]);
  });

  it('a visitor with the cookie is logged once per hour', async () => {
    const l = await create({ kind: 'folder', area: 'docs', path: 'Fotos' });
    const t = tokenOf(l.url);
    const first = await pub().get(`/s/${t}`).expect(200);
    const c = cookieOf(first, links.VISITOR_COOKIE);
    await pub().get(`/s/${t}`).set('Cookie', c).expect(200);
    await pub().get(`/s/${t}`).set('Cookie', c).expect(200);
    const ev = (await gc('publicLinks.events', t)).result;
    assert.equal(ev.filter((x) => x.kind === 'open').length, 1);
    assert.equal(ev[0].visitor, c.split('=')[1]);
    assert.equal((await gc('publicLinks.get', t)).result.opens, 3);
  });

  it('with a PIN: nothing before the unlock', async () => {
    const l = await create({ kind: 'folder', area: 'docs', path: 'Fotos', pin: '4711' });
    const t = tokenOf(l.url);
    const p = await pub().get(`/s/${t}`).expect(200);
    assert.ok(!p.text.includes(files.aId), 'only the PIN form');
    await pub().get(`/s/${t}/m/${files.aId}`).query({ view: 1 }).expect(403);
    await pub().get(`/s/${t}/zip`).expect(403);
    await pub().post(`/s/${t}/unlock`).send({ pin: '0000' }).set('Accept', 'application/json').expect(403);
    const ok = await pub().post(`/s/${t}/unlock`).send({ pin: '4711' }).set('Accept', 'application/json').expect(200);
    const c = cookieOf(ok, links.UNLOCK_COOKIE);
    await pub().get(`/s/${t}/m/${files.aId}`).query({ view: 1 }).set('Cookie', c).expect(200);
    const kinds = (await gc('publicLinks.events', t)).result.map((x) => x.kind);
    assert.ok(kinds.includes('pin_failed') && kinds.includes('unlock'));
  });

  it('the area removed → the link has ended (410)', async () => {
    await gc('media.areas.ensure', 'tmp');
    const t = tokenOf((await create({ kind: 'folder', area: 'tmp' })).url);
    const r = await pub().get(`/s/${t}`).expect(200);
    assert.match(r.text, /leer|empty/i);
    assert.equal((await gc('media.areas.remove', 'tmp')).ok, true);
    await pub().get(`/s/${t}`).expect(410);
    assert.equal((await gc('publicLinks.get', t)).result.state, 'gone');
  });
});

describe("mode 'view'", () => {
  it('a folder link: inline views only, no download, no ZIP', async () => {
    const t = tokenOf((await create({ kind: 'folder', mode: 'view', area: 'docs', path: 'Fotos' })).url);
    const r = await pub().get(`/s/${t}`).expect(200);
    assert.ok(r.text.includes(`/m/${files.aId}?view=1`));
    assert.ok(!r.text.includes(`/s/${t}/zip`), 'no ZIP');
    assert.ok(!r.text.includes(`href="/s/${t}/m/${files.cId}"`), 'no download of the PDF');
    await pub().get(`/s/${t}/m/${files.aId}`).query({ view: 1 }).expect(200);
    assert.equal((await pub().get(`/s/${t}/m/${files.aId}`).expect(403)).text, 'view only');
    await pub().get(`/s/${t}/zip`).expect(403);
  });

  it('a files link: no download, no ZIP; the picture inline', async () => {
    const t = tokenOf((await create({ mode: 'view', files: [{ mediaId: files.cId }, { mediaId: files.aId }] })).url);
    const r = await pub().get(`/s/${t}`).expect(200);
    assert.ok(r.text.includes(`/s/${t}/f/2?view=1`));
    assert.ok(!r.text.includes(`/s/${t}/zip`));
    assert.equal((await pub().get(`/s/${t}/f/1`).expect(403)).text, 'view only');
    const v = await pub().get(`/s/${t}/f/2`).query({ view: 1 }).buffer(true).parse(binary).expect(200);
    assert.ok(v.body.equals(files.a));
    await pub().get(`/s/${t}/f/1`).query({ view: 1 }).expect(403);
    await pub().get(`/s/${t}/zip`).expect(403);
    assert.equal((await gc('publicLinks.get', t)).result.downloads, 0, 'views are no downloads');
  });
});

describe('upload links', () => {
  let t;
  let visitor;
  const up = (buf, q, cookie) => {
    let r = pub().put(`/s/${t}/u`).query(q).set('Content-Type', 'application/octet-stream');
    if (cookie) r = r.set('Cookie', cookie);
    return r.send(buf);
  };
  before(async () => {
    t = tokenOf((await create({ kind: 'upload', area: 'docs', path: 'Eingang', maxFiles: 3, maxBytes: MB, types: ['image/*', '.pdf'], title: 'Für Anna' })).url);
    await kv('public-link-events', []);
  });

  it('the page: the form, its script, the limits', async () => {
    const r = await pub().get(`/s/${t}`).set('Accept-Language', 'de').expect(200);
    assert.ok(r.text.includes('id="pl-up"'));
    assert.ok(r.text.includes('/js/public-link-upload.js'));
    assert.match(r.headers['content-security-policy'], /script-src 'self'; connect-src 'self'/);
    assert.ok(r.text.includes('image/*, .pdf'));
    visitor = cookieOf(r, links.VISITOR_COOKIE);
    assert.ok(visitor);
  });

  it('files come in under the link folder, owned by the link owner; a taken name gets " (2)"', async () => {
    const a = crypto.randomBytes(4000);
    let r = await up(a, { name: 'bild.jpg', type: 'image/jpeg', by: 'Oma Erna' }, visitor).expect(200);
    assert.deepEqual(r.body, { ok: true, name: 'bild.jpg', bytes: 4000 });
    r = await up(crypto.randomBytes(100), { name: 'bild.jpg', type: 'image/jpeg', by: 'Oma Erna' }, visitor).expect(200);
    assert.equal(r.body.name, 'bild (2).jpg');
    const rows = db().prepare("SELECT * FROM plugin_media WHERE plugin = ? AND path LIKE 'Eingang/%' ORDER BY created_at, path").all(PID);
    assert.deepEqual(rows.map((x) => x.path).sort(), ['Eingang/bild (2).jpg', 'Eingang/bild.jpg']);
    assert.ok(rows.every((x) => x.owner_user_id === anna && x.area === 'docs' && x.ref_count === 1));
    const got = await supertest(app).get(`${CLIENT}/${PID}/media/${rows.find((x) => x.path === 'Eingang/bild.jpg').id}`).set('X-API-Token', dev.raw)
      .buffer(true).parse(binary).expect(200);
    assert.ok(got.body.equals(a));
  });

  it('refuses other types, bad names, foreign pages and parsed bodies', async () => {
    assert.equal((await up(Buffer.from('x'), { name: 'a.txt', type: 'text/plain' }).expect(415)).body.code, 'type');
    assert.equal((await up(Buffer.from('x'), { name: '.hidden.jpg', type: 'image/jpeg' }).expect(400)).body.code, 'name');
    assert.equal((await up(Buffer.from('x'), { type: 'image/jpeg' }).expect(400)).body.code, 'name');
    await pub().put(`/s/${t}/u`).query({ name: 'x.jpg' }).set('Origin', 'https://evil.example').set('Content-Type', 'application/octet-stream').send(Buffer.from('x')).expect(403);
    await pub().put(`/s/${t}/u`).query({ name: 'x.jpg', type: 'image/jpeg' }).set('Content-Type', 'application/json').send('{"a":1}').expect(415);
    assert.equal((await up(Buffer.from('x'), { name: 'v.mp4', type: 'video/mp4' }).expect(415)).body.code, 'type', 'the link takes no videos');
    const n = (await gc('publicLinks.get', t)).result.upload;
    assert.deepEqual([n.files, n.bytes], [2, 4100], 'refusals reserve nothing');
  });

  it('the type from the name when the browser names none; then the limit', async () => {
    let r = await up(crypto.randomBytes(500), { name: 'Rechnung.pdf' }, visitor).expect(200);
    assert.equal(r.body.name, 'Rechnung.pdf');
    assert.equal(db().prepare("SELECT mime FROM plugin_media WHERE plugin = ? AND path = 'Eingang/Rechnung.pdf'").get(PID).mime, 'application/pdf');
    r = await up(crypto.randomBytes(10), { name: 'x.jpg', type: 'image/jpeg' }, visitor).expect(413);
    assert.equal(r.body.code, 'limit');
  });

  it('the page: the visitor sees their own uploads, a new visitor none; full', async () => {
    const mine = await pub().get(`/s/${t}`).set('Cookie', visitor).expect(200);
    assert.ok(mine.text.includes('bild (2).jpg'));
    assert.ok(mine.text.includes('Rechnung.pdf'));
    const other = await pub().get(`/s/${t}`).expect(200);
    assert.ok(!other.text.includes('Rechnung.pdf'), 'other uploads stay hidden');
    assert.ok(!other.text.includes('id="pl-up"'), 'full: no form');
  });

  it('gc.publicLinks.uploads, the log and the hook', async () => {
    await sleep(300);
    const u = (await gc('publicLinks.uploads', t)).result;
    assert.deepEqual(u.map((x) => x.path).sort(), ['Eingang/Rechnung.pdf', 'Eingang/bild (2).jpg', 'Eingang/bild.jpg']);
    assert.ok(u.filter((x) => x.path.includes('bild')).every((x) => x.uploader === 'Oma Erna'));
    const ev = (await gc('publicLinks.events', t)).result.filter((x) => x.kind === 'upload');
    assert.equal(ev.length, 3);
    assert.ok(ev.every((x) => x.visitor === visitor.split('=')[1]));
    const hook = await kvGet('public-link-events');
    assert.deepEqual(hook.filter((h) => h.event === 'upload').map((h) => h.path).sort(), ['Eingang/Rechnung.pdf', 'Eingang/bild (2).jpg', 'Eingang/bild.jpg']);
    const got = (await gc('publicLinks.get', t)).result;
    assert.deepEqual([got.upload.files, got.upload.bytes], [3, 4600]);
    assert.equal((await gc('publicLinks.uploads', 'A'.repeat(24))).result, null);
  });

  it('the byte limit of the link and the size limit of the plugin', async () => {
    const t2 = tokenOf((await create({ kind: 'upload', area: 'docs', maxBytes: MB })).url);
    await pub().put(`/s/${t2}/u`).query({ name: 'a.pdf' }).set('Content-Type', 'application/octet-stream').send(crypto.randomBytes(600 * 1024)).expect(200);
    const r = await pub().put(`/s/${t2}/u`).query({ name: 'b.pdf' }).set('Content-Type', 'application/octet-stream').send(crypto.randomBytes(600 * 1024)).expect(413);
    assert.equal(r.body.code, 'limit');
    const t3 = tokenOf((await create({ kind: 'upload', area: 'docs', maxBytes: 10 * MB })).url);
    const big = await pub().put(`/s/${t3}/u`).query({ name: 'big.pdf' }).set('Content-Type', 'application/octet-stream').send(crypto.randomBytes(2 * MB + 1)).expect(413);
    assert.equal(big.body.code, 'too_large');
    assert.deepEqual((await gc('publicLinks.get', t3)).result.upload.files, 0, 'refunded');
  });

  it('only upload links take uploads; an upload link serves no files', async () => {
    const f = tokenOf((await create({ kind: 'folder', area: 'docs', path: 'Eingang' })).url);
    await pub().put(`/s/${f}/u`).query({ name: 'x.pdf' }).set('Content-Type', 'application/octet-stream').send(Buffer.from('x')).expect(404);
    await pub().get(`/s/${t}/zip`).expect(404); // an upload link shows no files
    await pub().get(`/s/${t}/m/${files.aId}`).expect(404);
  });
});

describe('links without an end', () => {
  it('only while the administrator allows them; switching off ends them for good', async () => {
    let r = await agent.get(`${API}/${PID}/public-links`).expect(200);
    assert.equal(r.body.publicLinks.unlimited, false);
    await agent.put(`${API}/${PID}/public-links`).set('X-CSRF-Token', csrf).send({ unlimited: 'yes' }).expect(400);
    r = await setLinks({ unlimited: true });
    assert.deepEqual([r.body.publicLinks.allowed, r.body.publicLinks.unlimited], [true, true]);
    const act = db().prepare("SELECT * FROM activity_log WHERE event_type = 'plugin_public_links' ORDER BY id DESC LIMIT 1").get();
    assert.ok(act && /end/i.test(act.message), act && act.message);
    const l = await create({ kind: 'folder', area: 'docs', path: 'Fotos', expiresAt: null });
    assert.equal(l.expiresAt, null);
    const t = tokenOf(l.url);
    const got = (await gc('publicLinks.get', t)).result;
    assert.deepEqual([got.expiresAt, got.state], [null, 'active']);
    const page = await pub().get(`/s/${t}`).set('Accept-Language', 'de').expect(200);
    assert.match(page.text, /Ohne Ablaufdatum/);
    // the hourly sweep a year later (it also ends and drops every other link) never ends it
    links.sweep(Date.now() + 365 * day);
    assert.equal((await gc('publicLinks.get', t)).result.state, 'active');
    const before = links.activeCount(PID);
    assert.equal(before, 1);
    await setLinks({ unlimited: false });
    assert.equal(links.activeCount(PID), before - 1);
    await pub().get(`/s/${t}`).expect(410);
    await setLinks({ unlimited: true });
    await pub().get(`/s/${t}`).expect(410); // not back
    assert.equal((await gc('publicLinks.get', t)).result.state, 'revoked');
    await setLinks({ unlimited: false });
  });
});

describe('shortIp', () => {
  it('IPv4 /24, IPv6 /48, nothing else', () => {
    assert.equal(links.shortIp('203.0.113.77'), '203.0.113.0');
    assert.equal(links.shortIp('::ffff:10.1.2.3'), '10.1.2.0');
    assert.equal(links.shortIp('2001:db8:abcd:12::1'), '2001:db8:abcd::');
    assert.equal(links.shortIp('2001:0db8:0000:0000:0000:0000:0000:0001'), '2001:db8:0::');
    assert.equal(links.shortIp('fe80::1%eth0'), 'fe80:0:0::');
    assert.equal(links.shortIp('not an ip'), null);
    assert.equal(links.shortIp(null), null);
  });
});
