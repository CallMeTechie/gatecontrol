'use strict';

// Messenger bridges, stage 4 (docs/feature-messenger-bridges.md, "Files", "A new chat by number"): files and
// pictures in both directions, and the bridge's lookup of a phone number. A stand-in homeserver
// (tests/helpers/fake-homeserver.js, now with authenticated media download and upload) and a stand-in bridge
// (tests/helpers/fake-bridge.js, resolve_identifier / create_dm); no WhatsApp.
//
//   in          a file reaches the plugin as a sealed reference (never an mxc:// address); media.fetch streams it
//               into the plugin's media with GateControl's virus scan — for that person only, within the plugin's
//               limits; pictures of chats and contacts the same way
//   out         a file of the plugin goes to the homeserver and into the room as m.image / m.video / m.audio
//               (voice: org.matrix.msc3245.voice) / m.file — only one the scan let through, uploaded once
//   new chat    resolve / createDm: a word, a name and a chat reference back; the number nowhere else, a limit per hour

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { setup, teardown } = require('./helpers/setup');
const { startFakeHomeserver } = require('./helpers/fake-homeserver');
const { startFakeBridge } = require('./helpers/fake-bridge');

let bridges, hsMod, appservice, hostApi, ctx, db, media, annaId, benId, hs, bridge;
const MEDIA = { maxBytes: 64 * 1024, quotaDefault: 10 * 1024 * 1024, types: ['image/jpeg', 'image/png', 'image/webp', 'audio/ogg', 'video/mp4', 'application/pdf', 'application/octet-stream'] };
// the messenger's own id: its files are checked by the virus scan by default (scan source "messenger")
const PLUGIN = { id: 'gatecontrol-messenger', manifest: { permissions: { bridges: true }, media: MEDIA } };
const NOMEDIA = { id: 'bridge-nomedia', manifest: { permissions: { bridges: true } } };
const asPerson = (userId, write, fn) => ctx.run(PLUGIN.id, userId, write, fn);
const call = (api, args, plugin = PLUGIN) => hostApi.handle(plugin, api, args);
const S = 'gc.internal';
const anna = () => `@gc_${annaId}:${S}`;
const KIM = `@whatsapp_4915198765432:${S}`;
const BOT = `@whatsappbot:${S}`;
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]);
let n = 0;
const ev = (room, sender, type, content, extra = {}) => ({ room_id: room, sender, type, content, event_id: `$f${++n}`, origin_server_ts: 1763150000000 + n * 1000, ...extra });
const msg = (room, sender, body, extra = {}) => ev(room, sender, 'm.room.message', { msgtype: 'm.text', body, ...extra });
const member = (room, sender, who, membership, extra = {}) => ev(room, sender, 'm.room.member', { membership, ...extra }, { state_key: who });
const bridgeState = (type = 'dm') => ({ type: 'm.bridge', state_key: 'x', content: { bridgebot: BOT, protocol: { id: 'whatsapp', displayname: 'WhatsApp' }, 'com.beeper.room_type.v2': type } });
const pulled = async () => { const r = await call('bridges.events.pull', {}); await call('bridges.events.ack', { upTo: 1e9 }); return r.events; };

before(async () => {
  await setup();
  process.env.GC_BRIDGES_PREVIEW = '1';
  bridges = require('../src/services/bridges');
  hsMod = require('../src/services/bridges/hs');
  appservice = require('../src/services/bridges/appservice');
  hostApi = require('../src/services/plugins/hostApi');
  ctx = require('../src/services/plugins/personContext');
  media = require('../src/services/plugins/media');
  db = require('../src/db/connection').getDb();
  const add = db.prepare('INSERT INTO users (username, password_hash, role, enabled, language, display_name) VALUES (?, ?, ?, 1, ?, ?)');
  annaId = Number(add.run('anna-brmedia', 'x', 'user', 'de', 'Anna').lastInsertRowid);
  benId = Number(add.run('ben-brmedia', 'x', 'user', 'de', 'Ben').lastInsertRowid);
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
  db.exec('DELETE FROM bridge_inbox; DELETE FROM bridge_rooms; DELETE FROM bridge_txns; DELETE FROM plugin_media;');
  bridges._reset();
  bridges._runtime.wake = () => {};
  hs.rooms.clear();
  hs.files.clear();
  hs.requests.length = 0;
  hs.sent.length = 0;
  hs.down = false;
  hs.noLength = false;
  bridge.numbers.clear();
  bridge.requests.length = 0;
  bridge.logins.set(anna(), [{ id: 'login-a', name: '+491700000001', state_event: 'CONNECTED', timestamp: Date.now() }]);
});

/** A room the bridge made for Anna with Kim, Anna in it. → the chat's reference */
async function annaAndKim(room, state = []) {
  hs.room(room, { state: [bridgeState(), { type: 'm.room.name', state_key: '', content: { name: 'Kim Muster' } }, ...state], members: [anna()] });
  assert.equal((await hs.push(`open-${room}`, { events: [member(room, anna(), anna(), 'join')] })).status, 200);
  const chat = (await pulled()).find((e) => e.type === 'chat');
  return chat.chat;
}

describe('files in: a reference, then the plugin fetches', () => {
  it('a picture, a voice message, a file, a sticker: kind, type, size, sides, length — and a reference instead of the address', async () => {
    const room = '!fm1:gc.internal';
    await annaAndKim(room);
    hs.file('pic1', { data: JPEG, mime: 'image/jpeg' });
    await hs.push('t-f1', { events: [
      msg(room, KIM, 'Grill', { msgtype: 'm.image', filename: 'image.jpg', url: 'mxc://gc.internal/pic1', info: { mimetype: 'image/jpeg', size: JPEG.length, w: 1280, h: 960 } }),
      msg(room, KIM, 'Voice message.ogg', { msgtype: 'm.audio', url: 'mxc://gc.internal/v1', 'org.matrix.msc3245.voice': {}, 'org.matrix.msc1767.audio': { duration: 4200, waveform: Array.from({ length: 100 }, (_, i) => i * 10) }, info: { mimetype: 'audio/ogg; codecs=opus', size: 900, duration: 4200 } }),
      msg(room, KIM, 'Vertrag.pdf', { msgtype: 'm.file', url: 'mxc://gc.internal/d1', info: { mimetype: 'application/pdf', size: 2000 } }),
      ev(room, KIM, 'm.sticker', { body: 'sticker.webp', url: 'mxc://gc.internal/s1', info: { mimetype: 'image/webp', w: 190, h: 190 } }),
      msg(room, KIM, 'Location: Marktplatz', { msgtype: 'm.location', geo_uri: 'geo:51.123456,7.654321;u=35' }),
      // encrypted (`file` instead of `url`): nothing to fetch, stays a placeholder
      msg(room, KIM, 'x.jpg', { msgtype: 'm.image', file: { url: 'mxc://gc.internal/enc', key: {} } }),
      // a file of another server (there is no federation): no reference
      msg(room, KIM, 'y.jpg', { msgtype: 'm.image', url: 'mxc://evil.example/zzz' }),
    ] });
    const evs = await pulled();
    const [pic, voice, doc, sticker, loc, enc, other] = evs.map((e) => e.media);
    assert.equal(pic.kind, 'image');
    assert.match(pic.ref, /^m[A-Za-z0-9_-]{40,}$/);
    assert.deepEqual({ ...pic, ref: 'x' }, { kind: 'image', name: 'image.jpg', ref: 'x', mime: 'image/jpeg', size: JPEG.length, w: 1280, h: 960, durationMs: null });
    assert.equal(evs[0].text, 'Grill', 'the caption');
    assert.deepEqual([voice.kind, voice.mime, voice.durationMs, voice.waveform.length, Math.max(...voice.waveform)], ['voice', 'audio/ogg', 4200, 64, 980]);
    assert.deepEqual([doc.kind, doc.mime, doc.size], ['file', 'application/pdf', 2000]);
    assert.deepEqual([sticker.kind, sticker.mime, sticker.w], ['sticker', 'image/webp', 190]);
    assert.deepEqual(loc, { kind: 'location', name: null, geo: { lat: 51.123456, lon: 7.654321 } });
    assert.equal(enc.ref, undefined);
    assert.equal(other.ref, undefined);
    assert.doesNotMatch(JSON.stringify(evs), /mxc:|pic1|gc\.internal|whatsapp_/, 'no file address, no Matrix address');
    // the same file again → the same reference (the plugin can tell "unchanged")
    await hs.push('t-f1b', { events: [msg(room, KIM, 'again', { msgtype: 'm.image', url: 'mxc://gc.internal/pic1' })] });
    assert.equal((await pulled())[0].media.ref, pic.ref);
  });

  it('media.fetch streams the file into the plugin’s media — with the virus scan, unclaimed, no owner', async () => {
    const room = '!fm2:gc.internal';
    await annaAndKim(room);
    hs.file('pic2', { data: JPEG, mime: 'image/jpeg' });
    await hs.push('t-f2', { events: [msg(room, KIM, 'image.jpg', { msgtype: 'm.image', url: 'mxc://gc.internal/pic2' })] });
    const [e] = await pulled();
    // no person needed: it reads what was delivered for Anna, into the plugin's own media
    const r = await call('bridges.media.fetch', { userId: annaId, network: 'whatsapp', ref: e.media.ref, name: 'image.jpg' });
    assert.deepEqual(Object.keys(r).sort(), ['bytes', 'mediaId', 'mime', 'name', 'scan']);
    assert.deepEqual([r.mime, r.bytes, r.name], ['image/jpeg', JPEG.length, 'image.jpg']);
    assert.equal(r.scan.state, 'clean', 'the messenger’s files are checked');
    const row = media.row(PLUGIN.id, r.mediaId);
    assert.deepEqual([row.owner_user_id, row.ref_count, row.sha256], [null, 0, require('node:crypto').createHash('sha256').update(JPEG).digest('hex')]);
    const dl = hs.requests.find((q) => q.path.startsWith('/_matrix/client/v1/media/download/'));
    assert.equal(dl.path, '/_matrix/client/v1/media/download/gc.internal/pic2');
    assert.equal(dl.userId, anna(), 'as Anna’s internal account');
  });

  it('only for the person it was delivered for, only within the plugin’s limits, never without media', async () => {
    const room = '!fm3:gc.internal';
    await annaAndKim(room);
    hs.file('big', { data: Buffer.alloc(MEDIA.maxBytes + 1, 1), mime: 'image/jpeg' });
    hs.file('html', { data: Buffer.from('GIF89a-not-really'), mime: 'image/gif' });
    hs.file('odd', { data: Buffer.from('BEGIN:VCARD\nEND:VCARD\n'), mime: 'text/x-odd' });
    hs.file('virus', { data: Buffer.from(EICAR), mime: 'application/octet-stream' });
    await hs.push('t-f3', { events: ['big', 'html', 'odd', 'virus'].map((id) => msg(room, KIM, `${id}.bin`, { msgtype: 'm.file', url: `mxc://gc.internal/${id}` })) });
    const [big, html, odd, virus] = (await pulled()).map((x) => x.media.ref);
    const fetch = (ref, userId = annaId, plugin = PLUGIN) => call('bridges.media.fetch', { userId, network: 'whatsapp', ref }, plugin);
    await assert.rejects(fetch(big, benId), (e) => e.code === 'ERR_INVALID', 'Anna’s file is not Ben’s');
    await assert.rejects(fetch('m' + 'A'.repeat(60)), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(fetch(big), (e) => e.code === 'ERR_MEDIA_TOO_LARGE');
    // refused before a byte was stored
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plugin_media').get().n, 0);
    await assert.rejects(fetch(html), (e) => e.code === 'ERR_MEDIA_TYPE', 'a picture of a type the plugin does not take: refused');
    const kept = await fetch(odd);
    assert.equal(kept.mime, 'application/octet-stream', 'any other type of file: kept as a download');
    const v = await fetch(virus);
    assert.deepEqual([v.scan.state, v.scan.blocked], ['infected', true]);
    await assert.rejects(fetch(big, annaId, NOMEDIA), (e) => e.code === 'ERR_MEDIA_DENIED');
    // an answer without Content-Length (chunked): taken as it comes, at most the plugin's limit
    hs.noLength = true;
    const chunked = await fetch(odd);
    assert.deepEqual([chunked.mime, chunked.bytes], ['application/octet-stream', Buffer.byteLength('BEGIN:VCARD\nEND:VCARD\n')]);
    const before = db.prepare('SELECT COUNT(*) AS n FROM plugin_media').get().n;
    await assert.rejects(fetch(big), (e) => e.code === 'ERR_MEDIA_TOO_LARGE', 'chunked and too large: stopped at the limit');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plugin_media').get().n, before, 'nothing kept of it');
    hs.noLength = false;
    hs.files.delete('odd');
    await assert.rejects(fetch(odd), (e) => e.code === 'ERR_BRIDGE' && e.reason === 'm_not_found');
    hs.down = true;
    await assert.rejects(fetch(odd), (e) => e.code === 'ERR_BRIDGE_UNREACHABLE');
    hs.down = false;
    bridges.configure({ networks: { whatsapp: false } }, {});
    await assert.rejects(fetch(odd), (e) => e.code === 'ERR_BRIDGES_UNAVAILABLE' && e.reason === 'off');
    bridges.configure({ networks: { whatsapp: true } }, {});
    await bridges.start();
  });

  it('pictures of a chat and of its contacts: references too, null when taken away', async () => {
    const room = '!fm4:gc.internal';
    const chat = await annaAndKim(room, [{ type: 'm.room.avatar', state_key: '', content: { url: 'mxc://gc.internal/av1' } },
      { type: 'm.room.member', state_key: KIM, content: { membership: 'join', displayname: 'Kim Muster', avatar_url: 'mxc://gc.internal/kim1' } }]);
    assert.match(chat.avatar, /^m[A-Za-z0-9_-]{40,}$/);
    await hs.push('t-f4', { events: [msg(room, KIM, 'hi')] });
    const [m1] = await pulled();
    assert.match(m1.sender.avatar, /^m/);
    assert.notEqual(m1.sender.avatar, chat.avatar);
    hs.file('av2', { data: JPEG, mime: 'image/jpeg' });
    await hs.push('t-f4b', { events: [
      ev(room, BOT, 'm.room.avatar', { url: 'mxc://gc.internal/av2' }, { state_key: '' }),
      member(room, KIM, KIM, 'join', { displayname: 'Kim Muster' }),
      ev(room, BOT, 'm.room.avatar', {}, { state_key: '' }),
    ] });
    const evs = await pulled();
    assert.deepEqual(evs.map((e) => e.type), ['chat', 'contact', 'chat']);
    assert.notEqual(evs[0].chat.avatar, chat.avatar);
    assert.equal(evs[1].contact.avatar, null, 'the contact took the picture away');
    assert.equal(evs[2].chat.avatar, null);
    const pic = await call('bridges.media.fetch', { userId: annaId, network: 'whatsapp', ref: evs[0].chat.avatar });
    assert.equal(pic.mime, 'image/jpeg');
  });
});

describe('files out: from the plugin’s media to the room', () => {
  async function stored(data, mime, name) {
    const out = await media.storeBuffer(PLUGIN, data, { mime, name });
    return out.mediaId;
  }

  it('a picture, a video, a voice message, a file — the message mautrix-whatsapp reads, the file uploaded once', async () => {
    const room = '!fo1:gc.internal';
    const chat = await annaAndKim(room);
    const pic = await stored(JPEG, 'image/jpeg', 'grill.jpg');
    const ogg = await stored(Buffer.from('OggS\0\x02voice-voice-voice'), 'audio/ogg', null);
    const mp4 = await stored(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(100)]), 'video/mp4', 'clip.mp4');
    const pdf = await stored(Buffer.from('%PDF-1.4\n%x\n'), 'application/pdf', 'Plan.pdf');
    const send = (txnId, message) => asPerson(annaId, true, () => call('bridges.send', { userId: annaId, network: 'whatsapp', chatId: chat.id, message: { txnId, ...message } }));

    const r1 = await send('client-f0001', { text: 'So sieht es aus', media: { mediaId: pic, kind: 'image', name: 'grill.jpg', w: 1280, h: 960 } });
    assert.match(r1.id, /^\$sent/);
    const up = hs.requests.find((q) => q.path === '/_matrix/media/v3/upload');
    assert.equal(up.userId, anna());
    assert.match(up.query, /filename=grill\.jpg/);
    const [uri] = [...hs.files.keys()];
    assert.deepEqual(hs.files.get(uri).data, JPEG, 'the bytes as stored, decrypted on the way');
    assert.equal(hs.files.get(uri).mime, 'image/jpeg');
    assert.deepEqual(hs.sent[0].content, { msgtype: 'm.image', body: 'So sieht es aus', filename: 'grill.jpg', url: `mxc://gc.internal/${uri}`, info: { mimetype: 'image/jpeg', size: JPEG.length, w: 1280, h: 960 } });

    await send('client-f0002', { media: { mediaId: ogg, kind: 'voice', durationMs: 4200, waveform: [0, 40, 255, 999, -3] } });
    assert.deepEqual(hs.sent[1].content['org.matrix.msc3245.voice'], {});
    assert.deepEqual(hs.sent[1].content['org.matrix.msc1767.audio'], { duration: 4200, waveform: [0, 40, 255, 255, 0] });
    assert.deepEqual([hs.sent[1].content.msgtype, hs.sent[1].content.body, hs.sent[1].content.info], ['m.audio', 'voice', { mimetype: 'audio/ogg', size: 23, duration: 4200 }]);
    await send('client-f0003', { media: { mediaId: mp4, kind: 'video', name: 'clip.mp4', durationMs: 9000, w: 640, h: 360 }, replyTo: '$f1' });
    assert.deepEqual([hs.sent[2].content.msgtype, hs.sent[2].content.info.duration, hs.sent[2].content['m.relates_to']], ['m.video', 9000, { 'm.in_reply_to': { event_id: '$f1' } }]);
    await send('client-f0004', { media: { mediaId: pdf, kind: 'file', name: '../../Plan.pdf' } });
    assert.deepEqual([hs.sent[3].content.msgtype, hs.sent[3].content.body, hs.sent[3].content.filename], ['m.file', '.. .. Plan.pdf', '.. .. Plan.pdf']);
    assert.equal(hs.files.size, 4);
    // "Erneut senden" with a new txn: the same file is not uploaded again
    await send('client-f0005', { media: { mediaId: pic, kind: 'image' } });
    assert.equal(hs.files.size, 4);
    assert.equal(hs.sent[4].content.url, hs.sent[0].content.url);
  });

  it('only the plugin’s own, stored file that the virus scan let through; only as the person who acts', async () => {
    const room = '!fo2:gc.internal';
    const chat = await annaAndKim(room);
    const pic = await stored(JPEG, 'image/jpeg', 'a.jpg');
    const bad = await stored(Buffer.from(EICAR), 'application/octet-stream', 'b.bin');
    const args = (message) => ({ userId: annaId, network: 'whatsapp', chatId: chat.id, message: { txnId: 'client-f0100', ...message } });
    await assert.rejects(call('bridges.send', args({ media: { mediaId: pic, kind: 'image' } })), (e) => e.code === 'ERR_NOT_PERSON', 'not from a tick');
    const w = (a) => asPerson(annaId, true, () => call('bridges.send', a));
    await assert.rejects(w(args({ media: { mediaId: bad, kind: 'file' } })), (e) => e.code === 'ERR_MEDIA_QUARANTINED');
    await assert.rejects(w(args({ media: { mediaId: 'f'.repeat(32), kind: 'file' } })), (e) => e.code === 'ERR_NOT_FOUND');
    await assert.rejects(w(args({ media: { mediaId: '../x', kind: 'file' } })), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(w(args({ media: { mediaId: pic, kind: 'poll' } })), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(w(args({ media: { mediaId: pic, kind: 'image' }, edit: '$f1' })), (e) => e.code === 'ERR_INVALID', 'a file is never an edit');
    await assert.rejects(asPerson(annaId, true, () => call('bridges.send', args({ media: { mediaId: pic, kind: 'image' } }), NOMEDIA)), (e) => e.code === 'ERR_MEDIA_DENIED');
    assert.equal(hs.files.size, 0, 'nothing was uploaded');
    assert.equal(hs.sent.length, 0);
  });
});

describe('a new chat by number', () => {
  it('resolve: found with a name, or not — never the number, an id or an address in the answer', async () => {
    bridge.numbers.set('+4915112345678', { name: 'Kim Muster', room: '!new1:gc.internal' });
    const r = (number) => asPerson(annaId, true, () => call('bridges.resolve', { userId: annaId, network: 'whatsapp', number }));
    assert.deepEqual(await r('+49 151 1234-5678'), { found: true, name: 'Kim Muster' });
    assert.deepEqual(await r('0049 151 12345678'), { found: true, name: 'Kim Muster' });
    assert.deepEqual(await r('+4915199999999'), { found: false });
    const q = bridge.requests.filter((x) => x.path.includes('resolve_identifier'));
    assert.equal(decodeURIComponent(q[0].path), '/_matrix/provision/v3/resolve_identifier/+4915112345678');
    assert.equal(q[0].userId, anna());
    for (const bad of ['015112345678', '+0151', 'abc', '', '+49 151 1234 5678 9999 99', null]) {
      await assert.rejects(r(bad), (e) => e.code === 'ERR_INVALID' && e.reason === 'invalid_number');
    }
    await assert.rejects(call('bridges.resolve', { userId: annaId, network: 'whatsapp', number: '+4915112345678' }), (e) => e.code === 'ERR_NOT_PERSON');
    await assert.rejects(asPerson(annaId, false, () => call('bridges.resolve', { userId: annaId, network: 'whatsapp', number: '+4915112345678' })), (e) => e.code === 'ERR_NOT_PERSON');
    // without a link the bridge refuses — as a word, without its text
    await assert.rejects(asPerson(benId, true, () => call('bridges.resolve', { userId: benId, network: 'whatsapp', number: '+4915112345678' })),
      (e) => e.code === 'ERR_BRIDGE' && !/4915/.test(e.message));
  });

  it('createDm: the chat is known at once, its join fills in the rest; the reference stays the same', async () => {
    const room = '!new2:gc.internal';
    bridge.numbers.set('+4915112345678', { name: 'Kim Muster', room });
    const r = await asPerson(annaId, true, () => call('bridges.createDm', { userId: annaId, network: 'whatsapp', number: '+4915112345678' }));
    assert.match(r.chat.id, /^r[A-Za-z0-9_-]{20}$/);
    assert.deepEqual({ ...r.chat, id: 'x' }, { id: 'x', kind: 'direct', name: 'Kim Muster' });
    assert.doesNotMatch(JSON.stringify(r), /4915|whatsapp_|gc\.internal/);
    const [row] = db.prepare('SELECT * FROM bridge_rooms').all();
    assert.deepEqual([row.ref, row.user_id, row.state], [r.chat.id, annaId, 'invited']);
    // the person can write before the join arrived
    const s = await asPerson(annaId, true, () => call('bridges.send', { userId: annaId, network: 'whatsapp', chatId: r.chat.id, message: { txnId: 'client-n0001', text: 'Hallo Kim!' } })).catch((e) => e);
    assert.equal(s.code, 'ERR_BRIDGE', 'the stand-in homeserver does not know the room yet');
    hs.room(room, { state: [bridgeState(), { type: 'm.room.name', state_key: '', content: { name: 'Kim Muster' } }], members: [anna()] });
    await hs.push('t-n2', { events: [member(room, anna(), anna(), 'join')] });
    const evs = await pulled();
    assert.deepEqual(evs.map((e) => [e.type, e.chat.id, e.chat.name]), [['chat', r.chat.id, 'Kim Muster']]);
    assert.equal(db.prepare('SELECT state FROM bridge_rooms WHERE room_id = ?').get(room).state, 'joined');
    // asked again: the same chat
    const again = await asPerson(annaId, true, () => call('bridges.createDm', { userId: annaId, network: 'whatsapp', number: '+4915112345678' }));
    assert.equal(again.chat.id, r.chat.id);
    await assert.rejects(asPerson(annaId, true, () => call('bridges.createDm', { userId: annaId, network: 'whatsapp', number: '+4915199999999' })), (e) => e.code === 'ERR_BRIDGE' && e.reason === 'not_found');
  });

  it('at most 20 numbers per person and hour — with the time to wait', async () => {
    bridge.numbers.set('+4915112345678', { name: 'Kim', room: '!new3:gc.internal' });
    const r = () => asPerson(annaId, true, () => call('bridges.resolve', { userId: annaId, network: 'whatsapp', number: '+4915112345678' }));
    for (let i = 0; i < 20; i++) await r();
    await assert.rejects(r(), (e) => e.code === 'ERR_RATE_LIMIT' && e.retryAfterS > 3000);
    // a number that is not even one does not count
    bridges._reset();
    await assert.rejects(asPerson(annaId, true, () => call('bridges.resolve', { userId: annaId, network: 'whatsapp', number: 'x' })), (e) => e.code === 'ERR_INVALID');
    assert.deepEqual(await r(), { found: true, name: 'Kim' });
  });
});
