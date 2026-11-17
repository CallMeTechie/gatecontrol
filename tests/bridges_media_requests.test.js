'use strict';

// Messenger bridges, gc.bridges version 13 (docs/feature-messenger-bridges.md, "Old media from the phone"): the
// administrator's choice whether mautrix-whatsapp v0.2610.0 asks the person's phone for a file of the history whose copy
// at WhatsApp ran out (history_sync.media_requests), and the bridge's English notice about such a file turned into a
// placeholder (message.oldMedia) — later replaced by the file the phone sent (an edit with `media`). The stand-in
// homeserver delivers the events; nothing here starts a container.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, teardown } = require('./helpers/setup');
const { startFakeHomeserver } = require('./helpers/fake-homeserver');

const config = require('../src/services/bridges/config');
const KEYS = new Set(require('./fixtures/bridges/keys-mautrix-whatsapp-0.2610.0.json').keys);
const SECRETS = { asToken: 'a'.repeat(43), hsToken: 'b'.repeat(43), provisionSecret: 'c'.repeat(43), coreAsToken: 'd'.repeat(43), coreHsToken: 'e'.repeat(43), puppetAsToken: 'f'.repeat(43), puppetHsToken: 'g'.repeat(43), signalAsToken: 'h'.repeat(43), signalHsToken: 'i'.repeat(43), telegramAsToken: 'j'.repeat(43), telegramHsToken: 'k'.repeat(43) };
const APP = { apiId: 12345, apiHash: '0123456789abcdef0123456789abcdef' };
const keysOf = (o, pre = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length ? [pre + k, ...keysOf(v, pre + k + '.')] : [pre + k]));

let bridges, hsMod, appservice, hostApi, db, annaId, hs;
const PLUGIN = { id: 'bridge-demo', manifest: { permissions: { bridges: true } } };
const call = (api, args) => hostApi.handle(PLUGIN, api, args);
const S = 'gc.internal';
const anna = () => `@gc_${annaId}:${S}`;
const BOT = `@whatsappbot:${S}`;
const KIM = `@whatsapp_lid-100000000000001:${S}`;
let n = 0;
const ev = (room, sender, type, content, extra = {}) => ({ room_id: room, sender, type, content, event_id: `$om${++n}`, origin_server_ts: Date.now() - 1000 + n, ...extra });
const bridgeState = (id, type, net = 'whatsapp') => ({ type: 'm.bridge', state_key: 'x', content: { bridgebot: `@${net}bot:${S}`, protocol: { id: net, displayname: net }, channel: { id, displayname: 'x' }, ...(type ? { 'com.beeper.room_type.v2': type } : {}) } });
const memberState = (who, displayname) => ({ type: 'm.room.member', state_key: who, content: { membership: 'join', displayname } });
const pulled = () => call('bridges.events.pull', {}).then((r) => r.events);
const ack = () => call('bridges.events.ack', { upTo: 1e9 });

/**
 * The bridge's notice about an old file as mautrix-whatsapp v0.2610.0 writes it (pkg/msgconv/wa-media.go
 * makeMediaFailure: m.notice "Old <kind>. <suffix>", the file's description in fi.mau.whatsapp.failed_media).
 */
function oldNotice(kind, suffix, media, caption = null) {
  const content = { msgtype: 'm.notice', body: `Old ${kind}. ${suffix}${caption ? `\n\n${caption}` : ''}` };
  if (media) content['fi.mau.whatsapp.failed_media'] = { type: media.type || 'm.room.message', content: media.content, extra: {}, whatsapp_media: { key: 'AAAA', length: 5, type: 'WhatsApp Audio Keys', sha256: 'AAAA', enc_sha256: 'AAAA' }, type_description: kind };
  return content;
}
const OFF = 'Requesting old media is not enabled on this bridge.';
const SOON = 'Media will be requested from your phone automatically soon.';
const OVERNIGHT = 'Media will be requested from your phone automatically overnight.';

before(async () => {
  await setup();
  process.env.GC_BRIDGES_PREVIEW = '1';
  bridges = require('../src/services/bridges');
  hsMod = require('../src/services/bridges/hs');
  appservice = require('../src/services/bridges/appservice');
  hostApi = require('../src/services/plugins/hostApi');
  db = require('../src/db/connection').getDb();
  const add = db.prepare('INSERT INTO users (username, password_hash, role, enabled, language, display_name) VALUES (?, ?, ?, 1, ?, ?)');
  annaId = Number(add.run('anna-brom', 'x', 'user', 'de', 'Anna').lastInsertRowid);
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

/** A room the bridge made for Anna, Anna in it. */
async function open(room, state) {
  hs.room(room, { state, timeline: [], members: [anna()] });
  const r = await hs.push(`open-${room}`, { events: [ev(room, anna(), 'm.room.member', { membership: 'join' }, { state_key: anna() })] });
  assert.equal(r.status, 200);
  await pulled();
  await ack();
}

describe('the configuration of the WhatsApp bridge', () => {
  it('off (the default): exactly what was written before version 13 — an update recreates no container', () => {
    for (const opts of [{}, { mediaRequests: 'off' }, { mediaRequests: 'nonsense' }, { history: true }]) {
      const m = config.bridgeModel('whatsapp', SECRETS, opts);
      assert.deepEqual(m.network.history_sync.media_requests, { auto_request_media: false });
    }
    assert.equal(config.rev(SECRETS, ['whatsapp'], { history: true, mediaRequests: 'off' }), config.rev(SECRETS, ['whatsapp'], { history: true }));
  });

  it('daily: local_time (the bridge\'s loop, 8 hours after it connected); now: immediate — only keys of the pinned version', () => {
    const daily = config.bridgeModel('whatsapp', SECRETS, { history: true, mediaRequests: 'daily' });
    assert.deepEqual(daily.network.history_sync, { max_initial_conversations: 30, request_full_sync: false, media_requests: { auto_request_media: true, request_method: 'local_time' } });
    const now = config.bridgeModel('whatsapp', SECRETS, { history: true, mediaRequests: 'now' });
    assert.deepEqual(now.network.history_sync.media_requests, { auto_request_media: true, request_method: 'immediate' });
    assert.equal(config.HISTORY.conversations, 30, 'the number of chats at a link stays');
    for (const m of [daily, now]) {
      for (const k of keysOf(m)) if (!k.startsWith('bridge.permissions.') && !k.startsWith('double_puppet.secrets.')) assert.ok(KEYS.has(k), k);
    }
    assert.ok(!('request_local_time' in daily.network.history_sync.media_requests), 'v0.2610.0 has no time zone for a login: the key would change nothing');
    const revs = new Set(['off', 'daily', 'now'].map((mediaRequests) => config.rev(SECRETS, ['whatsapp'], { history: true, mediaRequests })));
    assert.equal(revs.size, 3, 'every change recreates the bridge');
  });

  it('Signal and Telegram: nothing changes (neither bridge asks a phone for a file)', () => {
    for (const net of ['signal', 'telegram']) {
      const opts = { history: true, telegramApp: APP };
      assert.deepEqual(config.bridgeModel(net, SECRETS, { ...opts, mediaRequests: 'now' }), config.bridgeModel(net, SECRETS, opts), net);
    }
  });
});

describe('the administrator\'s switch', () => {
  it('off by default; daily and now are kept, written into the bridge\'s file and named in status()', () => {
    const st = bridges.status();
    assert.equal(st.version, 14);
    assert.deepEqual(st.mediaRequests, { mode: 'off', options: ['off', 'daily', 'now'], dailyAt: '11:10', timeZone: st.history.timeZone });
    const file = path.join(bridges.dir(), 'whatsapp/config/config.yaml');
    bridges.configure({ mediaRequests: 'daily' }, { actor: { id: 1, name: 'admin' } });
    assert.equal(bridges.status().mediaRequests.mode, 'daily');
    require('../src/services/autoUpdate').syncConfigFile();
    assert.match(fs.readFileSync(file, 'utf8'), /auto_request_media: true\n\s+request_method: "local_time"/);
    bridges.configure({ mediaRequests: 'now' }, {});
    assert.equal(bridges.status().mediaRequests.mode, 'now');
    // the nightly snapshot moves the time of 'daily' with it
    bridges.configure({ backupTime: '19:00' }, {});
    assert.equal(bridges.status().mediaRequests.dailyAt, '03:00');
    bridges.configure({ backupTime: '03:10', mediaRequests: 'off' }, {});
    assert.equal(bridges.status().mediaRequests.mode, 'off');
  });

  it('refuses anything else', () => {
    for (const bad of ['night', true, null, 1, 'OFF']) assert.throws(() => bridges.configure({ mediaRequests: bad }, {}), (e) => e.code === 'ERR_INVALID', String(bad));
    assert.equal(bridges.status().mediaRequests.mode, 'off');
  });
});

describe('the bridge\'s notice about an old file', () => {
  const room = '!dmkim:gc.internal';
  const voice = { content: { msgtype: 'm.audio', body: 'Voice message.ogg', filename: 'Voice message.ogg', info: { mimetype: 'audio/ogg' }, 'org.matrix.msc3245.voice': {} } };

  it('becomes a placeholder of its kind with what the bridge was told — never the English line', async () => {
    await open(room, [bridgeState('100000000000001@lid', 'dm'), memberState(KIM, 'Kim')]);
    const photo = { content: { msgtype: 'm.image', body: 'Am See', filename: 'image.jpg', info: { mimetype: 'image/jpeg' } } };
    const doc = { content: { msgtype: 'm.file', body: 'Rechnung.pdf', filename: 'Rechnung.pdf', info: { mimetype: 'application/pdf' } } };
    const sticker = { type: 'm.sticker', content: { msgtype: '', body: '', info: { mimetype: 'image/webp' } } };
    const video = { content: { msgtype: 'm.video', body: 'video.mp4', filename: 'video.mp4' } };
    const events = [
      ev(room, KIM, 'm.room.message', oldNotice('voice message', OFF, voice)),
      ev(room, KIM, 'm.room.message', oldNotice('photo', OVERNIGHT, photo, 'Am See')),
      ev(room, KIM, 'm.room.message', oldNotice('file attachment', SOON, doc)),
      ev(room, KIM, 'm.room.message', oldNotice('sticker', OFF, sticker)),
      ev(room, KIM, 'm.room.message', oldNotice('video message', OFF, video)),
      // without the bridge's field: the first words and the suffix still say it
      ev(room, KIM, 'm.room.message', oldNotice('audio attachment', SOON, null)),
      // a file it could not carry over for another reason (a live message as well)
      ev(room, KIM, 'm.room.message', { msgtype: 'm.notice', body: 'Failed to bridge photo, please view it on the WhatsApp app' }),
    ];
    await hs.push('t-om1', { events });
    const evs = (await pulled()).filter((e) => e.type === 'message');
    assert.deepEqual(evs.map((e) => [e.kind, e.oldMedia, e.text]), [
      ['unsupported', { kind: 'voice', name: null, request: 'off' }, null],
      ['unsupported', { kind: 'image', name: null, request: 'daily' }, 'Am See'],
      ['unsupported', { kind: 'file', name: 'Rechnung.pdf', request: 'now' }, null],
      ['unsupported', { kind: 'sticker', name: null, request: 'off' }, null],
      ['unsupported', { kind: 'video', name: null, request: 'off' }, null],
      ['unsupported', { kind: 'audio', name: null, request: 'now' }, null],
      ['unsupported', { kind: 'image', name: null, request: 'failed' }, null],
    ]);
    assert.doesNotMatch(JSON.stringify(evs), /Old |Requesting|requested|Failed to bridge|WhatsApp app|failed_media|AAAA/, 'no English line, no key of the file');
  });

  it('a notice without the suffix the bridge writes: what the administrator chose now', async () => {
    await open(room, [bridgeState('100000000000001@lid', 'dm'), memberState(KIM, 'Kim')]);
    bridges.configure({ mediaRequests: 'daily' }, {});
    try {
      const c = oldNotice('voice message', OFF, voice);
      c.body = 'Old voice message. Something else.';
      await hs.push('t-om2', { events: [ev(room, KIM, 'm.room.message', c)] });
      const m = (await pulled()).find((e) => e.type === 'message');
      assert.deepEqual(m.oldMedia, { kind: 'voice', name: null, request: 'daily' });
    } finally { bridges.configure({ mediaRequests: 'off' }, {}); }
  });

  it('the file the phone sent later: an edit with the file; a phone that could not: an edit without text', async () => {
    await open(room, [bridgeState('100000000000001@lid', 'dm'), memberState(KIM, 'Kim')]);
    const first = ev(room, KIM, 'm.room.message', oldNotice('voice message', OVERNIGHT, voice));
    const second = ev(room, KIM, 'm.room.message', oldNotice('photo', OVERNIGHT, { content: { msgtype: 'm.image', body: 'image.jpg', filename: 'image.jpg' } }));
    await hs.push('t-om3', { events: [first, second] });
    await ack();
    // pkg/connector/events.go WAMediaRetry → MediaRetryToMatrix: the notice edited into the file
    const nc = { msgtype: 'm.audio', body: 'Voice message.ogg', filename: 'Voice message.ogg', url: `mxc://${S}/vm1`, info: { mimetype: 'audio/ogg', size: 4000, duration: 3000 }, 'org.matrix.msc3245.voice': {}, 'org.matrix.msc1767.audio': { duration: 3000, waveform: [0, 512, 1024] } };
    const got = ev(room, KIM, 'm.room.message', { ...nc, body: `* ${nc.body}`, 'm.new_content': nc, 'm.relates_to': { rel_type: 'm.replace', event_id: first.event_id } });
    // makeErrorEdit: the phone did not have it any more
    const gone = ev(room, KIM, 'm.room.message', { msgtype: 'm.notice', body: '* Failed to bridge media after re-requesting it from your phone: media not available on phone', 'm.new_content': { msgtype: 'm.notice', body: 'Failed to bridge media after re-requesting it from your phone: media not available on phone' }, 'm.relates_to': { rel_type: 'm.replace', event_id: second.event_id } });
    // an edit back into the notice of an old file changes nothing (and brings no English line)
    const back = ev(room, KIM, 'm.room.message', { msgtype: 'm.notice', body: `* Old photo. ${OFF}`, 'm.new_content': oldNotice('photo', OFF, null), 'm.relates_to': { rel_type: 'm.replace', event_id: second.event_id } });
    await hs.push('t-om4', { events: [got, gone, back] });
    const evs = (await pulled()).filter((e) => e.type === 'edit');
    assert.equal(evs.length, 2);
    assert.equal(evs[0].target, first.event_id);
    assert.equal(evs[0].media.kind, 'voice');
    assert.match(evs[0].media.ref, /^m[A-Za-z0-9_-]{40,700}$/);
    assert.deepEqual([evs[0].media.mime, evs[0].media.durationMs, evs[0].media.waveform], ['audio/ogg', 3000, [0, 512, 1024]]);
    assert.deepEqual([evs[1].target, evs[1].text, evs[1].oldMedia], [second.event_id, null, { request: 'failed' }]);
    assert.doesNotMatch(JSON.stringify(evs), /Failed to bridge|re-requesting|mxc:/);
    // the file is noted for the clean-up at the homeserver like any other
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_media').get().n, 1);
  });

  it('only WhatsApp\'s notices: the same words from another bridge stay a notice', async () => {
    const tg = '!tg:gc.internal';
    const TG = `@telegram_100:${S}`;
    await open(tg, [bridgeState('user:100', 'dm', 'telegram'), memberState(TG, 'Tom')]);
    await hs.push('t-om5', { events: [ev(tg, TG, 'm.room.message', { msgtype: 'm.notice', body: `Old photo. ${OFF}` })] });
    const m = (await pulled()).find((e) => e.type === 'message');
    assert.ok(m, 'the message arrives');
    assert.equal(m.oldMedia, undefined);
    assert.equal(m.kind, 'notice');
  });
});
