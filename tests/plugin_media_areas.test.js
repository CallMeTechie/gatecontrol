'use strict';

// Media areas (docs/plugins.md "Media areas", src/services/plugins/
// mediaAreas.js): plugin.json media.areas (100 GB, */*), gc.media.areas.*,
// gc.media.claim(id, { area, path }), copies to a storage target (a folder
// here), the cache and its eviction, reads of files without a local copy
// (ranges, whole file), moving an area, deletions on targets, failing
// targets, the upload digest, the admin API, backups.

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
const PUI = require('../public/js/plugins-ui.js');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

let app, agent, csrf, runtime, plugins, manifest, media, areas, targets, anna, annaDev, tmp, folderA, folderB, tA, tB;
const API = '/api/v1/plugins';
const CLIENT = '/api/v1/client/plugins';
const PID = 'hello-drive';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const MB = 1024 * 1024;
const GB = 1024 * MB;

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  return r.body;
}
/** gc.<fn>(...args) inside the plugin process → { ok, result } | { ok: false, code } */
const gc = async (fn, ...args) => (await agent.post(`${API}/${PID}/api/gc`).set('X-CSRF-Token', csrf).send({ fn, args })).body;
const put = (buf, type = 'application/octet-stream', headers = {}) => {
  let r = supertest(app).put(`${CLIENT}/${PID}/media`).set('X-API-Token', annaDev.raw).set('Content-Type', type);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send(buf);
};
const get = (id, range) => {
  let r = supertest(app).get(`${CLIENT}/${PID}/media/${id}`).set('X-API-Token', annaDev.raw).buffer(true).parse((res, cb) => {
    const parts = [];
    res.on('data', (c) => parts.push(c));
    res.on('end', () => cb(null, Buffer.concat(parts)));
  });
  if (range) r = r.set('Range', range);
  return r;
};
const db = () => H.db();
const rowOf = (id) => db().prepare('SELECT * FROM plugin_media WHERE id = ?').get(id);
const plugin = () => require('../src/services/plugins/registry').get(PID);
const sha = (b) => crypto.createHash('sha256').update(b).digest();

/** Upload `buf`, claim it into `area` → media id. */
async function addFile(buf, area, p) {
  const id = (await put(buf).expect(200)).body.mediaId;
  const r = await gc('media.claim', id, { area, path: p || null });
  assert.equal(r.ok, true, JSON.stringify(r));
  return id;
}

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  manifest = require('../src/services/plugins/manifest');
  media = require('../src/services/plugins/media');
  areas = require('../src/services/plugins/mediaAreas');
  targets = require('../src/services/storageTargets');
  anna = H.makeUser('areas-anna');
  annaDev = H.makeDevice(anna, { name: 'areas-anna-phone' });
  await install(helloPackage({ overrides: {
    id: PID, name: { de: 'Hallo Drive', en: 'Hello drive' }, permissions: { ...clone(helloManifest.permissions), app: true },
    media: { maxBytes: 200 * MB, types: ['*/*'], quotaDefault: '2TB', areas: true },
  } }));
  assert.equal(await runtime.waitRunning(PID), true);
  assert.equal((await gc('storage.set', 'media-access', true)).ok, true); // the mediaAccess hook of the test plugin lets everyone read
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-areas-'));
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

/** Files below a folder (relative paths). */
function filesIn(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p)); } };
  walk(dir);
  return out.sort();
}

describe('plugin.json media.areas', () => {
  const check = (mediaDecl) => { const m = clone(helloManifest); m.media = mediaDecl; return manifest.validate(m); };

  it('allows 100 GB per file, a quota up to 1 PB and */* — only with areas', () => {
    let r = check({ maxBytes: 100 * GB, types: ['*/*'], quotaDefault: '1024TB', areas: true });
    assert.equal(r.ok, true, r.errors.join(', '));
    assert.equal(r.manifest.media.areas, true);
    assert.equal(r.manifest.media.quotaDefault, 1024 ** 5);
    assert.deepEqual(check({ maxBytes: 100 * GB + 1, types: ['*/*'], areas: true }).errors, ['media.maxBytes: invalid']);
    assert.deepEqual(check({ maxBytes: 100 * GB, types: ['image/png'] }).errors, ['media.maxBytes: invalid']);
    assert.deepEqual(check({ maxBytes: 4096, types: ['*/*'] }).errors, ['media.types: invalid']);
    assert.deepEqual(check({ maxBytes: 4096, types: ['image/png'], areas: 'yes' }).errors, ['media.areas: invalid']);
    r = check({ maxBytes: 4096, types: ['image/png'] });
    assert.equal('areas' in r.manifest.media, false, 'no key for plugins without areas');
  });

  it('the install dialog names every type and the storage places', () => {
    const t = (k, p) => { let s = de[k] || k; for (const [a, b] of Object.entries(p || {})) s = s.split('{{' + a + '}}').join(String(b)); return s; };
    const rows = Object.fromEntries(PUI.permRows({ media: { maxBytes: 100 * GB, types: ['*/*'], quotaDefault: GB, uploads: true, areas: true } }, t).map((x) => [x.label, x.value]));
    assert.match(rows.Medien, /alle Dateitypen/);
    assert.equal(rows.Speicherorte, de['plugins.perm.media_areas_on']);
    for (const k of ['plugins.perm.media_all_types', 'plugins.perm.media_areas', 'plugins.perm.media_areas_on', 'plugins.areas.title', 'plugins.stg.cache',
      'st.event.storage_problem', 'push.type.storage_target_unreachable', 'push.type.storage_target_recovered']) assert.ok(de[k] && en[k], k);
  });
});

describe('gc.media.areas', () => {
  it('ensure creates and updates, info/list report, remove only empty areas', async () => {
    let r = await gc('media.areas.ensure', 'family', { label: 'Familie', quota: 10 * MB });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.label, 'Familie');
    assert.equal(r.result.quota, 10 * MB);
    assert.deepEqual(r.result.target, { id: null, kind: 'server', label: null });
    assert.equal(r.result.state, 'ok');
    r = await gc('media.areas.ensure', 'family', { label: 'Familie & Freunde' });
    assert.equal(r.result.label, 'Familie & Freunde');
    assert.equal(r.result.quota, null);
    await gc('media.areas.ensure', 'tmp');
    assert.deepEqual((await gc('media.areas.list')).result.map((a) => a.area), ['family', 'tmp']);
    assert.equal((await gc('media.areas.info', 'nope')).result, null);
    for (const bad of ['', 'Family', '-x', 'a/b', 'x'.repeat(65)]) assert.equal((await gc('media.areas.ensure', bad)).code, 'ERR_INVALID', bad);
    assert.equal((await gc('media.areas.ensure', 'q', { quota: 5 })).code, 'ERR_INVALID');
    assert.equal((await gc('media.areas.remove', 'tmp')).result, true);
    assert.equal((await gc('media.areas.remove', 'tmp')).result, false);
    const usage = (await gc('media.usage')).result;
    assert.equal(usage.areas, true);
  });

  it('claim into an area: path normalised, area must exist, quota of the area', async () => {
    const id = await addFile(Buffer.from('hallo welt'), 'family', '/Fotos//Urlaub/a.txt');
    const info = (await gc('media.info', id)).result;
    assert.equal(info.area, 'family');
    assert.equal(info.path, 'Fotos/Urlaub/a.txt');
    assert.equal(info.stored, 'server');
    const id2 = (await put(Buffer.from('x')).expect(200)).body.mediaId;
    assert.equal((await gc('media.claim', id2, { area: 'nope' })).code, 'ERR_INVALID');
    assert.equal((await gc('media.claim', id2, { area: 'family', path: '../x' })).code, 'ERR_INVALID');
    assert.equal((await gc('media.areas.remove', 'family')).code, 'ERR_INVALID', 'not empty');
    await gc('media.areas.ensure', 'small', { quota: MB });
    const big = (await put(crypto.randomBytes(MB)).expect(200)).body.mediaId;
    await addFile(Buffer.from('1'), 'small');
    assert.equal((await gc('media.claim', big, { area: 'small' })).code, 'ERR_MEDIA_QUOTA');
  });

  it('*/* stores any type; types a browser would run are served as a download', async () => {
    const id = (await put(Buffer.from('<script>alert(1)</script>'), 'text/html').expect(200)).body.mediaId;
    await gc('media.claim', id, { area: 'family', path: 'x.html' });
    const r = await get(id).expect(200);
    assert.equal(r.headers['content-type'].split(';')[0], 'application/octet-stream');
    assert.match(r.headers['content-disposition'], /^attachment/);
  });

  it('an upload digest that does not match is refused; a good one passes', async () => {
    const buf = crypto.randomBytes(5000);
    const good = 'sha-256=:' + sha(buf).toString('base64') + ':';
    assert.equal((await put(buf, 'application/octet-stream', { 'Repr-Digest': good }).expect(200)).body.bytes, 5000);
    const bad = 'sha-256=:' + sha(Buffer.from('other')).toString('base64') + ':';
    assert.equal((await put(buf, 'application/octet-stream', { 'Content-Digest': bad }).expect(400)).body.code, 'digest_mismatch');
    assert.equal((await put(buf, 'application/octet-stream', { Digest: 'sha-256=nope' }).expect(400)).body.code, 'invalid_digest');
  });
});

describe('areas on a storage target', () => {
  let id, plain;
  before(async () => {
    await gc('media.areas.ensure', 'photos', { label: 'Fotos' });
    plain = crypto.randomBytes(200 * 1024 + 123); // four sealed chunks, the last one short
    id = await addFile(plain, 'photos', 'IMG_0001.jpg');
  });

  it('the admin moves the (non-empty) area to a target: the worker copies, the area finishes moving', async () => {
    const r = await agent.put(`${API}/${PID}/media/areas/photos`).set('X-CSRF-Token', csrf).send({ targetId: tA }).expect(200);
    assert.equal(r.body.area.state, 'moving');
    assert.equal(areas.stateOf(rowOf(id)), 'pending');
    await areas.tick();
    const row = rowOf(id);
    assert.equal(row.target_id, tA);
    assert.equal(row.remote_key, `${PID}/photos/${id.slice(0, 2)}/${id}`);
    assert.match(row.nonce_prefix, /^[0-9a-f]{16}$/);
    assert.equal(row.local, 1, 'the local copy stays as cache');
    assert.deepEqual(filesIn(folderA), [row.remote_key]);
    const stored = fs.readFileSync(path.join(folderA, row.remote_key));
    assert.equal(stored.length, media.sealedSize(plain.length));
    assert.equal(stored.includes(plain.subarray(0, 64)), false, 'the target only sees encrypted bytes');
    const a = areas.info(PID, 'photos', { admin: true });
    assert.equal(a.state, 'ok');
    assert.equal(a.target.id, tA);
    assert.equal(a.moving, null);
    assert.equal((await gc('media.info', id)).result.stored, 'target');
    assert.deepEqual(targets.usedBy(tA).map((u) => [u.kind, u.area]), [['area', 'photos']]);
    assert.equal((await agent.delete(`/api/v1/storage-targets/${tA}`).set('X-CSRF-Token', csrf)).status, 409, 'in use');
  });

  it('new files of the area go to the target after the next run', async () => {
    const id2 = await addFile(Buffer.from('neu'), 'photos', 'neu.txt');
    assert.equal(areas.stateOf(rowOf(id2)), 'pending');
    assert.equal(areas.info(PID, 'photos').pending.count, 1);
    await areas.tick();
    assert.equal(rowOf(id2).target_id, tA);
  });

  it('the cache drops the least recently used local copies; reads come from the target (ranges and whole)', async () => {
    const before = media.usage(PID);
    areas.setCacheLimit(256 * MB);
    assert.equal(areas.evict(), 0, 'fits');
    db().prepare("UPDATE settings SET value = '1' WHERE key = ?").run(areas.CACHE_SETTING); // below the minimum → the default
    assert.equal(areas.cacheLimit(), areas.CACHE_DEFAULT);
    // force eviction: a tiny limit straight in the table (setCacheLimit refuses it)
    const realMin = areas.CACHE_MIN;
    db().prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(realMin), areas.CACHE_SETTING);
    const fake = db().prepare('UPDATE plugin_media SET bytes = ? WHERE id = ?');
    fake.run(realMin + 1, id); // pretend it is big
    assert.ok(areas.evict() >= 1);
    fake.run(plain.length, id);
    assert.equal(rowOf(id).local, 0);
    assert.equal(fs.existsSync(media.fileOf(PID, id)), false);
    assert.deepEqual(media.usage(PID), before, 'the quota still counts it');
    let r = await get(id).expect(200);
    assert.ok(r.body.equals(plain), 'whole file');
    r = await get(id, 'bytes=70000-140000').expect(206);
    assert.ok(r.body.equals(plain.subarray(70000, 140001)), 'a range over chunk borders');
    r = await get(id, `bytes=-10`).expect(206);
    assert.ok(r.body.equals(plain.subarray(plain.length - 10)), 'the end');
    assert.equal(rowOf(id).local, 0, 'a range read does not fill the cache');
    areas.setCacheLimit(null);
  });

  it('a target without ranges (SMB) brings the whole file into the cache', async () => {
    const real = await targets.driverOf(targets.rowOf(tA));
    areas._setDriverForTest(async () => ({ ...real, ranges: false }));
    try {
      const r = await get(id, 'bytes=0-9').expect(206);
      assert.ok(r.body.equals(plain.subarray(0, 10)));
      assert.equal(rowOf(id).local, 1);
      assert.ok(fs.existsSync(media.fileOf(PID, id)));
    } finally { areas._setDriverForTest(null); }
  });

  it('a failing target: copies wait, backoff, an alert after 15 minutes, recovered afterwards', async () => {
    const id3 = await addFile(Buffer.from('wartet'), 'photos', 'w.txt');
    const { StorageError } = targets;
    areas._setDriverForTest(async () => ({ ranges: true, put: async () => { throw new StorageError('unreachable', 'down'); },
      head: async () => null, get: async () => { throw new StorageError('unreachable', 'down'); }, remove: async () => { throw new StorageError('unreachable', 'down'); } }));
    try {
      await areas.tick();
      assert.equal(rowOf(id3).target_id, null);
      assert.equal(rowOf(id3).push_error, 'unreachable');
      assert.equal(areas.healthy(tA), false, 'backing off');
      assert.equal(areas.info(PID, 'photos').state, 'unreachable');
      const h = areas._health.get(tA);
      h.failingSince -= areas.ALERT_AFTER_MS;
      areas.noteFailure(tA, new StorageError('unreachable', 'down'));
      const ev = db().prepare("SELECT * FROM activity_log WHERE event_type = 'storage_target_unreachable' ORDER BY id DESC LIMIT 1").get();
      assert.ok(ev, 'alerted');
      assert.equal(JSON.parse(ev.details).target_label, 'Platte A');
      areas.noteFailure(tA, new StorageError('unreachable', 'down'));
      assert.equal(db().prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'storage_target_unreachable'").get().n, 1, 'once');
    } finally { areas._setDriverForTest(null); }
    areas._health.get(tA).nextTry = 0;
    await areas.tick();
    assert.equal(rowOf(id3).target_id, tA);
    assert.equal(rowOf(id3).push_error, null);
    assert.equal(areas.healthy(tA), true);
    assert.ok(db().prepare("SELECT 1 FROM activity_log WHERE event_type = 'storage_target_recovered'").get());
  });

  it('while a target is down and the waiting files fill the cache, uploads get 503', async () => {
    areas._health.set(tA, { failingSince: Date.now(), backoff: 30000, nextTry: Date.now() + 30000, lastError: 'unreachable', alerted: false });
    db().prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(areas.CACHE_MIN), areas.CACHE_SETTING);
    const pend = await addFile(Buffer.from('p'), 'photos');
    db().prepare('UPDATE plugin_media SET bytes = ? WHERE id = ?').run(areas.CACHE_MIN, pend);
    try {
      assert.equal((await put(Buffer.from('more')).expect(503)).body.code, 'storage_unavailable');
    } finally {
      db().prepare('UPDATE plugin_media SET bytes = 1 WHERE id = ?').run(pend);
      areas._resetHealthForTest();
      areas.setCacheLimit(null);
    }
    await put(Buffer.from('more')).expect(200);
  });

  it('moving to another target copies and deletes the old copies; deleting a file deletes its copy', async () => {
    await areas.tick();
    const n = db().prepare("SELECT COUNT(*) AS n FROM plugin_media WHERE plugin = ? AND area = 'photos'").get(PID).n;
    await agent.put(`${API}/${PID}/media/areas/photos`).set('X-CSRF-Token', csrf).send({ targetId: tB }).expect(200);
    assert.equal(areas.info(PID, 'photos').moving.total, n);
    await areas.tick();
    await areas.tick(); // the deletions queued by the copies
    assert.equal(areas.info(PID, 'photos', { admin: true }).target.id, tB);
    assert.equal(filesIn(folderA).length, 0, 'old copies gone');
    assert.equal(filesIn(folderB).length, n);
    assert.ok((await get(id).expect(200)).body.equals(plain));
    const key = rowOf(id).remote_key;
    assert.equal((await gc('media.delete', id)).result, true);
    await areas.tick();
    assert.equal(fs.existsSync(path.join(folderB, key)), false);
    assert.equal(db().prepare('SELECT COUNT(*) AS n FROM plugin_media_gone').get().n, 0);
    assert.ok(db().prepare("SELECT 1 FROM activity_log WHERE event_type = 'plugin_media_area_moved'").get());
  });

  it('back to this server: files come home, the target copies go', async () => {
    await agent.put(`${API}/${PID}/media/areas/photos`).set('X-CSRF-Token', csrf).send({ targetId: null }).expect(200);
    db().prepare("UPDATE plugin_media SET local = 0 WHERE plugin = ? AND area = 'photos'").run(PID);
    for (const r of db().prepare("SELECT id FROM plugin_media WHERE plugin = ? AND area = 'photos'").all(PID)) fs.rmSync(media.fileOf(PID, r.id), { force: true });
    await areas.tick();
    await areas.tick();
    const rows = db().prepare("SELECT * FROM plugin_media WHERE plugin = ? AND area = 'photos'").all(PID);
    assert.ok(rows.every((r) => r.target_id == null && r.local === 1 && fs.existsSync(media.fileOf(PID, r.id))));
    assert.equal(filesIn(folderB).length, 0);
    assert.equal(areas.info(PID, 'photos').state, 'ok');
    assert.deepEqual(targets.usedBy(tB), []);
  });
});

describe('admin API', () => {
  it('GET areas lists areas, targets and the cache; PUT sets quota and refuses bad input', async () => {
    const r = await agent.get(`${API}/${PID}/media/areas`).expect(200);
    assert.ok(r.body.areas.some((a) => a.area === 'photos'));
    assert.deepEqual(r.body.targets.map((t) => t.label).sort(), ['Platte A', 'Platte B']);
    assert.deepEqual(Object.keys(r.body.cache).sort(), ['cached', 'default', 'limit', 'pending']);
    let p = await agent.put(`${API}/${PID}/media/areas/photos`).set('X-CSRF-Token', csrf).send({ quotaBytes: 5 * GB }).expect(200);
    assert.equal(p.body.area.quota, 5 * GB);
    p = await agent.put(`${API}/${PID}/media/areas/photos`).set('X-CSRF-Token', csrf).send({ quotaBytes: null }).expect(200);
    assert.equal(p.body.area.quota, null);
    await agent.put(`${API}/${PID}/media/areas/photos`).set('X-CSRF-Token', csrf).send({ quotaBytes: 5 }).expect(400);
    await agent.put(`${API}/${PID}/media/areas/photos`).set('X-CSRF-Token', csrf).send({ targetId: 99999 }).expect(400);
    await agent.put(`${API}/${PID}/media/areas/none`).set('X-CSRF-Token', csrf).send({ targetId: null }).expect(404);
    await agent.get(`${API}/hello/media/areas`).expect(404);
  });

  it('the storage page shows and sets the cache', async () => {
    const r = await agent.get('/api/v1/storage-targets').expect(200);
    assert.equal(r.body.cache.limit, areas.CACHE_DEFAULT);
    const p = await agent.put('/api/v1/storage-targets/cache').set('X-CSRF-Token', csrf).send({ limitBytes: 2 * GB }).expect(200);
    assert.equal(p.body.cache.limit, 2 * GB);
    await agent.put('/api/v1/storage-targets/cache').set('X-CSRF-Token', csrf).send({ limitBytes: 10 }).expect(400);
    assert.equal((await agent.put('/api/v1/storage-targets/cache').set('X-CSRF-Token', csrf).send({ limitBytes: null }).expect(200)).body.cache.limit, areas.CACHE_DEFAULT);
  });

  it('the notification catalogue has storage_problem', () => {
    const n = require('../src/services/notifications');
    const ev = (n.CATALOGUE || []).flatMap((g) => g.events).find((e) => e.id === 'storage_problem');
    assert.deepEqual(ev.types, ['storage_target_unreachable', 'storage_target_recovered']);
  });
});

describe('backup', () => {
  it('exports areas and file metadata (never bytes); a restore brings them back while the bytes are still there', async () => {
    await gc('media.areas.ensure', 'nas', { label: 'NAS' });
    await agent.put(`${API}/${PID}/media/areas/nas`).set('X-CSRF-Token', csrf).send({ targetId: tA }).expect(200);
    const buf = crypto.randomBytes(70000);
    const id = await addFile(buf, 'nas', 'a/b.bin');
    await areas.tick();
    const exp = areas.exportAreas(PID);
    assert.ok(exp.areas.some((a) => a.area === 'nas' && a.target_id === tA));
    const f = exp.files.find((x) => x.id === id);
    assert.equal(f.remote_key, rowOf(id).remote_key);
    assert.equal('data' in f, false);
    assert.equal(JSON.stringify(exp).includes(buf.toString('base64').slice(0, 40)), false);
    const pluginBackup = await require('../src/services/plugins/backup').exportAll();
    const entry = pluginBackup.find((e) => e.id === PID);
    assert.ok(entry.media_areas && entry.media_areas.files.some((x) => x.id === id));
    assert.deepEqual(require('../src/services/plugins/backup').validate([{ id: PID, media_areas: [] }]), [`Plugin "${PID}": invalid media areas`]);
    // lose the rows (and the local copy), restore them
    db().prepare('DELETE FROM plugin_media WHERE plugin = ? AND area = ?').run(PID, 'nas');
    db().prepare('DELETE FROM plugin_media_areas WHERE plugin = ? AND area = ?').run(PID, 'nas');
    fs.rmSync(media.fileOf(PID, id), { force: true });
    assert.ok(areas.importAreas(PID, exp) >= 1);
    const row = rowOf(id);
    assert.equal(row.target_id, tA);
    assert.equal(row.local, 0);
    assert.equal(row.path, 'a/b.bin');
    assert.ok((await get(id).expect(200)).body.equals(buf), 'readable from the target with the restored key');
  });

  it('"Alles löschen" removes the copies on targets and the areas', async () => {
    const keys = db().prepare('SELECT remote_key FROM plugin_media WHERE plugin = ? AND target_id IS NOT NULL').all(PID).map((r) => r.remote_key);
    assert.ok(keys.length);
    media.removeAll(PID);
    await areas.tick();
    for (const k of keys) assert.equal(fs.existsSync(path.join(folderA, k)), false, k);
    assert.equal(areas.rows(PID).length, 0);
  });
});
