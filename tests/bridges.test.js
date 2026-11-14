'use strict';

// Messenger bridges, stage 1 (docs/feature-messenger-bridges.md): the service
// (off by default, preview gate, secrets, the wish for update.sh, what the
// host reported), the provisioning client against a stand-in bridge on a
// Unix socket (tests/helpers/fake-bridge.js), the host API gc.bridges with
// its "only the person themselves" rule, and update.sh with a fake docker.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setup, teardown } = require('./helpers/setup');
const { startFakeBridge } = require('./helpers/fake-bridge');

let bridges, au, hostApi, ctx, db, adminId, annaId, benId;
const PLUGIN = { id: 'bridge-demo', manifest: { permissions: { bridges: true } } };
const NOPERM = { id: 'other-demo', manifest: { permissions: {} } };
const cfgFile = () => JSON.parse(fs.readFileSync(au.CONFIG_FILE, 'utf8'));
const stateFile = () => path.join(au.DATA_DIR, '.bridges-state.json');
const asPerson = (userId, write, fn) => ctx.run(PLUGIN.id, userId, write, fn);
const call = (api, args) => hostApi.handle(PLUGIN, api, args);

before(async () => {
  await setup();
  bridges = require('../src/services/bridges');
  au = require('../src/services/autoUpdate');
  hostApi = require('../src/services/plugins/hostApi');
  ctx = require('../src/services/plugins/personContext');
  db = require('../src/db/connection').getDb();
  adminId = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get().id;
  const add = db.prepare('INSERT INTO users (username, password_hash, role, enabled, language, display_name) VALUES (?, ?, ?, 1, ?, ?)');
  annaId = Number(add.run('anna-bridges', 'x', 'user', 'de', 'Anna').lastInsertRowid);
  benId = Number(add.run('ben-bridges', 'x', 'user', 'de', 'Ben').lastInsertRowid);
});
after(() => { delete process.env.GC_BRIDGES_PREVIEW; teardown(); });

function off() {
  const s = require('../src/services/settings');
  s.set('bridges.enabled', '0');
  s.set('bridges.networks', 'null');
  try { fs.unlinkSync(stateFile()); } catch { /* none */ }
  bridges._reset();
}

describe('the service', () => {
  beforeEach(() => { delete process.env.GC_BRIDGES_PREVIEW; off(); });

  it('does not exist without the preview switch — no status, no switch, no wish for update.sh', () => {
    const st = bridges.status();
    assert.equal(st.available, false);
    assert.equal(st.reason, 'preview_off');
    assert.deepEqual(st.networks, []);
    assert.throws(() => bridges.configure({ enabled: true }, {}), (e) => e.code === 'ERR_BRIDGES_UNAVAILABLE' && e.reason === 'preview_off');
    // even a stored "on" (preview switched off again) asks update.sh for nothing
    require('../src/services/settings').set('bridges.enabled', '1');
    require('../src/services/settings').set('bridges.networks', '{"whatsapp":true}');
    assert.deepEqual(bridges.wanted(), []);
    au.syncConfigFile();
    assert.equal(cfgFile().bridges, undefined);
  });

  it('is off by default, and switching on makes the secrets and tells update.sh', () => {
    process.env.GC_BRIDGES_PREVIEW = '1';
    let st = bridges.status();
    assert.equal(st.available, true);
    assert.equal(st.enabled, false);
    assert.equal(st.location, 'server');
    assert.equal(st.locations.length, 1);
    assert.equal(st.locations[0].kind, 'server');
    assert.ok(st.locations[0].cores >= 1 && st.locations[0].memMb > 0);
    assert.deepEqual(st.networks.map((n) => [n.id, n.enabled, n.state]), [['whatsapp', false, 'off']]);
    assert.equal(st.history.enabled, false, 'older history is not loaded on the server');
    au.syncConfigFile();
    assert.equal(cfgFile().bridges, undefined);

    st = bridges.configure({ enabled: true, networks: { whatsapp: true } }, { actor: { id: adminId, name: 'admin' }, pluginId: PLUGIN.id });
    assert.equal(st.enabled, true);
    assert.equal(st.networks[0].state, 'starting', 'nothing reported by the host yet');
    assert.equal(cfgFile().bridges, 'whatsapp');
    assert.equal(cfgFile().mode !== undefined, true, 'the update mode stays in the file');

    const secrets = bridges.readSecrets();
    assert.ok(secrets && secrets.asToken !== secrets.hsToken && secrets.provisionSecret.length >= 32);
    const mode = fs.statSync(path.join(bridges.dir(), 'secrets.json')).mode & 0o777;
    assert.equal(mode, 0o600, 'secrets.json is readable by the server only');
    assert.doesNotMatch(JSON.stringify(st), new RegExp(secrets.provisionSecret), 'status never carries a secret');
    // on disk: one master key; what is sent to a bridge is derived from it, never the file's content
    const onDisk = JSON.parse(fs.readFileSync(path.join(bridges.dir(), 'secrets.json'), 'utf8'));
    assert.deepEqual(Object.keys(onDisk), ['key']);
    for (const tok of Object.values(secrets)) assert.ok(tok !== onDisk.key && !fs.readFileSync(path.join(bridges.dir(), 'secrets.json'), 'utf8').includes(tok));
    // a second switch keeps the tokens (the containers hold them too)
    bridges.configure({ enabled: true }, {});
    assert.deepEqual(bridges.readSecrets(), secrets);

    // the bridge off, the service on → nothing to run
    bridges.configure({ networks: { whatsapp: false } }, {});
    assert.equal(cfgFile().bridges, undefined);
    bridges.configure({ networks: { whatsapp: true }, enabled: false }, {});
    assert.equal(cfgFile().bridges, undefined);
    assert.equal(bridges.status().networks[0].state, 'off');
  });

  it('refuses anything but its two switches', () => {
    process.env.GC_BRIDGES_PREVIEW = '1';
    for (const bad of [null, [], { enabled: 'yes' }, { networks: { signal: true } }, { networks: { whatsapp: 1 } }, { location: 'gateway' }, { networks: [] }]) {
      assert.throws(() => bridges.configure(bad, {}), (e) => e.code === 'ERR_INVALID', JSON.stringify(bad));
    }
    assert.equal(bridges.status().enabled, false);
  });

  it('shows what update.sh reported, and only known values', () => {
    process.env.GC_BRIDGES_PREVIEW = '1';
    bridges.configure({ enabled: true, networks: { whatsapp: true } }, {});
    fs.writeFileSync(stateFile(), JSON.stringify({
      checked_at: new Date().toISOString(), state: 'running', error: '', update_sh: 5,
      services: { hs: { running: true, mem_mb: 61, limit_mb: 384, version: '1.2.0' }, whatsapp: { running: true, mem_mb: 88, limit_mb: 512, version: 'v26.10' } },
    }));
    let st = bridges.status();
    assert.equal(st.host.state, 'running');
    assert.deepEqual(st.host.homeserver, { running: true, memMb: 61, limitMb: 384, version: '1.2.0', outdated: false, wantVersion: '1.9.4' });
    assert.deepEqual(st.networks[0], { id: 'whatsapp', enabled: true, state: 'running', version: 'v26.10', memMb: 88, limitMb: 512, outdated: false, wantVersion: '0.2610.0' });
    assert.equal(st.host.limitsProvisional, true, 'no measured memory need yet');
    assert.equal(st.host.probe, null);
    assert.equal(st.host.script.needed, 6);

    fs.writeFileSync(stateFile(), JSON.stringify({ checked_at: new Date().toISOString(), state: 'failed', error: 'compose_missing', services: {} }));
    st = bridges.status();
    assert.equal(st.host.state, 'failed');
    assert.equal(st.host.error, 'compose_missing');
    assert.equal(st.networks[0].state, 'failed');

    fs.writeFileSync(stateFile(), JSON.stringify({ checked_at: 'x', state: '<b>', error: 'rm -rf', services: { hs: { running: 'yes', mem_mb: -4, version: '<script>' }, whatsapp: 7 } }));
    st = bridges.status();
    assert.equal(st.host.state, null);
    assert.equal(st.host.error, null);
    assert.equal(st.host.checkedAt, null);
    assert.deepEqual(st.host.homeserver, { running: false, memMb: null, limitMb: null, version: null, outdated: false, wantVersion: '1.9.4' });
    assert.equal(st.networks[0].version, null);
  });
});

describe('a person links their own account (stand-in bridge)', () => {
  let bridge;
  before(async () => {
    process.env.GC_BRIDGES_PREVIEW = '1';
    off();
    bridges.configure({ enabled: true, networks: { whatsapp: true } }, {});
    const socket = path.join(bridges.dir(), 'run', 'whatsapp.sock');
    bridge = await startFakeBridge({ socket, secret: bridges.readSecrets().provisionSecret });
  });
  after(async () => { await bridge.close(); });
  beforeEach(() => { bridges._reset(); });

  it('pairing code: number → code → confirmed on the phone → linked', async () => {
    const flows = await bridges.login.flows(annaId, 'whatsapp');
    assert.deepEqual(flows.map((f) => f.id), ['qr', 'phone']);
    const first = await bridges.login.start(annaId, 'whatsapp', 'phone');
    assert.equal(first.step.type, 'user_input');
    assert.deepEqual(first.step.fields, [{ id: 'phone_number', type: 'phone_number', name: 'Phone number', description: 'Include the country code with a +', optional: false }]);
    const code = await bridges.login.step(annaId, 'whatsapp', first.processId, first.step.id, 'user_input', { phone_number: '+4915120000000' });
    assert.deepEqual(code.step.display, { type: 'code', data: 'K7P2-M4X9' });

    // the phone has not confirmed yet: the caller is told to ask again, and the bridge is asked only once
    const wait1 = await bridges.login.step(annaId, 'whatsapp', code.processId, code.step.id, 'display_and_wait', undefined, { pollMs: 30 });
    assert.deepEqual(wait1, { processId: code.processId, waiting: true });
    const wait2 = await bridges.login.step(annaId, 'whatsapp', code.processId, code.step.id, 'display_and_wait', undefined, { pollMs: 30 });
    assert.equal(wait2.waiting, true);
    assert.equal(bridge.requests.filter((r) => r.path.endsWith('/display_and_wait')).length, 1);

    bridge.confirm(code.processId);
    const done = await bridges.login.step(annaId, 'whatsapp', code.processId, code.step.id, 'display_and_wait', undefined, { pollMs: 2000 });
    assert.equal(done.step.type, 'complete');
    assert.match(done.step.loginId, /^login-\d+$/);

    const mine = await bridges.logins(annaId, 'whatsapp');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].state, 'connected');
    assert.equal(mine[0].network, 'whatsapp');
    assert.ok(!('space_room' in mine[0]) && !('profile' in mine[0]), 'nothing of Matrix is passed on');
    assert.deepEqual(await bridges.logins(benId, 'whatsapp'), [], 'another person sees nothing of it');

    // every request carried the secret and this person's internal id — and only that id
    assert.ok(bridge.requests.length > 0);
    for (const r of bridge.requests) {
      assert.equal(r.auth, `Bearer ${bridges.readSecrets().provisionSecret}`);
      assert.ok(r.userId === `@gc_${annaId}:gc.internal` || r.userId === `@gc_${benId}:gc.internal`);
    }
  });

  it('QR code, then logged out by the service, then unlinked here', async () => {
    const qr = await bridges.login.start(benId, 'whatsapp', 'qr');
    assert.equal(qr.step.display.type, 'qr');
    assert.ok(qr.step.display.data.length > 10);
    assert.ok(!('image_url' in qr.step.display), 'the picture address of the bridge is not passed on');
    bridge.confirm(qr.processId);
    const done = await bridges.login.step(benId, 'whatsapp', qr.processId, qr.step.id, 'display_and_wait', undefined, { pollMs: 2000 });
    assert.equal(done.step.type, 'complete');

    bridge.logOut(`@gc_${benId}:gc.internal`, done.step.loginId);
    const mine = await bridges.logins(benId, 'whatsapp');
    assert.equal(mine[0].state, 'logged_out');
    assert.equal(mine[0].error, 'wa-logged-out');

    assert.deepEqual(await bridges.logout(benId, 'whatsapp', done.step.loginId), { ok: true });
    assert.deepEqual(await bridges.logins(benId, 'whatsapp'), []);
    // somebody else's login id is unknown to the bridge under their own id
    await assert.rejects(bridges.logout(benId, 'whatsapp', 'login-1'), (e) => e.code === 'ERR_BRIDGE' && e.reason === 'not_found');
  });

  it('a code that ran out, a cancelled login, a wrong number', async () => {
    const qr = await bridges.login.start(annaId, 'whatsapp', 'qr');
    bridge.expire(qr.processId);
    await assert.rejects(bridges.login.step(annaId, 'whatsapp', qr.processId, qr.step.id, 'display_and_wait', undefined, { pollMs: 2000 }),
      (e) => e.code === 'ERR_BRIDGE' && e.reason === 'fi_mau_whatsapp_login_timeout');

    const p = await bridges.login.start(annaId, 'whatsapp', 'phone');
    await assert.rejects(bridges.login.step(annaId, 'whatsapp', p.processId, p.step.id, 'user_input', { phone_number: 'abc' }), (e) => e.code === 'ERR_BRIDGE' && e.reason === 'm_bad_json');
    assert.deepEqual(await bridges.login.cancel(annaId, 'whatsapp', p.processId), { ok: true });
    await assert.rejects(bridges.login.cancel(annaId, 'whatsapp', p.processId), (e) => e.code === 'ERR_BRIDGE' && e.reason === 'not_found');
    // Ben cannot continue Anna's login
    const a = await bridges.login.start(annaId, 'whatsapp', 'phone');
    await assert.rejects(bridges.login.step(benId, 'whatsapp', a.processId, a.step.id, 'user_input', { phone_number: '+4915120000001' }), (e) => e.reason === 'not_found');
  });

  it('checks what goes to the bridge and what comes back', async () => {
    await assert.rejects(async () => bridges.login.start(annaId, 'signal', 'qr'), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(async () => bridges.login.start(0, 'whatsapp', 'qr'), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(bridges.login.start(annaId, 'whatsapp', '../whoami'), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(bridges.login.step(annaId, 'whatsapp', 'p/../x', 's', 'user_input', { a: 'b' }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(bridges.login.step(annaId, 'whatsapp', 'p', 's', 'cookies', { a: 'b' }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(bridges.login.step(annaId, 'whatsapp', 'p', 's', 'user_input', { a: 5 }), (e) => e.code === 'ERR_INVALID');
    // a step only a browser driven by the bridge could do (passkey) is named, not passed on
    bridge.oddStep = 'webauthn';
    await assert.rejects(bridges.login.start(annaId, 'whatsapp', 'qr'), (e) => e.code === 'ERR_BRIDGE' && e.reason === 'unsupported_step');
  });

  it('sends requests to a bridge socket of its own only', async () => {
    const { request } = require('../src/services/bridges/provision');
    const secret = bridges.readSecrets().provisionSecret;
    const good = { method: 'GET', path: 'whoami', mxid: `@gc_${annaId}:gc.internal` };
    for (const socket of ['/etc/passwd', 'relative/run/whatsapp.sock', path.join(bridges.dir(), 'run', '..', 'run', 'whatsapp.sock').replace('/run/whatsapp', '/x/../run/whatsapp'), '/data/bridges/run/WhatsApp.sock']) {
      await assert.rejects(request({ socket, secret }, good), (e) => e.code === 'ERR_INVALID', socket);
    }
    const socket = path.join(bridges.dir(), 'run', 'whatsapp.sock');
    await assert.rejects(request({ socket, secret: 'short' }, good), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(request({ socket, secret }, { ...good, method: 'DELETE' }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(request({ socket, secret }, { ...good, path: '../v1/x' }), (e) => e.code === 'ERR_INVALID');
    await assert.rejects(request({ socket, secret }, { ...good, mxid: '@admin:matrix.org' }), (e) => e.code === 'ERR_INVALID');
  });

  it('says so when the bridge is not there or switched off', async () => {
    await bridge.close();
    await assert.rejects(bridges.logins(annaId, 'whatsapp'), (e) => e.code === 'ERR_BRIDGE_UNREACHABLE' && e.reason === 'not_running');
    bridges.configure({ networks: { whatsapp: false } }, {});
    await assert.rejects(async () => bridges.logins(annaId, 'whatsapp'), (e) => e.code === 'ERR_BRIDGES_UNAVAILABLE' && e.reason === 'off');
    bridges.configure({ networks: { whatsapp: true } }, {});
    bridge = await startFakeBridge({ socket: path.join(bridges.dir(), 'run', 'whatsapp.sock'), secret: 'another-secret-another-secret-another' });
    await assert.rejects(bridges.logins(annaId, 'whatsapp'), (e) => e.code === 'ERR_BRIDGE' && e.reason === 'refused');
  });
});

describe('host API gc.bridges', () => {
  let bridge;
  before(async () => {
    process.env.GC_BRIDGES_PREVIEW = '1';
    off();
    bridges.configure({ enabled: true, networks: { whatsapp: true } }, {});
    bridge = await startFakeBridge({ socket: path.join(bridges.dir(), 'run', 'whatsapp.sock'), secret: bridges.readSecrets().provisionSecret });
  });
  after(async () => { await bridge.close(); });

  it('needs the permission; an unknown key is ignored by the manifest of older plugins', async () => {
    await assert.rejects(hostApi.handle(NOPERM, 'bridges.status', {}), (e) => e.code === 'ERR_BRIDGES_DENIED');
    const validateManifest = require('../src/services/plugins/manifest').validate;
    const base = { id: 'bridge-demo', name: 'Demo', version: '1.0.0', publisher: 'x', gatecontrol: '>=1.0.0', entry: 'server/index.js' };
    const ok = validateManifest({ ...base, permissions: { bridges: true } });
    assert.equal(ok.manifest.permissions.bridges, true, JSON.stringify(ok.errors));
    assert.equal(validateManifest({ ...base, permissions: {} }).manifest.permissions.bridges, false);
    assert.ok(validateManifest({ ...base, permissions: { bridges: 'yes' } }).errors.some((e) => /permissions\.bridges/.test(e)));
  });

  it('status for everybody, the switch for an administrator in a changing request only', async () => {
    assert.equal((await call('bridges.status', {})).available, true);
    await assert.rejects(call('bridges.configure', { patch: { enabled: false } }), (e) => e.code === 'ERR_NOT_PERSON');
    await assert.rejects(asPerson(annaId, true, () => call('bridges.configure', { patch: { enabled: false } })), (e) => e.code === 'ERR_NOT_ADMIN');
    await assert.rejects(asPerson(adminId, false, () => call('bridges.configure', { patch: { enabled: false } })), (e) => e.code === 'ERR_NOT_PERSON');
    const st = await asPerson(adminId, true, () => call('bridges.configure', { patch: { enabled: true } }));
    assert.equal(st.enabled, true);
    const row = db.prepare("SELECT message, details FROM activity_log WHERE event_type = 'bridges_changed' ORDER BY id DESC LIMIT 1").get();
    assert.ok(row, 'switching is in the activity log');
  });

  it('nobody links, reads or unlinks for somebody else', async () => {
    // not in a tick, not for another person, not an administrator for a member
    await assert.rejects(call('bridges.logins', { userId: annaId, network: 'whatsapp' }), (e) => e.code === 'ERR_NOT_PERSON');
    await assert.rejects(asPerson(adminId, true, () => call('bridges.login.start', { userId: annaId, network: 'whatsapp', flowId: 'qr' })), (e) => e.code === 'ERR_NOT_PERSON');
    await assert.rejects(asPerson(benId, true, () => call('bridges.logins', { userId: annaId, network: 'whatsapp' })), (e) => e.code === 'ERR_NOT_PERSON');
    // starting needs a changing request, reading does not
    await assert.rejects(asPerson(annaId, false, () => call('bridges.login.start', { userId: annaId, network: 'whatsapp', flowId: 'qr' })), (e) => e.code === 'ERR_NOT_PERSON');
    assert.deepEqual(await asPerson(annaId, false, () => call('bridges.logins', { userId: annaId, network: 'whatsapp' })), []);
    const qr = await asPerson(annaId, true, () => call('bridges.login.start', { userId: annaId, network: 'whatsapp', flowId: 'qr' }));
    assert.equal(qr.step.display.type, 'qr');
    bridge.confirm(qr.processId);
    const done = await asPerson(annaId, true, () => call('bridges.login.step', { userId: annaId, network: 'whatsapp', processId: qr.processId, stepId: qr.step.id, kind: 'display_and_wait' }));
    assert.equal(done.step.type, 'complete');
    await assert.rejects(asPerson(benId, true, () => call('bridges.logout', { userId: annaId, network: 'whatsapp', loginId: done.step.loginId })), (e) => e.code === 'ERR_NOT_PERSON');
    assert.deepEqual(await asPerson(annaId, true, () => call('bridges.logout', { userId: annaId, network: 'whatsapp', loginId: done.step.loginId })), { ok: true });
  });

  it('passes the reason of a refusal on, never the bridge’s own text', async () => {
    const err = await asPerson(annaId, true, () => call('bridges.login.cancel', { userId: annaId, network: 'whatsapp', processId: 'proc-none' })).then(() => null, (e) => e);
    assert.equal(err.code, 'ERR_BRIDGE');
    assert.equal(err.reason, 'not_found');
    assert.doesNotMatch(err.message, /internal detail/);
    await assert.rejects(asPerson(annaId, true, () => call('bridges.login.start', { userId: annaId, network: 'telegram', flowId: 'qr' })), (e) => e.code === 'ERR_INVALID');
  });
});

describe('update.sh runs the compose profile "bruecken"', () => {
  const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
  const skip = !has('bash');
  const ROOT = path.join(__dirname, '..');
  let box;

  // A fake docker: st/services = the services of the compose profile, st/run_<name> = a running container,
  // st/upfail = `compose up` fails. Every call is appended to st/calls.
  const DOCKER = `#!/usr/bin/env bash
S="$SHIM_ST"; echo "$*" >>"$S/calls"
case "$1" in
  inspect)
    case "$*" in
      *State.Running*) [ -f "$S/run_\${!#}" ] && echo true || echo false; exit 0 ;;
      *image.version*) echo "v26.10"; exit 0 ;;
      *Config.Image*) cat "$S/image_\${!#}" 2>/dev/null || echo "example.org/x/\${!#}:v1@sha256:$(printf '%064d' 0)"; exit 0 ;;
      *State.Pid*) echo "$$"; exit 0 ;;
      *RestartCount*) echo 0; exit 0 ;;
      *OOMKilled*) echo false; exit 0 ;;
      *ExitCode*) echo 0; exit 0 ;;
      *State.Health*) echo healthy; exit 0 ;;
      *) exit 1 ;;
    esac ;;
  stats) case "$*" in *BlockIO*) echo "1.5MB / 2.5MB" ;; *) echo "87.6MiB / 512MiB" ;; esac; exit 0 ;;
  logs) echo "started; token $(printf 'x%.0s' $(seq 1 40)) for 4915120000000"; exit 0 ;;
  rm) rm -f "$S/run_\${!#}"; exit 0 ;;
  compose)
    case "$*" in
      *"config --services"*) cat "$S/services" 2>/dev/null; exit 0 ;;
      *" up -d "*) [ -f "$S/upfail" ] && exit 1
                   seen=0; for a in "$@"; do [ "$seen" = 1 ] && : >"$S/run_$a"; [ "$a" = "-d" ] && seen=1; done; exit 0 ;;
    esac; exit 0 ;;
esac
exit 0
`;
  function run(config, args = []) {
    fs.writeFileSync(path.join(box, 'data', '.auto-update-config.json'), JSON.stringify(config) + '\n');
    const r = spawnSync('bash', [path.join(box, 'update.sh'), ...args], {
      env: { PATH: `${path.join(box, 'bin')}:${process.env.PATH}`, SHIM_ST: path.join(box, 'st'), GC_UPDATE_LOG: path.join(box, 'update.log'), TMPDIR: box, HOME: box },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    let state = null;
    try { state = JSON.parse(fs.readFileSync(path.join(box, 'data', '.bridges-state.json'), 'utf8')); } catch { state = null; }
    return { state, calls: fs.readFileSync(path.join(box, 'st', 'calls'), 'utf8'), out: r.stdout };
  }
  // what the server writes before it asks for the bridges
  function writeConfig() {
    for (const f of ['hs/config/tuwunel.toml', 'whatsapp/config/config.yaml']) {
      fs.mkdirSync(path.dirname(path.join(box, 'data', 'bridges', f)), { recursive: true });
      fs.writeFileSync(path.join(box, 'data', 'bridges', f), 'x\n');
    }
  }
  const st = (f) => path.join(box, 'st', f);

  beforeEach(() => {
    box = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-bridges-sh-'));
    for (const d of ['bin', 'data', 'st']) fs.mkdirSync(path.join(box, d));
    fs.writeFileSync(path.join(box, 'docker-compose.yml'), 'services:\n  gatecontrol:\n    image: x\n');
    fs.copyFileSync(path.join(ROOT, 'update.sh'), path.join(box, 'update.sh'));
    fs.writeFileSync(path.join(box, 'bin', 'docker'), DOCKER, { mode: 0o755 });
    fs.writeFileSync(st('calls'), '');
    writeConfig();
  });

  it('does nothing while the bridges are not wanted', { skip }, () => {
    fs.writeFileSync(st('services'), 'bruecken-hs\nbruecken-whatsapp\n');
    const r = run({ mode: 'manual' });
    assert.equal(r.state, null);
    assert.doesNotMatch(r.calls, /bruecken/);
  });

  it('an older docker-compose.yml: says so instead of starting anything', { skip }, () => {
    fs.writeFileSync(st('services'), '');
    const r = run({ mode: 'manual', bridges: 'whatsapp' });
    assert.equal(r.state.state, 'failed');
    assert.equal(r.state.error, 'compose_missing');
    assert.equal(r.state.update_sh, 6);
    assert.doesNotMatch(r.calls, / up -d /);
  });

  it('starts homeserver and bridge, reports memory, and removes only what it started', { skip }, () => {
    fs.writeFileSync(st('services'), 'bruecken-hs\nbruecken-whatsapp\n');
    let r = run({ mode: 'manual', bridges: 'whatsapp' });
    assert.match(r.calls, /compose --profile bruecken up -d bruecken-hs bruecken-whatsapp/);
    assert.equal(r.state.state, 'starting');
    assert.ok(fs.existsSync(path.join(box, '.bruecken-managed')), 'marker next to docker-compose.yml, not on /data');

    fs.writeFileSync(st('calls'), '');
    r = run({ mode: 'manual', bridges: 'whatsapp' });
    assert.equal(r.state.state, 'running');
    const img = (n) => `example.org/x/${n}:v1@sha256:${'0'.repeat(64)}`;
    assert.deepEqual(r.state.services.hs, { running: true, mem_mb: 88, limit_mb: 512, version: 'v26.10', image: img('bruecken-hs') });
    assert.deepEqual(r.state.services.whatsapp, { running: true, mem_mb: 88, limit_mb: 512, version: 'v26.10', image: img('bruecken-whatsapp') });
    assert.doesNotMatch(r.calls, / up -d /, 'a running service is left alone');

    r = run({ mode: 'manual' });
    assert.equal(r.state.state, 'stopped');
    assert.ok(!fs.existsSync(st('run_bruecken-hs')) && !fs.existsSync(st('run_bruecken-whatsapp')));
    assert.ok(!fs.existsSync(path.join(box, '.bruecken-managed')));
  });

  it('leaves containers alone it did not start, retries a failed start only later, and takes no name it does not know', { skip }, () => {
    fs.writeFileSync(st('services'), 'bruecken-hs\nbruecken-whatsapp\n');
    fs.writeFileSync(st('run_bruecken-hs'), '');
    let r = run({ mode: 'manual' });
    assert.ok(fs.existsSync(st('run_bruecken-hs')), 'started by hand → stays');
    fs.unlinkSync(st('run_bruecken-hs'));

    fs.writeFileSync(st('upfail'), '');
    r = run({ mode: 'manual', bridges: 'whatsapp' });
    assert.equal(r.state.state, 'failed');
    assert.equal(r.state.error, 'start_failed');
    fs.writeFileSync(st('calls'), '');
    r = run({ mode: 'manual', bridges: 'whatsapp' });
    assert.doesNotMatch(r.calls, / up -d /, 'not every run');

    fs.unlinkSync(path.join(box, 'data', '.bridges-state.json'));
    fs.writeFileSync(st('calls'), '');
    r = run({ mode: 'manual', bridges: 'whatsapp;rm -rf /,$(id)' });
    assert.equal(r.state, null, 'a value outside [a-z,] is no wish at all');
    assert.doesNotMatch(r.calls, /bruecken/);
  });

  it('starts the relay of a bridge with it, and waits for the configuration the server writes', { skip }, () => {
    fs.writeFileSync(st('services'), 'bruecken-hs\nbruecken-whatsapp\nbruecken-whatsapp-relay\n');
    fs.rmSync(path.join(box, 'data', 'bridges'), { recursive: true });
    let r = run({ mode: 'manual', bridges: 'whatsapp' });
    assert.equal(r.state.state, 'failed');
    assert.equal(r.state.error, 'config_missing');
    assert.doesNotMatch(r.calls, / up -d /, 'Docker would make empty folders');

    writeConfig();
    fs.unlinkSync(path.join(box, 'data', '.bridges-state.json'));
    r = run({ mode: 'manual', bridges: 'whatsapp', bridges_rev: 'aaaaaaaaaaaa' });
    assert.match(r.calls, /compose --profile bruecken up -d bruecken-hs bruecken-whatsapp bruecken-whatsapp-relay/);
    assert.match(fs.readFileSync(path.join(box, '.bruecken-managed'), 'utf8'), /^rev=aaaaaaaaaaaa compose=\d+/);

    r = run({ mode: 'manual' });
    assert.ok(!fs.existsSync(st('run_bruecken-whatsapp-relay')), 'the relay goes with the bridges');
  });

  it('recreates its containers when the configuration changed, and looks again after a new docker-compose.yml', { skip }, () => {
    fs.writeFileSync(st('services'), 'bruecken-hs\nbruecken-whatsapp\n');
    run({ mode: 'manual', bridges: 'whatsapp', bridges_rev: 'aaaaaaaaaaaa' });
    fs.writeFileSync(st('calls'), '');
    let r = run({ mode: 'manual', bridges: 'whatsapp', bridges_rev: 'aaaaaaaaaaaa' });
    assert.equal(r.state.state, 'running');
    assert.doesNotMatch(r.calls, / up -d /);

    r = run({ mode: 'manual', bridges: 'whatsapp', bridges_rev: 'bbbbbbbbbbbb' });
    assert.match(r.calls, /compose --profile bruecken up -d --force-recreate bruecken-hs bruecken-whatsapp/);
    assert.match(fs.readFileSync(path.join(box, '.bruecken-managed'), 'utf8'), /^rev=bbbbbbbbbbbb /);

    fs.writeFileSync(st('calls'), '');
    fs.appendFileSync(path.join(box, 'docker-compose.yml'), '# a newer file\n');
    r = run({ mode: 'manual', bridges: 'whatsapp', bridges_rev: 'bbbbbbbbbbbb' });
    assert.match(r.calls, /compose --profile bruecken up -d bruecken-hs bruecken-whatsapp/, 'compose decides what changed');
    assert.doesNotMatch(r.calls, /--force-recreate/);
  });

  it('bridges-probe: starts what is switched on, measures, and writes numbers and blanked log lines', { skip }, () => {
    fs.writeFileSync(st('services'), 'bruecken-hs\nbruecken-whatsapp\nbruecken-whatsapp-relay\n');
    const probe = () => JSON.parse(fs.readFileSync(path.join(box, 'data', '.bridges-probe.json'), 'utf8'));
    let r = run({ mode: 'manual' }, ['bridges-probe', '10']);
    assert.equal(probe().result, 'not_wanted');
    assert.doesNotMatch(r.calls, / up -d /, 'the probe switches nothing on');

    // the sockets the containers would make (bound by a child that exits: the file stays)
    for (const f of ['hs/run/hs.sock', 'run/whatsapp.sock']) {
      const file = path.join(box, 'data', 'bridges', f);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const c = spawnSync(process.execPath, ['-e', `const s=require('net').createServer();s.listen(${JSON.stringify(file)},()=>process.exit(0));`]);
      assert.equal(c.status, 0);
    }
    r = run({ mode: 'manual', bridges: 'whatsapp' }, ['bridges-probe', '10']);
    const p = probe();
    assert.match(r.calls, /compose --profile bruecken up -d bruecken-hs bruecken-whatsapp bruecken-whatsapp-relay/);
    assert.equal(p.update_sh, 6);
    assert.equal(p.window_s, 10);
    assert.deepEqual(Object.keys(p.services), ['hs', 'whatsapp', 'whatsapp-relay']);
    assert.equal(p.services.hs.running, true);
    assert.equal(p.services.hs.mem_mb, 88);
    assert.equal(p.services.hs.mem_peak_mb, 88);
    assert.equal(p.services.hs.limit_mb, 512);
    assert.equal(p.services.hs.restarts, 0);
    assert.equal(p.services.hs.oom, false);
    assert.equal(p.services.hs.blkio_write_kb, 0);
    assert.doesNotMatch(p.logs.hs, /x{32}/, 'what looks like a token is blanked');
    assert.doesNotMatch(p.logs.hs, /4915120000000/, 'and long numbers');
    assert.match(r.out, /Result: /);
    assert.equal(p.result, 'ok');
    assert.deepEqual(p.sockets, { hs: true, whatsapp: true });
  });
});
