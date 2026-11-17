'use strict';

// Messenger bridges, stage 3 (docs/feature-messenger-bridges.md, "Messages"):
// the server as an application service of the internal homeserver. A stand-in
// homeserver (tests/helpers/fake-homeserver.js) delivers transactions the way
// Tuwunel does and answers the client API; no bridge, no WhatsApp.
//
//   the listener        token, paths, what is answered when
//   rooms               an invite is accepted, a room joined by the bridge is adopted, what was said
//                       before is fetched, one room belongs to one person
//   the neutral events  text, reply, edit, deletion, reaction, media as a placeholder, what the bridge
//                       says about a sent message, typing and read receipts — and nothing with an address
//   twice, any order    the same transaction again, a restart in between, the homeserver not answering
//   the host API        gc.bridges version 3: who may pull, who may send as whom

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setup, teardown } = require('./helpers/setup');
const { startFakeHomeserver } = require('./helpers/fake-homeserver');

let bridges, hsMod, appservice, hostApi, ctx, db, annaId, benId, hs, woke;
const PLUGIN = { id: 'bridge-demo', manifest: { permissions: { bridges: true } } };
const NOPERM = { id: 'other-demo', manifest: { permissions: {} } };
const asPerson = (userId, write, fn) => ctx.run(PLUGIN.id, userId, write, fn);
const call = (api, args) => hostApi.handle(PLUGIN, api, args);
const S = 'gc.internal';
const anna = () => `@gc_${annaId}:${S}`;
const ben = () => `@gc_${benId}:${S}`;
const KIM = `@whatsapp_4915198765432:${S}`;
const BOT = `@whatsappbot:${S}`;
let n = 0;
const ev = (room, sender, type, content, extra = {}) => ({ room_id: room, sender, type, content, event_id: `$e${++n}`, origin_server_ts: 1763150000000 + n * 1000, ...extra });
const msg = (room, sender, body, extra = {}) => ev(room, sender, 'm.room.message', { msgtype: 'm.text', body, ...extra });
const member = (room, sender, who, membership, displayname) => ev(room, sender, 'm.room.member', { membership, ...(displayname ? { displayname } : {}) }, { state_key: who });
const bridgeState = (type = 'dm') => ({ type: 'm.bridge', state_key: 'x', content: { bridgebot: BOT, protocol: { id: 'whatsapp', displayname: 'WhatsApp' }, channel: { id: '4915198765432@s.whatsapp.net' }, 'com.beeper.room_type.v2': type } });
const nameState = (name) => ({ type: 'm.room.name', state_key: '', content: { name } });
const memberState = (who, displayname) => ({ type: 'm.room.member', state_key: who, content: { membership: 'join', displayname } });
const pulled = () => call('bridges.events.pull', {}).then((r) => r.events);
const rooms = () => db.prepare('SELECT * FROM bridge_rooms ORDER BY created_at, room_id').all();

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
  annaId = Number(add.run('anna-brmsg', 'x', 'user', 'de', 'Anna').lastInsertRowid);
  benId = Number(add.run('ben-brmsg', 'x', 'user', 'de', 'Ben').lastInsertRowid);
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
  db.exec('DELETE FROM bridge_inbox; DELETE FROM bridge_rooms; DELETE FROM bridge_txns;');
  bridges._reset();
  woke = [];
  bridges._runtime.wake = (eph) => woke.push(eph);
  hs.rooms.clear();
  hs.requests.length = 0;
  hs.sent.length = 0;
  hs.down = false;
  hs.refuseJoin = null;
});

/** A room the bridge made for Anna with Kim, and Anna already in it. → the chat's reference */
async function annaAndKim(room = '!kim:gc.internal') {
  hs.room(room, { state: [bridgeState(), nameState('Kim Muster'), memberState(KIM, 'Kim Muster')], members: [anna()] });
  const r = await hs.push(`open-${room}`, { events: [member(room, anna(), anna(), 'join')] });
  assert.equal(r.status, 200);
  const chat = (await pulled()).find((e) => e.type === 'chat');
  await call('bridges.events.ack', { upTo: 1e9 });
  woke.length = 0;
  return chat.chat.id;
}

describe('the listener', () => {
  it('lies in the bridges’ folder, takes only the homeserver’s token and knows two paths', async () => {
    const sock = appservice.socketOf(bridges.dir());
    assert.ok(fs.statSync(sock).isSocket());
    assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
    assert.equal(bridges.status().messages.listening, true);
    assert.equal((await hs.push('t1', { events: [] }, { token: 'x'.repeat(43) })).status, 403);
    assert.equal((await hs.push('t1', { events: [] }, { token: '' })).status, 401);
    // the bridge's own token is not the server's
    assert.equal((await hs.push('t1', { events: [] }, { token: bridges.readSecrets().hsToken })).status, 403);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_txns').get().n, 0, 'nothing was read');
    const ok = await hs.push('t1', { events: [] });
    assert.deepEqual([ok.status, ok.json], [200, {}]);
    assert.deepEqual((await hs.push('', {}, { method: 'POST', path: '/_matrix/app/v1/ping' })).status, 200);
    assert.equal((await hs.push('', {}, { method: 'GET', path: '/_matrix/app/v1/users/%40x%3Agc.internal' })).status, 404);
    assert.equal((await hs.push('', {}, { method: 'POST', path: '/_matrix/app/v1/transactions/t9' })).status, 404, 'only PUT');
    assert.equal((await hs.push('', {}, { method: 'GET', path: '/' })).status, 404);
  });

  it('stops when the bridges are switched off and listens again when they come back', async () => {
    const sock = appservice.socketOf(bridges.dir());
    bridges.configure({ enabled: false }, {});
    await bridges.start();
    assert.equal(fs.existsSync(sock), false);
    assert.equal(bridges.status().messages.listening, false);
    bridges.configure({ enabled: true }, {});
    assert.equal(await bridges.start(), true);
    assert.ok(fs.statSync(sock).isSocket());
  });
});

describe('rooms', () => {
  it('accepts a bridge’s invite, and fetches what was said before the account was in the room', async () => {
    const room = '!r1:gc.internal';
    // the message that made the bridge open the room is already in it
    hs.room(room, { state: [bridgeState(), nameState('Kim Muster'), memberState(KIM, 'Kim Muster')], timeline: [msg(room, KIM, 'Kommt ihr Samstag?')] });
    const r = await hs.push('t-invite', { events: [member(room, BOT, anna(), 'invite')] });
    assert.equal(r.status, 200);
    const join = hs.requests.find((q) => q.path.endsWith('/join'));
    assert.equal(join.userId, anna(), 'joined as Anna’s internal account');
    assert.match(join.auth, /^Bearer /);
    const [row] = rooms();
    assert.deepEqual([row.user_id, row.network, row.kind, row.state], [annaId, 'whatsapp', 'direct', 'joined']);
    assert.match(row.ref, /^r[A-Za-z0-9_-]{20}$/);
    const evs = await pulled();
    assert.deepEqual(evs.map((e) => e.type), ['chat', 'message']);
    assert.deepEqual(evs[0].chat, { id: row.ref, kind: 'direct', name: 'Kim Muster', avatar: null, channel: false, readOnly: false, timer: null });
    assert.equal(evs[0].userId, annaId);
    assert.equal(evs[1].text, 'Kommt ihr Samstag?');
    assert.equal(evs[1].sender.name, 'Kim Muster');
    assert.match(evs[1].sender.id, /^c[A-Za-z0-9_-]{21}$/);
    assert.equal(woke.length, 1, 'the plugin is woken once');
    // the same message arrives again with the next transaction: same id — the plugin files it once
    const again = { ...hs.rooms.get(room).timeline[0] };
    await hs.push('t-next', { events: [again] });
    const all = await pulled();
    assert.equal(all.filter((e) => e.type === 'message').length, 2);
    assert.equal(new Set(all.filter((e) => e.type === 'message').map((e) => e.id)).size, 1);
  });

  it('adopts a room the bridge joined the account to itself (double puppeting) — and no room that is not a bridge’s', async () => {
    const room = '!r2:gc.internal';
    hs.room(room, { state: [bridgeState('default'), nameState('Elternrunde 4b'), memberState(KIM, 'Kim')], members: [anna()] });
    await hs.push('t-join', { events: [member(room, anna(), anna(), 'join')] });
    const [row] = rooms();
    assert.deepEqual([row.user_id, row.kind, row.state], [annaId, 'group', 'joined']);
    assert.equal(hs.requests.some((q) => q.path.endsWith('/join')), false, 'nothing to accept');
    assert.deepEqual((await pulled()).map((e) => [e.type, e.chat.kind, e.chat.name]), [['chat', 'group', 'Elternrunde 4b']]);

    // a room without the bridge's mark
    hs.room('!other:gc.internal', { state: [nameState('x')], members: [anna()] });
    await hs.push('t-other', { events: [member('!other:gc.internal', anna(), anna(), 'join'), msg('!other:gc.internal', KIM, 'hi')] });
    assert.equal(rooms().length, 1);
    assert.equal((await pulled()).length, 1);
  });

  it('one room, one person: a second account is not let in, an invite from a stranger is not accepted', async () => {
    const room = '!r3:gc.internal';
    hs.room(room, { state: [bridgeState(), nameState('Kim')], members: [] });
    await hs.push('t-a', { events: [member(room, BOT, anna(), 'invite')] });
    hs.requests.length = 0;
    await hs.push('t-b', { events: [member(room, BOT, ben(), 'invite')] });
    assert.equal(hs.requests.length, 0, 'no join for Ben');
    assert.equal(rooms().length, 1);
    assert.equal(rooms()[0].user_id, annaId);
    // somebody who is neither the bridge nor one of its contacts
    hs.room('!r4:gc.internal', { state: [bridgeState()] });
    await hs.push('t-c', { events: [member('!r4:gc.internal', '@mallory:gc.internal', ben(), 'invite'), member('!r5:gc.internal', '@whatsappbot:evil.example', ben(), 'invite')] });
    assert.equal(hs.requests.some((q) => q.path.endsWith('/join')), false);
    assert.equal(rooms().length, 1);
    // events of a room nobody was invited to are not anybody's
    await hs.push('t-d', { events: [msg('!r4:gc.internal', KIM, 'für niemanden')] });
    assert.equal((await pulled()).some((e) => e.text === 'für niemanden'), false);
  });

  it('closes a chat when the account leaves, and opens it again', async () => {
    const chat = await annaAndKim('!r6:gc.internal');
    await hs.push('t-leave', { events: [member('!r6:gc.internal', BOT, anna(), 'leave')] });
    assert.equal(rooms()[0].state, 'left');
    const evs = await pulled();
    assert.deepEqual([evs[0].type, evs[0].closed, evs[0].chat.id], ['chat', true, chat]);
    await hs.push('t-late', { events: [msg('!r6:gc.internal', KIM, 'danach')] });
    assert.equal((await pulled()).length, 1, 'nothing from a room the account left');
    await assert.rejects(asPerson(annaId, true, () => call('bridges.send', { userId: annaId, network: 'whatsapp', chatId: chat, message: { txnId: 'abcdefgh1', text: 'x' } })), (e) => e.code === 'ERR_BRIDGE' && e.reason === 'chat_closed');
  });
});

describe('the neutral events', () => {
  it('text, reply, edit, deletion and reaction of a contact — with ids, never with an address', async () => {
    const room = '!m1:gc.internal';
    const chat = await annaAndKim(room);
    const first = msg(room, KIM, 'Kommt ihr Samstag zum Grillen?\r\nAb 16 Uhr');
    const reply = msg(room, KIM, 'Passt, bis Samstag!', { 'm.relates_to': { 'm.in_reply_to': { event_id: first.event_id } } });
    const edit = msg(room, KIM, '* Ab 17 Uhr', { 'm.new_content': { msgtype: 'm.text', body: 'Ab 17 Uhr' }, 'm.relates_to': { rel_type: 'm.replace', event_id: first.event_id } });
    const react = ev(room, KIM, 'm.reaction', { 'm.relates_to': { rel_type: 'm.annotation', event_id: first.event_id, key: '👍' } });
    const unreact = ev(room, KIM, 'm.room.redaction', {}, { redacts: react.event_id });
    const del = ev(room, KIM, 'm.room.redaction', { redacts: reply.event_id });
    const r = await hs.push('t-m1', { events: [first, reply, edit, react, unreact, del] });
    assert.equal(r.status, 200);
    const evs = await pulled();
    assert.deepEqual(evs.map((e) => e.type), ['message', 'message', 'edit', 'reaction', 'redact', 'redact']);
    assert.deepEqual([evs[0].kind, evs[0].text, evs[0].id, evs[0].replyTo], ['text', 'Kommt ihr Samstag zum Grillen?\nAb 16 Uhr', first.event_id, null]);
    assert.equal(evs[0].at, first.origin_server_ts);
    assert.equal(evs[1].replyTo, first.event_id);
    assert.deepEqual([evs[2].target, evs[2].text], [first.event_id, 'Ab 17 Uhr']);
    assert.deepEqual([evs[3].target, evs[3].emoji, evs[3].id], [first.event_id, '👍', react.event_id]);
    assert.equal(evs[4].target, react.event_id);
    assert.equal(evs[5].target, reply.event_id);
    for (const e of evs) {
      assert.equal(e.chat.id, chat);
      assert.equal(e.userId, annaId);
      assert.equal(e.network, 'whatsapp');
      assert.equal(e.sender.id, evs[0].sender.id, 'the same contact every time');
      assert.equal(e.sender.name, 'Kim Muster');
    }
    const all = JSON.stringify(evs);
    assert.doesNotMatch(all, /gc\.internal|whatsapp_|4915198765432|!m1|@gc_/, 'no Matrix address, no room id, no number');
  });

  it('media arrive as a placeholder with their kind and name, unknown kinds as "unsupported" — nothing is swallowed', async () => {
    const room = '!m2:gc.internal';
    await annaAndKim(room);
    await hs.push('t-m2', { events: [
      msg(room, KIM, 'IMG_2041.jpg', { msgtype: 'm.image', url: 'mxc://gc.internal/abc', info: { mimetype: 'image/jpeg' } }),
      msg(room, KIM, 'So sah es letztes Jahr aus', { msgtype: 'm.image', filename: 'grill.jpg', url: 'mxc://gc.internal/abd' }),
      msg(room, KIM, 'voice.ogg', { msgtype: 'm.audio', 'org.matrix.msc3245.voice': {}, url: 'mxc://gc.internal/abe' }),
      msg(room, KIM, 'Vertrag.pdf', { msgtype: 'm.file', url: 'mxc://gc.internal/abf' }),
      msg(room, KIM, 'Location: Marktplatz', { msgtype: 'm.location', geo_uri: 'geo:51.1,7.1' }),
      ev(room, KIM, 'm.sticker', { body: 'sticker', url: 'mxc://gc.internal/abg' }),
      ev(room, KIM, 'org.matrix.msc3381.poll.start', { question: 'Kuchen?' }),
      msg(room, KIM, 'x', { msgtype: 'fi.mau.something' }),
      msg(room, BOT, 'Du wurdest abgemeldet', { msgtype: 'm.notice' }),
    ] });
    const evs = await pulled();
    assert.deepEqual(evs.map((e) => [e.kind, e.media ? e.media.kind : null, e.media ? e.media.name : null, e.text]), [
      ['media', 'image', 'IMG_2041.jpg', null],
      ['media', 'image', 'grill.jpg', 'So sah es letztes Jahr aus'],
      ['media', 'voice', 'voice.ogg', null],
      ['media', 'file', 'Vertrag.pdf', null],
      ['media', 'location', null, 'Location: Marktplatz'],
      ['media', 'sticker', 'sticker', null],
      ['unsupported', null, null, null],
      ['unsupported', null, null, null],
      ['notice', null, null, 'Du wurdest abgemeldet'],
    ]);
    assert.deepEqual(evs[8].sender, { system: true });
    assert.doesNotMatch(JSON.stringify(evs), /mxc:|geo:/, 'no file address goes out — files travel as sealed references (stage 4)');
  });

  it('tells the person’s own messages apart: written in the messenger’s app = theirs, sent by GateControl = known already', async () => {
    const room = '!m3:gc.internal';
    await annaAndKim(room);
    await hs.push('t-m3', { events: [
      msg(room, anna(), 'vom Handy geschrieben', { 'fi.mau.double_puppet_source': 'mautrix-whatsapp' }),
      msg(room, anna(), 'aus GateControl gesendet'),
      ev(room, anna(), 'm.reaction', { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$x1', key: '❤️' } }),
      msg(room, ben(), 'von einem anderen Konto'),
    ] });
    const evs = await pulled();
    assert.deepEqual(evs.map((e) => [e.type, e.text, e.sender]), [['message', 'vom Handy geschrieben', { self: true }]]);
  });

  it('passes on what the bridge says about a sent message: bridged, delivered, failed with its reason', async () => {
    const room = '!m4:gc.internal';
    await annaAndKim(room);
    const st = (status, extra = {}) => ev(room, BOT, 'com.beeper.message_send_status', { network: 'whatsapp', 'm.relates_to': { rel_type: 'm.reference', event_id: '$sent1' }, status, ...extra });
    await hs.push('t-m4', { events: [
      st('PENDING'), st('SUCCESS'), st('SUCCESS', { delivered_to_users: [KIM] }),
      st('FAIL_RETRIABLE', { reason: 'm.foreign_network_error', error: 'dial tcp 157.240.0.1:443: timeout', internal_error: 'x', message: 'Nicht verbunden' }),
      st('FAIL_PERMANENT', { reason: 'm.no_permission' }), st('FAIL_PERMANENT', { reason: '<script>' }),
      // only the bridge may say so
      ev(room, KIM, 'com.beeper.message_send_status', { 'm.relates_to': { event_id: '$sent1' }, status: 'SUCCESS' }),
    ] });
    const evs = await pulled();
    assert.deepEqual(evs.map((e) => [e.type, e.target, e.status, e.reason || null, e.retriable === undefined ? null : e.retriable]), [
      ['status', '$sent1', 'sent', null, null],
      ['status', '$sent1', 'delivered', null, null],
      ['status', '$sent1', 'failed', 'network_error', true],
      ['status', '$sent1', 'failed', 'no_permission', false],
      ['status', '$sent1', 'failed', 'bridge_error', false],
    ]);
    assert.doesNotMatch(JSON.stringify(evs), /157\.240|dial tcp|Nicht verbunden/, 'the bridge’s raw texts stay out');
  });

  it('follows a changed room name and a contact’s new name', async () => {
    const room = '!m5:gc.internal';
    const chat = await annaAndKim(room);
    await hs.push('t-m5', { events: [
      ev(room, BOT, 'm.room.name', { name: 'Kim M.' }, { state_key: '' }),
      member(room, KIM, KIM, 'join', 'Kim (neu)'),
      msg(room, KIM, 'hi'),
    ] });
    const evs = await pulled();
    assert.deepEqual(evs.map((e) => e.type), ['chat', 'contact', 'message']);
    assert.deepEqual(evs[0].chat, { id: chat, kind: 'direct', name: 'Kim M.', avatar: null, channel: false, readOnly: false, timer: null });
    assert.equal(evs[1].contact.name, 'Kim (neu)');
    assert.equal(evs[2].sender.name, 'Kim (neu)');
    assert.equal(evs[2].sender.id, evs[1].contact.id);
  });

  it('never a phone number as a name: a chat or contact the bridge names by number gets none, " (WA)" goes', async () => {
    // mautrix-whatsapp's own template falls back to the number ("+49 151 00000000 (WA)") and to its redacted form
    const room = '!m5n:gc.internal';
    const chat = await annaAndKim(room);
    await hs.push('t-m5n', { events: [
      ev(room, BOT, 'm.room.name', { name: '+4915100000000 (WA)' }, { state_key: '' }),
      member(room, KIM, KIM, 'join', '+49 151 00000000'),
      msg(room, KIM, 'hi'),
      ev(room, BOT, 'm.room.name', { name: '+4\u2219\u2219\u2219\u2219\u2219\u2219\u2219\u2219\u221900 (WA)' }, { state_key: '' }),
      member(room, KIM, KIM, 'join', 'Kim Muster (WA)'),
      ev(room, BOT, 'm.room.name', { name: 'Kim Muster (WA)' }, { state_key: '' }),
    ] });
    const evs = await pulled();
    assert.deepEqual(evs.map((e) => e.type), ['chat', 'contact', 'message', 'contact', 'chat']);
    assert.equal(evs[0].chat.id, chat);
    assert.equal(evs[0].chat.name, null, 'a number is no name');
    assert.equal(evs[1].contact.name, null);
    assert.equal(evs[2].sender.name, null);
    assert.equal(evs[3].contact.name, 'Kim Muster', 'the suffix goes');
    assert.equal(evs[4].chat.name, 'Kim Muster');
    assert.doesNotMatch(JSON.stringify(evs), /151|0{6}|\(WA\)|\u2219/);
  });

  it('typing and read receipts go out with the wake-up call and are never stored', async () => {
    const room = '!m6:gc.internal';
    const chat = await annaAndKim(room);
    const typing = { type: 'm.typing', room_id: room, content: { user_ids: [KIM, anna()] } };
    const receipt = { type: 'm.receipt', room_id: room, content: { $sent1: { 'm.read': { [KIM]: { ts: 1 }, [anna()]: { ts: 2 } } } } };
    const r = await hs.push('t-m6', { events: [], ephemeral: [typing], 'de.sorunome.msc2409.ephemeral': [receipt] });
    assert.equal(r.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_inbox').get().n, 0);
    assert.equal(woke.length, 1);
    const [t, r1, r2] = woke[0];
    assert.deepEqual([t.type, t.userId, t.chat.id, t.contacts.length], ['typing', annaId, chat, 1]);
    assert.match(t.contacts[0], /^c/);
    assert.deepEqual([r1.type, r1.upTo, typeof r1.reader.id], ['receipt', '$sent1', 'string']);
    assert.deepEqual(r2.reader, { self: true }, 'read in the messenger’s own app');
    assert.doesNotMatch(JSON.stringify(woke), /gc\.internal|whatsapp_/);
  });

  it('keeps what nobody fetched sealed in the database, hands it out in order and forgets what was acknowledged', async () => {
    const room = '!m7:gc.internal';
    await annaAndKim(room);
    await hs.push('t-m7', { events: [msg(room, KIM, 'streng geheim eins'), msg(room, KIM, 'streng geheim zwei'), msg(room, KIM, 'drei')] });
    const raw = db.prepare('SELECT payload FROM bridge_inbox').all().map((r) => r.payload).join('\n');
    assert.doesNotMatch(raw, /geheim|Kim|message/, 'no readable text or name in the server’s database');
    const first = await call('bridges.events.pull', { limit: 2 });
    assert.equal(first.events.length, 2);
    assert.equal(first.more, true);
    assert.ok(first.events[0].seq < first.events[1].seq);
    const rest = await call('bridges.events.pull', { after: first.events[1].seq });
    assert.deepEqual(rest.events.map((e) => e.text), ['drei']);
    assert.equal(rest.more, false);
    assert.deepEqual(await call('bridges.events.ack', { upTo: first.events[1].seq }), { ok: true, pending: 1 });
    assert.deepEqual((await pulled()).map((e) => e.text), ['drei']);
    assert.equal(bridges.status().messages.pending, 1);
    await assert.rejects(call('bridges.events.ack', { upTo: 'x' }), (e) => e.code === 'ERR_INVALID');
  });
});

describe('twice, in any order, with a restart in between', () => {
  it('takes a transaction once, however often the homeserver sends it', async () => {
    const room = '!t1:gc.internal';
    await annaAndKim(room);
    const body = { events: [msg(room, KIM, 'einmal')] };
    assert.equal((await hs.push('t-same', body)).status, 200);
    assert.equal((await hs.push('t-same', body)).status, 200);
    assert.equal((await hs.push('t-same', body)).status, 200);
    assert.equal((await pulled()).length, 1);
    assert.equal(woke.length, 1);
    // also after the plugin has fetched and acknowledged it
    await call('bridges.events.ack', { upTo: 1e9 });
    assert.equal((await hs.push('t-same', body)).status, 200);
    assert.equal((await pulled()).length, 0);
  });

  it('passes on a reaction, an edit and a deletion that arrive before their message', async () => {
    const room = '!t2:gc.internal';
    await annaAndKim(room);
    const m = msg(room, KIM, 'später');
    const react = ev(room, KIM, 'm.reaction', { 'm.relates_to': { rel_type: 'm.annotation', event_id: m.event_id, key: '👍' } });
    await hs.push('t-o1', { events: [react] });
    await hs.push('t-o2', { events: [m] });
    assert.deepEqual((await pulled()).map((e) => [e.type, e.target || e.id]), [['reaction', m.event_id], ['message', m.event_id]]);
  });

  it('goes on after a restart of the server: the room is known, its names are asked again', async () => {
    const room = '!t3:gc.internal';
    const chat = await annaAndKim(room);
    await hs.push('t-r1', { events: [msg(room, KIM, 'vor dem Neustart')] });
    // the process is new: nothing in memory, the database as it was
    bridges._reset();
    bridges._runtime.wake = (eph) => woke.push(eph);
    hs.requests.length = 0;
    await hs.push('t-r2', { events: [msg(room, KIM, 'nach dem Neustart')] });
    assert.equal(hs.requests.filter((q) => q.path.endsWith('/state')).length, 1);
    const evs = await pulled();
    assert.deepEqual(evs.map((e) => [e.text, e.chat.id, e.sender.name]), [['vor dem Neustart', chat, 'Kim Muster'], ['nach dem Neustart', chat, 'Kim Muster']]);
    assert.equal(evs[0].sender.id, evs[1].sender.id, 'a contact keeps its reference');
    // and the transaction from before the restart is still known
    assert.equal((await hs.push('t-r1', { events: [msg(room, KIM, 'vor dem Neustart')] })).status, 200);
    assert.equal((await pulled()).length, 2);
  });

  it('asks the homeserver to send again while it cannot be asked — and takes the retry', async () => {
    const room = '!t4:gc.internal';
    hs.room(room, { state: [bridgeState(), nameState('Kim')], timeline: [msg(room, KIM, 'erste')] });
    const body = { events: [member(room, BOT, anna(), 'invite')] };
    hs.down = true;
    assert.equal((await hs.push('t-down', body)).status, 500);
    assert.equal(rooms().length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_txns').get().n, 0, 'not marked as taken');
    hs.down = false;
    assert.equal((await hs.push('t-down', body)).status, 200);
    assert.deepEqual((await pulled()).map((e) => e.type), ['chat', 'message']);
  });

  it('does not let one transaction that never works hold up everything behind it', async () => {
    const room = '!t5:gc.internal';
    hs.room(room, { state: [bridgeState()] });
    const body = { events: [member(room, BOT, anna(), 'invite')] };
    hs.down = true;
    for (let i = 0; i < 5; i++) assert.equal((await hs.push('t-poison', body)).status, 500);
    assert.equal((await hs.push('t-poison', body)).status, 200, 'dropped after a few tries');
    hs.down = false;
    // a refused join is nothing to retry
    hs.refuseJoin = 'M_FORBIDDEN';
    assert.equal((await hs.push('t-refused', body)).status, 200);
    assert.equal(rooms().length, 0);
  });

  it('survives nonsense', async () => {
    const room = '!t6:gc.internal';
    await annaAndKim(room);
    const r = await hs.push('t-junk', { events: [null, 7, {}, { type: 'm.room.message' }, { ...msg(room, KIM, 'x'), event_id: 'no-id' }, { ...msg(room, KIM, 'y'), room_id: '../etc' },
      { ...msg(room, KIM, 'ok'), content: { msgtype: 'm.text', body: { not: 'a string' } } }, msg(room, KIM, 'heil')], ephemeral: [null, { type: 'm.typing' }, { type: 'm.receipt', room_id: room, content: 'x' }] });
    assert.equal(r.status, 200);
    assert.deepEqual((await pulled()).map((e) => e.text), ['', 'heil']);
    assert.equal((await hs.push('t-junk2', [1, 2])).status, 400);
  });
});

describe('gc.bridges version 3 (host API)', () => {
  it('lets the plugin pull without a person, and nobody without the permission', async () => {
    assert.deepEqual(await call('bridges.events.pull', {}), { events: [], more: false });
    await assert.rejects(hostApi.handle(NOPERM, 'bridges.events.pull', {}), (e) => e.code === 'ERR_BRIDGES_DENIED');
    await assert.rejects(hostApi.handle(NOPERM, 'bridges.send', { userId: annaId, network: 'whatsapp', chatId: 'r'.repeat(21), message: {} }), (e) => e.code === 'ERR_BRIDGES_DENIED');
  });

  it('sends only as the person who acts right now, and only into their own chat', async () => {
    const room = '!h1:gc.internal';
    const chat = await annaAndKim(room);
    const args = { userId: annaId, network: 'whatsapp', chatId: chat, message: { txnId: 'client-0001', text: 'Gern! Wir bringen Salat mit.' } };
    await assert.rejects(call('bridges.send', args), (e) => e.code === 'ERR_NOT_PERSON', 'not from a tick');
    await assert.rejects(asPerson(annaId, false, () => call('bridges.send', args)), (e) => e.code === 'ERR_NOT_PERSON', 'not while only reading');
    await assert.rejects(asPerson(benId, true, () => call('bridges.send', args)), (e) => e.code === 'ERR_NOT_PERSON', 'not for somebody else');
    await assert.rejects(asPerson(benId, true, () => call('bridges.send', { ...args, userId: benId })), (e) => e.code === 'ERR_INVALID', 'Anna’s chat is not Ben’s');
    assert.equal(hs.sent.length, 0);

    const r = await asPerson(annaId, true, () => call('bridges.send', args));
    assert.match(r.id, /^\$sent/);
    assert.deepEqual(hs.sent[0], { roomId: room, userId: anna(), type: 'm.room.message', txnId: 'client-0001', content: { msgtype: 'm.text', body: 'Gern! Wir bringen Salat mit.' }, eventId: r.id });
    // the same txnId again: the same message, sent once
    assert.equal((await asPerson(annaId, true, () => call('bridges.send', args))).id, r.id);
    assert.equal(hs.sent.length, 1);

    await asPerson(annaId, true, () => call('bridges.send', { ...args, message: { txnId: 'client-0002', text: 'Antwort', replyTo: '$e1' } }));
    assert.deepEqual(hs.sent[1].content, { msgtype: 'm.text', body: 'Antwort', 'm.relates_to': { 'm.in_reply_to': { event_id: '$e1' } } });
    await asPerson(annaId, true, () => call('bridges.send', { ...args, message: { txnId: 'client-0003', text: 'Gern!', edit: r.id } }));
    assert.deepEqual(hs.sent[2].content, { msgtype: 'm.text', body: '* Gern!', 'm.new_content': { msgtype: 'm.text', body: 'Gern!' }, 'm.relates_to': { rel_type: 'm.replace', event_id: r.id } });

    for (const bad of [{ txnId: 'x', text: 'a' }, { txnId: 'client-0009', text: '' }, { txnId: 'client-0009', text: '   ' }, { txnId: 'client-0009', text: 'a', replyTo: '../x' }, { txnId: 'client-0009' }, null]) {
      await assert.rejects(asPerson(annaId, true, () => call('bridges.send', { ...args, message: bad })), (e) => e.code === 'ERR_INVALID');
    }
    for (const badChat of ['', 'r1', '!h1:gc.internal', 'r' + 'x'.repeat(20)]) {
      await assert.rejects(asPerson(annaId, true, () => call('bridges.send', { ...args, chatId: badChat })), (e) => e.code === 'ERR_INVALID');
    }
    assert.equal(hs.sent.length, 3);
  });

  it('version 14: a place as m.location (geo_uri + MSC3488), with a reply like a text; nothing else with it', async () => {
    const room = '!loc1:gc.internal';
    const chat = await annaAndKim(room);
    const args = { userId: annaId, network: 'whatsapp', chatId: chat };
    const st = bridges.status();
    assert.equal(st.version, 14);
    assert.deepEqual(st.networks.map((x) => [x.id, x.location]), [['whatsapp', true], ['signal', false], ['telegram', true]]);
    const r = await asPerson(annaId, true, () => call('bridges.send', { ...args, message: { txnId: 'loc-000001', location: { lat: 52.5200081234, lon: 13.404954, label: ' Café am\nMarkt ' } } }));
    assert.match(r.id, /^\$sent/);
    assert.deepEqual(hs.sent[0], { roomId: room, userId: anna(), type: 'm.room.message', txnId: 'loc-000001', eventId: r.id, content: {
      msgtype: 'm.location', body: 'Café am Markt', geo_uri: 'geo:52.520008,13.404954',
      'org.matrix.msc3488.location': { uri: 'geo:52.520008,13.404954', description: 'Café am Markt' },
    } });
    // without a label: "Standort", no description (Telegram would show it as the text); a reply quotes like a text
    await asPerson(annaId, true, () => call('bridges.send', { ...args, message: { txnId: 'loc-000002', location: { lat: -33.8688, lon: -0, label: '  ' }, replyTo: '$e7' } }));
    assert.deepEqual(hs.sent[1].content, { msgtype: 'm.location', body: 'Standort', geo_uri: 'geo:-33.8688,0',
      'org.matrix.msc3488.location': { uri: 'geo:-33.8688,0' }, 'm.relates_to': { 'm.in_reply_to': { event_id: '$e7' } } });
    // the same txnId: sent once
    await asPerson(annaId, true, () => call('bridges.send', { ...args, message: { txnId: 'loc-000002', location: { lat: -33.8688, lon: 0 } } }));
    assert.equal(hs.sent.length, 2);
    for (const location of [{}, { lat: 91, lon: 0 }, { lat: 0, lon: 180.5 }, { lat: '52.5', lon: 13.4 }, { lat: NaN, lon: 1 }, { lat: 1 }, [1, 2], 'geo:1,2', { lat: 1, lon: 2, label: 7 }, { lat: 1, lon: 2, label: 'x'.repeat(201) }]) {
      await assert.rejects(asPerson(annaId, true, () => call('bridges.send', { ...args, message: { txnId: 'loc-000009', location } })), (e) => e.code === 'ERR_INVALID', JSON.stringify(location));
    }
    for (const extra of [{ text: 'Hier!' }, { edit: r.id }, { media: { kind: 'image' } }, { replyTo: '../x' }]) {
      // the service itself (the host API would look for the file of `media` first)
      await assert.rejects(bridges.send(annaId, 'whatsapp', chat, { txnId: 'loc-000009', location: { lat: 1, lon: 2 }, ...extra }), (e) => e.code === 'ERR_INVALID', JSON.stringify(extra));
    }
    assert.equal(hs.sent.length, 2);
  });

  it('reacts, takes back, deletes, marks as read and shows typing — as that person', async () => {
    const room = '!h2:gc.internal';
    const chat = await annaAndKim(room);
    const base = { userId: annaId, network: 'whatsapp', chatId: chat };
    const w = (api, extra) => asPerson(annaId, true, () => call(api, { ...base, ...extra }));
    const r = await w('bridges.react', { reaction: { txnId: 'react-0001', target: '$e5', emoji: '👍' } });
    assert.deepEqual(hs.sent[0].content, { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$e5', key: '👍' } });
    assert.equal(hs.sent[0].type, 'm.reaction');
    assert.deepEqual(await w('bridges.redact', { redaction: { txnId: 'redact-001', target: r.id } }), { ok: true });
    assert.deepEqual([hs.sent[1].type, hs.sent[1].target, hs.sent[1].userId], ['redact', r.id, anna()]);
    assert.deepEqual(await w('bridges.read', { messageId: '$e5' }), { ok: true });
    assert.deepEqual([hs.sent[2].type, hs.sent[2].kind, hs.sent[2].target], ['receipt', 'm.read', '$e5']);
    assert.deepEqual(await w('bridges.typing', { on: true }), { ok: true });
    assert.deepEqual([hs.sent[3].who, hs.sent[3].content.typing], [anna(), true]);
    await w('bridges.typing', { on: false });
    assert.deepEqual(hs.sent[4].content, { typing: false });
    await assert.rejects(w('bridges.react', { reaction: { txnId: 'react-0002', target: '$e5', emoji: 'a b' } }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(call('bridges.read', { ...base, messageId: '$e5' }), (e) => e.code === 'ERR_NOT_PERSON');
    // the person's chats: ids and kinds, no names
    assert.deepEqual(await asPerson(annaId, false, () => call('bridges.chats', { userId: annaId, network: 'whatsapp' })), [{ id: chat, kind: 'direct', open: true, channel: false, readOnly: false }]);
    assert.deepEqual(await asPerson(benId, false, () => call('bridges.chats', { userId: benId, network: 'whatsapp' })), []);
    await assert.rejects(call('bridges.chats', { userId: annaId, network: 'whatsapp' }), (e) => e.code === 'ERR_NOT_PERSON');
  });

  it('says why when the homeserver is away or refuses, in a word', async () => {
    const chat = await annaAndKim('!h3:gc.internal');
    const args = { userId: annaId, network: 'whatsapp', chatId: chat, message: { txnId: 'client-0100', text: 'x' } };
    hs.down = true;
    await assert.rejects(asPerson(annaId, true, () => call('bridges.send', args)), (e) => e.code === 'ERR_BRIDGE_UNREACHABLE');
    hs.down = false;
    hs.rooms.get('!h3:gc.internal').members.clear();
    await assert.rejects(asPerson(annaId, true, () => call('bridges.send', args)), (e) => e.code === 'ERR_BRIDGE' && e.reason === 'm_forbidden' && !/gc\.internal/.test(e.message));
    // switched off: no way out
    bridges.configure({ networks: { whatsapp: false } }, {});
    await assert.rejects(asPerson(annaId, true, () => call('bridges.send', args)), (e) => e.code === 'ERR_BRIDGES_UNAVAILABLE' && e.reason === 'off');
    bridges.configure({ networks: { whatsapp: true } }, {});
    await bridges.start();
  });

  it('forgets a person’s rooms and waiting events with their account', async () => {
    const add = db.prepare('INSERT INTO users (username, password_hash, role, enabled, language, display_name) VALUES (?, ?, ?, 1, ?, ?)');
    const id = Number(add.run('gone-brmsg', 'x', 'user', 'de', 'Gone').lastInsertRowid);
    const room = '!h4:gc.internal';
    hs.room(room, { state: [bridgeState(), nameState('K')], members: [`@gc_${id}:${S}`] });
    await hs.push('t-gone', { events: [member(room, `@gc_${id}:${S}`, `@gc_${id}:${S}`, 'join'), msg(room, KIM, 'x')] });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_inbox WHERE user_id = ?').get(id).n, 2);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_rooms WHERE user_id = ?').get(id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_inbox WHERE user_id = ?').get(id).n, 0);
  });
});
