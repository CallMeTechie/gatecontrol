'use strict';

// "Meine Orte" (docs/feature-user-profile.md "Meine Orte", services/places.js, services/placeSearch.js):
//   * migration 158: user_places / user_place_usage, ON DELETE CASCADE, detect
//   * the service: point required and valid (never 0/0), radius 50–2000, at most 100, name unique per person
//     without regard to case, events placesChanged (hook) and `places` (control event to the owner's apps)
//   * the endpoints under /api/v1/me, /api/v1/portal/me and /api/v1/client/me — own places only; "?shared=1" and the
//     levels self / family / all; DELETE 409 IN_USE with usedBy, ?force=1
//   * gc.places (permissions.places): list / get / resolve / markUsed / reportUsage / importFor, refused without
//   * the address search with a stand-in transport: rounding, User-Agent, cache, one request at a time, limits
//   * "Meine Daten" and the settings of the administrator
// Made-up names and addresses only.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');

let app, agent, csrf, db, places, search, hostApi;
const PLUGIN = (perms, id = 'gatecontrol-notizen') => ({ id, manifest: { permissions: { ...perms } } });
const WITH = PLUGIN({ places: true });

const client = (dev) => ({
  get: (p) => supertest(app).get(p).set('X-API-Token', dev.raw).set('Accept-Language', 'de'),
  post: (p) => supertest(app).post(p).set('X-API-Token', dev.raw).set('Accept-Language', 'de'),
  patch: (p) => supertest(app).patch(p).set('X-API-Token', dev.raw).set('Accept-Language', 'de'),
  del: (p) => supertest(app).delete(p).set('X-API-Token', dev.raw).set('Accept-Language', 'de'),
});

function family(...ids) {
  const groups = require('../src/services/groups');
  const g = groups.create({ name: H.uniq('Familie'), kind: 'family' }, {});
  ids.forEach((id, i) => groups.setMember(g.id, id, i === 0 ? 'parent' : 'child', {}));
  return g.id;
}
const HOME_PT = { lat: 50.110922, lon: 8.682127 };
const place = (name, extra) => ({ name, lat: HOME_PT.lat, lon: HOME_PT.lon, ...(extra || {}) });

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  places = require('../src/services/places');
  search = require('../src/services/placeSearch');
  hostApi = require('../src/services/plugins/hostApi');
});
after(() => { search._setTransport(null); teardown(); });

describe('migration 158', () => {
  it('creates user_places and user_place_usage; detect recognises it', () => {
    const m = require('../src/db/migrationList').migrations.find((x) => x.version === 158);
    assert.equal(m.name, 'user_places');
    assert.equal(m.detect(db), true);
    const cols = db.prepare('PRAGMA table_info(user_places)').all().map((c) => c.name);
    for (const c of ['id', 'user_id', 'name', 'name_lc', 'icon', 'lat', 'lon', 'radius_m', 'address', 'visibility', 'source', 'source_ref', 'created_at', 'updated_at', 'last_used_at']) assert.ok(cols.includes(c), c);
    assert.deepEqual(db.prepare('PRAGMA table_info(user_place_usage)').all().map((c) => c.name), ['place_id', 'plugin', 'kind', 'count', 'updated_at']);
  });

  it('places and their usage go with the user (ON DELETE CASCADE)', () => {
    const u = H.makeUser('pl-gone');
    const p = places.create(u, place('Zuhause'));
    places.reportUsage('gatecontrol-notizen', { userId: u, id: p.id, kind: 'task', count: 2 });
    require('../src/services/users').remove(u);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM user_places WHERE user_id = ?').get(u).c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM user_place_usage WHERE place_id = ?').get(p.id).c, 0);
  });
});

describe('the service', () => {
  it('a place: defaults, the answer form, the reference', () => {
    const u = H.makeUser('pl-form');
    const p = places.create(u, place('Arbeit', { address: 'Hafenstraße 4, Musterstadt' }));
    assert.deepEqual({ ...p, createdAt: null, updatedAt: null }, {
      id: p.id, ref: `profile:${p.id}`, name: 'Arbeit', icon: 'pin', lat: HOME_PT.lat, lon: HOME_PT.lon, radiusM: 150,
      address: 'Hafenstraße 4, Musterstadt', visibility: 'self', source: 'manual', usedBy: [], createdAt: null, updatedAt: null, lastUsedAt: null,
    });
    assert.equal(places.parseRef(p.ref), p.id);
    assert.equal(places.parseRef('profile:0'), null);
    assert.equal(places.parseRef('familie:3'), null);
  });

  it('no place without a valid point; never 0/0; radius 50–2000; known icon and level; unknown keys refused', () => {
    const u = H.makeUser('pl-rules');
    const bad = (input, field) => assert.throws(() => places.create(u, input), (e) => e.code === 'ERR_INVALID' && e.field === field, JSON.stringify(input));
    bad({ name: 'Ohne Punkt' }, 'lat');
    bad({ name: 'Halb', lat: 50.1 }, 'lon');
    bad({ name: 'Null', lat: 0, lon: 0 }, 'lat');
    bad({ name: 'Zu weit', lat: 91, lon: 8 }, 'lat');
    bad({ name: 'Zu weit', lat: 50, lon: -180.5 }, 'lon');
    bad({ name: 'Text', lat: 'fünfzig', lon: 8 }, 'lat');
    bad({ name: 'NaN', lat: Number.NaN, lon: 8 }, 'lat');
    bad(place('Klein', { radiusM: 49 }), 'radiusM');
    bad(place('Groß', { radiusM: 2001 }), 'radiusM');
    bad(place('Symbol', { icon: 'rocket' }), 'icon');
    bad(place('Ebene', { visibility: 'friends' }), 'visibility');
    bad(place('x'.repeat(61)), 'name');
    bad(place('   '), 'name');
    bad(place('Adresse', { address: 'a'.repeat(201) }), 'address');
    bad({ ...place('Fremd'), owner: 1 }, 'owner');
    // 0 on one axis is a real place (the equator, Greenwich)
    assert.equal(places.create(u, { name: 'Greenwich', lat: 51.4779, lon: 0 }).lon, 0);
    assert.equal(places.create(u, place('Rand', { radiusM: 2000 })).radiusM, 2000);
    assert.equal(places.create(u, { name: 'Strings', lat: '50.5', lon: '8.25', radiusM: '50' }).radiusM, 50);
  });

  it('a name only once per person — without regard to case; another person may use it', () => {
    const u = H.makeUser('pl-dup');
    const v = H.makeUser('pl-dup2');
    const a = places.create(u, place('Baumarkt'));
    assert.throws(() => places.create(u, place('BAUMARKT')), (e) => e.code === 'ERR_DUPLICATE' && e.field === 'name');
    const b = places.create(u, place('Bäckerei'));
    assert.throws(() => places.update(u, b.id, { name: 'baumarkt' }), (e) => e.code === 'ERR_DUPLICATE');
    assert.equal(places.update(u, a.id, { name: 'baumarkt' }).name, 'baumarkt', 'its own name in another case');
    assert.equal(places.create(v, place('Baumarkt')).name, 'Baumarkt');
  });

  it('at most 100 places', () => {
    const u = H.makeUser('pl-limit');
    const ins = db.prepare("INSERT INTO user_places (user_id, name, name_lc, lat, lon) VALUES (?, ?, ?, 50.1, 8.6)");
    for (let i = 0; i < 100; i++) ins.run(u, `Ort ${i}`, `ort ${i}`);
    assert.throws(() => places.create(u, place('Einer zu viel')), (e) => e.code === 'ERR_LIMIT');
  });

  it('update: lat and lon only together; somebody else\'s place is not found', () => {
    const u = H.makeUser('pl-upd');
    const v = H.makeUser('pl-upd2');
    const p = places.create(u, place('Schule', { icon: 'school' }));
    assert.throws(() => places.update(u, p.id, { lat: 51 }), (e) => e.code === 'ERR_INVALID' && e.field === 'lon');
    const q = places.update(u, p.id, { lat: 51.5, lon: 7.25, radiusM: 300, visibility: 'family', address: null });
    assert.deepEqual([q.lat, q.lon, q.radiusM, q.visibility, q.address, q.icon], [51.5, 7.25, 300, 'family', null, 'school']);
    assert.throws(() => places.update(v, p.id, { name: 'Meins' }), (e) => e.code === 'ERR_NOT_FOUND');
    assert.throws(() => places.remove(v, p.id), (e) => e.code === 'ERR_NOT_FOUND');
    assert.throws(() => places.getOwn(u, 'abc'), (e) => e.code === 'ERR_NOT_FOUND');
  });

  it('the activity log names the place\'s id — never its name, address or point', () => {
    const u = H.makeUser('pl-log');
    const p = places.create(u, place('Geheimer Garten', { address: 'Lindenweg 12' }));
    places.update(u, p.id, { radiusM: 400 });
    places.remove(u, p.id);
    const log = db.prepare("SELECT event_type, message, details FROM activity_log WHERE event_type LIKE 'place_%' AND json_extract(details, '$.userId') = ?").all(u);
    assert.deepEqual(log.map((r) => r.event_type), ['place_added', 'place_changed', 'place_removed']);
    assert.doesNotMatch(JSON.stringify(log), /Geheimer|Lindenweg|50\.11|8\.68/);
  });

  it('events: the hook placesChanged to running plugins with permissions.places, the control event to the owner\'s apps', async () => {
    const registry = require('../src/services/plugins/registry');
    const rt = require('../src/services/plugins/runtime');
    const stream = require('../src/services/notify/stream');
    const u = H.makeUser('pl-ev');
    const calls = [];
    const written = [];
    const orig = { list: registry.list, info: rt.info, call: rt.call, slist: stream.list, write: stream.writeEvent };
    registry.list = () => [
      { id: 'mit-orten', enabled: true, manifest: { permissions: { places: true } } },
      { id: 'ohne-orte', enabled: true, manifest: { permissions: { users: true } } },
      { id: 'aus', enabled: false, manifest: { permissions: { places: true } } },
    ];
    rt.info = () => ({ state: 'running' });
    // only this person's events (earlier tests may still have one on its way)
    rt.call = (id, hook, payload) => { if (payload.userId === u) calls.push({ id, hook, payload }); return Promise.resolve({}); };
    const mine = { tokenId: 901, userId: u, closed: false };
    const sender = { tokenId: 902, userId: u, closed: false };
    const other = { tokenId: 903, userId: u + 1000, closed: false };
    stream.list = () => [mine, sender, other];
    stream.writeEvent = (conn, ev, data) => { written.push({ tokenId: conn.tokenId, ev, data }); return true; };
    try {
      const p = places.create(u, place('Ankunft'), { exceptToken: 902 });
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(calls, [{ id: 'mit-orten', hook: 'placesChanged', payload: { userId: u, ids: [p.id], deleted: false } }]);
      assert.deepEqual(written, [{ tokenId: 901, ev: 'control', data: { type: 'places', ids: [p.id], deleted: false } }]);
      calls.length = 0; written.length = 0;
      places.remove(u, p.id);
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(calls.map((c) => c.payload), [{ userId: u, ids: [p.id], deleted: true }]);
      assert.deepEqual(written.map((w) => w.data), [{ type: 'places', ids: [p.id], deleted: true }, { type: 'places', ids: [p.id], deleted: true }]);
      // "zuletzt genutzt" is no change
      const q = places.create(u, place('Ruhig'));
      await new Promise((r) => setImmediate(r));
      calls.length = 0; written.length = 0;
      assert.ok(places.markUsed(u, q.id).lastUsedAt);
      await new Promise((r) => setImmediate(r));
      assert.deepEqual([calls.length, written.length], [0, 0]);
    } finally {
      registry.list = orig.list; rt.info = orig.info; rt.call = orig.call; stream.list = orig.slist; stream.writeEvent = orig.write;
    }
  });
});

describe('the endpoints', () => {
  let anna, ben, kim, stranger, phone, kimPhone;
  before(() => {
    anna = H.makeUser('pl-anna');
    ben = H.makeUser('pl-ben');
    kim = H.makeUser('pl-kim');
    stranger = H.makeUser('pl-fremd');
    family(anna, ben);
    phone = H.makeDevice(anna, { name: 'pl-phone' });
    kimPhone = H.makeDevice(kim, { name: 'pl-kim-phone' });
  });

  it('app: create, read, change, mark used, delete — own places only', async () => {
    const add = await client(phone).post('/api/v1/client/me/profile/places').send(place('Zuhause', { icon: 'home', radiusM: 120, address: 'Lindenweg 12' })).expect(201);
    const p = add.body.place;
    assert.deepEqual([p.name, p.icon, p.radiusM, p.ref], ['Zuhause', 'home', 120, `profile:${p.id}`]);
    const list = await client(phone).get('/api/v1/client/me/profile/places').expect(200);
    assert.deepEqual(list.body.places.map((x) => x.id), [p.id]);
    assert.equal(list.body.family, true);
    assert.equal(list.body.search, 'osm');
    assert.deepEqual(list.body.limits, { places: 100, name: 60, address: 200, radius: { min: 50, max: 2000, default: 150 } });
    assert.deepEqual(list.body.options.icons, ['home', 'work', 'school', 'gym', 'shop', 'family', 'pin']);
    assert.equal(list.body.shared, undefined);
    const ch = await client(phone).patch(`/api/v1/client/me/profile/places/${p.id}`).send({ radiusM: 200, visibility: 'family' }).expect(200);
    assert.deepEqual([ch.body.place.radiusM, ch.body.place.visibility], [200, 'family']);
    const used = await client(phone).post(`/api/v1/client/me/profile/places/${p.id}/used`).expect(200);
    assert.ok(used.body.place.lastUsedAt);
    assert.equal((await client(phone).get(`/api/v1/client/me/profile/places/${p.id}`).expect(200)).body.place.id, p.id);
    // somebody else's place: not found, never "exists"
    await client(kimPhone).get(`/api/v1/client/me/profile/places/${p.id}`).expect(404);
    await client(kimPhone).patch(`/api/v1/client/me/profile/places/${p.id}`).send({ name: 'Meins' }).expect(404);
    await client(kimPhone).del(`/api/v1/client/me/profile/places/${p.id}`).expect(404);
    await client(kimPhone).post(`/api/v1/client/me/profile/places/${p.id}/used`).expect(404);
    const bad = await client(phone).post('/api/v1/client/me/profile/places').send({ name: 'Ohne Punkt' }).expect(400);
    assert.deepEqual([bad.body.code, bad.body.field], ['INVALID', 'lat']);
    assert.match(bad.body.error, /Punkt/);
    const zero = await client(phone).post('/api/v1/client/me/profile/places').send({ name: 'Null', lat: 0, lon: 0 }).expect(400);
    assert.equal(zero.body.code, 'INVALID');
    const dup = await client(phone).post('/api/v1/client/me/profile/places').send(place('zuhause')).expect(409);
    assert.deepEqual([dup.body.code, dup.body.field], ['DUPLICATE', 'name']);
    await client(phone).del(`/api/v1/client/me/profile/places/${p.id}`).expect(200);
    await client(phone).del(`/api/v1/client/me/profile/places/${p.id}`).expect(404);
    // without a token: nothing
    await supertest(app).get('/api/v1/client/me/profile/places').expect(401);
  });

  it('DELETE of a place in use: 409 IN_USE with usedBy, ?force=1 deletes it', async () => {
    const add = await client(phone).post('/api/v1/client/me/profile/places').send(place('Arbeit', { icon: 'work' })).expect(201);
    const id = add.body.place.id;
    const registry = require('../src/services/plugins/registry');
    const orig = registry.list;
    registry.list = () => [{ id: 'gatecontrol-notizen', enabled: true, manifest: { name: { de: 'Notizen', en: 'Notes' }, permissions: { places: true } } }];
    try {
      places.reportUsage('gatecontrol-notizen', { userId: anna, id, kind: 'task', count: 2 });
      // a plugin no longer installed does not count
      places.reportUsage('gatecontrol-alt', { userId: anna, id, kind: 'task', count: 9 });
      const r = await client(phone).del(`/api/v1/client/me/profile/places/${id}`).expect(409);
      assert.equal(r.body.code, 'IN_USE');
      assert.deepEqual(r.body.usedBy, [{ plugin: 'gatecontrol-notizen', pluginName: 'Notizen', kind: 'task', count: 2 }]);
      const l = await client(phone).get('/api/v1/client/me/profile/places').expect(200);
      assert.deepEqual(l.body.places.find((x) => x.id === id).usedBy, r.body.usedBy);
      await client(phone).del(`/api/v1/client/me/profile/places/${id}?force=1`).expect(200);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM user_place_usage WHERE place_id = ?').get(id).c, 0);
    } finally { registry.list = orig; }
  });

  it('?shared=1: places of others by their level — family, everybody, never "Nur ich"', async () => {
    const own = places.create(ben, place('Bens Büro', { visibility: 'self' }));
    const fam = places.create(ben, place('Bens Garten', { visibility: 'family' }));
    const all = places.create(ben, place('Bens Verein', { visibility: 'all' }));
    const r = await client(phone).get('/api/v1/client/me/profile/places?shared=1').expect(200);
    const shared = r.body.shared.filter((x) => x.ownerId === ben);
    assert.deepEqual(shared.map((x) => x.id).sort(), [fam.id, all.id].sort());
    assert.ok(shared.every((x) => x.own === false && x.usedBy === undefined && typeof x.ownerName === 'string'));
    const k = await client(kimPhone).get('/api/v1/client/me/profile/places?shared=1').expect(200);
    assert.deepEqual(k.body.shared.filter((x) => x.ownerId === ben).map((x) => x.id), [all.id]);
    assert.equal(k.body.family, false);
    // a disabled account's places are nobody's to see
    db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(ben);
    const off = await client(kimPhone).get('/api/v1/client/me/profile/places?shared=1').expect(200);
    assert.equal(off.body.shared.filter((x) => x.ownerId === ben).length, 0);
    db.prepare('UPDATE users SET enabled = 1 WHERE id = ?').run(ben);
    assert.ok(!r.body.shared.some((x) => x.id === own.id));
    void stranger;
  });

  it('web session (/api/v1/me) and portal (/api/v1/portal/me): the same, with CSRF', async () => {
    const r = await agent.post('/api/v1/me/profile/places').set('X-CSRF-Token', csrf).send(place('Admin-Ort')).expect(201);
    await agent.post('/api/v1/me/profile/places').send(place('Ohne CSRF')).expect(403);
    const l = await agent.get('/api/v1/me/profile/places').expect(200);
    assert.ok(l.body.places.some((x) => x.id === r.body.place.id));
    await agent.delete(`/api/v1/me/profile/places/${r.body.place.id}`).set('X-CSRF-Token', csrf).expect(200);

    const config = require('../config/default');
    const HOME = `home.${config.dns.domain}`;
    const dev = H.makeDevice(anna, { name: 'pl-portal-phone' });
    const link = await supertest(app).post('/api/v1/client/portal-link').set('Authorization', `Bearer ${dev.raw}`).send({}).expect(200);
    const a = supertest.agent(app);
    await a.get('/auto?t=' + new URL(link.body.url).searchParams.get('t')).set('Host', HOME).set('X-GC-Portal-Peer-IP', dev.ip).expect(302);
    const page = await a.get('/portal').set('Host', HOME).set('X-GC-Portal-Peer-IP', dev.ip).expect(200);
    assert.match(page.text, /id="panel-orte"[^>]*data-extra/);
    assert.match(page.text, /href="#orte" data-goto="orte"/);
    assert.match(page.text, /"tiles":"\/plugins\/_shared\/tiles\/[0-9]+\.[A-Za-z0-9_-]+\/\{z\}\/\{x\}\/\{y\}\.png"/);
    const tok = (page.text.match(/"csrf":"([^"]+)"/) || [])[1];
    const at = (req) => req.set('Host', HOME).set('X-GC-Portal-Peer-IP', dev.ip);
    await at(a.post('/api/v1/portal/me/profile/places')).send(place('Portal-Ort')).expect(403);
    const c = await at(a.post('/api/v1/portal/me/profile/places')).set('X-CSRF-Token', tok).send(place('Portal-Ort')).expect(201);
    const pl = await at(a.get('/api/v1/portal/me/profile/places')).expect(200);
    assert.ok(pl.body.places.some((x) => x.id === c.body.place.id));
    await at(supertest(app).get('/api/v1/portal/me/profile/places')).expect(401);
  });

  it('"Meine Daten" carries the places with "Genutzt von"', async () => {
    const p = places.create(anna, place('Export-Ort', { address: 'Am Markt 7' }));
    const r = await client(phone).get('/api/v1/client/me/profile/export').expect(200);
    const data = JSON.parse(r.text);
    const x = data.places.find((y) => y.id === p.id);
    assert.deepEqual([x.name, x.address, x.lat, x.lon, x.ref], ['Export-Ort', 'Am Markt 7', HOME_PT.lat, HOME_PT.lon, `profile:${p.id}`]);
    assert.ok(Array.isArray(x.usedBy));
  });
});

describe('gc.places (permissions.places)', () => {
  let owner, member, outsider, p1, p2, p3, origList;
  after(() => { require('../src/services/plugins/registry').list = origList; });
  before(() => {
    // "Genutzt von" counts installed plugins only
    const registry = require('../src/services/plugins/registry');
    origList = registry.list;
    registry.list = () => ['gatecontrol-notizen', 'gatecontrol-messenger'].map((id) => ({ id, enabled: true, manifest: { name: { de: id, en: id }, permissions: { places: true } } }));
    owner = H.makeUser('pl-gc-owner');
    member = H.makeUser('pl-gc-member');
    outsider = H.makeUser('pl-gc-outsider');
    family(owner, member);
    p1 = places.create(owner, place('Nur meins', { visibility: 'self' }));
    p2 = places.create(owner, place('Für die Familie', { visibility: 'family' }));
    p3 = places.create(owner, place('Für alle', { visibility: 'all' }));
  });
  const call = (api, args, plugin = WITH) => hostApi.handle(plugin, api, args);

  it('refused without the permission — every method', async () => {
    for (const api of ['places.list', 'places.get', 'places.resolve', 'places.markUsed', 'places.reportUsage', 'places.importFor']) {
      await assert.rejects(call(api, { userId: owner, id: p1.id, ref: p1.ref }, PLUGIN({ users: true, profile: ['firstName'] })), (e) => e.code === 'ERR_PLACES_DENIED', api);
    }
  });

  it('the manifest knows the permission (a boolean)', () => {
    const { validate: validateManifest } = require('../src/services/plugins/manifest');
    const base = { id: 'orte-test', name: 'Orte', version: '1.0.0', publisher: 'Test', gatecontrol: '>=1.0.0', entry: 'index.js' };
    const ok = validateManifest({ ...base, permissions: { places: true } });
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));
    assert.equal(ok.manifest.permissions.places, true);
    assert.equal(validateManifest({ ...base }).manifest.permissions.places, false);
    const bad = validateManifest({ ...base, permissions: { places: 'ja' } });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.includes('permissions.places: invalid'));
  });

  it('list / get / resolve by the viewer\'s levels', async () => {
    const mine = await call('places.list', { userId: owner, owner });
    assert.deepEqual(mine.map((x) => x.id).sort(), [p1.id, p2.id, p3.id].sort());
    assert.ok(mine.every((x) => x.own === true && Array.isArray(x.usedBy)));
    const fam = (await call('places.list', { userId: member })).filter((x) => x.ownerId === owner);
    assert.deepEqual(fam.map((x) => x.id).sort(), [p2.id, p3.id].sort());
    const out = (await call('places.list', { userId: outsider })).filter((x) => x.ownerId === owner);
    assert.deepEqual(out.map((x) => x.id), [p3.id]);
    assert.equal(await call('places.get', { userId: outsider, id: p1.id }), null);
    assert.equal(await call('places.get', { userId: member, id: p1.id }), null);
    assert.equal((await call('places.get', { userId: member, id: p2.id })).name, 'Für die Familie');
    assert.equal((await call('places.get', { userId: owner, id: p1.id })).name, 'Nur meins');
    assert.equal(await call('places.get', { userId: owner, id: 99999999 }), null);
    // resolve: with a person by that person's levels, without one any place (the plugin keeps the reference)
    assert.equal(await call('places.resolve', { ref: p1.ref, userId: outsider }), null);
    const r = await call('places.resolve', { ref: p1.ref });
    assert.deepEqual([r.id, r.ownerId, r.lat, r.lon, r.radiusM], [p1.id, owner, HOME_PT.lat, HOME_PT.lon, 150]);
    assert.equal(await call('places.resolve', { ref: 'profile:99999999' }), null);
    await assert.rejects(call('places.resolve', { ref: 'familie:1' }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(call('places.list', { userId: 'abc' }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(call('places.list', { userId: 99999999 }), (e) => e.code === 'ERR_NOT_FOUND');
  });

  it('markUsed for the owner only', async () => {
    const r = await call('places.markUsed', { userId: owner, id: p1.id });
    assert.equal(r.id, p1.id);
    assert.ok(r.lastUsedAt);
    await assert.rejects(call('places.markUsed', { userId: member, id: p2.id }), (e) => e.code === 'ERR_NOT_FOUND');
  });

  it('reportUsage: absolute per plugin and kind, 0 removes it; only a place the person may see', async () => {
    const a = await call('places.reportUsage', { userId: owner, id: p2.id, kind: 'task', count: 3 });
    assert.deepEqual(a.usedBy.map((x) => [x.plugin, x.kind, x.count]), [['gatecontrol-notizen', 'task', 3]]);
    await call('places.reportUsage', { userId: member, id: p2.id, kind: 'task', count: 1 });
    const other = PLUGIN({ places: true }, 'gatecontrol-messenger');
    const b = await call('places.reportUsage', { userId: owner, id: p2.id, kind: 'location_message', count: 1 }, other);
    assert.deepEqual(b.usedBy.map((x) => [x.plugin, x.kind, x.count]), [['gatecontrol-messenger', 'location_message', 1], ['gatecontrol-notizen', 'task', 1]]);
    const c = await call('places.reportUsage', { userId: owner, id: p2.id, kind: 'task', count: 0 });
    assert.deepEqual(c.usedBy.map((x) => x.plugin), ['gatecontrol-messenger']);
    await assert.rejects(call('places.reportUsage', { userId: outsider, id: p2.id, kind: 'task', count: 1 }), (e) => e.code === 'ERR_NOT_FOUND');
    await assert.rejects(call('places.reportUsage', { userId: owner, id: p2.id, kind: 'Aufgabe!', count: 1 }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(call('places.reportUsage', { userId: owner, id: p2.id, kind: 'task', count: -1 }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(call('places.reportUsage', { userId: owner, id: p2.id, kind: 'task', count: 1.5 }), (e) => e.code === 'ERR_INVALID');
  });

  it('importFor: idempotent over source + sourceRef; a name in use gets a number; no point → skipped', async () => {
    const u = H.makeUser('pl-import');
    places.create(u, place('Baumarkt'));
    const list = [
      { sourceRef: 'n-1', name: 'Baumarkt', lat: 50.12, lon: 8.7, radiusM: 120, address: 'Industriestraße 20' },
      { sourceRef: 'n-2', name: 'Fitnessstudio', lat: 50.13, lon: 8.71, icon: 'gym' },
      { sourceRef: 'n-3', name: 'Arbeit' },
      { sourceRef: 'n-4', name: 'Nirgendwo', lat: 0, lon: 0 },
      { name: 'Ohne Herkunft', lat: 50.1, lon: 8.6 },
      { sourceRef: 'n-2', name: 'Doppelt', lat: 50.1, lon: 8.6 },
    ];
    const r = await call('places.importFor', { userId: u, places: list, source: 'notizen' });
    assert.deepEqual(Object.keys(r.map).sort(), ['n-1', 'n-2']);
    assert.ok(r.map['n-1'].created && r.map['n-2'].created);
    assert.equal(r.map['n-1'].ref, `profile:${r.map['n-1'].id}`);
    assert.deepEqual(r.skipped, [
      { sourceRef: 'n-3', reason: 'invalid', field: 'lat' },
      { sourceRef: 'n-4', reason: 'invalid', field: 'lat' },
      { sourceRef: null, reason: 'invalid', field: 'sourceRef' },
      { sourceRef: 'n-2', reason: 'invalid', field: 'sourceRef' },
    ]);
    const own = places.listOwn(u).places;
    const b2 = own.find((x) => x.id === r.map['n-1'].id);
    assert.deepEqual([b2.name, b2.source, b2.radiusM, b2.address], ['Baumarkt 2', 'notizen', 120, 'Industriestraße 20']);
    // again: the same mapping, nothing new
    const again = await call('places.importFor', { userId: u, places: list.slice(0, 2), source: 'notizen' });
    assert.deepEqual(again.map, { 'n-1': { ...r.map['n-1'], created: false }, 'n-2': { ...r.map['n-2'], created: false } });
    assert.equal(places.listOwn(u).places.length, 3);
    // the same sourceRef from another source is another place
    const f = await call('places.importFor', { userId: u, places: [{ sourceRef: 'n-1', name: 'Oma & Opa', lat: 50.2, lon: 8.8 }], source: 'familie' });
    assert.equal(f.map['n-1'].created, true);
    await assert.rejects(call('places.importFor', { userId: u, places: [], source: 'manual' }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(call('places.importFor', { userId: u, places: 'x', source: 'notizen' }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(call('places.importFor', { userId: u, places: new Array(101).fill({}), source: 'notizen' }), (e) => e.code === 'ERR_INVALID');
  });

  it('importFor stops at 100 places (reason limit)', async () => {
    const u = H.makeUser('pl-import-full');
    const ins = db.prepare("INSERT INTO user_places (user_id, name, name_lc, lat, lon) VALUES (?, ?, ?, 50.1, 8.6)");
    for (let i = 0; i < 99; i++) ins.run(u, `Ort ${i}`, `ort ${i}`);
    const r = await call('places.importFor', { userId: u, places: [{ sourceRef: 'a', name: 'A', lat: 50, lon: 8 }, { sourceRef: 'b', name: 'B', lat: 50, lon: 8 }], source: 'notizen' });
    assert.deepEqual([Object.keys(r.map), r.skipped], [['a'], [{ sourceRef: 'b', reason: 'limit' }]]);
  });
});

describe('the address search', () => {
  let requests;
  const NOMINATIM = [
    { lat: '50.1105', lon: '8.6821', name: 'Musterbau Baumarkt', display_name: 'Musterbau, Industriestraße 20, Musterstadt',
      address: { road: 'Industriestraße', house_number: '20', postcode: '60311', city: 'Musterstadt' } },
    { lat: '50.2', lon: '8.7', name: '', display_name: 'Kanalweg 3, Nordheim', address: { road: 'Kanalweg', house_number: '3', town: 'Nordheim' } },
    { lat: 'kaputt', lon: '8.7', name: 'Ohne Punkt' },
    { lat: '50.1105', lon: '8.6821', name: 'Doppelt am selben Punkt' },
  ];
  const ok = (body) => ({ status: 200, body: Buffer.from(JSON.stringify(body)) });
  beforeEach(() => {
    requests = [];
    search._reset({ pauseMs: 40 });
    search._setTransport(async (url, opts) => { requests.push({ url, opts, at: Date.now() }); return ok(NOMINATIM); });
    require('../src/services/settings').set('profile.place_search', 'osm');
    require('../src/services/settings').set('profile.place_search_url', '');
  });

  it('rounds the position to ~1 km before anything else; names the application; parses the hits', async () => {
    const u = H.makeUser('pl-s1');
    const r = await search.search({ q: 'Baumarkt', near: '50.112345,8.687654', lang: 'de', userId: u });
    assert.equal(requests.length, 1);
    const url = new URL(requests[0].url);
    assert.equal(url.origin + url.pathname, 'https://nominatim.openstreetmap.org/search');
    assert.equal(url.searchParams.get('q'), 'Baumarkt');
    assert.equal(url.searchParams.get('format'), 'jsonv2');
    assert.equal(url.searchParams.get('accept-language'), 'de');
    assert.equal(url.searchParams.get('viewbox'), search.boxOf({ lat: 50.11, lon: 8.69 }, 50));
    assert.doesNotMatch(requests[0].url, /112345|687654/);
    assert.match(requests[0].opts.headers['User-Agent'], /^GateControl\/\d+\.\d+\.\d+ \(.*\+https:\/\/github\.com\/CallMeTechie\/gatecontrol\)$/);
    assert.equal(requests[0].opts.allowPrivate, false);
    assert.deepEqual(r.results.map((h) => [h.name, h.address, h.lat, h.lon, h.source]), [
      ['Musterbau Baumarkt', 'Industriestraße 20, 60311 Musterstadt', 50.1105, 8.6821, 'osm'],
      ['Kanalweg 3', 'Kanalweg 3, Nordheim', 50.2, 8.7, 'osm'],
    ]);
    assert.ok(Number.isInteger(r.results[0].distanceM));
    assert.deepEqual(r.attribution, { text: '© OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' });
  });

  it('the same words in the same cell come from the cache; nothing is written down', async () => {
    const u = H.makeUser('pl-s2');
    await search.search({ q: 'Kanalweg', near: '50.111,8.681', userId: u });
    const again = await search.search({ q: 'kanalweg ', near: '50.114,8.684', userId: u });
    assert.equal(requests.length, 1, 'same cell, same words → cache');
    assert.equal(again.cached, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM activity_log WHERE details LIKE '%Kanalweg%' OR message LIKE '%Kanalweg%'").get().c, 0);
  });

  it('one request at a time with a pause between two starts (the public service: one a second)', async () => {
    assert.ok(search.PAUSE_MS.osm >= 1000);
    const u = H.makeUser('pl-s3');
    await Promise.all(['Aweg', 'Bweg', 'Cweg'].map((q) => search.search({ q, userId: u })));
    assert.equal(requests.length, 3);
    for (let i = 1; i < 3; i++) assert.ok(requests[i].at - requests[i - 1].at >= 35, `pause ${requests[i].at - requests[i - 1].at} ms`);
  });

  it('limits per person, wrong input, the service failing, switched off', async () => {
    const u = H.makeUser('pl-s4');
    await assert.rejects(search.search({ q: 'ab', userId: u }), (e) => e.code === 'ERR_INVALID' && e.field === 'q');
    await assert.rejects(search.search({ q: 'Abcweg', near: '0,0', userId: u }), (e) => e.code === 'ERR_INVALID' && e.field === 'near');
    await assert.rejects(search.search({ q: 'Abcweg', near: '95,8', userId: u }), (e) => e.code === 'ERR_INVALID' && e.field === 'near');
    search._reset({ pauseMs: 0 });
    for (let i = 0; i < search.PER_HOUR; i++) await search.search({ q: `Weg ${i}`, userId: u });
    await assert.rejects(search.search({ q: 'Noch einer', userId: u }), (e) => e.code === 'ERR_RATE_LIMIT' && e.retryAfter > 0);
    // cached answers still come
    assert.equal((await search.search({ q: 'Weg 0', userId: u })).cached, true);
    search._reset({ pauseMs: 0 });
    search._setTransport(async () => ({ status: 503, body: Buffer.from('busy') }));
    await assert.rejects(search.search({ q: 'Abcweg', userId: u }), (e) => e.code === 'ERR_UNAVAILABLE');
    await assert.rejects(search.search({ q: 'Defweg', userId: u }), (e) => e.code === 'ERR_UNAVAILABLE', 'left alone for a minute');
    require('../src/services/settings').set('profile.place_search', 'off');
    await assert.rejects(search.search({ q: 'Abcweg', userId: u }), (e) => e.code === 'ERR_SEARCH_OFF');
  });

  it('an own Nominatim: its URL, private addresses allowed; the settings of the administrator', async () => {
    const s = await agent.put('/api/v1/users/settings/profile').set('X-CSRF-Token', csrf).send({ placeSearch: 'own', placeSearchUrl: 'http://192.168.178.20:8080/' }).expect(200);
    assert.deepEqual([s.body.settings.placeSearch, s.body.settings.placeSearchUrl], ['own', 'http://192.168.178.20:8080']);
    await search.search({ q: 'Lindenweg', userId: H.makeUser('pl-s5') });
    assert.equal(new URL(requests[0].url).origin, 'http://192.168.178.20:8080');
    assert.equal(requests[0].opts.allowPrivate, true);
    for (const bad of ['http://127.0.0.1:8080', 'ftp://nominatim.example.org', 'https://user:pw@nominatim.example.org', 'https://nominatim.example.org/?x=1']) {
      const r = await agent.put('/api/v1/users/settings/profile').set('X-CSRF-Token', csrf).send({ placeSearch: 'own', placeSearchUrl: bad }).expect(400);
      assert.equal(r.body.field, 'placeSearchUrl', bad);
    }
    await agent.put('/api/v1/users/settings/profile').set('X-CSRF-Token', csrf).send({ placeSearch: 'own', placeSearchUrl: null }).expect(400);
    await agent.put('/api/v1/users/settings/profile').set('X-CSRF-Token', csrf).send({ placeSearch: 'bing' }).expect(400);
    const off = await agent.put('/api/v1/users/settings/profile').set('X-CSRF-Token', csrf).send({ placeSearch: 'off' }).expect(200);
    assert.equal(off.body.settings.placeSearch, 'off');
    await agent.put('/api/v1/users/settings/profile').set('X-CSRF-Token', csrf).send({ placeSearch: 'osm', placeSearchUrl: null }).expect(200);
  });

  it('the endpoint: results, 400 / 403 / 429 / 503 with their codes', async () => {
    const u = H.makeUser('pl-s6');
    const dev = H.makeDevice(u, { name: 'pl-search-phone' });
    const r = await client(dev).get('/api/v1/client/me/places/search?q=Baumarkt&near=50.11,8.68').expect(200);
    assert.equal(r.body.results[0].name, 'Musterbau Baumarkt');
    assert.equal(r.body.attribution.text, '© OpenStreetMap');
    const short = await client(dev).get('/api/v1/client/me/places/search?q=ab').expect(400);
    assert.deepEqual([short.body.code, short.body.field], ['INVALID', 'q']);
    search._setTransport(async () => { throw new Error('down'); });
    const down = await client(dev).get('/api/v1/client/me/places/search?q=Abcweg').expect(503);
    assert.equal(down.body.code, 'SEARCH_UNAVAILABLE');
    search._reset({ pauseMs: 0 });
    search._setTransport(async () => ok([]));
    for (let i = 0; i < search.PER_HOUR; i++) await search.search({ q: `Platz ${i}`, userId: u });
    const many = await client(dev).get('/api/v1/client/me/places/search?q=Platz%20neu').expect(429);
    assert.equal(many.body.code, 'RATE_LIMITED');
    assert.ok(Number(many.headers['retry-after']) > 0);
    require('../src/services/settings').set('profile.place_search', 'off');
    const off = await client(dev).get('/api/v1/client/me/places/search?q=Abcweg').expect(403);
    assert.equal(off.body.code, 'SEARCH_OFF');
    assert.equal((await client(dev).get('/api/v1/client/me/profile/places').expect(200)).body.search, 'off');
  });
});
