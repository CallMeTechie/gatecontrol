'use strict';

// Messenger bridges, stage 7a — Signal (docs/feature-messenger-bridges.md, "Signal"; gc.bridges version 10): the
// configuration of mautrix-signal v0.2610.0 (every key checked against tests/fixtures/bridges/keys-mautrix-signal-
// 0.2610.0.json), the pins and compose services, what differs per network in the service (flows, the update.sh marker,
// at most 30 days of history, our own login texts, no account id as a name), the link against a stand-in Signal bridge
// (tests/helpers/fake-bridge.js, network 'signal'), groups, disappearing messages, stickers and view-once pictures from
// the stand-in homeserver, and "Erkennen" by the own Signal (the fixed account id, never a number or the id itself).
// Nothing here starts a container; all ids, names and numbers are made up.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, teardown } = require('./helpers/setup');
const { startFakeBridge } = require('./helpers/fake-bridge');
const { startFakeHomeserver } = require('./helpers/fake-homeserver');

const ROOT = path.join(__dirname, '..');
const config = require('../src/services/bridges/config');
const images = require('../src/services/bridges/images');
const KEYS = require('./fixtures/bridges/keys-mautrix-signal-0.2610.0.json');
const SECRETS = { asToken: 'a'.repeat(43), hsToken: 'b'.repeat(43), provisionSecret: 'c'.repeat(43), coreAsToken: 'd'.repeat(43), coreHsToken: 'e'.repeat(43), puppetAsToken: 'f'.repeat(43), puppetHsToken: 'g'.repeat(43), signalAsToken: 'h'.repeat(43), signalHsToken: 'i'.repeat(43), telegramAsToken: 'j'.repeat(43), telegramHsToken: 'k'.repeat(43) };
const S = 'gc.internal';
const ACI_KIM = '3b1d2c4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
const ACI_BEN = '7c6b5a49-3827-4615-a4b3-c2d1e0f9a8b7';
const GROUP_ID = 'R3J1cHBlLWRlcy1TcG9ydHZlcmVpbnMtQmxhdS1XZWk='; // 44 characters of Base64, made up

let bridges, au, hostApi, ctx, settings, profile, db, hsMod, appservice, annaId, benId, hs, bridge;
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

describe('the configuration of mautrix-signal v0.2610.0', () => {
  const model = config.bridgeModel('signal', SECRETS);
  const withHistory = config.bridgeModel('signal', SECRETS, { history: true });

  it('writes only keys the pinned version documents', () => {
    assert.equal(KEYS.versions['mautrix-signal'], images.IMAGES.signal.version, 'the keys were taken from the pinned version');
    const known = new Set(KEYS.keys);
    const free = ['bridge.permissions.', 'double_puppet.servers.', 'double_puppet.secrets.'];
    for (const m of [model, withHistory]) {
      for (const p of keyPaths(m)) {
        if (free.some((f) => p.startsWith(f))) continue;
        assert.ok(known.has(p), `${p} is not in the example configuration of mautrix-signal ${KEYS.versions['mautrix-signal']}`);
      }
    }
  });

  it('names a contact by the Signal profile only, keeps numbers and address book pictures out, and is "GateControl" in Linked devices', () => {
    assert.equal(model.network.displayname_template, '{{or .ProfileName ""}}');
    assert.equal(model.network.number_in_topic, false);
    assert.equal(model.network.use_contact_avatars, false);
    assert.equal(model.network.device_name, 'GateControl');
    assert.equal(model.network.note_to_self_avatar, '', 'no picture from another server');
    assert.equal(model.bridge.view_limited_media, true, 'a view-once picture comes marked, not with an English line');
    assert.equal(model.bridge.personal_filtering_spaces, false, 'no spaces');
    assert.equal(model.logging.min_level, 'warn');
    assert.equal(model.encryption.allow, false);
    assert.deepEqual(model.bridge.permissions, { [S]: 'user' });
  });

  it('its own socket, relay, database and namespace — next to WhatsApp\'s', () => {
    assert.equal(model.appservice.hostname, '/run/bruecken/signal.sock');
    assert.equal(model.appservice.address, `http://bruecken-signal-relay:${config.RELAY_PORT.signal}`);
    assert.equal(model.appservice.username_template, 'signal_{{.}}');
    assert.equal(model.appservice.bot.username, 'signalbot');
    assert.match(model.database.uri, /^file:\/data\/signal\.db\?_txlock=immediate$/);
    const hs = config.hsModel(SECRETS, ['whatsapp', 'signal']);
    assert.deepEqual(hs.appservices.signal.users, [{ exclusive: true, regex: '@signal_.*:gc\\.internal' }]);
    assert.equal(hs.appservices.signal.url, `http://bruecken-signal-relay:${config.RELAY_PORT.signal}`);
    assert.equal(new Set(Object.values(config.RELAY_PORT)).size, Object.keys(config.RELAY_PORT).length, 'every relay its own port');
    // the YAML holds the template as one string
    assert.match(config.bridgeYaml(model), /^ {4}displayname_template: "\{\{or \.ProfileName \\"\\"\}\}"$/m);
  });

  it('history: the transfer archive only while an administrator allows history (backfill.enabled asks the phone for it)', () => {
    assert.deepEqual(model.backfill, { enabled: false });
    assert.equal(withHistory.backfill.enabled, true);
    assert.deepEqual(withHistory.backfill.queue, { enabled: false });
    assert.ok(!('history_sync' in withHistory.network), 'WhatsApp\'s keys are not written for Signal');
  });

  it('the files: whatsapp and signal side by side; another network is refused', () => {
    const f = config.files(SECRETS, ['whatsapp', 'signal']);
    assert.deepEqual(Object.keys(f).sort(), ['hs/config/tuwunel.toml', 'signal/config/config.yaml', 'whatsapp/config/config.yaml']);
    assert.throws(() => config.bridgeModel('icq', SECRETS), /unknown network/);
  });
});

describe('the pins and the release docker-compose.yml', () => {
  it('Signal and Telegram pinned by version and digest (checked against the registry), Telegram in the file already', () => {
    assert.equal(images.ref('signal'), 'dock.mau.dev/mautrix/signal:v0.2610.0@sha256:39afa721aa69472b2e91c75bd7d81a739e47f7e480fc0ff5ac8247af28eb2d0a');
    assert.equal(images.ref('telegram'), 'dock.mau.dev/mautrix/telegram:v0.2610.0@sha256:ed3f3b39289fae425a875311d8875729271c24f88ba03209bd1bfbaf31e6c78f');
    assert.equal(images.IMAGES['signal-relay'].digest, images.IMAGES['whatsapp-relay'].digest);
  });

  for (const f of ['docker-compose.yml', 'deploy/docker-compose.yml']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const block = (name) => {
      const m = new RegExp(`^  ${name}:\\n((?:(?:    .*|\\s*)\\n)+)`, 'm').exec(src);
      assert.ok(m, `${f}: service ${name}`);
      return m[1];
    };
    it(`${f}: bruecken-signal and its relay like WhatsApp's — no port, its own socket, the program itself`, () => {
      const b = block('bruecken-signal');
      assert.match(b, /command: \["\/usr\/bin\/mautrix-signal", "--config", "\/etc\/bruecken\/config\.yaml", "--no-update"\]/);
      assert.match(b, /^ {4}networks:\n {6}- bruecken-aussen\n {4}\S/m);
      assert.match(b, /\/signal\/config:\/etc\/bruecken:ro$/m);
      assert.match(b, /\/signal\/data:\/data$/m);
      assert.match(b, /^ {4}mem_limit: 384m$/m);
      assert.match(b, /test -S|"-S", "\/run\/bruecken\/signal\.sock"/);
      const r = block('bruecken-signal-relay');
      assert.ok(r.includes(`command: ["TCP-LISTEN:${config.RELAY_PORT.signal},fork,reuseaddr", "UNIX-CONNECT:${config.RUN_DIR}/signal.sock"]`));
      assert.match(r, /^ {4}networks:\n {6}- bruecken-intern\n {4}\S/m);
      assert.match(block('bruecken-telegram'), /command: \["\/usr\/bin\/mautrix-telegram", "--config", "\/etc\/bruecken\/config\.yaml", "--no-update"\]/);
      assert.ok(block('bruecken-telegram-relay').includes(`TCP-LISTEN:${config.RELAY_PORT.telegram},`));
    });
  }

  it('update.sh (marker 10) knows the repositories of Signal and Telegram', () => {
    const s = fs.readFileSync(path.join(ROOT, 'update.sh'), 'utf8');
    assert.match(s, /^# gc-update-sh: 10$/m);
    assert.match(s, /signal\) echo 'dock\.mau\.dev\/mautrix\/signal' ;;/);
    assert.match(s, /telegram\) echo 'dock\.mau\.dev\/mautrix\/telegram' ;;/);
    assert.match(s, /core-relay\|whatsapp-relay\|signal-relay\|telegram-relay\) echo 'alpine\/socat' ;;/);
    assert.equal(s, fs.readFileSync(path.join(ROOT, 'src/services/systemSetup/templates/update.sh'), 'utf8'), 'the copy in the image is the same');
  });
});

describe('the service with Signal', () => {
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
    annaId = Number(add.run('anna-signal', 'x', 'user', 'de', 'Anna').lastInsertRowid);
    benId = Number(add.run('ben-signal', 'x', 'user', 'de', 'Ben').lastInsertRowid);
    marker(10);
    bridges.configure({ enabled: true, networks: { whatsapp: true, signal: true } }, {});
    assert.equal(await bridges.start(), true);
    const secrets = bridges.readSecrets();
    hs = await startFakeHomeserver({ socket: hsMod.socketOf(bridges.dir()), asToken: secrets.coreAsToken, coreSocket: appservice.socketOf(bridges.dir()), hsToken: secrets.coreHsToken });
    bridge = await startFakeBridge({ socket: path.join(bridges.dir(), 'run', 'signal.sock'), secret: secrets.provisionSecret, network: 'signal' });
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

  it('status (version 10 and newer): what each network offers, and one switch for animated stickers', () => {
    const st = bridges.status();
    assert.ok(st.version >= 10);
    const sg = st.networks.find((n) => n.id === 'signal');
    assert.deepEqual(sg.flows, ['qr']);
    assert.deepEqual(sg.history, { maxDays: 30, phoneConfirms: true });
    assert.equal(sg.wantVersion, '0.2610.0');
    assert.equal(sg.scriptNeeded, 10);
    assert.deepEqual(st.stickers, { animated: false }, 'off by default: a still picture');
    bridges.configure({ animatedStickers: true }, { actor: { id: 1, name: 'admin' } });
    assert.deepEqual(bridges.status().stickers, { animated: true });
    bridges.configure({ animatedStickers: false }, {});
    assert.equal(bridges.status().stickers.animated, false);
  });

  it('Signal is asked of update.sh only once its marker is 10 — WhatsApp regardless', () => {
    assert.deepEqual(bridges.wanted(), ['whatsapp', 'signal']);
    marker(9);
    assert.deepEqual(bridges.wanted(), ['whatsapp']);
    const sg = bridges.status().networks.find((n) => n.id === 'signal');
    assert.equal(sg.needs, 'script');
    fs.rmSync(au.STATE_FILE, { force: true });
    assert.deepEqual(bridges.wanted(), ['whatsapp'], 'an update.sh that never reported: not yet');
    marker(10);
    assert.deepEqual(bridges.wanted(), ['whatsapp', 'signal']);
    au.syncConfigFile();
    const cfg = JSON.parse(fs.readFileSync(au.CONFIG_FILE, 'utf8'));
    assert.equal(cfg.bridges, 'whatsapp,signal');
    assert.match(cfg.bridges_images, /signal=dock\.mau\.dev\/mautrix\/signal:v0\.2610\.0@sha256:[0-9a-f]{64}/);
    assert.match(cfg.bridges_images, /signal-relay=alpine\/socat:/);
    assert.doesNotMatch(cfg.bridges_images, /telegram/);
    assert.ok(fs.existsSync(path.join(bridges.dir(), 'signal', 'config', 'config.yaml')));
  });

  it('an older docker-compose.yml without Signal: needs "compose", WhatsApp is not touched', () => {
    fs.writeFileSync(path.join(au.DATA_DIR, '.bridges-state.json'), JSON.stringify({
      checked_at: new Date().toISOString(), state: 'running', error: '', update_sh: 10,
      services: { hs: { running: true }, whatsapp: { running: true }, signal: { present: false, running: false } },
    }));
    const st = bridges.status();
    assert.deepEqual(st.networks.map((n) => [n.id, n.state, n.needs]), [['whatsapp', 'running', null], ['signal', 'failed', 'compose'], ['telegram', 'off', null]]);
    fs.rmSync(path.join(au.DATA_DIR, '.bridges-state.json'), { force: true });
  });

  it('history: at most 30 days of Signal, also for "everything"; WhatsApp as the person chose', () => {
    settings.set('bridges.history_people', JSON.stringify({ [annaId]: -1 }));
    assert.equal(bridges.historyOf(annaId, 'whatsapp'), -1);
    assert.equal(bridges.historyOf(annaId, 'signal'), 30);
    settings.set('bridges.history_people', JSON.stringify({ [annaId]: 0 }));
    assert.equal(bridges.historyOf(annaId, 'signal'), 0);
    settings.set('bridges.history_people', '{}');
    assert.equal(bridges.historyOf(annaId, 'signal'), 30);
  });

  it('links by QR code only: a new code every 45 s, our own words, no number or account id in a step or a name', async () => {
    const flows = await asPerson(annaId, false, () => call('bridges.login.flows', { userId: annaId, network: 'signal' }));
    assert.deepEqual(flows.map((f) => f.id), ['qr']);
    await assert.rejects(asPerson(annaId, true, () => call('bridges.login.start', { userId: annaId, network: 'signal', flowId: 'phone' })), (e) => e.code === 'ERR_INVALID');
    const qr = await asPerson(annaId, true, () => call('bridges.login.start', { userId: annaId, network: 'signal', flowId: 'qr' }));
    assert.equal(qr.step.type, 'display_and_wait');
    assert.equal(qr.step.display.type, 'qr');
    assert.match(qr.step.display.data, /^sgnl:\/\/linkdevice\?/);
    assert.doesNotMatch(qr.step.instructions, /Signal app to log in/, 'not the bridge\'s text');
    // 45 s later the bridge shows a new code: the same login, a new step to show
    bridge.refresh(qr.processId);
    const again = await asPerson(annaId, true, () => bridges.login.step(annaId, 'signal', qr.processId, qr.step.id, 'display_and_wait', undefined, { pollMs: 2000 }));
    assert.equal(again.step.type, 'display_and_wait');
    assert.notEqual(again.step.display.data, qr.step.display.data);
    bridge.nextAci = ACI_BEN.replace('7c6b', '1111');
    bridge.confirm(qr.processId);
    const done = await asPerson(annaId, true, () => bridges.login.step(annaId, 'signal', again.processId, again.step.id, 'display_and_wait', undefined, { pollMs: 2000 }));
    assert.equal(done.step.type, 'complete');
    assert.equal(done.step.instructions, 'Signal is linked.');
    assert.match(done.step.loginId, /^l[A-Za-z0-9_-]{22}$/);
    assert.doesNotMatch(JSON.stringify(done), /4915100000000|1111/, 'the bridge\'s last words name the number and the account id — not passed on');
    const mine = await asPerson(annaId, false, () => call('bridges.logins', { userId: annaId, network: 'signal' }));
    assert.equal(mine.length, 1);
    assert.equal(mine[0].name, '+4915100000000', 'the person\'s own number, theirs to see');
    assert.doesNotMatch(JSON.stringify(mine), /1111|5a49/);
    // linked: the profile knows a Signal of Anna's (a keyed hash of the account id), the consent is still off
    const r = await asPerson(annaId, false, () => call('bridges.recognition.get', { userId: annaId, network: 'signal' }));
    assert.deepEqual(r, { asked: false, allowed: false, linked: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM user_bridge_accounts WHERE user_id = ? AND network = 'signal'").get(annaId).n, 1);
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM user_bridge_accounts').all()), /1111/, 'never the id itself');
    // an account without a visible number: no name at all, never the account id
    await asPerson(annaId, true, () => call('bridges.logout', { userId: annaId, network: 'signal', loginId: mine[0].id }));
    bridge.nextNumber = null;
    bridge.nextAci = ACI_BEN.replace('7c6b', '2222');
    const qr2 = await asPerson(annaId, true, () => call('bridges.login.start', { userId: annaId, network: 'signal', flowId: 'qr' }));
    bridge.confirm(qr2.processId);
    await asPerson(annaId, true, () => bridges.login.step(annaId, 'signal', qr2.processId, qr2.step.id, 'display_and_wait', undefined, { pollMs: 2000 }));
    const mine2 = await asPerson(annaId, false, () => call('bridges.logins', { userId: annaId, network: 'signal' }));
    assert.equal(mine2[0].name, '');
    await asPerson(annaId, true, () => call('bridges.logout', { userId: annaId, network: 'signal', loginId: mine2[0].id }));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM user_bridge_accounts WHERE user_id = ? AND network = 'signal'").get(annaId).n, 0, 'gone with the link');
    bridge.nextNumber = '+4915100000000';
  });

  it('Erkennen by the own Signal: the fixed account id — strong, only with the consent, never a number that is not there', async () => {
    // Ben links his own Signal (account id ACI_BEN, no visible number)
    bridge.nextAci = ACI_BEN;
    bridge.nextNumber = null;
    const qr = await asPerson(benId, true, () => call('bridges.login.start', { userId: benId, network: 'signal', flowId: 'qr' }));
    bridge.confirm(qr.processId);
    await asPerson(benId, true, () => bridges.login.step(benId, 'signal', qr.processId, qr.step.id, 'display_and_wait', undefined, { pollMs: 2000 }));
    await asPerson(benId, false, () => call('bridges.logins', { userId: benId, network: 'signal' }));
    // Anna links hers and has Ben and Kim among her Signal contacts
    bridge.nextAci = ACI_BEN.replace('7c6b', '3333');
    bridge.nextNumber = '+4915100000000';
    const qa = await asPerson(annaId, true, () => call('bridges.login.start', { userId: annaId, network: 'signal', flowId: 'qr' }));
    bridge.confirm(qa.processId);
    await asPerson(annaId, true, () => bridges.login.step(annaId, 'signal', qa.processId, qa.step.id, 'display_and_wait', undefined, { pollMs: 2000 }));
    bridge.contacts = [{ aci: ACI_BEN, name: 'Benni' }, { aci: ACI_KIM, name: 'Kim', number: '+4915100000001' }];
    let m = await asPerson(annaId, false, () => call('bridges.matchAccounts', { userId: annaId, network: 'signal' }));
    assert.deepEqual(m.matches, [], 'Ben has not agreed');
    await asPerson(benId, true, () => call('bridges.recognition.set', { userId: benId, network: 'signal', allowed: true }));
    assert.deepEqual(await asPerson(benId, false, () => call('bridges.recognition.get', { userId: benId, network: 'signal' })), { asked: true, allowed: true, linked: true });
    // the WhatsApp consent is another one
    assert.equal((await asPerson(benId, false, () => call('bridges.recognition.get', { userId: benId, network: 'whatsapp' }))).allowed, false);
    bridges._reset();
    m = await asPerson(annaId, false, () => call('bridges.matchAccounts', { userId: annaId, network: 'signal' }));
    assert.equal(m.matches.length, 1);
    assert.equal(m.matches[0].userId, benId);
    assert.equal(m.matches[0].strength, 'strong');
    assert.equal(m.matches[0].via, 'own_signal');
    assert.match(m.matches[0].contactId, /^c[A-Za-z0-9_-]{21}$/);
    assert.doesNotMatch(JSON.stringify(m), new RegExp(ACI_BEN), 'never the account id');
    // the profile names it per network
    const own = profile.ownView(benId).recognition;
    assert.equal(own.bySignal, true);
    assert.deepEqual(own.networks.signal, { allowed: true, answered: true, linked: true });
    assert.equal(own.networks.whatsapp.linked, false);
    assert.throws(() => profile.update(benId, { recognition: { byIcq: true } }), (e) => e.code === 'ERR_INVALID');
  });

  it('a profile number Signal confirms is "Bestätigt über dein Signal"', () => {
    const ph = profile.addPhone(annaId, { kind: 'mobile', number: '+4915100000000', visibility: 'none' });
    assert.equal(ph.state, 'signal');
    assert.equal(ph.confirmed, true);
    // the link ends: unconfirmed again
    profile.noteOwnNumbers(annaId, 'signal', []);
    assert.equal(profile.ownView(annaId).phones.find((x) => x.id === ph.id).state, 'unconfirmed');
    profile.removePhone(annaId, ph.id);
  });

  describe('chats over Signal (stand-in homeserver)', () => {
    const BOT = `@signalbot:${S}`;
    const KIM = `@signal_${ACI_KIM}:${S}`;
    const anna = () => `@gc_${annaId}:${S}`;
    let n = 0;
    const ev = (room, sender, type, content, extra = {}) => ({ room_id: room, sender, type, content, event_id: `$sg${++n}`, origin_server_ts: Date.now(), ...extra });
    // as bridgev2 writes it: a group without room type, a direct chat with "dm"; the chat's id at the bridge in channel.id
    const bridgeState = (id, dm) => ({ type: 'm.bridge', state_key: 'x', content: { bridgebot: BOT, protocol: { id: 'signal', displayname: 'Signal' }, channel: { id }, ...(dm ? { 'com.beeper.room_type': 'dm', 'com.beeper.room_type.v2': 'dm' } : {}) } });
    const timerState = (type, ms) => ({ type: 'com.beeper.disappearing_timer', state_key: '', content: type ? { type, timer: ms } : {} });
    const pulled = () => call('bridges.events.pull', {}).then((r) => r.events);
    const ack = () => call('bridges.events.ack', { upTo: 1e9 });
    async function open(room, state) {
      hs.room(room, { state, timeline: [], members: [anna()] });
      const r = await hs.push(`open-${room}`, { events: [ev(room, anna(), 'm.room.member', { membership: 'join' }, { state_key: anna() })] });
      assert.equal(r.status, 200);
      const evs = await pulled();
      await ack();
      return evs.find((e) => e.type === 'chat');
    }
    beforeEach(() => {
      db.exec('DELETE FROM bridge_inbox; DELETE FROM bridge_rooms; DELETE FROM bridge_txns; DELETE FROM bridge_backlog; DELETE FROM bridge_media;');
      hs.rooms.clear();
      hs.requests.length = 0;
    });

    it('a Signal group (its 44-character id) is a group, a person (a UUID) direct — the ids stay here', async () => {
      const g = await open('!sgrp:gc.internal', [bridgeState(GROUP_ID), { type: 'm.room.name', state_key: '', content: { name: 'Sportverein Blau-Weiß' } }]);
      assert.equal(g.network, 'signal');
      assert.equal(g.chat.kind, 'group');
      assert.equal(g.chat.name, 'Sportverein Blau-Weiß');
      const d = await open('!sdm:gc.internal', [{ ...bridgeState(ACI_KIM), content: { ...bridgeState(ACI_KIM).content } }]);
      assert.equal(d.chat.kind, 'direct', 'by its id, also without the room type');
      const p = await open('!spni:gc.internal', [bridgeState(`PNI:${ACI_KIM}`)]);
      assert.equal(p.chat.kind, 'direct');
      assert.doesNotMatch(JSON.stringify([g, d, p]), new RegExp(`${GROUP_ID.slice(0, 12)}|${ACI_KIM}`));
    });

    it('version 14: no place over Signal (its bridge would send a map link as text) — ERR_INVALID / unsupported, nothing sent', async () => {
      const d = await open('!sloc:gc.internal', [bridgeState(ACI_KIM, true)]);
      const before = hs.sent.length;
      await assert.rejects(asPerson(annaId, true, () => call('bridges.send', { userId: annaId, network: 'signal', chatId: d.chat.id, message: { txnId: 'sg-loc-0001', location: { lat: 48.137154, lon: 11.576124 } } })),
        (e) => e.code === 'ERR_INVALID' && e.reason === 'unsupported');
      assert.equal(hs.sent.length, before);
      assert.equal(bridges.status().networks.find((x) => x.id === 'signal').location, false);
      // a text still goes
      await asPerson(annaId, true, () => call('bridges.send', { userId: annaId, network: 'signal', chatId: d.chat.id, message: { txnId: 'sg-txt-0001', text: 'Bin gleich da' } }));
      assert.equal(hs.sent.length, before + 1);
    });

    it('disappearing messages: the chat\'s timer, its change as a notice with an action; the bridge deletes the messages itself', async () => {
      const room = '!stimer:gc.internal';
      const c = await open(room, [bridgeState(ACI_KIM, true), timerState('after_read', 604800000)]);
      assert.deepEqual(c.chat.timer, { type: 'after_read', seconds: 604800 });
      await hs.push('t-timer', { events: [
        ev(room, KIM, 'com.beeper.disappearing_timer', { type: 'after_read', timer: 3600000 }, { state_key: '' }),
        ev(room, KIM, 'm.room.message', { msgtype: 'm.notice', body: 'Set the disappearing message timer to 1h', 'com.beeper.action_message': { type: 'disappearing_timer', timer: 3600000, timer_type: 'after_read' } }),
      ] });
      let evs = await pulled();
      assert.deepEqual(evs.map((e) => e.type), ['chat', 'message']);
      assert.deepEqual(evs[0].chat.timer, { type: 'after_read', seconds: 3600 });
      assert.equal(evs[1].kind, 'notice');
      assert.deepEqual(evs[1].action, { type: 'timer', seconds: 3600 });
      await ack();
      // switched off: {} — timer null
      await hs.push('t-off', { events: [ev(room, KIM, 'com.beeper.disappearing_timer', {}, { state_key: '' })] });
      evs = await pulled();
      assert.equal(evs[0].chat.timer, null);
      await ack();
    });

    it('a sticker is a picture; a view-once picture is a hint — the file is not passed on and goes at the homeserver', async () => {
      const room = '!sview:gc.internal';
      hs.file('stk1', { data: Buffer.from('webp'), mime: 'image/webp' });
      hs.file('vo1', { data: Buffer.from('jpeg'), mime: 'image/jpeg' });
      await open(room, [bridgeState(ACI_KIM, true)]);
      await hs.push('t-media', { events: [
        ev(room, KIM, 'm.sticker', { body: '🥰', url: `mxc://${S}/stk1`, info: { mimetype: 'image/webp', w: 200, h: 200 } }),
        ev(room, KIM, 'm.room.message', { msgtype: 'm.image', body: 'image.jpg', url: `mxc://${S}/vo1`, info: { mimetype: 'image/jpeg' }, 'com.beeper.view_limited': { type: 'count', count: 1 } }),
      ] });
      const evs = await pulled();
      assert.equal(evs[0].kind, 'media');
      assert.equal(evs[0].media.kind, 'sticker');
      assert.match(evs[0].media.ref, /^m/);
      assert.equal(evs[1].kind, 'unsupported');
      assert.equal(evs[1].viewOnce, true);
      assert.ok(!('media' in evs[1]), 'no file of a view-once picture');
      const rows = db.prepare('SELECT mxc, state FROM bridge_media ORDER BY mxc').all().map((r) => [r.mxc, r.state]);
      assert.deepEqual(rows, [[`mxc://${S}/stk1`, 'wait'], [`mxc://${S}/vo1`, 'drop']]);
      await ack();
    });

    it('older messages from the transfer archive: at most 30 days, also when the person wants everything', async () => {
      settings.set('bridges.history_people', JSON.stringify({ [annaId]: -1 }));
      settings.set('bridges.linked_at', JSON.stringify({ [`${annaId}:signal`]: Date.now() }));
      const room = '!shist:gc.internal';
      await open(room, [bridgeState(ACI_KIM, true)]);
      db.prepare('UPDATE bridge_rooms SET created_at = ? WHERE room_id = ?').run(Date.now(), room);
      bridges._reset();
      bridges._runtime.wake = () => {};
      const DAY = 86400000;
      await hs.push('t-hist', { events: [
        ev(room, KIM, 'm.room.message', { msgtype: 'm.text', body: 'vor 40 Tagen' }, { origin_server_ts: Date.now() - 40 * DAY }),
        ev(room, KIM, 'm.room.message', { msgtype: 'm.text', body: 'vor 10 Tagen' }, { origin_server_ts: Date.now() - 10 * DAY }),
      ] });
      const h = await call('bridges.history.pull', {});
      assert.deepEqual(h.events.map((e) => e.text), ['vor 10 Tagen']);
      settings.set('bridges.history_people', '{}');
      settings.set('bridges.linked_at', '{}');
    });
  });
});
