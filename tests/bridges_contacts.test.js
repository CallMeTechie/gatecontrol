'use strict';

// Messenger bridges, stage 4c (docs/feature-messenger-bridges.md, "Contacts"): a new chat with a contact the bridge
// keeps — no number typed, no question to WhatsApp. A stand-in bridge (tests/helpers/fake-bridge.js: GET contacts,
// POST search_users, create_dm with a ghost's Matrix id) and a stand-in homeserver; no WhatsApp.
//
//   contacts       names, picture references, the chat that exists — and a sealed reference instead of the number,
//                  the WhatsApp id or the Matrix address; the list is kept in memory for 10 minutes
//   matchNumbers   the person's own numbers against that list: nothing but the list is read, nothing counted
//   createDmByRef  only this person's reference, only on this network, only for 30 minutes

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { setup, teardown } = require('./helpers/setup');
const { startFakeHomeserver } = require('./helpers/fake-homeserver');
const { startFakeBridge } = require('./helpers/fake-bridge');

let bridges, hsMod, appservice, hostApi, ctx, db, annaId, benId, hs, bridge;
const PLUGIN = { id: 'gatecontrol-messenger', manifest: { permissions: { bridges: true } } };
const asPerson = (userId, write, fn) => ctx.run(PLUGIN.id, userId, write, fn);
const call = (api, args) => hostApi.handle(PLUGIN, api, args);
const S = 'gc.internal';
const anna = () => `@gc_${annaId}:${S}`;
const CONTACTS = [
  { number: '+4915112345678', name: 'Kim Muster', lid: '2041', avatar: 'mxc://gc.internal/kimpic', room: '!kc1:gc.internal' },
  { number: '+4917099887766', name: 'Lena Berger', chatRoom: '!kc2:gc.internal' },
  { number: '+4930123456', name: 'Tom Richter', avatar: 'mxc://evil.example/x' },
];
// what may never reach a plugin: the numbers (also without +), the ids, the ghosts' Matrix addresses, the server
const SECRET = /4915112345678|4917099887766|4930123456|lid-|2041|whatsapp_|gc\.internal|mxc:/;

before(async () => {
  await setup();
  process.env.GC_BRIDGES_PREVIEW = '1';
  bridges = require('../src/services/bridges');
  hsMod = require('../src/services/bridges/hs');
  appservice = require('../src/services/bridges/appservice');
  hostApi = require('../src/services/plugins/hostApi');
  ctx = require('../src/services/plugins/personContext');
  db = require('../src/db/connection').getDb();
  const add = db.prepare('INSERT INTO users (username, password_hash, role, enabled, language, display_name) VALUES (?, ?, ?, 1, ?, ?)');
  annaId = Number(add.run('anna-brcontacts', 'x', 'user', 'de', 'Anna').lastInsertRowid);
  benId = Number(add.run('ben-brcontacts', 'x', 'user', 'de', 'Ben').lastInsertRowid);
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
beforeEach(() => {
  db.exec('DELETE FROM bridge_inbox; DELETE FROM bridge_rooms; DELETE FROM bridge_txns;');
  bridges._reset();
  bridges._runtime.wake = () => {};
  bridge.requests.length = 0;
  bridge.numbers.clear();
  bridge.contacts = CONTACTS.map((c) => ({ ...c }));
  bridge.logins.set(anna(), [{ id: 'login-a', name: '+491700000001', state_event: 'CONNECTED', timestamp: Date.now() }]);
});

const list = (userId = annaId, query) => asPerson(userId, false, () => call('bridges.contacts', { userId, network: 'whatsapp', ...(query ? { query } : {}) }));
const match = (numbers, userId = annaId) => asPerson(userId, false, () => call('bridges.matchNumbers', { userId, network: 'whatsapp', numbers }));
const startByRef = (ref, userId = annaId) => asPerson(userId, true, () => call('bridges.createDmByRef', { userId, network: 'whatsapp', ref }));
/** Lena's room is known to GateControl as Anna's (a chat she had before) → its reference */
function lenasRoom() {
  db.prepare("INSERT INTO bridge_rooms (room_id, ref, user_id, network, state, kind, created_at, updated_at) VALUES (?, ?, ?, 'whatsapp', 'joined', 'direct', ?, ?)")
    .run('!kc2:gc.internal', 'r' + 'L'.repeat(20), annaId, Date.now(), Date.now());
  return 'r' + 'L'.repeat(20);
}

describe('contacts', () => {
  it('names, picture references and the chat that exists — never a number, an id or an address', async () => {
    const lena = lenasRoom();
    const r = await list();
    assert.deepEqual(Object.keys(r), ['contacts']);
    assert.equal(r.contacts.length, 3);
    for (const c of r.contacts) assert.deepEqual(Object.keys(c).sort(), ['avatar', 'chatId', 'contactId', 'name', 'ref']);
    const [kim, l, tom] = r.contacts;
    assert.deepEqual([kim.name, l.name, tom.name], ['Kim Muster', 'Lena Berger', 'Tom Richter']);
    assert.match(kim.ref, /^k[A-Za-z0-9_-]{40,}$/);
    assert.match(kim.avatar, /^m[A-Za-z0-9_-]{40,}$/, 'a picture reference for media.fetch');
    assert.equal(tom.avatar, null, 'a picture of another server: none');
    assert.equal(kim.chatId, null);
    assert.equal(l.chatId, lena, 'the chat Anna has with Lena already');
    assert.doesNotMatch(JSON.stringify(r), SECRET);
    const q = bridge.requests.filter((x) => x.path.endsWith('/contacts'));
    assert.equal(q.length, 1);
    assert.equal(q[0].userId, anna(), 'as Anna');
    // the picture is Anna's to fetch, not Ben's
    const ev = bridges._eventsOf();
    assert.equal(ev.openMediaRef(kim.avatar).userId, annaId);
  });

  it('a contact the bridge names by its number has no name here — the number never goes out as one', async () => {
    bridge.contacts = [{ number: '+4915100000000', name: '+4915100000000 (WA)' }, { number: '+4915100000001', name: 'Mia (WA)' }];
    const r = await list();
    assert.deepEqual(r.contacts.map((c) => c.name), [null, 'Mia']);
    assert.doesNotMatch(JSON.stringify(r), /15100000|\(WA\)/);
    const m = await match(['+49 151 00000000']);
    assert.equal(m.matches[0].name, null);
  });

  it('kept in memory for 10 minutes: asked once, a new reference each time', async () => {
    const a = await list();
    const b = await list();
    assert.equal(bridge.requests.filter((x) => x.path.endsWith('/contacts')).length, 1);
    assert.notEqual(a.contacts[0].ref, b.contacts[0].ref, 'sealed with a fresh nonce');
    assert.equal(a.contacts[0].contactId, b.contacts[0].contactId, 'the contact id is stable');
    assert.match(a.contacts[0].contactId, /^c[A-Za-z0-9_-]{21}$/);
    assert.equal(a.contacts[0].contactId, bridges._eventsOf().contactRef('whatsapp', '@whatsapp_lid-2041:gc.internal'), 'as the events name the sender');
    bridges._reset();
    await list();
    assert.equal(bridge.requests.filter((x) => x.path.endsWith('/contacts')).length, 2);
  });

  it('a search goes to the bridge’s own search, never kept', async () => {
    const r = await list(annaId, 'ber');
    assert.deepEqual(r.contacts.map((c) => c.name), ['Lena Berger']);
    const q = bridge.requests.find((x) => x.path.endsWith('/search_users'));
    assert.deepEqual(q.body, { query: 'ber' });
    assert.doesNotMatch(JSON.stringify(r), SECRET);
  });

  it('only for the person inside their request; without a link the bridge refuses as a word', async () => {
    await assert.rejects(call('bridges.contacts', { userId: annaId, network: 'whatsapp' }), (e) => e.code === 'ERR_NOT_PERSON');
    await assert.rejects(asPerson(benId, false, () => call('bridges.contacts', { userId: annaId, network: 'whatsapp' })), (e) => e.code === 'ERR_NOT_PERSON');
    await assert.rejects(list(benId), (e) => e.code === 'ERR_BRIDGE' && e.reason === 'refused' && !SECRET.test(e.message));
    await assert.rejects(asPerson(annaId, false, () => call('bridges.contacts', { userId: annaId, network: 'signal' })), (e) => e.code === 'ERR_INVALID');
  });
});

describe('matchNumbers', () => {
  it('the person’s numbers against the list the bridge keeps — no question about a number, nothing counted', async () => {
    const r = await match(['+49 151 1234-5678', '0170 99887766', '+4917099887766', '+4915199999999', 'x', null]);
    assert.deepEqual(r.matches.map((m) => [m.index, m.name]), [[0, 'Kim Muster'], [2, 'Lena Berger']]);
    for (const m of r.matches) assert.deepEqual(Object.keys(m).sort(), ['avatar', 'chatId', 'contactId', 'index', 'name', 'ref']);
    assert.doesNotMatch(JSON.stringify(r), SECRET);
    assert.equal(bridge.requests.filter((x) => /resolve_identifier|create_dm/.test(x.path)).length, 0, 'nothing asked about a number');
    assert.deepEqual(bridge.requests.map((x) => x.path), ['/_matrix/provision/v3/contacts']);
    // nothing counted: the 20 lookups of the hour are all still there
    bridge.numbers.set('+4915112345678', { name: 'Kim', room: '!x:gc.internal' });
    for (let i = 0; i < 20; i++) await asPerson(annaId, true, () => call('bridges.resolve', { userId: annaId, network: 'whatsapp', number: '+4915112345678' }));
    assert.deepEqual(await match([]), { matches: [] });
    await assert.rejects(match('nope'), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(match(Array.from({ length: 2001 }, () => '+4915112345678')), (e) => e.code === 'ERR_INVALID');
  });
});

describe('createDmByRef', () => {
  it('starts the chat by the bridge’s contact — by its ghost, not by a number', async () => {
    const [kim] = (await list()).contacts;
    const r = await startByRef(kim.ref);
    assert.match(r.chat.id, /^r[A-Za-z0-9_-]{20}$/);
    assert.deepEqual({ ...r.chat, id: 'x' }, { id: 'x', kind: 'direct', name: 'Kim Muster' });
    assert.doesNotMatch(JSON.stringify(r), SECRET);
    const q = bridge.requests.find((x) => x.path.includes('create_dm'));
    assert.equal(decodeURIComponent(q.path), '/_matrix/provision/v3/create_dm/@whatsapp_lid-2041:gc.internal');
    assert.equal(bridge.requests.filter((x) => x.path.includes('resolve_identifier')).length, 0);
    const [row] = db.prepare('SELECT * FROM bridge_rooms').all();
    assert.deepEqual([row.ref, row.user_id, row.room_id], [r.chat.id, annaId, '!kc1:gc.internal']);
    // the same again: the same chat; and the list now names it
    assert.equal((await startByRef(kim.ref)).chat.id, r.chat.id);
    assert.equal((await list()).contacts[0].chatId, null, 'the bridge names the room only once it has one (dm_room_mxid)');
  });

  it('only the person’s own reference, only on this network, only for 30 minutes, only in this process', async () => {
    const [kim] = (await list()).contacts;
    await assert.rejects(call('bridges.createDmByRef', { userId: annaId, network: 'whatsapp', ref: kim.ref }), (e) => e.code === 'ERR_NOT_PERSON');
    await assert.rejects(asPerson(annaId, false, () => call('bridges.createDmByRef', { userId: annaId, network: 'whatsapp', ref: kim.ref })), (e) => e.code === 'ERR_NOT_PERSON', 'a changing request');
    bridge.logins.set(`@gc_${benId}:${S}`, [{ id: 'login-b', name: '+491700000002', state_event: 'CONNECTED', timestamp: Date.now() }]);
    await assert.rejects(startByRef(kim.ref, benId), (e) => e.code === 'ERR_INVALID' && e.reason === 'expired_ref', 'Anna’s reference is not Ben’s');
    for (const bad of ['', 'k' + 'A'.repeat(60), kim.ref.slice(0, -2) + 'AA', 'x', null, 42]) {
      await assert.rejects(startByRef(bad), (e) => e.code === 'ERR_INVALID');
    }
    assert.equal(bridges._openContactRef(annaId, 'whatsapp', kim.ref, Date.now() + 29 * 60000) !== null, true);
    assert.equal(bridges._openContactRef(annaId, 'whatsapp', kim.ref, Date.now() + 31 * 60000), null, 'runs out after 30 minutes');
    assert.equal(bridges._openContactRef(annaId, 'telegram', kim.ref), null);
    bridges._reset();
    await assert.rejects(startByRef(kim.ref), (e) => e.code === 'ERR_INVALID' && e.reason === 'expired_ref', 'a restart: a new key');
    assert.equal(bridge.requests.filter((x) => x.path.includes('create_dm')).length, 0);
  });

  it('a contact the bridge no longer knows: not_found as a word', async () => {
    const [kim] = (await list()).contacts;
    bridge.contacts = [];
    await assert.rejects(startByRef(kim.ref), (e) => e.code === 'ERR_BRIDGE' && e.reason === 'not_found');
  });
});

describe('gc.bridges version 6', () => {
  it('status() names version 7 (6 and newer: contacts)', () => {
    assert.equal(bridges.status().version, 7);
  });
});
