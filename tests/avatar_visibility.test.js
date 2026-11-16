'use strict';

// "Wer sieht dein Bild?" (docs/feature-avatars.md, services/avatars.js, profile.visibility.avatar):
//   * migration 154: broken profile_visibility JSON and unknown avatar values go
//   * the own profile: visibility.avatar (default 'all'), options.avatarVisibility, PATCH, invalid → 400
//   * a narrower level gives the picture a new address — the old one answers 404; a wider one keeps it
//   * gc.users: avatarUrl only for viewers who may see it ('contacts' = 'family' in the core), without a viewer only
//     'all', the viewer only while that person's request is in flight; unmasked for the Messenger; avatarVisibility
//   * gc.users.setAvatarVisibility only for the person of a changing request; adoptAvatarVisibility once, only narrower
//   * "Wer bist du?" on a shared device: the picture only at 'all'; the portal's group pages per viewer
//   * administration: the picture always, avatarHidden ("für andere verborgen")

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');
const H = require('./helpers/notify');

let app, agent, avatars, profile, hostApi, ctx, db;
const PLUGIN = { id: 'gatecontrol-familie', manifest: { permissions: { users: true } } };
const asPerson = (userId, fn, write = false) => ctx.run(PLUGIN.id, userId, write, fn);

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}
function png(w) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.alloc(16, 7)), chunk('IEND', Buffer.alloc(0))]);
}
function family(...ids) {
  const groups = require('../src/services/groups');
  const g = groups.create({ name: H.uniq('Familie'), kind: 'family' }, {});
  ids.forEach((id, i) => groups.setMember(g.id, id, i === 0 ? 'parent' : 'child', {}));
  return g.id;
}
const client = (dev) => ({
  get: (p) => supertest(app).get(p).set('X-API-Token', dev.raw),
  patch: (p) => supertest(app).patch(p).set('X-API-Token', dev.raw),
});
const level = (id, l) => profile.update(id, { visibility: { avatar: l } });
const listed = (list, id) => list.find((u) => u.id === id);

before(async () => {
  ({ app, agent } = await setup());
  avatars = require('../src/services/avatars');
  profile = require('../src/services/profile');
  hostApi = require('../src/services/plugins/hostApi');
  ctx = require('../src/services/plugins/personContext');
  db = require('../src/db/connection').getDb();
});
after(() => teardown());

describe('migration 154', () => {
  it('drops broken JSON and unknown avatar values, keeps the rest', () => {
    const m = require('../src/db/migrationList').migrations.find((x) => x.version === 154);
    assert.equal(m.name, 'profile_avatar_visibility');
    const a = H.makeUser('av-mig-a');
    const b = H.makeUser('av-mig-b');
    const c = H.makeUser('av-mig-c');
    db.prepare('UPDATE users SET profile_visibility = ? WHERE id = ?').run('{broken', a);
    db.prepare('UPDATE users SET profile_visibility = ? WHERE id = ?').run(JSON.stringify({ birthday: 'all', avatar: 'nobody' }), b);
    db.prepare('UPDATE users SET profile_visibility = ? WHERE id = ?').run(JSON.stringify({ about: 'self', avatar: 'family' }), c);
    db.exec(m.sql);
    const get = (id) => db.prepare('SELECT profile_visibility AS v FROM users WHERE id = ?').get(id).v;
    assert.equal(get(a), null);
    assert.deepEqual(JSON.parse(get(b)), { birthday: 'all' });
    assert.deepEqual(JSON.parse(get(c)), { about: 'self', avatar: 'family' });
    db.exec(m.sql); // again: nothing changes
    assert.deepEqual(JSON.parse(get(c)), { about: 'self', avatar: 'family' });
  });
});

describe('the own profile', () => {
  it('visibility.avatar is "all" until chosen; the app changes it; an unknown level is refused', async () => {
    const u = H.makeUser('av-own');
    const dev = H.makeDevice(u, { name: 'av-own-phone' });
    const r = await client(dev).get('/api/v1/client/me/profile').expect(200);
    assert.equal(r.body.profile.visibility.avatar, 'all');
    assert.deepEqual(r.body.profile.options.avatarVisibility, ['all', 'contacts', 'family', 'self']);
    const p = await client(dev).patch('/api/v1/client/me/profile').send({ visibility: { avatar: 'contacts' } }).expect(200);
    assert.equal(p.body.profile.visibility.avatar, 'contacts');
    const bad = await client(dev).patch('/api/v1/client/me/profile').send({ visibility: { avatar: 'nobody' } }).expect(400);
    assert.deepEqual([bad.body.code, bad.body.field], ['INVALID', 'visibility']);
    // a change of another field keeps the choice; the other fields keep theirs
    profile.update(u, { visibility: { birthday: 'all' } });
    assert.deepEqual(JSON.parse(db.prepare('SELECT profile_visibility AS v FROM users WHERE id = ?').get(u).v).avatar, 'contacts');
    assert.equal(profile.ownView(u).visibility.birthday, 'all');
  });

  it('a narrower level gives the picture a new address, the old one answers 404 at once; wider keeps it', async () => {
    const u = H.makeUser('av-rot');
    const first = avatars.set(u, png(128)).avatarUrl;
    await supertest(app).get(first).expect(200);
    level(u, 'family');
    const second = avatars.info(u).avatarUrl;
    assert.notEqual(second, first);
    await supertest(app).get(first).expect(404);
    await supertest(app).get(second).expect(200);
    level(u, 'all');
    assert.equal(avatars.info(u).avatarUrl, second, 'wider: the same address');
    level(u, 'contacts');
    assert.notEqual(avatars.info(u).avatarUrl, second);
    const log = db.prepare("SELECT details FROM activity_log WHERE event_type = 'profile_updated' AND json_extract(details, '$.userId') = ?").all(u);
    assert.ok(log.some((l) => JSON.parse(l.details).fields.includes('avatar')));
  });
});

describe('gc.users', () => {
  let mum, kid, other, hidden, contact, selfOnly, open;
  before(() => {
    mum = H.makeUser('av-mum');
    kid = H.makeUser('av-kid');
    other = H.makeUser('av-other');
    family(mum, kid);
    for (const id of [mum, kid, other]) avatars.set(id, png(96));
    hidden = mum; // family
    level(mum, 'family');
    contact = kid; // contacts
    level(kid, 'contacts');
    selfOnly = other;
    level(other, 'self');
    open = H.makeUser('av-open');
    avatars.set(open, png(96));
  });

  it('without a viewer only "all"; every entry names its level', async () => {
    const list = await hostApi.handle(PLUGIN, 'users.list', {});
    assert.equal(listed(list, hidden).avatarUrl, null);
    assert.equal(listed(list, contact).avatarUrl, null);
    assert.equal(listed(list, selfOnly).avatarUrl, null);
    assert.match(listed(list, open).avatarUrl, /^\/avatars\//);
    assert.deepEqual([hidden, contact, selfOnly, open].map((id) => listed(list, id).avatarVisibility), ['family', 'contacts', 'self', 'all']);
    assert.equal(listed(list, hidden).initials.length > 0, true, 'the initials stay');
  });

  it('a viewer in the family sees "family" and "contacts" (contacts = family in the core), never "self"', async () => {
    const list = await asPerson(kid, () => hostApi.handle(PLUGIN, 'users.list', { viewer: kid }));
    assert.match(listed(list, mum).avatarUrl, /^\/avatars\//);
    assert.match(listed(list, kid).avatarUrl, /^\/avatars\//, 'the own picture always');
    assert.equal(listed(list, other).avatarUrl, null);
    const one = await asPerson(mum, () => hostApi.handle(PLUGIN, 'users.get', { id: kid, viewer: mum }));
    assert.match(one.avatarUrl, /^\/avatars\//);
    const own = await asPerson(other, () => hostApi.handle(PLUGIN, 'users.get', { id: other, viewer: other }));
    assert.match(own.avatarUrl, /^\/avatars\//, '"Nur ich": the person herself');
  });

  it('somebody outside the family sees neither; a viewer without a request in flight counts as nobody', async () => {
    const list = await asPerson(other, () => hostApi.handle(PLUGIN, 'users.list', { viewer: other }));
    assert.equal(listed(list, mum).avatarUrl, null);
    assert.equal(listed(list, kid).avatarUrl, null);
    const claimed = await hostApi.handle(PLUGIN, 'users.get', { id: mum, viewer: kid });
    assert.equal(claimed.avatarUrl, null, 'no request of the kid in flight');
    await assert.rejects(hostApi.handle(PLUGIN, 'users.get', { id: mum, viewer: 'x' }), (e) => e.code === 'ERR_INVALID');
  });

  it('unmasked: every picture with its level (the Messenger applies it itself)', async () => {
    const list = await hostApi.handle(PLUGIN, 'users.list', { unmasked: true });
    for (const id of [mum, kid, other, open]) assert.match(listed(list, id).avatarUrl, /^\/avatars\//);
    assert.equal(listed(list, other).avatarVisibility, 'self');
  });

  it('setAvatarVisibility: only for the person of a changing request in flight', async () => {
    const u = H.makeUser('av-set');
    await assert.rejects(hostApi.handle(PLUGIN, 'users.setAvatarVisibility', { userId: u, level: 'self' }), (e) => e.code === 'ERR_FORBIDDEN');
    await assert.rejects(asPerson(u, () => hostApi.handle(PLUGIN, 'users.setAvatarVisibility', { userId: u, level: 'self' })), (e) => e.code === 'ERR_FORBIDDEN', 'a reading request is not enough');
    await assert.rejects(asPerson(u, () => hostApi.handle(PLUGIN, 'users.setAvatarVisibility', { userId: u, level: 'nobody' }), true), (e) => e.code === 'ERR_INVALID');
    const r = await asPerson(u, () => hostApi.handle(PLUGIN, 'users.setAvatarVisibility', { userId: u, level: 'self' }), true);
    assert.deepEqual(r, { level: 'self' });
    assert.equal(profile.ownView(u).visibility.avatar, 'self');
    await assert.rejects(hostApi.handle({ id: 'x', manifest: { permissions: {} } }, 'users.setAvatarVisibility', { userId: u, level: 'all' }), (e) => e.code === 'ERR_USERS_DENIED');
  });

  it('adoptAvatarVisibility: once, only while nothing is chosen, only narrower', async () => {
    const u = H.makeUser('av-adopt');
    // another field's visibility changed before — the picture's level is still "not chosen"
    profile.update(u, { visibility: { about: 'family' } });
    assert.deepEqual(await hostApi.handle(PLUGIN, 'users.adoptAvatarVisibility', { userId: u, level: 'all' }), { adopted: false, level: 'all' });
    assert.deepEqual(await hostApi.handle(PLUGIN, 'users.adoptAvatarVisibility', { userId: u, level: 'self' }), { adopted: true, level: 'self' });
    assert.deepEqual(await hostApi.handle(PLUGIN, 'users.adoptAvatarVisibility', { userId: u, level: 'family' }), { adopted: false, level: 'self' });
    const chose = H.makeUser('av-chose');
    level(chose, 'all');
    assert.deepEqual(await hostApi.handle(PLUGIN, 'users.adoptAvatarVisibility', { userId: chose, level: 'self' }), { adopted: false, level: 'all' }, 'a choice of the person wins');
    await assert.rejects(hostApi.handle(PLUGIN, 'users.adoptAvatarVisibility', { userId: 999999, level: 'self' }), (e) => e.code === 'ERR_NOT_FOUND');
  });
});

describe('portal and administration', () => {
  it('"Wer bist du?" on a shared device: the picture only at "all", else the initials', () => {
    const svc = require('../src/services/portalDevices');
    const owner = H.makeUser('av-who');
    const dev = H.makeDevice(owner, { name: 'av-who-dev' });
    db.prepare("UPDATE api_tokens SET device_usage = 'multi' WHERE id = ?").run(dev.tokenId);
    avatars.set(owner, png(128));
    assert.match(svc.peopleForPicker(dev.peerId).find((p) => p.id === owner).avatarUrl, /^\/avatars\//);
    level(owner, 'family');
    const me = svc.peopleForPicker(dev.peerId).find((p) => p.id === owner);
    assert.equal(me.avatarUrl, null);
    assert.ok(me.initials);
  });

  it('the administration sees the picture with "für andere verborgen"', async () => {
    const u = H.makeUser('av-adm');
    avatars.set(u, png(128));
    let r = await agent.get(`/api/v1/users/${u}`).expect(200);
    assert.equal(r.body.user.avatarHidden, false);
    level(u, 'self');
    r = await agent.get(`/api/v1/users/${u}`).expect(200);
    assert.match(r.body.user.avatarUrl, /^\/avatars\//);
    assert.deepEqual([r.body.user.avatarVisibility, r.body.user.avatarHidden], ['self', true]);
    const card = await agent.get(`/api/v1/users/${u}/profile`).expect(200);
    assert.deepEqual(card.body.profile.avatar, { visibility: 'self', hiddenFromOthers: true });
  });

  it('strings exist in both languages', () => {
    const de = require('../src/i18n/de.json');
    const en = require('../src/i18n/en.json');
    for (const k of ['avatar.hidden_others', 'myprofile.avatar_vis.title', 'myprofile.avatar_vis.all', 'myprofile.avatar_vis.contacts',
      'myprofile.avatar_vis.family', 'myprofile.avatar_vis.self', 'myprofile.avatar_vis.foot']) {
      assert.ok(de[k] && en[k], k);
    }
    assert.equal(de['myprofile.avatar_vis.title'], 'Wer sieht dein Bild?');
    assert.equal(en['avatar.hidden_others'], 'hidden from others');
  });
});
