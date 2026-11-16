'use strict';

// Messenger bridges, gc.bridges version 12 (docs/feature-messenger-bridges.md, "WhatsApp-Status"): the room in which
// mautrix-whatsapp v0.2610.0 puts the contacts' status updates (status@broadcast, RoomTypeDefault, name "WhatsApp
// Status Broadcast" — pkg/connector/chatinfo.go wrapStatusBroadcastInfo) is chat.status; "seen" is reported there only
// on an explicit word of the plugin, nothing is sent into it. The stand-in homeserver delivers the events.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { startFakeHomeserver } = require('./helpers/fake-homeserver');

let bridges, hsMod, appservice, hostApi, ctx, db, annaId, hs;
const PLUGIN = { id: 'bridge-demo', manifest: { permissions: { bridges: true } } };
const call = (api, args) => hostApi.handle(PLUGIN, api, args);
const asPerson = (userId, write, fn) => ctx.run(PLUGIN.id, userId, write, fn);
const S = 'gc.internal';
const anna = () => `@gc_${annaId}:${S}`;
const BOT = `@whatsappbot:${S}`;
// the bridge names a contact by its LID when WhatsApp tells it (events.go pickLID) — in the direct chat as in the status room
const KIM = `@whatsapp_lid-100000000000001:${S}`;
const JO = `@whatsapp_4915100000000:${S}`;
let n = 0;
const ev = (room, sender, type, content, extra = {}) => ({ room_id: room, sender, type, content, event_id: `$st${++n}`, origin_server_ts: 1763290000000 + n * 1000, ...extra });
const msg = (room, sender, body, extra = {}) => ev(room, sender, 'm.room.message', { msgtype: 'm.text', body, ...extra });
const bridgeState = (id, type) => ({ type: 'm.bridge', state_key: 'x', content: { bridgebot: BOT, protocol: { id: 'whatsapp', displayname: 'WhatsApp' }, channel: { id, displayname: 'x' }, ...(type ? { 'com.beeper.room_type.v2': type } : {}) } });
const nameState = (name) => ({ type: 'm.room.name', state_key: '', content: { name } });
const memberState = (who, displayname) => ({ type: 'm.room.member', state_key: who, content: { membership: 'join', displayname } });
const pulled = () => call('bridges.events.pull', {}).then((r) => r.events);
const ack = () => call('bridges.events.ack', { upTo: 1e9 });

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
  annaId = Number(add.run('anna-brst', 'x', 'user', 'de', 'Anna').lastInsertRowid);
  bridges.configure({ enabled: true, networks: { whatsapp: true } }, {});
  assert.equal(await bridges.start(), true);
  const secrets = bridges.readSecrets();
  hs = await startFakeHomeserver({ socket: hsMod.socketOf(bridges.dir()), asToken: secrets.coreAsToken, coreSocket: appservice.socketOf(bridges.dir()), hsToken: secrets.coreHsToken });
});
after(async () => {
  await bridges.stop();
  await hs.close();
  delete process.env.GC_BRIDGES_PREVIEW;
  teardown();
});
beforeEach(() => {
  db.exec('DELETE FROM bridge_inbox; DELETE FROM bridge_rooms; DELETE FROM bridge_txns; DELETE FROM bridge_backlog; DELETE FROM bridge_media;');
  bridges._reset();
  bridges._runtime.wake = () => {};
  hs.rooms.clear();
  hs.requests.length = 0;
  hs.sent.length = 0;
  hs.down = false;
});

/** A room the bridge made for Anna, Anna in it. → the 'chat' event */
async function open(room, state, timeline = []) {
  hs.room(room, { state, timeline, members: [anna()] });
  const r = await hs.push(`open-${room}`, { events: [ev(room, anna(), 'm.room.member', { membership: 'join' }, { state_key: anna() })] });
  assert.equal(r.status, 200);
  const evs = await pulled();
  await ack();
  return evs.find((e) => e.type === 'chat');
}
const STATUS_STATE = () => [bridgeState('status@broadcast'), nameState('WhatsApp Status Broadcast'), memberState(KIM, 'Kim'), memberState(JO, 'Jo')];

describe('the room of the WhatsApp status updates', () => {
  it('is chat.status — a group nobody writes in; its updates are messages of the contacts, the same contact as in the direct chat', async () => {
    const room = '!status:gc.internal';
    const chat = await open(room, STATUS_STATE());
    assert.deepEqual({ ...chat.chat, id: 'x' }, { id: 'x', kind: 'group', name: 'WhatsApp Status Broadcast', avatar: null, channel: false, readOnly: true, timer: null, status: true });
    assert.equal(db.prepare('SELECT status FROM bridge_rooms WHERE room_id = ?').get(room).status, 1);
    // the direct chat with Kim (the bridge's DM portal, the same LID ghost)
    const dm = await open('!dmkim:gc.internal', [bridgeState('100000000000001@lid', 'dm'), memberState(KIM, 'Kim')]);
    assert.equal(dm.chat.kind, 'direct');
    assert.equal(dm.chat.status, undefined, 'only the status room carries the field');

    hs.file('st1', { data: Buffer.from('jpeg'), mime: 'image/jpeg' });
    const text = msg(room, KIM, 'Heute ab 15 Uhr nicht erreichbar');
    const pic = ev(room, JO, 'm.room.message', { msgtype: 'm.image', body: 'Abendrunde am See', filename: 'status.jpg', url: `mxc://${S}/st1`, info: { mimetype: 'image/jpeg', w: 1080, h: 1920, size: 4 } });
    const del = ev(room, KIM, 'm.room.redaction', {}, { redacts: text.event_id });
    const inDm = msg('!dmkim:gc.internal', KIM, 'Hallo');
    await hs.push('t-st', { events: [text, pic, del, inDm] });
    const evs = await pulled();
    assert.deepEqual(evs.map((e) => [e.type, e.chat.status === true]), [['message', true], ['message', true], ['redact', true], ['message', false]]);
    assert.deepEqual([evs[0].kind, evs[0].text, evs[0].sender.name], ['text', 'Heute ab 15 Uhr nicht erreichbar', 'Kim']);
    assert.deepEqual([evs[1].kind, evs[1].media.kind, evs[1].text], ['media', 'image', 'Abendrunde am See']);
    assert.equal(evs[0].sender.id, evs[3].sender.id, 'Kim is the same contact in the status room and in the direct chat');
    assert.notEqual(evs[0].sender.id, evs[1].sender.id);
    assert.doesNotMatch(JSON.stringify(evs), /broadcast|lid-|4915100000000|gc\.internal/, 'no id at the bridge, no number, no Matrix address');
    const list = await asPerson(annaId, false, () => call('bridges.chats', { userId: annaId, network: 'whatsapp' }));
    assert.deepEqual(list.map((c) => [c.kind, c.readOnly, c.status === true]), [['group', true, true], ['direct', false, false]]);
  });

  it('nothing is sent into it; "seen" only with { status: true }, never automatically', async () => {
    const room = '!status2:gc.internal';
    const chat = (await open(room, STATUS_STATE())).chat.id;
    const one = msg(room, KIM, 'Status');
    await hs.push('t-st2', { events: [one] });
    await ack();
    const args = { userId: annaId, network: 'whatsapp', chatId: chat };
    await assert.rejects(asPerson(annaId, true, () => call('bridges.send', { ...args, message: { txnId: 'abcdefgh1', text: 'x' } })), (e) => e.code === 'ERR_BRIDGE' && e.reason === 'status_room');
    await assert.rejects(asPerson(annaId, true, () => call('bridges.react', { ...args, reaction: { txnId: 'abcdefgh2', target: one.event_id, emoji: '❤️' } })), (e) => e.code === 'ERR_BRIDGE' && e.reason === 'status_room');
    await assert.rejects(asPerson(annaId, true, () => call('bridges.redact', { ...args, redaction: { txnId: 'abcdefgh3', target: one.event_id } })), (e) => e.code === 'ERR_BRIDGE' && e.reason === 'status_room');
    assert.deepEqual(await asPerson(annaId, true, () => call('bridges.typing', { ...args, on: true })), { ok: true, skipped: 'status' });
    // an older plugin opens the room as a chat: its read receipt goes nowhere
    assert.deepEqual(await asPerson(annaId, true, () => call('bridges.read', { ...args, messageId: one.event_id })), { ok: true, skipped: 'status' });
    assert.equal(hs.sent.length, 0);
    // the person watched this status (and asked for "seen" at WhatsApp): the one receipt
    await asPerson(annaId, true, () => call('bridges.read', { ...args, messageId: one.event_id, status: true }));
    assert.deepEqual(hs.sent.map((s) => [s.type, s.kind, s.target]), [['receipt', 'm.read', one.event_id]]);
  });

  it('a status room from before version 12 (kept as a direct chat) turns into one by refreshRooms — the plugin hears of it once', async () => {
    const room = '!before-st:gc.internal';
    await open(room, STATUS_STATE());
    // as an older server kept it: no id fitted, a direct chat, looked at; the migration sets channel back to NULL
    db.prepare("UPDATE bridge_rooms SET kind = 'direct', channel = 0, read_only = 0, status = 0 WHERE room_id = ?").run(room);
    db.prepare("UPDATE bridge_rooms SET channel = NULL WHERE network = 'whatsapp' AND kind = 'direct'").run();
    bridges._runtime.events._forget();
    const r = await bridges._runtime.events.refreshRooms();
    assert.deepEqual([r.looked, r.changed], [1, 1]);
    const evs = await pulled();
    assert.deepEqual(evs.map((e) => [e.type, e.chat.kind, e.chat.status, e.chat.readOnly]), [['chat', 'group', true, true]]);
    assert.equal((await bridges._runtime.events.refreshRooms()).looked, 0, 'looked at once');
  });

  it('an older room learns it with its next event as well', async () => {
    const room = '!before-st2:gc.internal';
    await open(room, STATUS_STATE());
    db.prepare("UPDATE bridge_rooms SET kind = 'direct', channel = 0, status = 0 WHERE room_id = ?").run(room);
    bridges._runtime.events._forget();
    await hs.push('t-st4', { events: [msg(room, KIM, 'Neu')] });
    const evs = await pulled();
    assert.deepEqual(evs.map((e) => [e.type, e.chat.status === true]), [['chat', true], ['message', true]]);
  });

  it('the migration: a status column, WhatsApp direct chats looked at once more, nothing else touched', () => {
    const m = require('../src/db/migrationList').migrations.find((x) => x.name === 'bridge_rooms_status');
    assert.equal(m.version, 156);
    assert.match(m.sql, /ADD COLUMN status INTEGER NOT NULL DEFAULT 0/);
    assert.match(m.sql, /SET channel = NULL WHERE network = 'whatsapp' AND kind = 'direct'/);
    assert.equal(m.detect(db), true);
  });
});

describe('gc.bridges version 12', () => {
  it('status() and the plugin side say 12', () => {
    assert.equal(bridges.status().version, 12);
  });
});
