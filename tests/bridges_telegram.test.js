'use strict';

// Messenger bridges, stage 7b — Telegram (docs/feature-messenger-bridges.md, "Telegram"; gc.bridges version 11): the
// configuration of mautrix-telegram v0.2610.0 (every key checked against tests/fixtures/bridges/keys-mautrix-telegram-
// 0.2610.0.json), the administrator's application id (encrypted, never returned, without it no Telegram), the links by
// number, code and password and by QR code against a stand-in Telegram bridge (tests/helpers/fake-bridge.js, network
// 'telegram') — the password goes to the bridge and nowhere else —, channels, supergroups, bots, "Saved Messages",
// member counts from the bridge's own database (bridgedb.js), files too large for the homeserver, and "Erkennen" by the
// own Telegram (the user id, never taken for a number). Nothing here starts a container; all ids, names and numbers are
// made up.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, teardown } = require('./helpers/setup');
const { startFakeBridge } = require('./helpers/fake-bridge');
const { startFakeHomeserver } = require('./helpers/fake-homeserver');

const config = require('../src/services/bridges/config');
const images = require('../src/services/bridges/images');
const KEYS = require('./fixtures/bridges/keys-mautrix-telegram-0.2610.0.json');
const SECRETS = { asToken: 'a'.repeat(43), hsToken: 'b'.repeat(43), provisionSecret: 'c'.repeat(43), coreAsToken: 'd'.repeat(43), coreHsToken: 'e'.repeat(43), puppetAsToken: 'f'.repeat(43), puppetHsToken: 'g'.repeat(43) };
const S = 'gc.internal';
// made up — an application id of the right form, not a real one
const APP = { apiId: 20000001, apiHash: '0123456789abcdef0123456789abcdef' };
const PASSWORD = 'Wanderweg-Eifel-7';
const TG_KIM = '611000001';
const TG_BEN = '611000002';

let bridges, au, hostApi, ctx, settings, profile, db, hsMod, appservice, annaId, benId, adminId, hs, bridge;
const PLUGIN = { id: 'bridge-demo', manifest: { permissions: { bridges: true } } };
const call = (api, args) => hostApi.handle(PLUGIN, api, args);
const asPerson = (userId, write, fn) => ctx.run(PLUGIN.id, userId, write, fn);
const marker = (n) => fs.writeFileSync(au.STATE_FILE, JSON.stringify({ checked_at: new Date().toISOString(), action: 'none', mode: 'manual', ok: true, update_sh: n }));

function keyPaths(o, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.push(p);
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...keyPaths(v, p));
  }
  return out;
}

describe('the configuration of mautrix-telegram v0.2610.0', () => {
  const model = config.bridgeModel('telegram', SECRETS, { telegramApp: APP });
  const animated = config.bridgeModel('telegram', SECRETS, { telegramApp: APP, history: true, animatedStickers: true });

  it('writes only keys the pinned version documents', () => {
    assert.equal(KEYS.versions['mautrix-telegram'], images.IMAGES.telegram.version, 'the keys were taken from the pinned version');
    const known = new Set(KEYS.keys);
    const free = ['bridge.permissions.', 'double_puppet.servers.', 'double_puppet.secrets.'];
    for (const m of [model, animated]) {
      for (const p of keyPaths(m)) {
        if (free.some((f) => p.startsWith(f))) continue;
        assert.ok(known.has(p), `${p} is not in the example configuration of mautrix-telegram ${KEYS.versions['mautrix-telegram']}`);
      }
    }
  });

  it('the settings of the draft: names, no address book, "GateControl" in Devices, 15 chats, 100 members, no spaces', () => {
    const n = model.network;
    assert.equal(n.displayname_template, '{{.FullName}}');
    assert.equal(n.contact_names, false);
    assert.equal(n.contact_avatars, false);
    assert.equal(n.device_info.device_model, 'GateControl');
    assert.equal(n.sync.create_limit, 15);
    assert.equal(n.member_list.max_initial_sync, 100);
    assert.equal(n.member_list.sync_broadcast_channels, false);
    assert.equal(n.bridge_communities, false);
    assert.equal(n.takeout.dialog_sync, false);
    assert.equal(n.saved_message_avatar, '', 'no picture from another server');
    assert.equal(model.logging.min_level, 'warn');
    assert.equal(model.bridge.view_limited_media, true);
    assert.deepEqual(model.bridge.permissions, { [S]: 'user' });
    assert.equal(model.appservice.hostname, '/run/bruecken/telegram.sock');
    assert.equal(model.appservice.address, `http://bruecken-telegram-relay:${config.RELAY_PORT.telegram}`);
    assert.match(model.database.uri, /^file:\/data\/telegram\.db\?_txlock=immediate$/);
  });

  it('animated stickers: a still picture by default, a GIF with the administrator\'s switch', () => {
    assert.deepEqual(model.network.animated_sticker, { target: 'png', convert_from_webm: false });
    assert.equal(animated.network.animated_sticker.target, 'gif');
  });

  it('the application id only in its own file, never the example values; without it no Telegram file', () => {
    assert.equal(model.network.api_id, APP.apiId);
    assert.equal(model.network.api_hash, APP.apiHash);
    assert.throws(() => config.bridgeModel('telegram', SECRETS), /application id/);
    const f = config.files(SECRETS, ['whatsapp', 'telegram'], { telegramApp: APP });
    assert.deepEqual(Object.keys(f).sort(), ['hs/config/tuwunel.toml', 'telegram/config/config.yaml', 'whatsapp/config/config.yaml']);
    assert.match(f['telegram/config/config.yaml'], new RegExp(APP.apiHash));
    assert.doesNotMatch(f['whatsapp/config/config.yaml'] + f['hs/config/tuwunel.toml'], new RegExp(APP.apiHash));
    assert.match(config.bridgeYaml(model), /^ {4}displayname_template: "\{\{\.FullName\}\}"$/m);
  });
});

describe('the service with Telegram', () => {
  before(async () => {
    await setup();
    process.env.GC_BRIDGES_PREVIEW = '1';
    bridges = require('../src/services/bridges');
    au = require('../src/services/autoUpdate');
    hostApi = require('../src/services/plugins/hostApi');
    ctx = require('../src/services/plugins/personContext');
    settings = require('../src/services/settings');
    profile = require('../src/services/profile');
    hsMod = require('../src/services/bridges/hs');
    appservice = require('../src/services/bridges/appservice');
    db = require('../src/db/connection').getDb();
    const add = db.prepare('INSERT INTO users (username, password_hash, role, enabled, language, display_name) VALUES (?, ?, ?, 1, ?, ?)');
    annaId = Number(add.run('anna-telegram', 'x', 'user', 'de', 'Anna').lastInsertRowid);
    benId = Number(add.run('ben-telegram', 'x', 'user', 'de', 'Ben').lastInsertRowid);
    adminId = Number(add.run('max-admin', 'x', 'admin', 'de', 'Max Berger').lastInsertRowid);
    marker(10);
    bridges.configure({ enabled: true, networks: { whatsapp: true, telegram: true } }, {});
    assert.equal(await bridges.start(), true);
    const secrets = bridges.readSecrets();
    hs = await startFakeHomeserver({ socket: hsMod.socketOf(bridges.dir()), asToken: secrets.coreAsToken, coreSocket: appservice.socketOf(bridges.dir()), hsToken: secrets.coreHsToken });
    bridge = await startFakeBridge({ socket: path.join(bridges.dir(), 'run', 'telegram.sock'), secret: secrets.provisionSecret, network: 'telegram' });
  });
  after(async () => {
    await bridges.stop();
    if (hs) await hs.close();
    if (bridge) await bridge.close();
    try { fs.rmSync(au.STATE_FILE, { force: true }); } catch { /* gone */ }
    delete process.env.GC_BRIDGES_PREVIEW;
    teardown();
  });
  beforeEach(() => { marker(10); bridges._reset(); bridges._runtime.wake = () => {}; });

  it('without the application id: not started, needs "app", nobody can link', async () => {
    const st = bridges.status();
    assert.equal(st.version, 11);
    const tg = st.networks.find((n) => n.id === 'telegram');
    assert.equal(tg.needs, 'app');
    assert.equal(tg.state, 'stopped');
    assert.deepEqual(tg.flows, ['qr', 'phone']);
    assert.deepEqual(tg.history, { maxDays: null, phoneConfirms: false });
    assert.deepEqual(st.telegramApp, { set: false, setAt: null, setBy: null });
    assert.deepEqual(bridges.wanted(), ['whatsapp']);
    au.syncConfigFile();
    assert.doesNotMatch(JSON.parse(fs.readFileSync(au.CONFIG_FILE, 'utf8')).bridges_images, /telegram/);
    await assert.rejects(asPerson(annaId, false, () => call('bridges.login.flows', { userId: annaId, network: 'telegram' })), (e) => e.code === 'ERR_BRIDGES_UNAVAILABLE' && e.reason === 'no_app');
  });

  it('the application id: refused when malformed or the bridge\'s example, never echoed, kept encrypted, said only as { set, setAt, setBy }', () => {
    const bad = [{ apiId: 123, apiHash: APP.apiHash }, { apiId: APP.apiId, apiHash: 'zz' }, { apiId: 12345, apiHash: APP.apiHash },
      { apiId: APP.apiId, apiHash: 'tjyd5yge35lbodk1xwzw2jstp90k55qz' }, { apiId: APP.apiId, apiHash: APP.apiHash, extra: 1 }, 'x', []];
    for (const v of bad) {
      assert.throws(() => bridges.configure({ telegramApp: v }, {}), (e) => e.code === 'ERR_INVALID' && !e.message.includes(APP.apiHash) && !e.message.includes(String(APP.apiId)), JSON.stringify(v));
    }
    assert.equal(bridges.status().telegramApp.set, false);
    // an administrator enters it (the hash as the form may send it: upper case, spaces, the id as text)
    const st = bridges.configure({ telegramApp: { apiId: String(APP.apiId), apiHash: ` ${APP.apiHash.toUpperCase()} ` } }, { actor: { id: adminId, name: 'Max Berger' }, pluginId: PLUGIN.id });
    assert.equal(st.telegramApp.set, true);
    assert.equal(st.telegramApp.setBy, 'Max Berger');
    assert.ok(Date.parse(st.telegramApp.setAt) > 0);
    assert.doesNotMatch(JSON.stringify(st), new RegExp(`${APP.apiHash}|${APP.apiId}`), 'never in the status');
    // on disk: next to the master key, encrypted, 0600
    const file = path.join(bridges.dir(), 'secrets.json');
    const raw = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(raw, new RegExp(`${APP.apiHash}|${APP.apiId}`));
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['key', 'telegramApp']);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // the activity log: that it was entered and by whom, never the value
    const act = db.prepare("SELECT message, details FROM activity_log WHERE event_type = 'bridges_changed' ORDER BY id DESC LIMIT 1").get();
    assert.match(act.message, /Telegram-Anwendung hinterlegt/);
    assert.doesNotMatch(JSON.stringify(act), new RegExp(`${APP.apiHash}|${APP.apiId}`));
    // now Telegram runs: its configuration holds the id, the other files do not
    assert.deepEqual(bridges.wanted(), ['whatsapp', 'telegram']);
    au.syncConfigFile();
    assert.match(JSON.parse(fs.readFileSync(au.CONFIG_FILE, 'utf8')).bridges_images, /telegram=dock\.mau\.dev\/mautrix\/telegram:v0\.2610\.0@sha256:ed3f3b39/);
    const yml = fs.readFileSync(path.join(bridges.dir(), 'telegram', 'config', 'config.yaml'), 'utf8');
    assert.match(yml, new RegExp(`api_id: ${APP.apiId}`));
    assert.equal(fs.statSync(path.join(bridges.dir(), 'telegram', 'config', 'config.yaml')).mode & 0o777, 0o600);
    assert.equal(bridges.status().networks.find((n) => n.id === 'telegram').needs, null);
    // a restore of the master key keeps it; a backup carries it encrypted only
    bridges.writeMasterKey(bridges.masterKey());
    assert.equal(bridges.status().telegramApp.set, true);
  });

  it('the backup carries the application id encrypted, a restore puts it back', async () => {
    const bk = require('../src/services/bridges/backup');
    const part = await bk.exportPart();
    try {
      assert.ok(part.telegram_app && typeof part.telegram_app.enc === 'string');
      assert.doesNotMatch(JSON.stringify(part), new RegExp(`${APP.apiHash}|"${APP.apiId}"`));
      assert.deepEqual(bk.validate(part), []);
      assert.ok(bk.encryptedFields(part).some(([w]) => /Telegram/.test(w)));
      // removed here, put back by the restore
      bridges.configure({ telegramApp: null }, { actor: { id: adminId, name: 'Max Berger' } });
      assert.equal(bridges.status().telegramApp.set, false);
      assert.deepEqual(bridges.wanted(), ['whatsapp']);
      await bk.restorePart({ ...part, snapshot: null }, { userIdByName: (n) => db.prepare('SELECT id FROM users WHERE username = ?').get(n)?.id });
      assert.equal(bridges.status().telegramApp.set, true);
      assert.equal(bridges.status().telegramApp.setBy, 'Max Berger');
    } finally { await part.release(); }
  });

  it('the history: what the person chose (Telegram brings it from its server at any time)', () => {
    settings.set('bridges.history_people', JSON.stringify({ [annaId]: -1 }));
    assert.equal(bridges.historyOf(annaId, 'telegram'), -1);
    settings.set('bridges.history_people', '{}');
    assert.equal(bridges.historyOf(annaId, 'telegram'), 30);
  });

  it('by number, code and password: only QR and phone are offered, our own words, the password goes to the bridge and nowhere else', async () => {
    const flows = await asPerson(annaId, false, () => call('bridges.login.flows', { userId: annaId, network: 'telegram' }));
    assert.deepEqual(flows.map((f) => f.id), ['phone', 'qr'], 'never bot or manual');
    for (const f of ['bot', 'manual']) {
      await assert.rejects(asPerson(annaId, true, () => call('bridges.login.start', { userId: annaId, network: 'telegram', flowId: f })), (e) => e.code === 'ERR_INVALID');
    }
    bridge.tgPassword = PASSWORD;
    bridge.nextTgId = '4915100000000'; // a user id that looks like a number: never taken for one
    bridge.nextNumber = null; // and no number in the profile
    const s1 = await asPerson(annaId, true, () => call('bridges.login.start', { userId: annaId, network: 'telegram', flowId: 'phone' }));
    assert.equal(s1.step.type, 'user_input');
    assert.deepEqual(s1.step.fields.map((f) => [f.type, f.name, f.description]), [['phone_number', '', '']]);
    const fid = s1.step.fields[0].id;
    const step = (s, input) => asPerson(annaId, true, () => call('bridges.login.step', { userId: annaId, network: 'telegram', processId: s.processId, stepId: s.step.id, kind: 'user_input', input }));
    const s2 = await step(s1, { [fid]: '+4915100000000' });
    assert.deepEqual(s2.step.fields.map((f) => f.type), ['2fa_code']);
    assert.ok(!s2.step.retry);
    assert.doesNotMatch(JSON.stringify(s2), /Telegram app on your phone/, 'not the bridge\'s text');
    const wrong = await step(s2, { [s2.step.fields[0].id]: '11111' });
    assert.equal(wrong.step.retry, true, 'a wrong code: asked again');
    const s3 = await step(wrong, { [wrong.step.fields[0].id]: '47000' });
    assert.deepEqual(s3.step.fields.map((f) => f.type), ['password']);
    assert.doesNotMatch(JSON.stringify(s3), /two-factor/);
    const wrongPw = await step(s3, { [s3.step.fields[0].id]: 'falsch' });
    assert.equal(wrongPw.step.retry, true);
    assert.doesNotMatch(JSON.stringify(wrongPw), /official Telegram app/);
    const done = await step(wrongPw, { [wrongPw.step.fields[0].id]: PASSWORD });
    assert.equal(done.step.type, 'complete');
    assert.equal(done.step.instructions, 'Telegram is linked.');
    assert.doesNotMatch(JSON.stringify(done), /4915100000000|Lena/, 'the bridge\'s last words name the person and the id — not passed on');
    assert.deepEqual(bridge.tgPasswords, ['falsch', PASSWORD], 'the bridge got it');
    // … and nothing else: no table, no setting, no file of the bridges' folder holds it
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    for (const t of tables) assert.doesNotMatch(JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all()), new RegExp(PASSWORD), `table ${t}`);
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.isFile() ? [path.join(d, e.name)] : []));
    for (const f of walk(bridges.dir())) assert.doesNotMatch(fs.readFileSync(f, 'latin1'), new RegExp(PASSWORD), f);
    // the login: the person's number as its name, the user id never taken for a number
    const mine = await asPerson(annaId, false, () => call('bridges.logins', { userId: annaId, network: 'telegram' }));
    assert.equal(mine.length, 1);
    assert.equal(mine[0].name, '');
    assert.doesNotMatch(JSON.stringify(mine), /4915100000000/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM user_bridge_accounts WHERE user_id = ? AND network = 'telegram'").get(annaId).n, 1, 'the account id, as a keyed hash');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM user_bridge_selves WHERE user_id = ? AND network = 'telegram'").get(annaId).n, 0, 'no number: the id is none');
    await asPerson(annaId, true, () => call('bridges.logout', { userId: annaId, network: 'telegram', loginId: mine[0].id }));
    bridge.tgPassword = null;
  });

  it('by QR code: tg://login, a new code when it runs out, then the password', async () => {
    bridge.tgPassword = PASSWORD;
    bridge.nextTgId = '611000050';
    bridge.nextNumber = '+4915100000000';
    const qr = await asPerson(annaId, true, () => call('bridges.login.start', { userId: annaId, network: 'telegram', flowId: 'qr' }));
    assert.equal(qr.step.type, 'display_and_wait');
    assert.match(qr.step.display.data, /^tg:\/\/login\?token=/);
    assert.doesNotMatch(qr.step.instructions, /Scan the QR code on your phone/);
    bridge.refresh(qr.processId);
    const again = await asPerson(annaId, true, () => bridges.login.step(annaId, 'telegram', qr.processId, qr.step.id, 'display_and_wait', undefined, { pollMs: 2000 }));
    assert.notEqual(again.step.display.data, qr.step.display.data);
    bridge.confirm(qr.processId);
    const pw = await asPerson(annaId, true, () => bridges.login.step(annaId, 'telegram', again.processId, again.step.id, 'display_and_wait', undefined, { pollMs: 2000 }));
    assert.equal(pw.step.type, 'user_input');
    assert.deepEqual(pw.step.fields.map((f) => f.type), ['password']);
    const done = await asPerson(annaId, true, () => call('bridges.login.step', { userId: annaId, network: 'telegram', processId: pw.processId, stepId: pw.step.id, kind: 'user_input', input: { [pw.step.fields[0].id]: PASSWORD } }));
    assert.equal(done.step.type, 'complete');
    const mine = await asPerson(annaId, false, () => call('bridges.logins', { userId: annaId, network: 'telegram' }));
    assert.equal(mine[0].name, '+4915100000000', 'the person\'s own number (the profile phone), theirs to see');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM user_bridge_selves WHERE user_id = ? AND network = 'telegram'").get(annaId).n, 1, 'the number of the profile phone');
    await asPerson(annaId, true, () => call('bridges.logout', { userId: annaId, network: 'telegram', loginId: mine[0].id }));
    bridge.tgPassword = null;
  });

  it('Erkennen by the own Telegram: the user id — strong, only with the consent', async () => {
    bridge.nextTgId = TG_BEN;
    bridge.nextNumber = null;
    const link = async (userId) => {
      const s1 = await asPerson(userId, true, () => call('bridges.login.start', { userId, network: 'telegram', flowId: 'phone' }));
      const s2 = await asPerson(userId, true, () => call('bridges.login.step', { userId, network: 'telegram', processId: s1.processId, stepId: s1.step.id, kind: 'user_input', input: { [s1.step.fields[0].id]: '+4915100000000' } }));
      await asPerson(userId, true, () => call('bridges.login.step', { userId, network: 'telegram', processId: s2.processId, stepId: s2.step.id, kind: 'user_input', input: { [s2.step.fields[0].id]: '47000' } }));
      await asPerson(userId, false, () => call('bridges.logins', { userId, network: 'telegram' }));
    };
    await link(benId);
    bridge.nextTgId = '611000099';
    await link(annaId);
    bridge.contacts = [{ tg: TG_BEN, name: 'Ben', username: 'ben_wandert' }, { tg: TG_KIM, name: 'Kim' }];
    let m = await asPerson(annaId, false, () => call('bridges.matchAccounts', { userId: annaId, network: 'telegram' }));
    assert.deepEqual(m.matches, [], 'Ben has not agreed');
    await asPerson(benId, true, () => call('bridges.recognition.set', { userId: benId, network: 'telegram', allowed: true }));
    bridges._reset();
    m = await asPerson(annaId, false, () => call('bridges.matchAccounts', { userId: annaId, network: 'telegram' }));
    assert.equal(m.matches.length, 1);
    assert.deepEqual([m.matches[0].userId, m.matches[0].strength, m.matches[0].via], [benId, 'strong', 'own_telegram']);
    assert.doesNotMatch(JSON.stringify(m), new RegExp(`${TG_BEN}|ben_wandert`), 'never the id or the user name');
  });

  describe('chats over Telegram (stand-in homeserver, the bridge\'s database)', () => {
    const BOT = `@telegrambot:${S}`;
    const KIM = `@telegram_${TG_KIM}:${S}`;
    const anna = () => `@gc_${annaId}:${S}`;
    let n = 0;
    const ev = (room, sender, type, content, extra = {}) => ({ room_id: room, sender, type, content, event_id: `$tg${++n}`, origin_server_ts: Date.now(), ...extra });
    const bridgeState = (id, dm) => ({ type: 'm.bridge', state_key: 'x', content: { bridgebot: BOT, protocol: { id: 'telegram', displayname: 'Telegram' }, channel: { id }, ...(dm ? { 'com.beeper.room_type': 'dm', 'com.beeper.room_type.v2': 'dm' } : {}) } });
    const pulled = () => call('bridges.events.pull', {}).then((r) => r.events);
    const ack = () => call('bridges.events.ack', { upTo: 1e9 });
    let tgdb;
    async function open(room, state) {
      hs.room(room, { state, timeline: [], members: [anna()] });
      const r = await hs.push(`open-${room}`, { events: [ev(room, anna(), 'm.room.member', { membership: 'join' }, { state_key: anna() })] });
      assert.equal(r.status, 200);
      const evs = await pulled();
      await ack();
      return evs.find((e) => e.type === 'chat');
    }
    before(() => {
      // the bridge's own database, as far as bridgedb.js reads it (bridgev2 tables portal and ghost)
      const Database = require('better-sqlite3');
      const file = path.join(bridges.dir(), 'telegram', 'data', 'telegram.db');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      tgdb = new Database(file);
      tgdb.pragma('journal_mode = WAL');
      tgdb.exec(`CREATE TABLE portal (bridge_id TEXT NOT NULL, id TEXT NOT NULL, receiver TEXT NOT NULL, mxid TEXT, other_user_id TEXT, name TEXT NOT NULL DEFAULT '', metadata jsonb NOT NULL, PRIMARY KEY (bridge_id, id, receiver));
        CREATE TABLE ghost (bridge_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', is_bot BOOLEAN NOT NULL, identifiers jsonb NOT NULL DEFAULT '[]', metadata jsonb NOT NULL DEFAULT '{}', PRIMARY KEY (bridge_id, id));`);
    });
    after(() => { if (tgdb) tgdb.close(); });
    beforeEach(() => {
      db.exec('DELETE FROM bridge_inbox; DELETE FROM bridge_rooms; DELETE FROM bridge_txns; DELETE FROM bridge_backlog; DELETE FROM bridge_media;');
      hs.rooms.clear();
      hs.requests.length = 0;
    });
    const portal = (id, mxid, meta, other = null) => tgdb.prepare('INSERT OR REPLACE INTO portal (bridge_id, id, receiver, mxid, other_user_id, metadata) VALUES (?, ?, ?, ?, ?, ?)').run('telegram', id, '611000099', mxid, other, JSON.stringify(meta));

    it('a person, a small group, a supergroup with its member count — the ids stay here', async () => {
      portal('chat:4001', '!tgsmall:gc.internal', { member_count: 12 });
      portal('channel:5001', '!tgsuper:gc.internal', { is_supergroup: true, member_count: 340 });
      const d = await open('!tgdm:gc.internal', [bridgeState(`user:${TG_KIM}`, true)]);
      assert.equal(d.network, 'telegram');
      assert.equal(d.chat.kind, 'direct');
      assert.ok(!d.chat.bot);
      const g = await open('!tgsmall:gc.internal', [bridgeState('chat:4001'), { type: 'm.room.name', state_key: '', content: { name: 'Familie' } }]);
      assert.equal(g.chat.kind, 'group');
      assert.equal(g.chat.members, 12);
      const sg = await open('!tgsuper:gc.internal', [bridgeState('channel:5001'), { type: 'm.room.name', state_key: '', content: { name: 'Wandergruppe Eifel' } }]);
      assert.equal(sg.chat.kind, 'group');
      assert.equal(sg.chat.channel, false, 'a supergroup is no channel');
      assert.equal(sg.chat.members, 340, 'what Telegram counts, not the 100 members in the room');
      assert.doesNotMatch(JSON.stringify([d, g, sg]), /4001|5001|611000001/);
    });

    it('a channel: its own account is in the room — chat.channel, read-only, its posts by the channel', async () => {
      const room = '!tgchan:gc.internal';
      const CH = `@telegram_channel-6001:${S}`;
      const state = [bridgeState('channel:6001'), { type: 'm.room.name', state_key: '', content: { name: 'Wetter Musterland' } },
        { type: 'm.room.power_levels', state_key: '', content: { users: { [CH]: 100, [BOT]: 100 }, users_default: 0, events_default: 50 } },
        { type: 'm.room.member', state_key: CH, content: { membership: 'join', displayname: 'Wetter Musterland' } }];
      const c = await open(room, state);
      assert.equal(c.chat.channel, true);
      assert.equal(c.chat.readOnly, true);
      await hs.push('t-post', { events: [ev(room, CH, 'm.room.message', { msgtype: 'm.text', body: 'Unwetterwarnung für morgen früh' })] });
      const evs = await pulled();
      assert.deepEqual(evs[0].sender, { channel: true, system: true });
      assert.equal(evs[0].kind, 'text');
      await ack();
    });

    it('a bot is a direct chat with chat.bot; "Saved Messages" is not shown at all', async () => {
      tgdb.prepare('INSERT OR REPLACE INTO ghost (bridge_id, id, is_bot) VALUES (?, ?, ?)').run('telegram', '622000001', 1);
      portal('user:622000001', '!tgbot:gc.internal', {}, '622000001');
      const b = await open('!tgbot:gc.internal', [bridgeState('user:622000001', true), { type: 'm.room.name', state_key: '', content: { name: 'Paketdienst-Bot' } }]);
      assert.equal(b.chat.kind, 'direct');
      assert.equal(b.chat.bot, true);
      // Anna's own Telegram (user id 611000099, linked above): her "Saved Messages"
      const room = '!tgsaved:gc.internal';
      hs.room(room, { state: [bridgeState('user:611000099', true)], timeline: [], members: [anna()] });
      await hs.push('t-saved', { events: [ev(room, anna(), 'm.room.member', { membership: 'join' }, { state_key: anna() })] });
      await hs.push('t-saved2', { events: [ev(room, `@telegram_611000099:${S}`, 'm.room.message', { msgtype: 'm.text', body: 'Notiz an mich' })] });
      const evs = await pulled();
      assert.deepEqual(evs, [], 'nothing of it');
      assert.equal(db.prepare('SELECT state FROM bridge_rooms WHERE room_id = ?').get(room).state, 'left');
    });

    it('a file too large for the homeserver, media the bridge cannot carry: our hint, not its English text or the file\'s name', async () => {
      const room = '!tgfiles:gc.internal';
      await open(room, [bridgeState(`user:${TG_KIM}`, true)]);
      await hs.push('t-files', { events: [
        ev(room, KIM, 'm.room.message', { msgtype: 'm.notice', body: 'Too large file urlaub-2026.mp4 (812.40 MiB)' }),
        ev(room, KIM, 'm.room.message', { msgtype: 'm.notice', body: 'Stories are not yet supported. Open Telegram to view.', 'fi.mau.telegram.unsupported': true }),
        ev(room, KIM, 'm.room.message', { msgtype: 'm.notice', body: 'Failed to transfer media. Check Telegram app.' }),
      ] });
      const evs = await pulled();
      assert.deepEqual(evs.map((e) => [e.kind, !!e.tooLarge]), [['unsupported', true], ['unsupported', false], ['unsupported', false]]);
      assert.doesNotMatch(JSON.stringify(evs), /urlaub|Stories|Check Telegram/);
      await ack();
    });
  });
});
