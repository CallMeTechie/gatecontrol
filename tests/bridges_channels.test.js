'use strict';

// Messenger bridges, gc.bridges version 7 (docs/feature-messenger-bridges.md, "Channels, groups, format"): what
// mautrix-whatsapp v0.2610.0 really sends for a group and a channel — no com.beeper.room_type.v2 (RoomTypeDefault), the
// chat's id at the bridge in m.bridge → channel.id, the channel's posts from the bridge's own account, power levels that
// keep the person from writing — turned into chat.kind / chat.channel / chat.readOnly, sender.channel, marks and preview.
// The stand-in homeserver (tests/helpers/fake-homeserver.js) delivers the events; no bridge, no WhatsApp.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { startFakeHomeserver } = require('./helpers/fake-homeserver');

let bridges, hsMod, appservice, hostApi, settings, db, annaId, hs;
const PLUGIN = { id: 'bridge-demo', manifest: { permissions: { bridges: true } } };
const call = (api, args) => hostApi.handle(PLUGIN, api, args);
const S = 'gc.internal';
const DAY = 86400000;
const anna = () => `@gc_${annaId}:${S}`;
const BOT = `@whatsappbot:${S}`;
const KIM = `@whatsapp_lid-kim:${S}`;
const CHANNEL_ID = 'kanal-test-1@newsletter';
const GROUP_ID = 'gruppe-test-1@g.us';
let n = 0;
const ev = (room, sender, type, content, extra = {}) => ({ room_id: room, sender, type, content, event_id: `$ch${++n}`, origin_server_ts: Date.now(), ...extra });
const msg = (room, sender, body, extra = {}, ts) => ev(room, sender, 'm.room.message', { msgtype: 'm.text', body, ...extra }, ts ? { origin_server_ts: ts } : {});
const member = (room, who, membership) => ev(room, BOT, 'm.room.member', { membership }, { state_key: who });
// as bridgev2 writes it for a group and a channel: no room type, the chat's id in channel.id
const bridgeState = (id) => ({ type: 'm.bridge', state_key: 'x', content: { bridgebot: BOT, protocol: { id: 'whatsapp', displayname: 'WhatsApp' }, channel: { id, displayname: 'x' } } });
const powerState = (own, send) => ({ type: 'm.room.power_levels', state_key: '', content: { users: { [anna()]: own, [BOT]: 100 }, users_default: 0, events_default: send, events: { 'm.reaction': 0 } } });
const nameState = (name) => ({ type: 'm.room.name', state_key: '', content: { name } });
const pulled = () => call('bridges.events.pull', {}).then((r) => r.events);
const ack = () => call('bridges.events.ack', { upTo: 1e9 });

before(async () => {
  await setup();
  process.env.GC_BRIDGES_PREVIEW = '1';
  bridges = require('../src/services/bridges');
  hsMod = require('../src/services/bridges/hs');
  appservice = require('../src/services/bridges/appservice');
  hostApi = require('../src/services/plugins/hostApi');
  settings = require('../src/services/settings');
  db = require('../src/db/connection').getDb();
  const add = db.prepare('INSERT INTO users (username, password_hash, role, enabled, language, display_name) VALUES (?, ?, ?, 1, ?, ?)');
  annaId = Number(add.run('anna-brch', 'x', 'user', 'de', 'Anna').lastInsertRowid);
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
  for (const k of ['bridges.history', 'bridges.history_people', 'bridges.linked_at']) settings.set(k, k === 'bridges.history' ? '1' : '{}');
  bridges._reset();
  bridges._runtime.wake = () => {};
  hs.rooms.clear();
  hs.requests.length = 0;
  hs.down = false;
});

/** A room the bridge made for Anna, Anna in it. → the 'chat' event */
async function open(room, state, timeline = []) {
  hs.room(room, { state, timeline, members: [anna()] });
  const r = await hs.push(`open-${room}`, { events: [ev(room, anna(), 'm.room.member', { membership: 'join' }, { state_key: anna() })] });
  assert.equal(r.status, 200);
  const evs = await pulled();
  await ack();
  return { chat: evs.find((e) => e.type === 'chat'), evs };
}

describe('the kind of a chat', () => {
  it('a WhatsApp group (no room type, …@g.us) is a group; only admins write → readOnly; the bot stays a notice', async () => {
    const room = '!grp:gc.internal';
    const { chat } = await open(room, [bridgeState(GROUP_ID), nameState('Verein'), powerState(0, 50)]);
    assert.deepEqual({ ...chat.chat, id: 'x' }, { id: 'x', kind: 'group', name: 'Verein', avatar: null, channel: false, readOnly: true });
    const row = db.prepare('SELECT kind, channel, read_only FROM bridge_rooms WHERE room_id = ?').get(room);
    assert.deepEqual({ ...row }, { kind: 'group', channel: 0, read_only: 1 });
    // the admins open the group to everybody: the plugin learns it
    await hs.push('t-pl', { events: [ev(room, BOT, 'm.room.power_levels', powerState(0, 0).content, { state_key: '' })] });
    await hs.push('t-bot', { events: [msg(room, BOT, 'Die Gruppe wurde geändert')] });
    const evs = await pulled();
    assert.deepEqual(evs.map((e) => e.type), ['chat', 'message']);
    assert.equal(evs[0].chat.readOnly, false);
    assert.deepEqual([evs[1].kind, evs[1].sender], ['notice', { system: true }]);
    assert.doesNotMatch(JSON.stringify(evs), /g\.us|gruppe-test/, 'the id at the bridge stays here');
  });

  it('a direct chat stays direct (room type "dm"), also by its id when the type is missing', async () => {
    const st = (id) => ({ type: 'm.bridge', state_key: 'x', content: { bridgebot: BOT, protocol: { id: 'whatsapp' }, channel: { id } } });
    const { chat } = await open('!dm:gc.internal', [st('lid-kim@lid')]);
    assert.equal(chat.chat.kind, 'direct');
    assert.equal(chat.chat.channel, false);
  });
});

describe('a channel', () => {
  it('is known as a channel, read only — its posts are texts of the channel with format and link preview', async () => {
    const room = '!chn:gc.internal';
    hs.file('pv1', { data: Buffer.from('jpeg'), mime: 'image/jpeg' });
    const { chat } = await open(room, [bridgeState(CHANNEL_ID), nameState('Sicherheit kompakt'), powerState(0, 50)]);
    assert.deepEqual({ ...chat.chat, id: 'x' }, { id: 'x', kind: 'group', name: 'Sicherheit kompakt', avatar: null, channel: true, readOnly: true });
    const post = msg(room, BOT, '*Jetzt patchen:* Update für X200 https://sicher.example/x200', {
      format: 'org.matrix.custom.html',
      formatted_body: '<strong>Jetzt patchen:</strong> Update für <em>X200</em><br>https://sicher.example/x200',
      'com.beeper.linkpreviews': [{ matched_url: 'https://sicher.example/x200', 'og:title': 'Kritische Lücke', 'og:description': 'Angreifer können …', 'og:image': `mxc://${S}/pv1`, 'og:image:type': 'image/jpeg', 'og:image:width': 640, 'og:image:height': 360, 'matrix:image:size': 4 }],
    });
    const pic = ev(room, BOT, 'm.room.message', { msgtype: 'm.image', body: 'bild.jpg', url: `mxc://${S}/pv1`, info: { mimetype: 'image/jpeg', w: 10, h: 10, size: 4 } });
    const edit = msg(room, BOT, '* neu', { 'm.new_content': { msgtype: 'm.text', body: '*neu*', format: 'org.matrix.custom.html', formatted_body: '<b>neu</b>' }, 'm.relates_to': { rel_type: 'm.replace', event_id: post.event_id } });
    const poll = ev(room, BOT, 'org.matrix.msc3381.poll.start', { body: 'Umfrage' });
    const del = ev(room, BOT, 'm.room.redaction', {}, { redacts: pic.event_id });
    await hs.push('t-posts', { events: [post, pic, edit, poll, del] });
    const evs = await pulled();
    assert.deepEqual(evs.map((e) => e.type), ['message', 'message', 'edit', 'message', 'redact']);
    const [p, m, e, u, r] = evs;
    assert.deepEqual(p.sender, { channel: true, system: true });
    assert.equal(p.kind, 'text');
    assert.equal(p.text, 'Jetzt patchen: Update für X200\nhttps://sicher.example/x200');
    assert.deepEqual(p.marks, [{ type: 'bold', start: 0, end: 14 }, { type: 'italic', start: 26, end: 30 }]);
    assert.deepEqual({ ...p.preview, image: { ...p.preview.image, ref: 'r' } }, { url: 'https://sicher.example/x200', title: 'Kritische Lücke', description: 'Angreifer können …', site: 'sicher.example', image: { ref: 'r', mime: 'image/jpeg', w: 640, h: 360, size: 4 } });
    assert.match(p.preview.image.ref, /^m[A-Za-z0-9_-]{40,}$/);
    assert.equal(p.preview.image.ref, m.media.ref, 'the same file, the same reference');
    assert.deepEqual([m.kind, m.media.kind, m.sender.channel], ['media', 'image', true]);
    assert.deepEqual([e.target, e.text, e.marks], [post.event_id, 'neu', [{ type: 'bold', start: 0, end: 3 }]]);
    assert.deepEqual([u.kind, u.sender.channel], ['unsupported', true]);
    assert.equal(r.target, pic.event_id);
    // the preview's picture is a file of the homeserver like any other: the clean-up knows it
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_media WHERE user_id = ?').get(annaId).n, 1);
    assert.doesNotMatch(JSON.stringify(evs), /newsletter|kanal-test|gc\.internal|whatsappbot/, 'no id at the bridge, no Matrix address');
  });

  it('HTML it does not know: the plain text, no marks — a mention is no link', async () => {
    const room = '!chn2:gc.internal';
    await open(room, [bridgeState(CHANNEL_ID), powerState(0, 50)]);
    await hs.push('t-odd', { events: [
      msg(room, BOT, 'Bild: x', { format: 'org.matrix.custom.html', formatted_body: '<img src="mxc://x/y"> Bild' }),
      msg(room, BOT, 'Kim hallo', { format: 'org.matrix.custom.html', formatted_body: `<a href="https://matrix.to/#/${KIM}">Kim</a> hallo <a href="javascript:x">y</a>` }),
    ] });
    const [a, b] = await pulled();
    assert.deepEqual([a.text, a.marks], ['Bild: x', undefined]);
    assert.deepEqual([b.text, b.marks], ['Kim hallo y', undefined]);
  });

  it('brings only its newest posts when it is opened, and at most 10 of its history at a new link', async () => {
    const room = '!chn3:gc.internal';
    const old = Array.from({ length: 15 }, (_, k) => msg(room, BOT, `Beitrag ${k}`));
    await open(room, [bridgeState(CHANNEL_ID), powerState(0, 50)], old);
    const q = hs.requests.find((x) => x.path.endsWith('/messages'));
    assert.match(q.query, /limit=10\b/);
    // the history the bridge brings at a new link: 14 posts, two days old
    settings.set('bridges.linked_at', JSON.stringify({ [`${annaId}:whatsapp`]: Date.now() - DAY }));
    const hist = Array.from({ length: 14 }, (_, k) => msg(room, BOT, `Alt ${k}`, {}, Date.now() - 2 * DAY + k * 1000));
    hist.push(ev(room, BOT, 'm.reaction', { 'm.relates_to': { rel_type: 'm.annotation', event_id: hist[0].event_id, key: '👍' } }, { origin_server_ts: Date.now() - 2 * DAY + 20000 }));
    await hs.push('t-hist', { events: hist });
    const back = (await call('bridges.history.pull', { limit: 100 })).events;
    assert.deepEqual(back.map((e) => e.text), hist.slice(4, 14).map((e) => e.content.body), 'the newest 10, without the reaction on a post that went');
  });

  it('a room from before version 7 gets its kind by refreshRooms — the plugin hears of it once', async () => {
    const room = '!before:gc.internal';
    await open(room, [bridgeState(CHANNEL_ID), nameState('Alt'), powerState(0, 50)]);
    db.prepare("UPDATE bridge_rooms SET kind = 'direct', channel = NULL, read_only = 0 WHERE room_id = ?").run(room);
    bridges._runtime.events._forget();
    const r = await bridges._runtime.events.refreshRooms();
    assert.deepEqual([r.looked, r.changed], [1, 1]);
    const evs = await pulled();
    assert.equal(evs.length, 1);
    assert.deepEqual([evs[0].type, evs[0].chat.kind, evs[0].chat.channel, evs[0].chat.readOnly], ['chat', 'group', true, true]);
    assert.deepEqual((await bridges._runtime.events.refreshRooms()).looked, 0, 'looked at once');
  });
});
