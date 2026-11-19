'use strict';

// Messenger bridges, stage 5 (docs/feature-messenger-bridges.md, "History", "Backup", "Clean-up", "Health"):
// against the stand-in homeserver (tests/helpers/fake-homeserver.js) and update.sh with a fake docker — no bridge, no
// WhatsApp, no Docker.
//
//   configuration   history allowed → the bridge keeps the phone's history at a link (backfill, history_sync);
//                   the homeserver makes the server's bot its administrator; only keys of the pinned versions
//   history         older than the link AND the room → history; what the person chose (off, 30 days, everything)
//                   decides; kept apart (bridge_backlog), handed over in the order it came, before a live event of
//                   the same chat; changed minds drop what waits
//   files           noted per person; deleted at the homeserver once taken over — the bot joins the admin room once
//   health          the bridge's phone warning and "client outdated", without a person's request, no names
//   backup          update.sh's plain snapshot → encrypted at once; in the GateControl backup only encrypted;
//                   restored: master key, rooms of the same people, the snapshot decrypted for update.sh
//   update.sh       the pinned images as an override (known repositories only), a snapshot of the stopped
//                   containers, a restore that checks every name in the file
//   (the sealed media area of a plugin: tests/plugin_media_areas.test.js)

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { setup, teardown } = require('./helpers/setup');
const { startFakeHomeserver } = require('./helpers/fake-homeserver');

let bridges, hsMod, appservice, hostApi, ctx, db, annaId, benId, hs, au, settings;
const PLUGIN = { id: 'bridge-demo', manifest: { permissions: { bridges: true } } };
const call = (api, args) => hostApi.handle(PLUGIN, api, args);
const asPerson = (userId, write, fn) => ctx.run(PLUGIN.id, userId, write, fn);
const S = 'gc.internal';
const anna = () => `@gc_${annaId}:${S}`;
const KIM = `@whatsapp_4915198765432:${S}`;
const BOT = `@whatsappbot:${S}`;
const DAY = 86400000;
let n = 0;
const ev = (room, sender, type, content, extra = {}) => ({ room_id: room, sender, type, content, event_id: `$s5e${++n}`, origin_server_ts: Date.now(), ...extra });
const msg = (room, body, ts, extra = {}) => ev(room, KIM, 'm.room.message', { msgtype: 'm.text', body, ...extra }, { origin_server_ts: ts });
const member = (room, who, membership) => ev(room, BOT, 'm.room.member', { membership }, { state_key: who });
const bridgeState = () => ({ type: 'm.bridge', state_key: 'x', content: { bridgebot: BOT, protocol: { id: 'whatsapp' }, 'com.beeper.room_type.v2': 'dm' } });
const nameState = (name) => ({ type: 'm.room.name', state_key: '', content: { name } });
const memberState = (who, displayname) => ({ type: 'm.room.member', state_key: who, content: { membership: 'join', displayname } });

before(async () => {
  await setup();
  process.env.GC_BRIDGES_PREVIEW = '1';
  bridges = require('../src/services/bridges');
  hsMod = require('../src/services/bridges/hs');
  appservice = require('../src/services/bridges/appservice');
  hostApi = require('../src/services/plugins/hostApi');
  ctx = require('../src/services/plugins/personContext');
  au = require('../src/services/autoUpdate');
  settings = require('../src/services/settings');
  db = require('../src/db/connection').getDb();
  const add = db.prepare('INSERT INTO users (username, password_hash, role, enabled, language, display_name) VALUES (?, ?, ?, 1, ?, ?)');
  annaId = Number(add.run('anna-br5', 'x', 'user', 'de', 'Anna').lastInsertRowid);
  benId = Number(add.run('ben-br5', 'x', 'user', 'de', 'Ben').lastInsertRowid);
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
  hs.adminInvited = false;
  hs.admins.clear();
});

/** Anna linked "days" ago; a room the bridge made for her with Kim right now. → the chat reference */
async function room(roomId, { linkedDaysAgo = 1 } = {}) {
  settings.set('bridges.linked_at', JSON.stringify({ [`${annaId}:whatsapp`]: Date.now() - linkedDaysAgo * DAY }));
  hs.room(roomId, { state: [bridgeState(), nameState('Kim Muster'), memberState(KIM, 'Kim Muster')], members: [anna()] });
  await hs.push(`open-${roomId}`, { events: [member(roomId, anna(), 'join')] });
  const chat = db.prepare('SELECT ref FROM bridge_rooms WHERE room_id = ?').get(roomId).ref;
  await call('bridges.events.ack', { upTo: 1e9 });
  return chat;
}
const live = () => call('bridges.events.pull', {}).then((r) => r.events);
const backlog = (o = {}) => call('bridges.history.pull', o).then((r) => r.events);

describe('configuration', () => {
  const config = require('../src/services/bridges/config');
  const keysOf = (o, pre = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length ? [pre + k, ...keysOf(v, pre + k + '.')] : [pre + k]));
  const secrets = { asToken: 'a'.repeat(43), hsToken: 'b'.repeat(43), provisionSecret: 'c'.repeat(43), coreAsToken: 'd'.repeat(43), coreHsToken: 'e'.repeat(43), puppetAsToken: 'f'.repeat(43), puppetHsToken: 'g'.repeat(43), signalAsToken: 'h'.repeat(43), signalHsToken: 'i'.repeat(43), telegramAsToken: 'j'.repeat(43), telegramHsToken: 'k'.repeat(43) };

  it('history allowed: the bridge keeps the phone’s history and fills the most recent chats; otherwise as before', () => {
    const on = config.bridgeModel('whatsapp', secrets, { history: true });
    assert.deepEqual(on.backfill, { enabled: true, max_initial_messages: 200, max_catchup_messages: 100, queue: { enabled: false } });
    assert.deepEqual(on.network.history_sync, { max_initial_conversations: 30, request_full_sync: false, media_requests: { auto_request_media: false } });
    const offM = config.bridgeModel('whatsapp', secrets, {});
    assert.deepEqual(offM.backfill, { enabled: false });
    assert.equal(offM.network.history_sync.max_initial_conversations, 0);
    const known = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/bridges/keys-mautrix-whatsapp-0.2610.0.json'), 'utf8')).keys);
    for (const k of keysOf(on)) if (!k.startsWith('bridge.permissions.') && !k.startsWith('double_puppet.secrets.')) assert.ok(known.has(k), k);
    assert.notEqual(config.rev(secrets, ['whatsapp'], { history: true }), config.rev(secrets, ['whatsapp'], {}), 'a change recreates the containers');
  });

  it('the homeserver makes the server’s bot its administrator at every start — and an error does not stop it', () => {
    const toml = config.hsToml(config.hsModel(secrets, ['whatsapp']));
    assert.match(toml, /^admin_execute = \["users make-user-admin @gcbot:gc\.internal"\]$/m);
    assert.match(toml, /^admin_execute_errors_ignore = true$/m);
    const known = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/bridges/keys-tuwunel-1.9.4.json'), 'utf8')).sections.global);
    for (const k of Object.keys(config.hsModel(secrets, ['whatsapp']).global)) assert.ok(known.has(k), k);
  });

  it('the wish for update.sh: the pinned images, a snapshot when one is asked for', () => {
    const w = bridges.wish();
    assert.match(w.images, /^hs=ghcr\.io\/matrix-construct\/tuwunel:v1\.9\.4@sha256:[0-9a-f]{64},core-relay=alpine\/socat:[^,]+,whatsapp=dock\.mau\.dev\/mautrix\/whatsapp:v0\.2610\.0@sha256:[0-9a-f]{64},whatsapp-relay=alpine\/socat:/);
    au.syncConfigFile();
    let cfg = JSON.parse(fs.readFileSync(au.CONFIG_FILE, 'utf8'));
    assert.equal(cfg.bridges_images, w.images);
    assert.equal(cfg.bridges_backup, undefined);
    bridges.configure({ backupNow: true }, {});
    cfg = JSON.parse(fs.readFileSync(au.CONFIG_FILE, 'utf8'));
    assert.match(cfg.bridges_backup, /^[0-9a-f]{12}$/);
    assert.equal(bridges.status().backup.requested, true);
    settings.set('bridges.backup_req', '');
    assert.throws(() => bridges.configure({ backupNow: false }, {}), /backupNow/);
    assert.throws(() => bridges.configure({ backupTime: '3:10' }, {}), /backupTime/);
    bridges.configure({ backupTime: '02:40' }, {});
    assert.equal(bridges.status().backup.time, '02:40');
    settings.set('bridges.backup_time', '03:10');
  });
});

describe('history', () => {
  it('older than the link and the room: history — kept apart, marked, not in the live inbox', async () => {
    const chat = await room('!h1:gc.internal');
    const now = Date.now();
    await hs.push('h1', { events: [msg('!h1:gc.internal', 'vor zwei Tagen', now - 2 * DAY), msg('!h1:gc.internal', 'gerade eben', now)] });
    const l = await live();
    // the live one came after it in the same transaction: the history of the chat went ahead of it, marked
    assert.deepEqual(l.map((e) => [e.text, e.history === true]), [['vor zwei Tagen', true], ['gerade eben', false]]);
    assert.equal((await backlog()).length, 0);
    await call('bridges.events.ack', { upTo: 1e9 });
    await hs.push('h2', { events: [msg('!h1:gc.internal', 'vor drei Tagen', now - 3 * DAY)] });
    const b = await backlog();
    assert.deepEqual(b.map((e) => [e.text, e.history, e.chat.id]), [['vor drei Tagen', true, chat]]);
    assert.equal((await live()).length, 0);
    assert.equal(bridges.status().history.pending, 1);
  });

  it('in the order it came: history of a chat moves into the inbox ahead of that chat’s next message', async () => {
    await room('!h2:gc.internal');
    const now = Date.now();
    await hs.push('o1', { events: [msg('!h2:gc.internal', 'alt 1', now - 5 * DAY), msg('!h2:gc.internal', 'alt 2', now - 4 * DAY)] });
    assert.equal((await backlog()).length, 2);
    await hs.push('o2', { events: [msg('!h2:gc.internal', 'neu', now)] });
    const l = await live();
    assert.deepEqual(l.map((e) => [e.text, e.history === true]), [['alt 1', true], ['alt 2', true], ['neu', false]]);
    assert.equal((await backlog()).length, 0);
  });

  it('a late message is never history: newer than the link (the bridge or the phone was away)', async () => {
    await room('!h3:gc.internal', { linkedDaysAgo: 10 });
    await hs.push('l1', { events: [msg('!h3:gc.internal', 'kam spät', Date.now() - 2 * 3600000)] });
    assert.deepEqual((await live()).map((e) => [e.text, e.history === true]), [['kam spät', false]]);
    // without a known link time (linked before stage 5): nothing is history
    settings.set('bridges.linked_at', '{}');
    await hs.push('l2', { events: [msg('!h3:gc.internal', 'uralt', Date.now() - 300 * DAY)] });
    assert.equal((await backlog()).length, 0);
  });

  it('what the person chose decides: off writes nothing, 30 days only the last 30, everything all', async () => {
    await room('!h4:gc.internal', { linkedDaysAgo: 0.01 });
    const now = Date.now();
    const old = [msg('!h4:gc.internal', '40 Tage', now - 40 * DAY), msg('!h4:gc.internal', '20 Tage', now - 20 * DAY)];
    await hs.push('c1', { events: old });
    assert.deepEqual((await backlog()).map((e) => e.text), ['20 Tage'], 'the default: 30 days');
    db.exec('DELETE FROM bridge_backlog');
    await asPerson(annaId, true, () => call('bridges.history.set', { userId: annaId, days: -1 }));
    await hs.push('c2', { events: old.map((e) => ({ ...e, event_id: e.event_id + 'b' })) });
    assert.deepEqual((await backlog()).map((e) => e.text), ['40 Tage', '20 Tage']);
    // fewer days: what waits and is not wanted any more goes at once
    const r = await asPerson(annaId, true, () => call('bridges.history.set', { userId: annaId, days: 0 }));
    assert.deepEqual([r.days, r.pending], [0, 0]);
    await hs.push('c3', { events: old.map((e) => ({ ...e, event_id: e.event_id + 'c' })) });
    assert.equal((await backlog()).length, 0, 'off: nothing is written');
    // an administrator forbids it: off for everybody
    await asPerson(annaId, true, () => call('bridges.history.set', { userId: annaId, days: -1 }));
    bridges.configure({ history: false }, {});
    assert.equal(bridges.historyOf(annaId), 0);
    assert.equal((await asPerson(annaId, false, () => call('bridges.history.get', { userId: annaId }))).allowed, false);
    bridges.configure({ history: true }, {});
  });

  it('only the person sets their own; pull and ack need nobody; nonsense is refused', async () => {
    await assert.rejects(call('bridges.history.set', { userId: annaId, days: 0 }), (e) => e.code === 'ERR_NOT_PERSON');
    await assert.rejects(asPerson(annaId, false, () => call('bridges.history.set', { userId: annaId, days: 0 })), (e) => e.code === 'ERR_NOT_PERSON');
    await assert.rejects(asPerson(benId, true, () => call('bridges.history.set', { userId: annaId, days: 0 })), (e) => e.code === 'ERR_NOT_PERSON');
    await assert.rejects(asPerson(annaId, true, () => call('bridges.history.set', { userId: annaId, days: 7 })), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(call('bridges.history.ack', { seqs: ['x'] }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(call('bridges.history.pull', { chatId: 'nope' }), (e) => e.code === 'ERR_INVALID');
    assert.deepEqual(await call('bridges.history.pull', {}), { events: [], more: false });
    const g = await asPerson(annaId, false, () => call('bridges.history.get', { userId: annaId }));
    assert.deepEqual(g, { allowed: true, days: 30, default: 30, options: [0, 30, -1], pending: 0 });
  });

  it('ack forgets exactly what was filed', async () => {
    await room('!h5:gc.internal');
    const now = Date.now();
    await hs.push('a1', { events: [msg('!h5:gc.internal', 'eins', now - 3 * DAY), msg('!h5:gc.internal', 'zwei', now - 2 * DAY)] });
    const [first] = await backlog({ limit: 1 });
    assert.equal(first.text, 'eins');
    assert.deepEqual(await call('bridges.history.ack', { seqs: [first.seq] }), { ok: true, pending: 1 });
    assert.deepEqual((await backlog()).map((e) => e.text), ['zwei']);
    // sealed in the database like the inbox
    for (const { payload } of db.prepare('SELECT payload FROM bridge_backlog').all()) {
      assert.match(payload, /^[A-Za-z0-9+/]+={0,2}$/); // not /zwei/ on the base64: a random ciphertext has it now and then
      assert.doesNotMatch(Buffer.from(payload, 'base64').toString('latin1'), /zwei/);
    }
  });
});

describe('files at the homeserver', () => {
  it('deleted once taken over — the bot takes its seat in the admin room first; nobody else’s copy waits', async () => {
    await room('!f1:gc.internal');
    const url = hs.file('pic1', { data: Buffer.from('JPEGDATA'), mime: 'image/jpeg' });
    await hs.push('f1', { events: [ev('!f1:gc.internal', KIM, 'm.room.message', { msgtype: 'm.image', body: 'a.jpg', url, info: { mimetype: 'image/jpeg', size: 8 } })] });
    const [m] = await live();
    assert.equal(bridges.status().cleanup.waiting, 1);
    assert.equal(await bridges.cleanupRun(), 0, 'not taken over yet');
    // the plugin fetched it (host API media.fetch → mediaFetched); an hour later it may go
    bridges.mediaFetched(annaId, m.media.ref);
    db.prepare('UPDATE bridge_media SET at = ?').run(Date.now() - 2 * 3600000);
    // not an administrator yet: refused, nothing lost
    assert.equal(await bridges.cleanupRun(), 0);
    assert.equal(bridges.status().cleanup.error, 'no_admin');
    assert.ok(hs.files.has('pic1'));
    // the homeserver ran admin_execute: the bot joins and deletes
    hs.adminInvited = true;
    assert.equal(await bridges.cleanupRun(), 1);
    assert.ok(!hs.files.has('pic1'));
    assert.equal(bridges.status().cleanup.deleted, 1);
    const del = hs.requests.find((q) => q.method === 'DELETE');
    assert.deepEqual([del.path, del.userId], ['/_synapse/admin/v1/media/gc.internal/pic1', '@gcbot:gc.internal']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_media').get().n, 0);
  });

  it('a file of history nobody wanted goes; one nobody fetched stays 30 days', async () => {
    await room('!f2:gc.internal', { linkedDaysAgo: 0.01 });
    hs.adminInvited = true;
    await asPerson(annaId, true, () => call('bridges.history.set', { userId: annaId, days: 0 }));
    const u1 = hs.file('old1', { data: Buffer.from('x'), mime: 'image/jpeg' });
    const u2 = hs.file('new1', { data: Buffer.from('y'), mime: 'image/jpeg' });
    await hs.push('f2', { events: [
      ev('!f2:gc.internal', KIM, 'm.room.message', { msgtype: 'm.image', body: 'alt.jpg', url: u1 }, { origin_server_ts: Date.now() - 5 * DAY }),
      ev('!f2:gc.internal', KIM, 'm.room.message', { msgtype: 'm.image', body: 'neu.jpg', url: u2 }),
    ] });
    db.prepare('UPDATE bridge_media SET at = ?').run(Date.now() - 2 * 3600000);
    assert.equal(await bridges.cleanupRun(), 1);
    assert.ok(!hs.files.has('old1') && hs.files.has('new1'));
    db.prepare('UPDATE bridge_media SET at = ?').run(Date.now() - 31 * DAY);
    assert.equal(await bridges.cleanupRun(), 1);
    assert.ok(!hs.files.has('new1'));
  });
});

describe('health', () => {
  it('the phone warning and "client outdated" from the bridge, without a person, without names', async () => {
    const { startFakeBridge } = require('./helpers/fake-bridge');
    const provision = require('../src/services/bridges/provision');
    const secrets = bridges.readSecrets();
    const fb = await startFakeBridge({ socket: provision.socketOf(bridges.dir(), 'whatsapp'), secret: secrets.provisionSecret });
    try {
      fb.logins.set(anna(), [{ id: '4915111111111', name: '+49 151 11111111', state_event: 'TRANSIENT_DISCONNECT', error: 'wa-phone-offline', timestamp: Math.floor(Date.now() / 1000) - 2 * 86400 }]);
      fb.logins.set(`@gc_${benId}:${S}`, [{ id: '4915122222222', name: 'x', state_event: 'UNKNOWN_ERROR', error: 'wa-client-outdated', timestamp: Math.floor(Date.now() / 1000) }]);
      const r = await call('bridges.health', { userIds: [annaId, benId], network: 'whatsapp' });
      assert.equal(r[0].logins[0].state, 'connected', 'the link still works');
      assert.equal(r[0].logins[0].phoneOffline, true);
      assert.equal(r[1].logins[0].clientOutdated, true);
      assert.doesNotMatch(JSON.stringify(r), /\+49|11111111|22222222/, 'no id and no name of a login (both name the number)');
      assert.equal(bridges.status().networks[0].clientOutdated, true);
      await assert.rejects(call('bridges.health', { userIds: Array.from({ length: 101 }, (_, i) => i + 1), network: 'whatsapp' }), (e) => e.code === 'ERR_INVALID');
    } finally { await fb.close(); }
  });
});

describe('backup', () => {
  const bk = require('../src/services/bridges/backup');
  const plain = Buffer.concat([Buffer.from('hs/data/000001.sst\n'), crypto.randomBytes(5000)]);
  function hostLeaves(id, result = 'ok') {
    fs.mkdirSync(bk.dir(), { recursive: true });
    if (result === 'ok') fs.writeFileSync(path.join(bk.dir(), `state-${id}.tar`), plain);
    fs.writeFileSync(path.join(au.DATA_DIR, '.bridges-backup.json'), JSON.stringify({ id, result, at: new Date().toISOString(), bytes: plain.length, update_sh: 8 }));
  }

  it('the night asks once; update.sh’s plain snapshot is encrypted at once and the plain file deleted', async () => {
    settings.set('bridges.backup_night', '');
    settings.set('bridges.backup_req', '');
    const night = new Date('2026-11-16T02:20:00Z'); // 03:20 in Berlin
    await bk.tick(new Date('2026-11-16T01:00:00Z'));
    assert.equal(bk.requested(), null, 'not before 03:10');
    await bk.tick(night);
    const id = bk.requested();
    assert.match(id, /^[0-9a-f]{12}$/);
    await bk.tick(new Date(night.getTime() + 600000));
    assert.equal(bk.requested(), id, 'once a night');
    hostLeaves(id);
    await bk.tick(new Date(night.getTime() + 900000));
    assert.equal(bk.requested(), null);
    assert.ok(!fs.existsSync(path.join(bk.dir(), `state-${id}.tar`)), 'the plain file is gone');
    const enc = fs.readFileSync(path.join(bk.dir(), 'state.enc'));
    assert.equal(enc.length, plain.length);
    assert.ok(!enc.includes(Buffer.from('hs/data/000001.sst')), 'only encrypted');
    const st = bridges.status().backup;
    assert.equal(st.bytes, plain.length);
    assert.ok(st.lastAt);
  });

  it('a failed snapshot is said so, and nothing half is kept', async () => {
    const id = bk.request();
    hostLeaves(id, 'failed');
    await bk.ingest();
    assert.equal(bk.requested(), null);
    assert.equal(bridges.status().backup.error, 'failed');
  });

  it('in the GateControl backup only encrypted; validated; restored for update.sh with the master key and the rooms', async () => {
    const id = bk.request();
    hostLeaves(id);
    await bk.ingest();
    await room('!b1:gc.internal');
    const backup = require('../src/services/backup');
    const b = await backup.createBackup();
    const part = b.data.bridges;
    assert.ok(part && part.snapshot && typeof part.snapshot.data === 'string');
    assert.ok(!Buffer.from(part.snapshot.data, 'base64').includes(Buffer.from('hs/data/000001.sst')));
    assert.match(part.master_key_enc, /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    assert.doesNotMatch(JSON.stringify(part), new RegExp(bridges.masterKey()), 'never the key in the clear');
    assert.deepEqual(part.rooms.map((r) => [r.room_id, r.user_name]), [['!b1:gc.internal', 'anna-br5']]);
    assert.deepEqual(backup.validateBackup(b).filter((e) => /bridges/.test(e)), []);
    assert.equal(backup.getBackupSummary(b).bridges.snapshot, true);
    // a damaged part is refused
    assert.ok(backup.validateBackup({ ...b, data: { ...b.data, bridges: { ...part, snapshot: { ...part.snapshot, iv: 'x' } } } }).some((e) => /bridges/.test(e)));
    // restore: the key, the rooms of the same people, the snapshot decrypted for update.sh
    const key = bridges.masterKey();
    db.exec('DELETE FROM bridge_rooms');
    const r = await bk.restorePart(part, { userIdByName: (nm) => (nm === 'anna-br5' ? annaId : undefined) });
    assert.deepEqual([r.state, r.rooms, r.skipped], ['restoring', 1, 0]);
    assert.equal(bridges.masterKey(), key);
    const rid = settings.get('bridges.restore_req', '');
    assert.equal(rid, part.snapshot.id);
    assert.deepEqual(fs.readFileSync(path.join(bk.dir(), `restore-${rid}.tar`)), plain);
    au.syncConfigFile();
    assert.equal(JSON.parse(fs.readFileSync(au.CONFIG_FILE, 'utf8')).bridges_restore, rid);
    // update.sh reports: the request ends, the plain file goes
    fs.writeFileSync(path.join(au.DATA_DIR, '.bridges-restore.json'), JSON.stringify({ id: rid, result: 'ok' }));
    bk.ingestRestore();
    assert.equal(settings.get('bridges.restore_req', ''), '');
    assert.ok(!fs.existsSync(path.join(bk.dir(), `restore-${rid}.tar`)));
    // a person whose account has another id now: their rooms stay out (the internal account is named after the id)
    const r2 = await bk.restorePart({ ...part, snapshot: null }, { userIdByName: () => benId });
    assert.deepEqual([r2.state, r2.rooms, r2.skipped], ['keys', 0, 1]);
    // the off-site re-key converts the key like every other secret
    const { rekeyBackup } = require('../src/services/offsite/rekey');
    const from = require('../config/default').encryption.key;
    const to = crypto.randomBytes(32).toString('hex');
    const { converted } = rekeyBackup({ data: { bridges: { master_key_enc: part.master_key_enc, snapshot: { key_enc: part.snapshot.key_enc } } } }, from, to);
    assert.equal(converted, 2);
  });
});

describe('update.sh, marker 8', () => {
  const ROOT = path.join(__dirname, '..');
  let box;
  const DOCKER = `#!/usr/bin/env bash
S="$SHIM_ST"; echo "$*" >>"$S/calls"
case "$1" in
  inspect)
    case "$*" in
      *State.Running*) [ -f "$S/run_\${!#}" ] && echo true || echo false; exit 0 ;;
      *Config.Image*) echo "example.org/x/\${!#}:v1@sha256:$(printf '%064d' 0)"; exit 0 ;;
      *) echo ""; exit 0 ;;
    esac ;;
  stats) echo "10MiB / 512MiB"; exit 0 ;;
  rm) rm -f "$S/run_\${!#}"; exit 0 ;;
  compose)
    case "$*" in
      *"config --services"*) cat "$S/services" 2>/dev/null; exit 0 ;;
      *" up -d "*) seen=0; for a in "$@"; do [ "$seen" = 1 ] && [ "\${a#-}" = "$a" ] && : >"$S/run_$a"; [ "$a" = "-d" ] && seen=1; done; exit 0 ;;
      *" stop "*) seen=0; for a in "$@"; do [ "$seen" = 1 ] && rm -f "$S/run_$a" && echo "$a" >>"$S/stopped"; [ "$a" = "stop" ] && seen=1; done; exit 0 ;;
      *" start "*) seen=0; for a in "$@"; do [ "$seen" = 1 ] && : >"$S/run_$a"; [ "$a" = "start" ] && seen=1; done; exit 0 ;;
    esac; exit 0 ;;
esac
exit 0
`;
  const st = (f) => path.join(box, 'st', f);
  const data = (f) => path.join(box, 'data', f);
  function run(config) {
    fs.writeFileSync(data('.auto-update-config.json'), JSON.stringify({ mode: 'manual', bridges: 'whatsapp', ...config }) + '\n');
    const r = spawnSync('bash', [path.join(box, 'update.sh')], {
      env: { PATH: `${path.join(box, 'bin')}:${process.env.PATH}`, SHIM_ST: path.join(box, 'st'), GC_UPDATE_LOG: path.join(box, 'update.log'), TMPDIR: box, HOME: box },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return fs.readFileSync(st('calls'), 'utf8');
  }
  const pin = (repo) => `${repo}:v9@sha256:${'a'.repeat(64)}`;
  beforeEach(() => {
    box = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-bridges-sh5-'));
    for (const d of ['bin', 'data', 'st']) fs.mkdirSync(path.join(box, d));
    fs.writeFileSync(path.join(box, 'docker-compose.yml'), 'services:\n  gatecontrol:\n    image: x\n');
    fs.copyFileSync(path.join(ROOT, 'update.sh'), path.join(box, 'update.sh'));
    fs.writeFileSync(path.join(box, 'bin', 'docker'), DOCKER, { mode: 0o755 });
    fs.writeFileSync(st('calls'), '');
    fs.writeFileSync(st('services'), 'bruecken-hs\nbruecken-whatsapp\nbruecken-whatsapp-relay\nbruecken-core-relay\n');
    for (const f of ['hs/config/tuwunel.toml', 'whatsapp/config/config.yaml', 'hs/data/000001.sst', 'whatsapp/data/whatsapp.db']) {
      fs.mkdirSync(path.dirname(data(`bridges/${f}`)), { recursive: true });
      fs.writeFileSync(data(`bridges/${f}`), `${f}\n`);
    }
    fs.mkdirSync(data('bridges/backup'), { recursive: true });
  });

  it('the server’s pins become an override for `up` — only of the known repositories', { skip: process.platform !== 'linux' }, () => {
    const images = ['hs=' + pin('ghcr.io/matrix-construct/tuwunel'), 'whatsapp=' + pin('evil.example/mautrix/whatsapp'), 'whatsapp-relay=' + pin('alpine/socat'), 'core-relay=alpine/socat:latest'].join(',');
    const calls = run({ bridges_images: images });
    const o = fs.readFileSync(path.join(box, '.bruecken-images.yml'), 'utf8');
    assert.match(o, /bruecken-hs:\n {4}image: "ghcr\.io\/matrix-construct\/tuwunel:v9@sha256:a{64}"/);
    assert.match(o, /bruecken-whatsapp-relay:/);
    assert.doesNotMatch(o, /evil|bruecken-whatsapp:\n|:latest/, 'another repository or an unpinned tag is never taken');
    assert.match(calls, /compose -f docker-compose\.yml -f \.bruecken-images\.yml --profile bruecken up -d bruecken-hs/);
    assert.match(fs.readFileSync(path.join(box, '.bruecken-managed'), 'utf8'), / images=\d+/, 'a new pin updates the containers');
    // the config check uses the docker-compose.yml alone
    assert.match(calls, /^compose --profile bruecken config --services$/m);
  });

  it('stage 7a: the pins of Signal and its relay are taken only from their own repositories, Telegram not before the file has it', { skip: process.platform !== 'linux' }, () => {
    fs.mkdirSync(data('bridges/signal/config'), { recursive: true });
    fs.writeFileSync(data('bridges/signal/config/config.yaml'), 'x\n');
    fs.writeFileSync(st('services'), 'bruecken-hs\nbruecken-whatsapp\nbruecken-whatsapp-relay\nbruecken-signal\nbruecken-signal-relay\nbruecken-core-relay\n');
    const images = ['signal=' + pin('dock.mau.dev/mautrix/signal'), 'signal-relay=' + pin('alpine/socat'), 'telegram=' + pin('dock.mau.dev/mautrix/telegram'), 'whatsapp=' + pin('dock.mau.dev/mautrix/signal')].join(',');
    run({ bridges: 'signal,whatsapp', bridges_images: images });
    const o = fs.readFileSync(path.join(box, '.bruecken-images.yml'), 'utf8');
    assert.match(o, /bruecken-signal:\n {4}image: "dock\.mau\.dev\/mautrix\/signal:v9@sha256:a{64}"/);
    assert.match(o, /bruecken-signal-relay:\n {4}image: "alpine\/socat:v9@sha256:a{64}"/);
    assert.doesNotMatch(o, /bruecken-whatsapp:\n/, 'Signal\'s repository is not WhatsApp\'s');
    assert.doesNotMatch(o, /telegram/, 'a service the compose file lacks is not written');
  });

  it('a snapshot: stops bridge and homeserver, packs their data folders, starts them again — once per request', { skip: process.platform !== 'linux' || !spawnSync('sh', ['-c', 'command -v tar']).status === 0 }, () => {
    run({});
    run({}); // running now
    fs.writeFileSync(st('calls'), '');
    const calls = run({ bridges_backup: 'abcdefabcdef' });
    assert.match(calls, /compose --profile bruecken stop bruecken-whatsapp bruecken-hs/);
    assert.match(calls, /compose --profile bruecken start bruecken-hs bruecken-whatsapp/);
    const tar = data('bridges/backup/state-abcdefabcdef.tar');
    assert.equal(fs.statSync(tar).mode & 0o777, 0o600);
    const list = spawnSync('tar', ['-tf', tar], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    assert.ok(list.includes('hs/data/000001.sst') && list.includes('whatsapp/data/whatsapp.db'));
    assert.ok(!list.some((x) => /config|secrets/.test(x)), 'only the data folders');
    const rep = JSON.parse(fs.readFileSync(data('.bridges-backup.json'), 'utf8'));
    assert.deepEqual([rep.id, rep.result, rep.update_sh], ['abcdefabcdef', 'ok', 10]);
    fs.writeFileSync(st('calls'), '');
    assert.doesNotMatch(run({ bridges_backup: 'abcdefabcdef' }), / stop /, 'once');
  });

  it('a restore: checks every name, keeps the folders before, unpacks; anything else is refused', { skip: process.platform !== 'linux' }, () => {
    run({}); run({});
    // a good snapshot
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-br5-src-'));
    fs.mkdirSync(path.join(src, 'hs/data'), { recursive: true });
    fs.mkdirSync(path.join(src, 'whatsapp/data'), { recursive: true });
    fs.writeFileSync(path.join(src, 'hs/data/000009.sst'), 'restored\n');
    fs.writeFileSync(path.join(src, 'whatsapp/data/whatsapp.db'), 'restored db\n');
    spawnSync('tar', ['-C', src, '-cf', data('bridges/backup/restore-111111111111.tar'), 'hs/data', 'whatsapp/data']);
    const calls = run({ bridges_restore: '111111111111' });
    assert.match(calls, /stop bruecken-whatsapp bruecken-hs/);
    assert.equal(fs.readFileSync(data('bridges/hs/data/000009.sst'), 'utf8'), 'restored\n');
    assert.equal(fs.readFileSync(data('bridges/hs/data.prev/000001.sst'), 'utf8'), 'hs/data/000001.sst\n', 'the folder before is kept');
    assert.equal(JSON.parse(fs.readFileSync(data('.bridges-restore.json'), 'utf8')).result, 'ok');
    assert.ok(!fs.existsSync(data('bridges/backup/restore-111111111111.tar')));
    assert.match(calls, / up -d /, 'started again');
    // a file with something outside the data folders: refused, nothing touched
    fs.writeFileSync(path.join(src, 'evil'), 'x');
    fs.symlinkSync('/etc', path.join(src, 'hs/data/link'));
    spawnSync('tar', ['-C', src, '-cf', data('bridges/backup/restore-222222222222.tar'), 'hs/data', 'evil']);
    fs.writeFileSync(st('calls'), '');
    const c2 = run({ bridges_restore: '222222222222' });
    assert.equal(JSON.parse(fs.readFileSync(data('.bridges-restore.json'), 'utf8')).result, 'invalid');
    assert.doesNotMatch(c2, / stop /);
    assert.equal(fs.readFileSync(data('bridges/hs/data/000009.sst'), 'utf8'), 'restored\n');
  });
});
