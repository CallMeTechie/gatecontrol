'use strict';

// gc.media.copy (docs/plugins.md "Copies", since 1.215.0, media.js copy,
// mediaAreas.copyOnTarget): a second, independent file of the same plugin —
// only of its own files; a hard link of the sealed file here (else a copy),
// on a storage target the target's own copy (a folder here; S3 / WebDAV in
// storage_targets_live.test.js), the key wrapped for the new id, the quotas,
// the path in the area, nothing left behind when a copy fails or runs out
// of time, deleting one never touching the other.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const supertest = require('supertest');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');

let app, agent, csrf, runtime, plugins, media, areas, targets, anna, bert, annaDev, tmp, folderA, folderB, tA, tB;
const API = '/api/v1/plugins';
const CLIENT = '/api/v1/client/plugins';
const PID = 'copy-drive';
const OTHER = 'copy-other';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const MB = 1024 * 1024;

async function install(id, mediaDecl) {
  const buf = helloPackage({ overrides: {
    id, name: { de: id, en: id }, permissions: { ...clone(helloManifest.permissions), app: true }, media: mediaDecl,
  } });
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  assert.equal(await runtime.waitRunning(id), true);
}
/** gc.<fn>(...args) inside plugin `pid` → { ok, result } | { ok: false, code, error } */
const gcOf = async (pid, fn, ...args) => (await agent.post(`${API}/${pid}/api/gc`).set('X-CSRF-Token', csrf).send({ fn, args })).body;
const gc = (fn, ...args) => gcOf(PID, fn, ...args);
const put = (pid, buf) => supertest(app).put(`${CLIENT}/${pid}/media`).set('X-API-Token', annaDev.raw).set('Content-Type', 'application/octet-stream').send(buf);
const get = (id) => supertest(app).get(`${CLIENT}/${PID}/media/${id}`).set('X-API-Token', annaDev.raw).buffer(true).parse((res, cb) => {
  const parts = [];
  res.on('data', (c) => parts.push(c));
  res.on('end', () => cb(null, Buffer.concat(parts)));
});
const db = () => H.db();
const rowOf = (id) => db().prepare('SELECT * FROM plugin_media WHERE id = ?').get(id);
const plugin = () => require('../src/services/plugins/registry').get(PID);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmpLeft = () => fs.readdirSync(media.pluginDir(PID)).filter((n) => n.startsWith('.tmp-'));

/** Upload `buf` and claim it (into `area` at `p` when given) → media id. */
async function addFile(buf, area, p) {
  const id = (await put(PID, buf).expect(200)).body.mediaId;
  const r = await gc('media.claim', id, area ? { area, path: p || null } : undefined);
  assert.equal(r.ok, true, JSON.stringify(r));
  return id;
}
async function copyOk(id, opts) {
  const r = await gc('media.copy', id, opts);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.result;
}

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  media = require('../src/services/plugins/media');
  areas = require('../src/services/plugins/mediaAreas');
  targets = require('../src/services/storageTargets');
  anna = H.makeUser('copy-anna');
  bert = H.makeUser('copy-bert');
  annaDev = H.makeDevice(anna, { name: 'copy-anna-phone' });
  await install(PID, { maxBytes: 200 * MB, types: ['*/*'], quotaDefault: '2TB', areas: true });
  await install(OTHER, { maxBytes: 10 * MB, types: ['*/*'], quotaDefault: '1GB', areas: true });
  for (const pid of [PID, OTHER]) assert.equal((await gcOf(pid, 'storage.set', 'media-access', true)).ok, true);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-copy-'));
  folderA = path.join(tmp, 'a');
  folderB = path.join(tmp, 'b');
  fs.mkdirSync(folderA);
  fs.mkdirSync(folderB);
  tA = targets.create('local', { label: 'Platte A', path: folderA }).id;
  tB = targets.create('local', { label: 'Platte B', path: folderB }).id;
});
after(async () => {
  areas._setDriverForTest(null);
  await plugins.stop();
  teardown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('gc.media.copy on this server', () => {
  it('a new, independent file: same bytes, own id, own wrapped key, a hard link; unclaimed until claimed', async () => {
    assert.equal(typeof (await gc('media.copy', 'x')).code, 'string', 'the function exists');
    const plain = crypto.randomBytes(150 * 1024 + 9);
    const src = await addFile(plain);
    db().prepare('UPDATE plugin_media SET name = ?, owner_user_id = ? WHERE id = ?').run('Bild.jpg', anna, src);
    const c = await copyOk(src);
    assert.match(c.id, /^[0-9a-f]{32}$/);
    assert.notEqual(c.id, src);
    assert.deepEqual({ ...c, id: null, mediaId: null }, { id: null, mediaId: null, size: plain.length, bytes: plain.length, sha256: sha(plain),
      mime: 'application/octet-stream', name: 'Bild.jpg', area: null, path: null, claimed: false, method: 'link' });
    assert.equal(c.mediaId, c.id);
    const row = rowOf(c.id);
    assert.equal(row.plugin, PID);
    assert.equal(row.owner_user_id, anna, 'the owner of the source');
    assert.notEqual(row.key_enc, rowOf(src).key_enc);
    assert.ok(media._unwrapKey(row.key_enc, c.id).equals(media._unwrapKey(rowOf(src).key_enc, src)), 'the same file key, wrapped for the new id');
    assert.throws(() => media._unwrapKey(row.key_enc, src), 'bound to its own id');
    assert.equal(fs.statSync(media.fileOf(PID, c.id)).ino, fs.statSync(media.fileOf(PID, src)).ino, 'a hard link');
    assert.ok((await get(c.id).expect(200)).body.equals(plain));
    assert.equal((await gc('media.info', c.id)).result.claimed, false);
    assert.equal((await gc('media.claim', c.id)).result.claimed, true);
    // deleting the source leaves the copy whole, and the other way round
    assert.equal((await gc('media.delete', src)).result, true);
    assert.ok((await get(c.id).expect(200)).body.equals(plain));
    const c2 = await copyOk(c.id, { claim: true, user: bert });
    assert.equal(c2.claimed, true);
    assert.equal(rowOf(c2.id).owner_user_id, bert);
    assert.equal((await gc('media.delete', c.id)).result, true);
    assert.ok((await get(c2.id).expect(200)).body.equals(plain));
    assert.deepEqual(tmpLeft(), []);
  });

  it('only the plugin\'s own files: another plugin\'s id is unknown, bad options are refused', async () => {
    const foreign = (await put(OTHER, Buffer.from('fremd')).expect(200)).body.mediaId;
    assert.equal((await gcOf(OTHER, 'media.claim', foreign)).ok, true);
    const before = db().prepare('SELECT COUNT(*) AS n FROM plugin_media').get().n;
    const r = await gc('media.copy', foreign);
    assert.equal(r.code, 'ERR_INVALID');
    assert.match(r.error, /unknown media id/);
    assert.equal(db().prepare('SELECT COUNT(*) AS n FROM plugin_media').get().n, before);
    const own = await addFile(Buffer.from('eigen'));
    // OTHER's areas are not this plugin's
    await gcOf(OTHER, 'media.areas.ensure', 'fremd');
    assert.equal((await gc('media.copy', own, { area: 'fremd' })).code, 'ERR_INVALID');
    for (const bad of [{ nope: 1 }, { claim: 'yes' }, { area: 5 }, { path: 7 }, { user: -1 }, { user: 999999 }, { path: 'a.txt' }]) {
      assert.equal((await gc('media.copy', own, bad)).code, 'ERR_INVALID', JSON.stringify(bad));
    }
    assert.equal((await gc('media.copy', 'not-an-id')).code, 'ERR_INVALID');
    assert.equal((await gc('media.copy', own, 'x')).code, 'ERR_INVALID');
  });

  it('the plugin\'s quota and the area\'s quota; a taken path; nothing left behind', async () => {
    await gc('media.areas.ensure', 'small', { quota: MB });
    const src = await addFile(crypto.randomBytes(600 * 1024), 'small', 'a.bin');
    assert.equal((await gc('media.copy', src, { path: 'a.bin' })).code, 'ERR_CONFLICT');
    assert.equal((await gc('media.copy', src, { path: '../x' })).code, 'ERR_INVALID');
    const r = await gc('media.copy', src, { path: 'b.bin' });
    assert.equal(r.code, 'ERR_MEDIA_QUOTA', 'the area is full');
    media.setQuota(plugin(), media.usage(PID).bytes + 1024 * 1024);
    try {
      const big = await addFile(crypto.randomBytes(800 * 1024));
      assert.equal((await gc('media.copy', big)).code, 'ERR_MEDIA_QUOTA', 'the plugin\'s quota');
    } finally { media.setQuota(plugin(), null); }
    assert.deepEqual(tmpLeft(), []);
  });

  it('into an area with a path; a version becomes a current file; previews come along', async () => {
    await gc('media.areas.ensure', 'docs');
    const plain = Buffer.from('Version eins');
    const src = await addFile(plain, 'docs', 'Brief.txt');
    assert.equal((await gc('media.version', src)).ok, true);
    fs.writeFileSync(media.fileOf(PID, src) + '.ps', 'preview');
    const c = await copyOk(src, { path: 'Kopie/Brief.txt', claim: true });
    assert.deepEqual([c.area, c.path, c.claimed], ['docs', 'Kopie/Brief.txt', true]);
    const info = (await gc('media.info', c.id)).result;
    assert.deepEqual([info.area, info.path, info.versionOf, info.stored], ['docs', 'Kopie/Brief.txt', undefined, 'server']);
    assert.equal(fs.readFileSync(media.fileOf(PID, c.id) + '.ps', 'utf8'), 'preview');
    // out of the area (area: null) and into another one
    const plainCopy = await copyOk(c.id, { area: null });
    assert.deepEqual([plainCopy.area, plainCopy.path], [null, null]);
    await gc('media.areas.ensure', 'other');
    const moved = await copyOk(c.id, { area: 'other', path: 'x/Brief.txt' });
    assert.deepEqual([moved.area, moved.path, moved.claimed], ['other', 'x/Brief.txt', false]);
    // claim without options keeps area and path
    const kept = (await gc('media.claim', moved.id)).result;
    assert.deepEqual([kept.area, kept.path], ['other', 'x/Brief.txt']);
  });

  it('runs out of time → ERR_TIMEOUT-like error, no row and no file left', async () => {
    const src = await addFile(Buffer.from('zeit'));
    const count = db().prepare('SELECT COUNT(*) AS n FROM plugin_media WHERE plugin = ?').get(PID).n;
    await assert.rejects(media.copy(plugin(), src, { timeoutMs: -1 }), (e) => e.code === 'timeout');
    assert.equal(db().prepare('SELECT COUNT(*) AS n FROM plugin_media WHERE plugin = ?').get(PID).n, count);
    assert.deepEqual(tmpLeft(), []);
  });

  it('many copies at once: all done, each its own file', async () => {
    const plain = crypto.randomBytes(70 * 1024);
    const src = await addFile(plain);
    const all = await Promise.all(Array.from({ length: 9 }, () => gc('media.copy', src)));
    assert.ok(all.every((r) => r.ok), JSON.stringify(all.filter((r) => !r.ok)));
    assert.equal(new Set(all.map((r) => r.result.id)).size, 9);
    for (const r of all.slice(0, 2)) assert.ok((await get(r.result.id).expect(200)).body.equals(plain));
  });

  it('an unclaimed copy is cleaned up after 24 h like every new file', async () => {
    const src = await addFile(Buffer.from('weg'));
    const c = await copyOk(src);
    media.cleanup(Date.now() + media.UNCLAIMED_TTL_MS + 1000);
    assert.equal(rowOf(c.id), undefined);
    assert.equal(fs.existsSync(media.fileOf(PID, c.id)), false);
    assert.ok((await get(src).expect(200)).body.equals(Buffer.from('weg')), 'the source stays');
  });
});

describe('gc.media.copy with storage targets', () => {
  let plain, src;
  before(async () => {
    await gc('media.areas.ensure', 'photos');
    await agent.put(`${API}/${PID}/media/areas/photos`).set('X-CSRF-Token', csrf).send({ targetId: tA, form: 'blocks' }).expect(200);
    plain = crypto.randomBytes(200 * 1024 + 123);
    src = await addFile(plain, 'photos', 'IMG_1.jpg');
    await areas.tick();
    assert.equal(rowOf(src).target_id, tA);
  });

  it('the source on the area\'s target: copied there (sealed, under its own key), no local copy', async () => {
    const c = await copyOk(src, { path: 'IMG_1 Kopie.jpg' });
    assert.equal(c.method, 'target');
    const row = rowOf(c.id);
    assert.deepEqual([row.target_id, row.remote_key, row.stored_form, row.local], [tA, `${PID}/photos/${c.id.slice(0, 2)}/${c.id}`, 'blocks', 0]);
    assert.equal(row.nonce_prefix, rowOf(src).nonce_prefix);
    assert.equal(fs.existsSync(media.fileOf(PID, c.id)), false);
    assert.ok(fs.readFileSync(path.join(folderA, row.remote_key)).equals(fs.readFileSync(path.join(folderA, rowOf(src).remote_key))));
    assert.equal(db().prepare('SELECT COUNT(*) AS n FROM plugin_media_gone').get().n, 0, 'the tombstone went with the row');
    assert.equal(areas.stateOf(row), 'target');
    assert.ok((await get(c.id).expect(200)).body.equals(plain));
    // deleting the source deletes its object only
    assert.equal((await gc('media.claim', c.id)).ok, true);
    const srcKey = rowOf(src).remote_key;
    const keep = await copyOk(src, { claim: true });
    assert.equal((await gc('media.delete', src)).result, true);
    await areas.tick();
    assert.equal(fs.existsSync(path.join(folderA, srcKey)), false);
    assert.ok(fs.existsSync(path.join(folderA, row.remote_key)));
    assert.ok((await get(c.id).expect(200)).body.equals(plain));
    src = keep.id;
  });

  it('the source only on its target and no copy there (another area): fetched into the cache, linked, pushed after the claim', async () => {
    await gc('media.areas.ensure', 'archive');
    await agent.put(`${API}/${PID}/media/areas/archive`).set('X-CSRF-Token', csrf).send({ targetId: tB, form: 'blocks' }).expect(200);
    await areas.tick();
    fs.rmSync(media.fileOf(PID, src), { force: true });
    db().prepare('UPDATE plugin_media SET local = 0 WHERE id = ?').run(src);
    const c = await copyOk(src, { area: 'archive', path: 'IMG_1.jpg', claim: true });
    assert.equal(c.method, 'link');
    assert.equal(rowOf(src).local, 1, 'the source came back into the cache');
    assert.equal(areas.stateOf(rowOf(c.id)), 'pending');
    await areas.tick();
    const row = rowOf(c.id);
    assert.deepEqual([row.target_id, row.remote_key], [tB, `${PID}/archive/${c.id.slice(0, 2)}/${c.id}`]);
    assert.ok((await get(c.id).expect(200)).body.equals(plain));
  });

  it('a target that cannot copy, or whose copy fails: the local way; a failed copy on the target is deleted', async () => {
    const real = await targets.driverOf(targets.rowOf(tA));
    areas._setDriverForTest(async () => ({ ...real, copy: undefined }));
    try {
      assert.equal((await copyOk(src)).method, 'link');
    } finally { areas._setDriverForTest(null); }
    // a copy that leaves a wrong object behind
    let wrongKey = null;
    areas._setDriverForTest(async () => ({ ...real, copy: async (from, to) => { wrongKey = to; fs.mkdirSync(path.dirname(path.join(folderA, to)), { recursive: true }); fs.writeFileSync(path.join(folderA, to), 'kaputt'); } }));
    let c;
    try { c = await copyOk(src); } finally { areas._setDriverForTest(null); }
    assert.equal(c.method, 'link');
    assert.ok(wrongKey && fs.existsSync(path.join(folderA, wrongKey)));
    await areas.tick();
    assert.equal(fs.existsSync(path.join(folderA, wrongKey)), false, 'the worker deleted it');
    assert.equal(db().prepare('SELECT COUNT(*) AS n FROM plugin_media_gone').get().n, 0);
  });

  it('a copy left on the target without its row (the server stopped) goes after the grace time', async () => {
    const key = `${PID}/photos/zz/orphan`;
    fs.mkdirSync(path.join(folderA, `${PID}/photos/zz`), { recursive: true });
    fs.writeFileSync(path.join(folderA, key), 'x');
    db().prepare('INSERT INTO plugin_media_gone (target_id, remote_key, next_at) VALUES (?, ?, ?)').run(tA, key, new Date(Date.now() + areas.ORPHAN_GRACE_MS).toISOString());
    await areas.tick();
    assert.ok(fs.existsSync(path.join(folderA, key)), 'not before the grace time');
    db().prepare('UPDATE plugin_media_gone SET next_at = ? WHERE remote_key = ?').run(new Date(Date.now() - 1000).toISOString(), key);
    await areas.tick();
    assert.equal(fs.existsSync(path.join(folderA, key)), false);
  });

  it('readable files on a folder: copied there under the new path; an unclaimed copy goes with its file after 24 h', async () => {
    await gc('media.areas.ensure', 'nas');
    await agent.put(`${API}/${PID}/media/areas/nas`).set('X-CSRF-Token', csrf).send({ targetId: tB, form: 'files' }).expect(200);
    const doc = Buffer.from('Lesbare Datei');
    const s = await addFile(doc, 'nas', 'Ordner/a.txt');
    await areas.tick();
    assert.equal(fs.readFileSync(path.join(folderB, `${PID}/nas/Ordner/a.txt`), 'utf8'), 'Lesbare Datei');
    const c = await copyOk(s, { path: 'Ordner/a (Kopie).txt' });
    assert.equal(c.method, 'target');
    assert.equal(fs.readFileSync(path.join(folderB, `${PID}/nas/Ordner/a (Kopie).txt`), 'utf8'), 'Lesbare Datei');
    assert.deepEqual([rowOf(c.id).stored_form, rowOf(c.id).remote_size], ['files', doc.length]);
    // a file of that name already on the NAS (not known to GateControl): never overwritten — copied the local way
    fs.writeFileSync(path.join(folderB, `${PID}/nas/Ordner/fremd.txt`), 'von Hand');
    const c2 = await copyOk(s, { path: 'Ordner/fremd.txt' });
    assert.equal(c2.method, 'link');
    assert.equal(fs.readFileSync(path.join(folderB, `${PID}/nas/Ordner/fremd.txt`), 'utf8'), 'von Hand');
    // a file changed on the NAS since it was stored: not copied there
    const row = rowOf(s);
    db().prepare('UPDATE plugin_media SET remote_mtime = ? WHERE id = ?').run(1000, s);
    const c3 = await copyOk(s, { path: 'Ordner/b.txt' });
    assert.equal(c3.method, 'link');
    db().prepare('UPDATE plugin_media SET remote_mtime = ? WHERE id = ?').run(row.remote_mtime, s);
    // unclaimed: after 24 h row and file go
    media.cleanup(Date.now() + media.UNCLAIMED_TTL_MS + 1000);
    await areas.tick();
    assert.equal(rowOf(c.id), undefined);
    assert.equal(fs.existsSync(path.join(folderB, `${PID}/nas/Ordner/a (Kopie).txt`)), false);
    assert.equal(fs.readFileSync(path.join(folderB, `${PID}/nas/Ordner/a.txt`), 'utf8'), 'Lesbare Datei', 'the source stays');
  });
});
