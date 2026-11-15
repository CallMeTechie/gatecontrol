'use strict';

// The user profile (docs/feature-user-profile.md, services/profile.js):
//   * migration 151: columns, user_phones / user_emails / user_bridge_selves, ON DELETE CASCADE
//   * numbers at rest: encrypted with the server's key, a keyed hash — never the digits in the database or the log
//   * the own profile over the app API (/api/v1/client/me/profile…) and the portal (/api/v1/portal/me/profile…)
//   * visibility: self / family / all; numbers "Niemand" never leave, not even to a plugin acting for the person
//   * administrators: the "Profil" card never shows a digit; confirm / remove without seeing; settings
//   * "Meine Daten": numbers in plain text for the person only
//   * gc.profile.get (permissions.profile) and gc.bridges.matchAccounts (version 8) with a stand-in bridge:
//     consent off → nothing, a number in two accounts → nothing, never the viewer, unconfirmed = medium only

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const path = require('node:path');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');
const { startFakeHomeserver } = require('./helpers/fake-homeserver');
const { startFakeBridge } = require('./helpers/fake-bridge');

// made-up numbers only (zeros)
const N1 = '+4915100000001';
const N2 = '+4915100000002';
const N3 = '+4915100000003';
const DIGITS = /15100000|4915100/;

let app, agent, csrf, profile, db, bridges, hostApi, ctx, hs, bridge;
const PLUGIN = (perms) => ({ id: 'gatecontrol-messenger', manifest: { permissions: { users: true, bridges: true, ...perms } } });
const asPerson = (userId, fn) => ctx.run('gatecontrol-messenger', userId, false, fn);

const client = (dev) => ({
  get: (p) => supertest(app).get(p).set('X-API-Token', dev.raw),
  post: (p) => supertest(app).post(p).set('X-API-Token', dev.raw),
  patch: (p) => supertest(app).patch(p).set('X-API-Token', dev.raw),
  del: (p) => supertest(app).delete(p).set('X-API-Token', dev.raw),
});

function family(...ids) {
  const groups = require('../src/services/groups');
  const g = groups.create({ name: H.uniq('Familie'), kind: 'family' }, {});
  ids.forEach((id, i) => groups.setMember(g.id, id, i === 0 ? 'parent' : 'child', {}));
  return g.id;
}
const consent = (id, { wa = 0, phone = 0 } = {}) => db.prepare('UPDATE users SET recognize_by_whatsapp = ?, recognize_by_phone = ? WHERE id = ?').run(wa, phone, id);

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  process.env.GC_BRIDGES_PREVIEW = '1';
  profile = require('../src/services/profile');
  db = require('../src/db/connection').getDb();
  bridges = require('../src/services/bridges');
  hostApi = require('../src/services/plugins/hostApi');
  ctx = require('../src/services/plugins/personContext');
  const hsMod = require('../src/services/bridges/hs');
  const appservice = require('../src/services/bridges/appservice');
  bridges.configure({ enabled: true, networks: { whatsapp: true } }, {});
  assert.equal(await bridges.start(), true);
  const secrets = bridges.readSecrets();
  hs = await startFakeHomeserver({ socket: hsMod.socketOf(bridges.dir()), asToken: secrets.coreAsToken, coreSocket: appservice.socketOf(bridges.dir()), hsToken: secrets.coreHsToken });
  bridge = await startFakeBridge({ socket: path.join(bridges.dir(), 'run', 'whatsapp.sock'), secret: secrets.provisionSecret });
});
after(async () => {
  await bridges.stop();
  await hs.close();
  await bridge.close();
  delete process.env.GC_BRIDGES_PREVIEW;
  teardown();
});

describe('migration 151', () => {
  it('adds the profile columns and tables; detect recognises it', () => {
    const m = require('../src/db/migrationList').migrations.find((x) => x.version === 151);
    assert.equal(m.name, 'user_profile');
    assert.equal(m.detect(db), true);
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    for (const c of ['first_name', 'last_name', 'about', 'birthday', 'birthday_year_hidden', 'profile_visibility', 'recognize_by_whatsapp', 'recognize_by_phone']) assert.ok(cols.includes(c), c);
  });

  it('profile, numbers and addresses go with the user (ON DELETE CASCADE)', async () => {
    const u = H.makeUser('pf-gone');
    profile.addPhone(u, { kind: 'mobile', number: N1 });
    db.prepare("INSERT INTO user_emails (user_id, address, address_lc) VALUES (?, 'a@example.com', 'a@example.com')").run(u);
    profile.noteOwnNumbers(u, 'whatsapp', [N1]);
    require('../src/services/users').remove(u);
    for (const t of ['user_phones', 'user_emails', 'user_bridge_selves']) assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE user_id = ?`).get(u).c, 0, t);
  });
});

describe('numbers at rest', () => {
  it('encrypted with the server key and a keyed hash — no digit in the database or the activity log', () => {
    const u = H.makeUser('pf-rest');
    const p = profile.addPhone(u, { kind: 'work', number: '+49 151 0000-0001', visibility: 'none' });
    assert.equal(p.number, N1, 'normalised to E.164 for its owner');
    const row = db.prepare('SELECT * FROM user_phones WHERE id = ?').get(p.id);
    assert.doesNotMatch(JSON.stringify(row), DIGITS);
    assert.match(row.number_enc, /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    assert.match(row.number_hash, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(row.number_hash, crypto.createHash('sha256').update(N1).digest('base64url'), 'keyed, not a plain hash');
    assert.equal(require('../src/utils/crypto').decrypt(row.number_enc), N1);
    profile.updatePhone(u, p.id, { number: N2 });
    profile.removePhone(u, p.id);
    const log = db.prepare("SELECT message, details FROM activity_log WHERE event_type LIKE 'profile_phone_%' AND json_extract(details, '$.userId') = ?").all(u);
    assert.equal(log.length, 3);
    assert.doesNotMatch(JSON.stringify(log), DIGITS);
    assert.match(log[0].message, /Geschäftlich/);
  });

  it('refuses a number without country code, a sixth number and the same number twice', () => {
    const u = H.makeUser('pf-limits');
    assert.throws(() => profile.addPhone(u, { kind: 'mobile', number: '0151 0000000' }), (e) => e.code === 'ERR_INVALID' && e.field === 'number');
    assert.throws(() => profile.addPhone(u, { kind: 'pager', number: N1 }), (e) => e.code === 'ERR_INVALID' && e.field === 'kind');
    for (let i = 0; i < 5; i++) profile.addPhone(u, { kind: 'other', number: `+491510000010${i}` });
    assert.throws(() => profile.addPhone(u, { kind: 'other', number: N3 }), (e) => e.code === 'ERR_LIMIT');
    const v = H.makeUser('pf-dup-own');
    profile.addPhone(v, { kind: 'mobile', number: N1 });
    assert.throws(() => profile.addPhone(v, { kind: 'home', number: '0049 151 00000001' }), (e) => e.code === 'ERR_DUPLICATE');
  });
});

describe('own profile over the app API', () => {
  let anna, phone;
  before(() => {
    anna = H.makeUser('pf-anna');
    phone = H.makeDevice(anna, { name: 'pf-phone' });
  });

  it('GET returns picture, colour and the profile; PATCH changes fields, visibility, time zone, consents', async () => {
    const r = await client(phone).get('/api/v1/client/me/profile').expect(200);
    assert.equal(r.body.profile.userId, anna);
    assert.deepEqual(r.body.profile.visibility, profile.DEFAULT_VISIBILITY);
    assert.deepEqual(r.body.profile.recognition.byPhone, false);
    assert.deepEqual(r.body.profile.recognition.byWhatsapp, false);
    const p = await client(phone).patch('/api/v1/client/me/profile').send({
      firstName: 'Anna', lastName: 'Berg', about: 'Meist ab 17 Uhr erreichbar', birthday: { date: '1990-03-14', yearHidden: true },
      timezone: 'Europe/Berlin', visibility: { birthday: 'all' }, recognition: { byPhone: true },
    }).expect(200);
    const pr = p.body.profile;
    assert.deepEqual([pr.firstName, pr.lastName, pr.about, pr.timezone], ['Anna', 'Berg', 'Meist ab 17 Uhr erreichbar', 'Europe/Berlin']);
    assert.deepEqual(pr.birthday, { date: '1990-03-14', month: 3, day: 14, year: 1990, yearHidden: true });
    assert.equal(pr.visibility.birthday, 'all');
    assert.equal(pr.recognition.byPhone, true);
    assert.equal(pr.recognition.phoneAnswered, true);
    assert.equal(db.prepare('SELECT tz FROM notify_user_prefs WHERE user_id = ?').get(anna).tz, 'Europe/Berlin', 'the same value as the quiet hours');
    const bad = await client(phone).patch('/api/v1/client/me/profile').send({ about: 'x'.repeat(141) }).expect(400);
    assert.deepEqual([bad.body.code, bad.body.field], ['INVALID', 'about']);
    await client(phone).patch('/api/v1/client/me/profile').send({ role: 'admin' }).expect(400);
    await client(phone).patch('/api/v1/client/me/profile').send({ birthday: { date: '2001-02-29' } }).expect(400);
  });

  it('numbers: add, change, remove — the owner sees the number', async () => {
    const add = await client(phone).post('/api/v1/client/me/profile/phones').send({ kind: 'mobile', number: N1, visibility: 'family' }).expect(201);
    assert.deepEqual([add.body.phone.number, add.body.phone.state, add.body.phone.useForRecognition], [N1, 'unconfirmed', true]);
    const id = add.body.phone.id;
    const ch = await client(phone).patch(`/api/v1/client/me/profile/phones/${id}`).send({ useForRecognition: false }).expect(200);
    assert.equal(ch.body.phone.useForRecognition, false);
    await client(phone).post('/api/v1/client/me/profile/phones').send({ kind: 'mobile', number: '123' }).expect(400);
    await client(phone).del(`/api/v1/client/me/profile/phones/${id}`).expect(200);
    await client(phone).del(`/api/v1/client/me/profile/phones/${id}`).expect(404);
  });

  it('further addresses: unconfirmed without mail; at most 3; never the main address', async () => {
    db.prepare("UPDATE users SET email = 'anna@example.com' WHERE id = ?").run(anna);
    const a = await client(phone).post('/api/v1/client/me/profile/emails').send({ address: 'anna.privat@example.com' }).expect(201);
    assert.deepEqual([a.body.email.state, a.body.codeSent], ['unconfirmed', false]);
    await client(phone).post('/api/v1/client/me/profile/emails').send({ address: 'ANNA@example.com' }).expect(409);
    const conf = await client(phone).post(`/api/v1/client/me/profile/emails/${a.body.email.id}/confirm`).send({ code: '000000' }).expect(410);
    assert.equal(conf.body.code, 'CODE_EXPIRED');
    // a code as the mail would carry it
    db.prepare('UPDATE user_emails SET code_hash = ?, code_expires_at = ? WHERE id = ?').run(crypto.createHash('sha256').update('123456').digest('hex'), Date.now() + 60000, a.body.email.id);
    await client(phone).post(`/api/v1/client/me/profile/emails/${a.body.email.id}/confirm`).send({ code: '654321' }).expect(400);
    const ok = await client(phone).post(`/api/v1/client/me/profile/emails/${a.body.email.id}/confirm`).send({ code: '123456' }).expect(200);
    assert.equal(ok.body.email.state, 'confirmed');
    await client(phone).del(`/api/v1/client/me/profile/emails/${a.body.email.id}`).expect(200);
  });

  it('"Meine Daten": the numbers in plain text for the person, no secret', async () => {
    await client(phone).post('/api/v1/client/me/profile/phones').send({ kind: 'home', number: N2 }).expect(201);
    const r = await client(phone).get('/api/v1/client/me/profile/export').expect(200);
    assert.match(r.headers['content-disposition'], /attachment; filename="gatecontrol-meine-daten-\d{4}-\d{2}-\d{2}\.json"/);
    const data = JSON.parse(r.text);
    assert.equal(data.format, 'gatecontrol-my-data');
    assert.equal(data.account.id, anna);
    assert.deepEqual(data.phones.map((p) => p.number), [N2]);
    assert.ok(Array.isArray(data.groups) && Array.isArray(data.devices) && Array.isArray(data.plugins));
    assert.equal(data.devices.length, 1);
    assert.doesNotMatch(r.text, /password|number_enc|number_hash|code_hash|totp|token_hash/);
    assert.equal(data.recognition.byPhone, true);
  });

  it('a directory account cannot change name and e-mail', () => {
    const u = H.makeUser('pf-dir');
    const d = db.prepare("INSERT INTO directories (name, kind, enabled) VALUES (?, 'ad', 1)").run(H.uniq('AD'));
    db.prepare('INSERT INTO directory_links (user_id, directory_id, external_id) VALUES (?, ?, ?)').run(u, d.lastInsertRowid, H.uniq('ext'));
    assert.deepEqual(profile.ownView(u).locked, { displayName: true, email: true, directory: db.prepare('SELECT name FROM directories WHERE id = ?').get(d.lastInsertRowid).name });
    assert.throws(() => profile.update(u, { displayName: 'Neu' }), (e) => e.code === 'ERR_LOCKED');
    assert.equal(profile.update(u, { firstName: 'Paul' }).firstName, 'Paul');
  });
});

describe('the portal', () => {
  it('"Mein Profil" behind the own picture; kiosk devices and guests never reach it', async () => {
    const config = require('../config/default');
    const HOME = `home.${config.dns.domain}`;
    const u = H.makeUser('pf-portal');
    const dev = H.makeDevice(u, { name: 'pf-portal-phone' });
    const r = await supertest(app).post('/api/v1/client/portal-link').set('Authorization', `Bearer ${dev.raw}`).send({}).expect(200);
    const a = supertest.agent(app);
    await a.get('/auto?t=' + new URL(r.body.url).searchParams.get('t')).set('Host', HOME).set('X-GC-Portal-Peer-IP', dev.ip).expect(302);
    const page = await a.get('/portal').set('Host', HOME).set('X-GC-Portal-Peer-IP', dev.ip).expect(200);
    assert.match(page.text, /<a class="pt-user pt-user-link"[^>]*href="#profil" data-goto="profil"/);
    assert.match(page.text, /id="panel-profil"[^>]*data-extra/);
    const g = await a.get('/api/v1/portal/me/profile').set('Host', HOME).set('X-GC-Portal-Peer-IP', dev.ip).expect(200);
    assert.equal(g.body.profile.userId, u);
    const csrfTok = (page.text.match(/"csrf":"([^"]+)"/) || [])[1];
    await a.patch('/api/v1/portal/me/profile').set('Host', HOME).set('X-GC-Portal-Peer-IP', dev.ip).send({ about: 'Hallo' }).expect(403);
    const ok = await a.patch('/api/v1/portal/me/profile').set('Host', HOME).set('X-GC-Portal-Peer-IP', dev.ip).set('X-CSRF-Token', csrfTok).send({ about: 'Hallo' }).expect(200);
    assert.equal(ok.body.profile.about, 'Hallo');
    // without a session: nothing
    await supertest(app).get('/api/v1/portal/me/profile').set('Host', HOME).set('X-GC-Portal-Peer-IP', dev.ip).expect(401);
    assert.equal(require('../src/services/portalTickets').portalNext('/portal#profil'), '/portal#profil');
  });
});

describe('visibility (gc.profile.get)', () => {
  let jenny, paul, kid, stranger;
  before(() => {
    jenny = H.makeUser('pf-jenny');
    paul = H.makeUser('pf-paul');
    kid = H.makeUser('pf-kid');
    stranger = H.makeUser('pf-stranger');
    family(jenny, kid);
    profile.update(jenny, { firstName: 'Jenny', lastName: 'Backes', about: 'Hallo', birthday: { date: '1985-03-14', yearHidden: true },
      visibility: { firstName: 'all', lastName: 'family', about: 'self', birthday: 'family' } });
    profile.addPhone(jenny, { kind: 'mobile', number: N1, visibility: 'none' });
    profile.addPhone(jenny, { kind: 'work', number: N2, visibility: 'family' });
    profile.addPhone(jenny, { kind: 'home', number: N3, visibility: 'all' });
  });
  const all = ['firstName', 'lastName', 'about', 'birthday', 'phones'];

  it('self / family / everybody; "Niemand" never — not even for the person herself; the year stays hidden', () => {
    const self = profile.viewFor(jenny, jenny, all);
    assert.deepEqual([self.firstName, self.lastName, self.about], ['Jenny', 'Backes', 'Hallo']);
    assert.deepEqual(self.phones.map((p) => p.number), [N2, N3]);
    const fam = profile.viewFor(jenny, kid, all);
    assert.deepEqual([fam.firstName, fam.lastName, 'about' in fam], ['Jenny', 'Backes', false]);
    assert.deepEqual(fam.birthday, { date: '--03-14', month: 3, day: 14, year: null });
    assert.deepEqual(fam.phones.map((p) => p.number), [N2, N3]);
    const other = profile.viewFor(jenny, paul, all);
    assert.deepEqual(Object.keys(other).sort(), ['firstName', 'phones', 'userId']);
    assert.deepEqual(other.phones.map((p) => p.number), [N3]);
    assert.deepEqual(profile.viewFor(jenny, null, ['firstName']), { userId: jenny, firstName: 'Jenny' });
    assert.equal(profile.viewFor(jenny, null, ['firstName', 'lastName']).lastName, undefined);
  });

  it('the host API: only the declared fields; a viewer counts only inside that person\'s request', async () => {
    const p = PLUGIN({ profile: ['firstName', 'lastName'] });
    await assert.rejects(hostApi.handle(PLUGIN({}), 'profile.get', { id: jenny }), (e) => e.code === 'ERR_PROFILE_DENIED');
    // the plugin names the family member as viewer, but no request of hers is in flight
    assert.deepEqual(await hostApi.handle(p, 'profile.get', { id: jenny, viewer: kid }), { userId: jenny, firstName: 'Jenny' });
    assert.deepEqual(await asPerson(kid, () => hostApi.handle(p, 'profile.get', { id: jenny, viewer: kid })), { userId: jenny, firstName: 'Jenny', lastName: 'Backes' });
    const ph = await asPerson(stranger, () => hostApi.handle(PLUGIN({ profile: ['phones'] }), 'profile.get', { id: jenny, viewer: stranger }));
    assert.deepEqual(ph.phones, [{ kind: 'home', number: N3, confirmed: false }]);
    db.prepare("UPDATE users SET enabled = 0 WHERE id = ?").run(paul);
    assert.equal(await hostApi.handle(p, 'profile.get', { id: paul }), null);
    db.prepare("UPDATE users SET enabled = 1 WHERE id = ?").run(paul);
  });

  it('manifest: permissions.profile is a list of known fields and needs users', () => {
    const { validate: validateManifest } = require('../src/services/plugins/manifest');
    const { HELLO } = require('./helpers/plugins');
    const base = JSON.parse(require('node:fs').readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
    const v = (perms) => validateManifest({ ...base, permissions: { ...base.permissions, users: false, ...perms } });
    const ok = v({ users: true, profile: ['phones', 'firstName'] });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.manifest.permissions.profile, ['firstName', 'phones']);
    for (const bad of [{ users: true, profile: ['address'] }, { users: true, profile: [] }, { profile: ['firstName'] }]) {
      const r = v(bad);
      assert.ok((r.errors || []).some((e) => /permissions\.profile/.test(e)), JSON.stringify(bad));
    }
  });
});

describe('administrators', () => {
  it('the "Profil" card never carries a digit; hidden fields; duplicates; confirm and remove without seeing', async () => {
    const lena = H.makeUser('pf-lena');
    const tom = H.makeUser('pf-tom');
    profile.update(lena, { firstName: 'Lena', lastName: 'Berg', about: 'Privat', visibility: { firstName: 'all', lastName: 'all', about: 'family' } });
    const a = profile.addPhone(lena, { kind: 'mobile', number: '+4915100000011', visibility: 'all' });
    profile.addPhone(lena, { kind: 'work', number: '+4915100000012' });
    profile.addPhone(tom, { kind: 'mobile', number: '+4915100000012' });
    const r = await agent.get(`/api/v1/users/${lena}/profile`).expect(200);
    assert.doesNotMatch(JSON.stringify(r.body), DIGITS, 'no digit, not even of a number set to "Alle"');
    const p = r.body.profile;
    assert.deepEqual([p.firstName.value, p.about.hidden, p.about.value], ['Lena', true, null]);
    assert.deepEqual([p.phones.count, p.phones.confirmed, p.phones.duplicate], [2, 0, true]);
    assert.deepEqual(p.phones.list.map((x) => [x.kind, x.duplicate]), [['mobile', false], ['work', true]]);
    const c = await agent.post(`/api/v1/users/${lena}/profile/phones/${a.id}/confirm`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(c.body.profile.phones.list[0].state, 'admin');
    assert.doesNotMatch(JSON.stringify(c.body), DIGITS);
    const d = await agent.delete(`/api/v1/users/${lena}/profile/phones/${a.id}`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(d.body.profile.phones.count, 1);
    await agent.delete(`/api/v1/users/${lena}/profile/phones/999999`).set('X-CSRF-Token', csrf).expect(404);
  });

  it('settings: numbers can be switched off (and stay hidden everywhere); confirmed only', async () => {
    const s = await agent.put('/api/v1/users/settings/profile').set('X-CSRF-Token', csrf).send({ phonesEnabled: false, confirmedOnly: true }).expect(200);
    assert.deepEqual(s.body.settings, { phonesEnabled: false, confirmedOnly: true });
    const u = H.makeUser('pf-off');
    assert.throws(() => profile.addPhone(u, { kind: 'mobile', number: N3 }), (e) => e.code === 'ERR_PHONES_OFF');
    assert.deepEqual(profile.ownView(u).phones, []);
    await agent.put('/api/v1/users/settings/profile').set('X-CSRF-Token', csrf).send({ phonesEnabled: 'ja' }).expect(400);
    await agent.put('/api/v1/users/settings/profile').set('X-CSRF-Token', csrf).send({ phonesEnabled: true, confirmedOnly: false }).expect(200);
  });
});

describe('gc.bridges.matchAccounts (version 8)', () => {
  let viewer, jenny, paul, otto;
  const S = 'gc.internal';
  const call = (userId) => asPerson(userId, () => hostApi.handle(PLUGIN({}), 'bridges.matchAccounts', { userId, network: 'whatsapp' }));
  const contactOf = (number) => bridges._eventsOf().contactRef('whatsapp', `@whatsapp_${number.slice(1)}:${S}`);
  beforeEach(() => {
    db.exec('DELETE FROM user_phones; DELETE FROM user_bridge_selves;');
    bridges._reset();
    bridges._runtime.wake = () => {};
    viewer = H.makeUser('pf-viewer');
    jenny = H.makeUser('pf-mj');
    paul = H.makeUser('pf-mp');
    otto = H.makeUser('pf-mo');
    bridge.logins.set(`@gc_${viewer}:${S}`, [{ id: 'login-v', name: '+4915100000099', state_event: 'CONNECTED', timestamp: Date.now() }]);
    bridge.contacts = [{ number: N1, name: 'Schatzimausi' }, { number: N2, name: 'Paul P.' }, { number: N3, name: 'Otto' }];
  });

  it('consent off → nothing; on → the pairing only (no number, no hash)', async () => {
    profile.addPhone(jenny, { kind: 'mobile', number: N1 });
    assert.deepEqual((await call(viewer)).matches, []);
    consent(jenny, { phone: 1 });
    const r = await call(viewer);
    assert.deepEqual(r, { matches: [{ contactId: contactOf(N1), userId: jenny, strength: 'medium', via: 'profile_phone' }] });
    assert.doesNotMatch(JSON.stringify(r), /15100000|whatsapp_|gc\.internal/);
    // "Zum Erkennen nutzen" off for that number → nothing
    db.prepare('UPDATE user_phones SET use_for_recognition = 0 WHERE user_id = ?').run(jenny);
    assert.deepEqual((await call(viewer)).matches, []);
  });

  it('confirmed → strong; unconfirmed not at all with "nur bestätigte"; disabled accounts never', async () => {
    consent(jenny, { phone: 1 });
    consent(paul, { phone: 1 });
    const a = profile.addPhone(jenny, { kind: 'mobile', number: N1 });
    profile.addPhone(paul, { kind: 'mobile', number: N2 });
    profile.adminConfirmPhone(jenny, a.id, { actorId: 1 });
    profile.setSettings({ confirmedOnly: true });
    try {
      assert.deepEqual((await call(viewer)).matches.map((m) => [m.userId, m.strength]), [[jenny, 'strong']]);
    } finally { profile.setSettings({ confirmedOnly: false }); }
    db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(jenny);
    assert.deepEqual((await call(viewer)).matches.map((m) => m.userId), [paul]);
  });

  it('a number in two accounts is never used — and never the viewer', async () => {
    consent(jenny, { phone: 1 });
    consent(paul, { phone: 1 });
    consent(viewer, { phone: 1 });
    profile.addPhone(jenny, { kind: 'mobile', number: N1 });
    profile.addPhone(paul, { kind: 'mobile', number: N1 });
    profile.addPhone(viewer, { kind: 'mobile', number: N3 });
    assert.deepEqual((await call(viewer)).matches, []);
  });

  it('the own WhatsApp: whoami confirms the profile number ("Bestätigt über dein WhatsApp") and is a strong hint with consent', async () => {
    // Otto's own linked login has number N3 (as the bridge's profile phone)
    bridge.logins.set(`@gc_${otto}:${S}`, [{ id: 'login-o', name: N3, state_event: 'CONNECTED', timestamp: Date.now() }]);
    const p = profile.addPhone(otto, { kind: 'mobile', number: N3 });
    await asPerson(otto, () => hostApi.handle(PLUGIN({}), 'bridges.logins', { userId: otto, network: 'whatsapp' })).then((l) => assert.doesNotMatch(JSON.stringify(l), /"phone"/));
    assert.equal(profile.ownView(otto).phones.find((x) => x.id === p.id).state, 'whatsapp');
    assert.equal(profile.ownView(otto).recognition.whatsappLinked, true);
    assert.deepEqual((await call(viewer)).matches, [], 'no consent yet');
    consent(otto, { wa: 1 });
    assert.deepEqual((await call(viewer)).matches, [{ contactId: contactOf(N3), userId: otto, strength: 'strong', via: 'own_whatsapp' }]);
    // the link ends → the confirmation goes
    bridge.logins.set(`@gc_${otto}:${S}`, []);
    await asPerson(otto, () => hostApi.handle(PLUGIN({}), 'bridges.logins', { userId: otto, network: 'whatsapp' }));
    assert.equal(profile.ownView(otto).phones[0].state, 'unconfirmed');
    assert.deepEqual((await call(viewer)).matches, []);
  });

  it('only inside a request of that person', async () => {
    await assert.rejects(hostApi.handle(PLUGIN({}), 'bridges.matchAccounts', { userId: viewer, network: 'whatsapp' }), (e) => e.code === 'ERR_NOT_PERSON');
  });
});

describe('backup', () => {
  it('numbers and addresses survive export and restore, still encrypted', async () => {
    const backup = require('../src/services/backup');
    const u = H.makeUser('pf-backup');
    profile.addPhone(u, { kind: 'home', number: N2, visibility: 'family' });
    await profile.addEmail(u, { address: 'b@example.com' });
    const name = db.prepare('SELECT username FROM users WHERE id = ?').get(u).username;
    const data = JSON.parse(JSON.stringify(await backup.createBackup()));
    const ph = data.data.user_phones.find((p) => p.user_name === name);
    assert.doesNotMatch(JSON.stringify(ph), DIGITS);
    assert.equal(backup.getBackupSummary(data).user_phones, data.data.user_phones.length);
    await backup.restoreBackup(data);
    const id = db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
    assert.deepEqual(profile.ownView(id).phones.map((p) => [p.number, p.visibility]), [[N2, 'family']]);
    assert.deepEqual(profile.ownView(id).emails.map((e) => e.address), ['b@example.com']);
  });
});

describe('strings', () => {
  it('every myprofile.* / up.pf.* string exists in both languages', () => {
    const de = require('../src/i18n/de.json');
    const en = require('../src/i18n/en.json');
    const keys = (o) => Object.keys(o).filter((k) => k.startsWith('myprofile.') || k.startsWith('up.pf.')).sort();
    assert.deepEqual(keys(de), keys(en));
    assert.equal(de['myprofile.state.whatsapp'], 'Bestätigt über dein WhatsApp');
    assert.equal(en['myprofile.vis_none_hint'], 'Nobody sees it, not even an admin. GateControl only uses it for recognition.');
  });
});
