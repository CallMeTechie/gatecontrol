'use strict';

// Readable files on storage targets (docs/plugins.md "Media areas", form
// 'files'): a folder target stands in for the NAS. The plain file under the
// plugin's path, reads straight from it, gc.media.move (rename on the
// target), gc.media.version (→ .gcdrive/versions), changes made on the target
// (scanArea: changed → new version, added, removed after a second scan, the
// mass guard, conflict copies), the journal (gc.media.areas.changes), switching
// the form, deletions that never hit a reused key, backups.

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

let app, agent, csrf, runtime, plugins, media, areas, targets, annaDev, tmp, nas, tN, tS3;
const API = '/api/v1/plugins';
const CLIENT = '/api/v1/client/plugins';
const PID = 'hello-files';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const MB = 1024 * 1024;

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}
const gc = async (fn, ...args) => (await agent.post(`${API}/${PID}/api/gc`).set('X-CSRF-Token', csrf).send({ fn, args })).body;
const put = (buf) => supertest(app).put(`${CLIENT}/${PID}/media`).set('X-API-Token', annaDev.raw).set('Content-Type', 'application/octet-stream').send(buf);
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
const onNas = (...p) => path.join(nas, PID, ...p);
const setArea = (area, body) => agent.put(`${API}/${PID}/media/areas/${area}`).set('X-CSRF-Token', csrf).send(body);
/** age a file on the "NAS" so a scan takes it (files changed in the last minute wait) */
const age = (p, ms = 5 * 60 * 1000) => { const t = new Date(Date.now() - ms); fs.utimesSync(p, t, t); };
const write = (rel, data) => { const p = onNas(...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); age(p); return p; };

async function addFile(buf, area, p) {
  const id = (await put(buf).expect(200)).body.mediaId;
  const r = await gc('media.claim', id, { area, path: p });
  assert.equal(r.ok, true, JSON.stringify(r));
  return id;
}

/** the worker until nothing is left to do */
async function settle() { for (let i = 0; i < 4; i++) await areas.tick(); }

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  media = require('../src/services/plugins/media');
  areas = require('../src/services/plugins/mediaAreas');
  targets = require('../src/services/storageTargets');
  const anna = H.makeUser('files-anna');
  annaDev = H.makeDevice(anna, { name: 'files-anna-phone' });
  await install(helloPackage({ overrides: {
    id: PID, name: { de: 'Hallo Dateien', en: 'Hello files' }, permissions: { ...clone(helloManifest.permissions), app: true },
    media: { maxBytes: 200 * MB, types: ['*/*'], quotaDefault: '1TB', areas: true },
  } }));
  assert.equal(await runtime.waitRunning(PID), true);
  await gc('storage.set', 'media-access', true);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-files-'));
  nas = path.join(tmp, 'nas');
  fs.mkdirSync(nas);
  tN = targets.create('local', { label: 'NAS', path: nas }).id;
  tS3 = targets.create('s3', { label: 'Bucket', endpoint: 'https://s3.example.com', region: 'eu-central-1', bucket: 'gc-bucket', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY' }).id;
});
after(async () => {
  await plugins.stop();
  teardown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the form of an area', () => {
  it('a folder / NAS gets readable files by default, S3 and this server only blocks', async () => {
    await gc('media.areas.ensure', 'docs', { label: 'Dokumente' });
    let r = await setArea('docs', { targetId: tN }).expect(200);
    assert.equal(r.body.area.form, 'files');
    assert.equal(r.body.area.encrypted, false);
    assert.deepEqual(r.body.area.scan, { at: null, error: null, stats: null });
    await gc('media.areas.ensure', 'cloud');
    assert.equal((await setArea('cloud', { targetId: tS3, form: 'files' }).expect(400)).body.code, 'invalid');
    r = await setArea('cloud', { targetId: tS3 }).expect(200);
    assert.equal(r.body.area.form, 'blocks');
    assert.equal(r.body.area.encrypted, true);
    r = await setArea('cloud', { targetId: null }).expect(200);
    assert.equal(r.body.area.form, 'blocks');
    const list = (await agent.get(`${API}/${PID}/media/areas`).expect(200)).body.targets;
    assert.deepEqual(list.map((t) => [t.label, t.files]).sort(), [['Bucket', false], ['NAS', true]]);
  });
});

describe('readable files on the NAS', () => {
  let id, plain;
  before(async () => {
    plain = crypto.randomBytes(150 * 1024 + 9);
    id = await addFile(plain, 'docs', 'Briefe/Brief 1.bin');
    await settle();
  });

  it('the plain file lies under its path; the target sees no other copy', () => {
    assert.ok(fs.readFileSync(onNas('docs', 'Briefe', 'Brief 1.bin')).equals(plain));
    const r = rowOf(id);
    assert.equal(r.stored_form, 'files');
    assert.equal(r.remote_key, `${PID}/docs/Briefe/Brief 1.bin`);
    assert.equal(r.remote_size, plain.length);
    assert.equal(areas.stateOf(r), 'target');
  });

  it('reads come straight from the NAS without filling the cache (whole and ranges)', async () => {
    db().prepare('UPDATE plugin_media SET local = 0 WHERE id = ?').run(id);
    fs.rmSync(media.fileOf(PID, id), { force: true });
    assert.ok((await get(id).expect(200)).body.equals(plain));
    assert.ok((await get(id, 'bytes=70000-140000').expect(206)).body.equals(plain.subarray(70000, 140001)));
    assert.equal(rowOf(id).local, 0);
  });

  it('gc.media.move renames on the NAS (no copy), refuses a taken path, moves into another area', async () => {
    let r = await gc('media.move', id, { path: 'Archiv/Brief 1.bin' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.path, 'Archiv/Brief 1.bin');
    assert.equal(r.result.stored, 'pending');
    await settle();
    assert.equal(fs.existsSync(onNas('docs', 'Briefe', 'Brief 1.bin')), false);
    assert.ok(fs.readFileSync(onNas('docs', 'Archiv', 'Brief 1.bin')).equals(plain));
    assert.equal(rowOf(id).local, 0, 'renamed, never downloaded');
    const other = await addFile(Buffer.from('anderes'), 'docs', 'Archiv/x.txt');
    assert.equal((await gc('media.move', other, { path: 'Archiv/Brief 1.bin' })).code, 'ERR_CONFLICT');
    await gc('media.areas.ensure', 'shared', { label: 'Geteilt' });
    await setArea('shared', { targetId: tN }).expect(200);
    r = await gc('media.move', other, { area: 'shared', path: 'neu.txt' });
    assert.equal(r.result.area, 'shared');
    await settle();
    assert.equal(fs.readFileSync(onNas('shared', 'neu.txt'), 'utf8'), 'anderes');
    assert.equal(fs.existsSync(onNas('docs', 'Archiv', 'x.txt')), false);
    assert.equal((await gc('media.claim', other, { area: 'docs' })).code, 'ERR_INVALID', 'claim does not move between areas');
  });

  it('gc.media.version keeps the file under .gcdrive/versions and frees the path', async () => {
    const r = await gc('media.version', id);
    assert.equal(r.result.path, null);
    assert.equal(r.result.versionOf, 'Archiv/Brief 1.bin');
    const next = await addFile(Buffer.from('neue Fassung'), 'docs', 'Archiv/Brief 1.bin');
    await settle();
    assert.equal(fs.readFileSync(onNas('docs', 'Archiv', 'Brief 1.bin'), 'utf8'), 'neue Fassung');
    const v = rowOf(id);
    assert.match(v.remote_key, new RegExp(`^${PID}/docs/\\.gcdrive/versions/Archiv/Brief 1 \\(\\d{4}-\\d\\d-\\d\\d \\d{6} ${id.slice(0, 6)}\\)\\.bin$`));
    assert.ok(fs.readFileSync(path.join(nas, v.remote_key)).equals(plain));
    assert.ok((await get(id).expect(200)).body.equals(plain), 'the version stays readable');
    assert.equal((await gc('media.move', id, {})).code, 'ERR_INVALID', 'a version moves only to a path');
    assert.equal((await gc('media.move', id, { path: 'Archiv/Brief 1.bin' })).code, 'ERR_CONFLICT', 'the path is taken by the new file');
    assert.ok(next);
  });

  it('a version comes back to a path (restore, since 1.207.0): the current file there again, on the NAS too', async () => {
    const cur = (await gc('media.info', id)).result;
    assert.equal(cur.versionOf, 'Archiv/Brief 1.bin');
    const newer = db().prepare("SELECT id FROM plugin_media WHERE plugin = ? AND path = 'Archiv/Brief 1.bin'").get(PID).id;
    assert.equal((await gc('media.version', newer)).ok, true);
    const r = await gc('media.move', id, { path: 'Archiv/Brief 1.bin' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.result.path, r.result.versionOf || null], ['Archiv/Brief 1.bin', null]);
    await settle();
    assert.ok(fs.readFileSync(onNas('docs', 'Archiv', 'Brief 1.bin')).equals(plain), 'the old bytes are the file again');
    assert.equal(rowOf(id).remote_key, `${PID}/docs/Archiv/Brief 1.bin`);
    assert.equal((await gc('media.info', newer)).result.versionOf, 'Archiv/Brief 1.bin', 'the newer one is a version now');
  });

  it('a file without a path (e.g. in a trash) and back', async () => {
    const t = await addFile(Buffer.from('weg und wieder'), 'docs', 'Papierkorb-Test.txt');
    await settle();
    let r = await gc('media.move', t, { path: null });
    assert.deepEqual([r.ok, r.result.path], [true, null]);
    await settle();
    assert.equal(fs.existsSync(onNas('docs', 'Papierkorb-Test.txt')), false, 'gone from its place on the NAS');
    assert.equal(rowOf(t).remote_key, `${PID}/docs/.gcdrive/files/${t.slice(0, 2)}/${t}`);
    r = await gc('media.move', t, { path: 'Papierkorb-Test.txt' });
    assert.equal(r.result.path, 'Papierkorb-Test.txt');
    await settle();
    assert.equal(fs.readFileSync(onNas('docs', 'Papierkorb-Test.txt'), 'utf8'), 'weg und wieder');
  });

  it('a name the NAS cannot hold is kept below .gcdrive/files', async () => {
    const odd = await addFile(Buffer.from('odd'), 'docs', 'Fragen: wer?.txt');
    await settle();
    assert.equal(rowOf(odd).remote_key, `${PID}/docs/.gcdrive/files/${odd.slice(0, 2)}/${odd}`);
    assert.equal((await gc('media.info', odd)).result.path, 'Fragen: wer?.txt');
  });

  it('a deleted file goes on the NAS; its path taken again at once is never deleted', async () => {
    const a = await addFile(Buffer.from('erste'), 'docs', 'wieder.txt');
    await settle();
    await gc('media.delete', a);
    const b = await addFile(Buffer.from('zweite'), 'docs', 'wieder.txt');
    await settle();
    assert.equal(fs.readFileSync(onNas('docs', 'wieder.txt'), 'utf8'), 'zweite');
    assert.equal(rowOf(b).remote_key, `${PID}/docs/wieder.txt`);
    assert.equal(db().prepare('SELECT COUNT(*) AS n FROM plugin_media_gone').get().n, 0);
  });
});

describe('changes made on the NAS', () => {
  before(async () => {
    await gc('media.areas.ensure', 'fam', { label: 'Familie' });
    await setArea('fam', { targetId: tN }).expect(200);
  });

  it('a file changed there becomes a new file; the old one a version (its bytes were still here)', async () => {
    const id = await addFile(Buffer.from('Fassung eins'), 'fam', 'Notiz.txt');
    await settle();
    let stats = await areas.scanArea(PID, 'fam');
    assert.equal(stats.changed, 0, 'our own upload is no change');
    const p = onNas('fam', 'Notiz.txt');
    fs.writeFileSync(p, 'Fassung zwei, länger');
    age(p, 3 * 60 * 1000);
    stats = await areas.scanArea(PID, 'fam');
    assert.equal(stats.changed, 1);
    const ch = (await gc('media.areas.changes', 'fam', { since: 0 })).result;
    const c = ch.changes.find((x) => x.type === 'changed');
    assert.equal(c.previous, id);
    assert.equal(c.path, 'Notiz.txt');
    const fresh = (await gc('media.info', c.mediaId)).result;
    assert.equal(fresh.path, 'Notiz.txt');
    assert.equal(fresh.mime, 'application/octet-stream', 'the type of the file it replaces');
    assert.equal((await get(c.mediaId).expect(200)).body.toString(), 'Fassung zwei, länger');
    const old = (await gc('media.info', id)).result;
    assert.equal(old.versionOf, 'Notiz.txt');
    await settle();
    assert.equal(fs.readFileSync(path.join(nas, rowOf(id).remote_key), 'utf8'), 'Fassung eins');
    assert.equal(fs.readFileSync(p, 'utf8'), 'Fassung zwei, länger', 'the NAS file stays as the person left it');
    assert.equal((await areas.scanArea(PID, 'fam')).changed, 0, 'taken in once');
  });

  it('a new file there is taken in at its path (type from the extension); one still being written waits', async () => {
    const p = write('fam/Urlaub/Strand.jpg', crypto.randomBytes(5000));
    const fresh = onNas('fam', 'Urlaub', 'neu.png');
    fs.writeFileSync(fresh, 'png');
    const stats = await areas.scanArea(PID, 'fam');
    assert.equal(stats.added, 1);
    const ch = (await gc('media.areas.changes', 'fam', { since: 0 })).result.changes.filter((c) => c.type === 'added');
    assert.deepEqual(ch.map((c) => c.path), ['Urlaub/Strand.jpg']);
    const info = (await gc('media.info', ch[0].mediaId)).result;
    assert.equal(info.mime, 'image/jpeg');
    assert.equal(info.claimed, true);
    assert.ok((await get(ch[0].mediaId).expect(200)).body.equals(fs.readFileSync(p)));
    age(fresh);
    assert.equal((await areas.scanArea(PID, 'fam')).added, 1, 'next scan');
  });

  it('a file deleted there is marked first and removed at the next scan', async () => {
    const id = await addFile(Buffer.from('weg'), 'fam', 'weg.txt');
    await settle();
    fs.rmSync(onNas('fam', 'weg.txt'));
    let stats = await areas.scanArea(PID, 'fam');
    assert.equal(stats.missing, 1);
    assert.ok(rowOf(id).missing_since);
    stats = await areas.scanArea(PID, 'fam');
    assert.equal(stats.removed, 1);
    assert.equal(rowOf(id), undefined);
    const last = (await gc('media.areas.changes', 'fam', { since: 0 })).result.changes.pop();
    assert.deepEqual([last.type, last.mediaId, last.path], ['removed', id, 'weg.txt']);
  });

  it('a file that comes back before the second scan stays', async () => {
    const id = await addFile(Buffer.from('kurz weg'), 'fam', 'kurz.txt');
    await settle();
    const p = onNas('fam', 'kurz.txt');
    const keep = fs.readFileSync(p);
    fs.rmSync(p);
    await areas.scanArea(PID, 'fam');
    fs.writeFileSync(p, keep);
    age(p);
    db().prepare('UPDATE plugin_media SET remote_mtime = NULL WHERE id = ?').run(id);
    await areas.scanArea(PID, 'fam');
    assert.equal(rowOf(id).missing_since, null);
    await areas.scanArea(PID, 'fam');
    assert.ok(rowOf(id));
  });

  it('many files gone at once need the administrator: mass_missing, then confirm-removals', async () => {
    await gc('media.areas.ensure', 'bulk');
    await setArea('bulk', { targetId: tN }).expect(200);
    for (let i = 0; i < 60; i++) write(`bulk/f${i}.txt`, `x${i}`);
    assert.equal((await areas.scanArea(PID, 'bulk')).added, 60);
    fs.rmSync(onNas('bulk'), { recursive: true });
    await areas.scanArea(PID, 'bulk');
    const stats = await areas.scanArea(PID, 'bulk');
    assert.equal(stats.removed, 0);
    let info = (await agent.get(`${API}/${PID}/media/areas`).expect(200)).body.areas.find((a) => a.area === 'bulk');
    assert.equal(info.scan.error, 'mass_missing');
    assert.equal(info.count, 60);
    const r = await agent.post(`${API}/${PID}/media/areas/bulk/confirm-removals`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(r.body.stats.removed, 60);
    info = r.body.area;
    assert.equal(info.count, 0);
    assert.equal(info.scan.error, null);
  });

  it('a file put on the NAS where the area still wants to put one becomes a conflict copy', async () => {
    const id = (await put(Buffer.from('vom Handy')).expect(200)).body.mediaId;
    await gc('media.claim', id, { area: 'fam', path: 'Konflikt.txt' });
    write('fam/Konflikt.txt', 'von der NAS');
    await areas.scanArea(PID, 'fam');
    const added = (await gc('media.areas.changes', 'fam', { since: 0 })).result.changes.filter((c) => c.type === 'added').pop();
    assert.match(added.path, /^Konflikt \(Konflikt \d{4}-\d\d-\d\d \d{6}\)\.txt$/);
    assert.equal(fs.readFileSync(onNas('fam', ...added.path.split('/')), 'utf8'), 'von der NAS');
    await settle();
    assert.equal(fs.readFileSync(onNas('fam', 'Konflikt.txt'), 'utf8'), 'vom Handy');
  });

  it('the admin route scans now; the journal pages; the plugin hook is optional', async () => {
    write('fam/spaet.txt', 'später');
    const r = await agent.post(`${API}/${PID}/media/areas/fam/scan`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(r.body.stats.added, 1);
    assert.ok(r.body.area.scan.at);
    const all = (await gc('media.areas.changes', 'fam', { since: 0, limit: 2 })).result;
    assert.equal(all.changes.length, 2);
    assert.equal(all.more, true);
    const rest = (await gc('media.areas.changes', 'fam', { since: all.next, limit: 1000 })).result;
    assert.equal(rest.more, false);
    assert.ok(rest.changes.every((c) => c.seq > all.next));
    assert.equal((await gc('media.areas.scan', 'fam')).ok, true);
    assert.equal((await gc('media.areas.changes', 'nope')).code, 'ERR_INVALID');
  });
});

describe('switching the form', () => {
  it('readable → blocks: the files are sealed under opaque keys, the plain ones go; and back', async () => {
    await gc('media.areas.ensure', 'sw');
    await setArea('sw', { targetId: tN }).expect(200);
    const data = crypto.randomBytes(70000);
    const id = await addFile(data, 'sw', 'Ordner/a.bin');
    await settle();
    assert.ok(fs.existsSync(onNas('sw', 'Ordner', 'a.bin')));
    let r = await setArea('sw', { form: 'blocks' }).expect(200);
    assert.equal(r.body.area.state, 'moving');
    await settle();
    r = rowOf(id);
    assert.equal(r.stored_form, 'blocks');
    assert.equal(r.remote_key, `${PID}/sw/${id.slice(0, 2)}/${id}`);
    assert.equal(fs.existsSync(onNas('sw', 'Ordner', 'a.bin')), false);
    assert.equal(fs.readFileSync(path.join(nas, r.remote_key)).includes(data.subarray(0, 64)), false);
    assert.equal(areas.info(PID, 'sw').form, 'blocks');
    db().prepare('UPDATE plugin_media SET local = 0 WHERE id = ?').run(id);
    fs.rmSync(media.fileOf(PID, id), { force: true });
    await setArea('sw', { form: 'files' }).expect(200);
    await settle();
    assert.ok(fs.readFileSync(onNas('sw', 'Ordner', 'a.bin')).equals(data));
    assert.equal(rowOf(id).stored_form, 'files');
  });

  it('back to this server: a readable file comes home sealed (and must still be what was stored)', async () => {
    const id = await addFile(Buffer.from('nach Hause'), 'sw', 'heim.txt');
    await settle();
    db().prepare('UPDATE plugin_media SET local = 0 WHERE id = ?').run(id);
    fs.rmSync(media.fileOf(PID, id), { force: true });
    const changed = await addFile(Buffer.from('original!'), 'sw', 'geaendert.txt');
    await settle();
    db().prepare('UPDATE plugin_media SET local = 0 WHERE id = ?').run(changed);
    fs.rmSync(media.fileOf(PID, changed), { force: true });
    fs.writeFileSync(onNas('sw', 'geaendert.txt'), 'veraendert'); // same length
    await setArea('sw', { targetId: null }).expect(200);
    await settle();
    assert.equal(rowOf(id).target_id, null);
    assert.equal(rowOf(id).local, 1);
    assert.equal((await get(id).expect(200)).body.toString(), 'nach Hause');
    assert.equal(rowOf(changed).push_error, 'changed');
    assert.equal(areas.rowOf(PID, 'sw').scanned_at, null, 'a scan is due');
  });
});

describe('backup', () => {
  it('the form, the readable keys and the versions come back', async () => {
    const exp = areas.exportAreas(PID);
    assert.equal(exp.areas.find((a) => a.area === 'docs').form, 'files');
    const v = exp.files.find((f) => f.version_of === 'Archiv/Brief 1.bin');
    assert.ok(v && v.stored_form === 'files');
    const before = rowOf(v.id);
    db().prepare('DELETE FROM plugin_media WHERE id = ?').run(v.id);
    assert.ok(areas.importAreas(PID, { areas: exp.areas, files: [v] }) === 1);
    const after = rowOf(v.id);
    assert.deepEqual([after.stored_form, after.remote_key, after.version_of, after.want_key], [before.stored_form, before.remote_key, before.version_of, before.want_key]);
  });
});
