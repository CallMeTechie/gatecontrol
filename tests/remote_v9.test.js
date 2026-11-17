'use strict';

// gc.remote, version 9 (plugin "Fernzugriff" 1.8, docs/plugins.md "Remote access"): GateControl's key onto a device —
// hostKeys.scan, installKey (an own account or root through sudo), testKey, removeKey —, tmux.list with windows and
// tmux.kill, device codes of the Linux agent (enrollment.create / status / revoke).
//
// The device is an ssh2 server on 127.0.0.1 that runs every command with the real `sh` of the test machine in a home
// directory of its own, with a fake `sudo` and a fake `tmux` in front of PATH — so the script that writes
// authorized_keys really runs, and the key test logs in with what it wrote (from= included).

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const supertest = require('supertest');
const { Server: SshServer, utils: sshUtils } = require('ssh2');
const { remotePackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

const ID = 'gatecontrol-remote';
// made-up test credentials
const KIM_PW = 'Wiese-Blau-4711';
const ROOT_SUDO_PW = 'Turm-Gelb-0815';
// sudo's password in the "ticket" case: run by a shell, it would leave a file behind
const CANARY_PW = 'x; touch "$HOME/pwned"; echo LEAKED';

let app, agent, csrf, plugins, db, adminId, targets, hostKeys, vault, sshkeys, keySetup, tmp, fakebin;
const call = async (api, args = {}) => (await agent.post(`/api/v1/plugins/${ID}/api/call`).set('X-CSRF-Token', csrf).send({ api, args }).expect(200)).body;
const pget = async (p) => (await agent.get(`/api/v1/plugins/${ID}/api${p}`).expect(200)).body;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const seen = []; // every answer, checked for secrets at the end

async function rcall(api, args) {
  const r = await call(api, args);
  seen.push(JSON.stringify(r));
  return r;
}

async function install(buf) {
  const r = await agent.post('/api/v1/plugins/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await agent.post('/api/v1/plugins/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}

// ─── the fake sudo and tmux ───

const FAKE_SUDO = `#!/bin/sh
N=0; V=0; HH=0
while [ $# -gt 0 ]; do
  case "$1" in
    -n) N=1 ;;
    -v) V=1 ;;
    -H) HH=1 ;;
    -S) ;;
    -p) shift ;;
    --) shift; break ;;
    -*) ;;
    *) break ;;
  esac
  shift
done
echo "sudo n=$N v=$V H=$HH $1" >> "$FAKE_LOG"
mode="$FAKE_SUDO_MODE"
if [ "$mode" = nosudo ]; then echo "sh: 1: sudo: not found" >&2; exit 127; fi
need=1
[ "$mode" = nopasswd ] && need=0
if [ $N = 1 ] && [ $need = 1 ]; then echo "sudo: a password is required" >&2; exit 1; fi
read_pw=$need
if [ "$mode" = ticket ] && [ $V = 0 ]; then read_pw=0; fi
if [ $read_pw = 1 ]; then
  IFS= read -r pw || pw=
  if [ "$pw" != "$FAKE_SUDO_PW" ]; then echo "Sorry, try again." >&2; echo "sudo: 1 incorrect password attempt" >&2; exit 1; fi
fi
if [ "$mode" = denied ]; then echo "kim is not in the sudoers file.  This incident will be reported." >&2; exit 1; fi
[ $V = 1 ] && exit 0
if [ $HH = 1 ]; then HOME="$FAKE_ROOT_HOME"; export HOME; fi
exec "$@"
`;

const FAKE_TMUX = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const file = process.env.FAKE_TMUX_STATE;
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, 'tmux ' + JSON.stringify(a) + '\\n');
const save = () => fs.writeFileSync(file, JSON.stringify(st));
const sub = (fmt, v) => fmt.replace(/#\\{([a-z_]+)\\}/g, (m, k) => (v[k] === undefined ? '' : String(v[k])));
const fmtOf = () => a[a.indexOf('-F') + 1];
if (a[0] === '-V') { console.log('tmux 3.3a'); process.exit(0); }
if (!st.sessions.length && a[0] !== '-V') { process.stderr.write('no server running on /tmp/tmux-0/default\\n'); process.exit(1); }
if (a[0] === 'ls') {
  for (const s of st.sessions) process.stdout.write(sub(fmtOf(), { session_name: s.name, session_windows: s.windows.length, session_attached: s.attached, session_created: s.created, session_activity: s.activity, session_id: s.id }) + '\\n');
  process.exit(0);
}
if (a[0] === 'list-windows') {
  for (const s of st.sessions) for (const w of s.windows) process.stdout.write(sub(fmtOf(), { session_id: s.id, window_id: w.id, window_index: w.index, window_active: w.active ? 1 : 0, window_panes: w.panes, pane_current_command: w.command, window_name: w.name }) + '\\n');
  process.exit(0);
}
if (a[0] === 'kill-session' && a[1] === '-t') {
  const i = st.sessions.findIndex((s) => s.id === a[2]);
  if (i < 0) { process.stderr.write("can't find session: " + a[2] + '\\n'); process.exit(1); }
  st.sessions.splice(i, 1); save(); process.exit(0);
}
if (a[0] === 'kill-window' && a[1] === '-t') {
  const s = st.sessions.find((x) => x.windows.some((w) => w.id === a[2]));
  if (!s) { process.stderr.write("can't find window: " + a[2] + '\\n'); process.exit(1); }
  s.windows = s.windows.filter((w) => w.id !== a[2]);
  if (!s.windows.length) st.sessions = st.sessions.filter((x) => x !== s);
  save(); process.exit(0);
}
process.exit(1);
`;

// ─── the device ───

const devices = new Map(); // target id → device
const pools = new Map(); // target id → pool id (a listener of a pool)

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}

/** The authorized_keys check of sshd: the key, and from= against 127.0.0.1 (the address in $SSH_CLIENT). */
function keyAllowed(home, key) {
  for (const line of readLines(path.join(home, '.ssh', 'authorized_keys'))) {
    const m = /(?:^|\s)(ssh-ed25519) ([A-Za-z0-9+/=]+)/.exec(line);
    if (!m) continue;
    if (!Buffer.from(m[2], 'base64').equals(key.data)) continue;
    const from = /from="([^"]*)"/.exec(line);
    if (from && !from[1].split(',').includes('127.0.0.1')) continue;
    return sshUtils.parseKey(`${m[1]} ${m[2]}`);
  }
  return null;
}

function device(name, opts = {}) {
  const o = { passwordAuth: true, kbdOnly: false, pubkeyAuth: true, windows: false, sudo: 'password', sudoPw: KIM_PW, ...opts };
  const dir = fs.mkdtempSync(path.join(tmp, name + '-'));
  const homes = { kim: path.join(dir, 'kim'), root: path.join(dir, 'root') };
  for (const h of Object.values(homes)) fs.mkdirSync(h, { recursive: true });
  const log = { auth: [], execs: [], passwords: 0 };
  const tmuxState = path.join(dir, 'tmux.json');
  const fakeLog = path.join(dir, 'fake.log');
  fs.writeFileSync(tmuxState, JSON.stringify({ sessions: [] }));
  const hostKey = sshkeys.generateEd25519(name).privateKey;
  const srv = new SshServer({ hostKeys: [hostKey] }, (client) => {
    let user = null;
    client.on('authentication', (ctx) => {
      log.auth.push(`${ctx.username}:${ctx.method}`);
      const home = homes[ctx.username];
      const methods = o.passwordAuth ? (o.kbdOnly ? ['publickey', 'keyboard-interactive'] : ['publickey', 'password']) : ['publickey'];
      if (!home) return ctx.reject(methods);
      if (ctx.method === 'password' && o.passwordAuth && !o.kbdOnly) {
        log.passwords++;
        if (ctx.username === 'kim' && ctx.password === KIM_PW) { user = 'kim'; return ctx.accept(); }
        return ctx.reject(methods);
      }
      if (ctx.method === 'keyboard-interactive' && o.passwordAuth && o.kbdOnly) {
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => {
          log.passwords++;
          if (ctx.username === 'kim' && answers[0] === KIM_PW) { user = 'kim'; return ctx.accept(); }
          return ctx.reject(methods);
        });
      }
      if (ctx.method === 'publickey' && o.pubkeyAuth) {
        const k = keyAllowed(home, ctx.key);
        if (k && (!ctx.signature || k.verify(ctx.blob, ctx.signature, ctx.hashAlgo))) { user = ctx.username; return ctx.accept(); }
      }
      return ctx.reject(methods);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const s = accept();
        s.on('exec', (ok, no, info) => {
          const ch = ok();
          log.execs.push(`${user}: ${info.command}`);
          if (o.windows) { ch.stderr.write("'sh' is not recognized as an internal or external command\r\n"); ch.exit(1); ch.end(); return; }
          const child = spawn('sh', ['-c', info.command], {
            cwd: homes[user],
            env: {
              PATH: `${fakebin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: homes[user], USER: user, SSH_CLIENT: '127.0.0.1 40022 22',
              FAKE_SUDO_MODE: o.sudo, FAKE_SUDO_PW: o.sudoPw, FAKE_ROOT_HOME: homes.root, FAKE_TMUX_STATE: tmuxState, FAKE_LOG: fakeLog,
            },
          });
          child.stdin.on('error', () => { /* closed early */ });
          ch.on('data', (d) => { try { child.stdin.write(d); } catch { /* closed */ } });
          ch.on('end', () => { try { child.stdin.end(); } catch { /* closed */ } });
          child.stdout.on('data', (d) => ch.write(d));
          child.stderr.on('data', (d) => ch.stderr.write(d));
          child.on('close', (code) => { try { ch.exit(code == null ? 1 : code); ch.end(); } catch { /* gone */ } });
        });
      });
    });
    client.on('error', () => { /* closed by the test */ });
  });
  const d = { name, srv, log, homes, tmuxState, fakeLog, opts: o, dir, port: null };
  d.keys = (who = 'kim') => readLines(path.join(homes[who], '.ssh', 'authorized_keys'));
  d.tmux = (st) => fs.writeFileSync(tmuxState, JSON.stringify(st));
  d.tmuxNow = () => JSON.parse(fs.readFileSync(tmuxState, 'utf8'));
  d.fake = () => readLines(fakeLog);
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => { d.port = srv.address().port; resolve(d); }));
}

async function dev(id, opts) {
  const d = await device(id, opts);
  devices.set(id, d);
  return d;
}

const target = (id) => ({ id, name: id, host: '192.0.2.10', port: 22 });
const scanned = async (id) => (await rcall('hostKeys.scan', { target: target(id) })).result;

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  plugins = require('../src/services/plugins');
  db = require('../src/db/connection').getDb();
  targets = require('../src/services/remote/targets');
  hostKeys = require('../src/services/remote/hostKeys');
  vault = require('../src/services/remote/vault');
  sshkeys = require('../src/services/remote/sshkeys');
  keySetup = require('../src/services/remote/keySetup');
  adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-remote-v9-'));
  fakebin = path.join(tmp, 'bin');
  fs.mkdirSync(fakebin);
  fs.writeFileSync(path.join(fakebin, 'sudo'), FAKE_SUDO, { mode: 0o755 });
  fs.writeFileSync(path.join(fakebin, 'tmux'), FAKE_TMUX, { mode: 0o755 });
  const orig = targets.endpoint;
  targets._origEndpoint = orig;
  targets.endpoint = async (plugin, t) => {
    const d = devices.get(t.id);
    if (!d) return orig(plugin, t);
    const poolId = pools.get(t.id) || null;
    return { host: '127.0.0.1', port: d.port, gatewayPeerId: null, poolId, lanHost: null, lanPort: null, listener: poolId ? 'pool-' + t.id : null };
  };
  await install(remotePackage());
  for (let i = 0; i < 50; i++) { try { if ((await pget('/has')).version >= 9) break; } catch { /* starting */ } await wait(100); }
});

after(async () => {
  targets.endpoint = targets._origEndpoint;
  for (const d of devices.values()) { try { d.srv.close(); } catch { /* closed */ } }
  await plugins.stop();
  teardown();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* left */ }
});

beforeEach(() => keySetup._resetForTest());

describe('version 9', () => {
  it('gc.remote.version is 9', async () => {
    assert.equal((await pget('/has')).version, 9);
  });
});

describe('hostKeys.scan: the host key without logging in', () => {
  it('unpinned, pinned and matching, pinned to another key', async () => {
    const d = await dev('dev-scan');
    const a = await scanned('dev-scan');
    assert.equal(a.alg, 'ssh-ed25519');
    assert.match(a.sha256, /^[A-Za-z0-9+/]{43}$/);
    assert.equal(a.pinned, false);
    assert.equal('matches' in a, false);
    assert.deepEqual(d.log.auth, [], 'no login at all');
    hostKeys.pin(ID, { targetId: 'dev-scan', alg: a.alg, sha256: a.sha256 });
    assert.deepEqual(await scanned('dev-scan'), { ...a, pinned: true, matches: true });
    hostKeys.pin(ID, { targetId: 'dev-scan', alg: a.alg, sha256: 'A'.repeat(43) });
    assert.equal((await scanned('dev-scan')).matches, false);
  });

  it('an unreachable target: ERR_REMOTE_UNREACHABLE', async () => {
    const d = await dev('dev-gone');
    await new Promise((r) => d.srv.close(r));
    const r = await rcall('hostKeys.scan', { target: target('dev-gone') });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ERR_REMOTE_UNREACHABLE');
  });
});

/** installKey with the confirmed fingerprint of the device. */
async function installed(id, opts = {}, { confirm = true } = {}) {
  const fp = confirm ? (await scanned(id)).sha256 : null;
  const r = await rcall('installKey', { target: target(id), opts: { login: { username: 'kim', password: KIM_PW }, ...(fp ? { hostKey: { confirm: fp } } : {}), ...opts } });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.result;
}

describe('installKey: the own account', () => {
  it('confirms the host key, writes the restricted line, tests it, stores the key and drops the password', async () => {
    const d = await dev('dev-12');
    fs.mkdirSync(path.join(d.homes.kim, '.ssh'));
    const foreign = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFak kim@laptop';
    fs.writeFileSync(path.join(d.homes.kim, '.ssh', 'authorized_keys'), foreign); // no newline at the end
    const cred = vault.put(ID, { username: 'kim', password: KIM_PW, label: 'appserver' });
    const r = await installed('dev-12', { credential: cred.handle });
    assert.equal(r.ok, true);
    assert.deepEqual(r.steps.map((s) => [s.id, s.state]), [['connect', 'done'], ['hostkey', 'done'], ['install', 'done'], ['test', 'done']]);
    assert.equal(r.steps[0].detail, 'password');
    assert.equal(r.steps[1].detail, 'confirmed');
    assert.ok(r.steps.every((s) => Number.isInteger(s.ms) && s.ms >= 0));
    assert.equal(r.error, undefined);
    assert.equal(r.account, 'self');
    assert.equal(r.user, 'kim');
    assert.deepEqual(r.from, ['127.0.0.1']);
    assert.equal(r.path, path.join(d.homes.kim, '.ssh', 'authorized_keys'));
    assert.equal(r.credential, cred.handle);
    assert.equal(r.attemptsLeft, 4);
    assert.equal(r.fingerprint.alg, 'ssh-ed25519');
    assert.match(r.publicKey, /^ssh-ed25519 \S+ gatecontrol:dev-12$/);
    assert.equal(r.line, `from="127.0.0.1",no-agent-forwarding,no-X11-forwarding,no-port-forwarding ${r.publicKey}`);
    assert.deepEqual(d.keys(), [foreign, r.line], 'the foreign line stays, GateControl\'s comes once');
    assert.equal(fs.statSync(path.join(d.homes.kim, '.ssh')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(r.path).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(path.join(d.homes.kim, '.ssh')).length, 1, 'no temp file left');
    // the host key: pinned as confirmed by a person
    const pin = hostKeys.get(ID, 'dev-12');
    assert.equal(pin.source, 'trust');
    assert.deepEqual(r.hostKey, { alg: pin.alg, sha256: pin.sha256 });
    // the vault: the key with its public half, the account, no password
    const meta = vault.info(ID, cred.handle);
    assert.equal(meta.kind, 'ssh_key');
    assert.deepEqual([meta.has.username, meta.has.password, meta.has.privateKey], [true, false, true]);
    assert.equal(meta.publicKey, r.publicKey);
    assert.equal(vault.resolve(ID, cred.handle).username, 'kim');
    // the script and the line came over stdin, never on a command line
    assert.ok(d.log.execs.every((c) => !c.includes('ssh-ed25519') && !c.includes(KIM_PW)), JSON.stringify(d.log.execs));
    assert.equal(d.log.passwords, 1);
    assert.ok(d.log.auth.includes('kim:publickey'), 'the key test');
  });

  it('again: the same key is reused, the old line replaced (still one), no confirmation needed once pinned', async () => {
    const d = devices.get('dev-12');
    const before = d.keys();
    const handle = vault.list(ID).find((m) => m.publicKey && m.publicKey.endsWith('gatecontrol:dev-12')).handle;
    const first = vault.info(ID, handle).publicKey;
    const r = await rcall('installKey', { target: target('dev-12'), opts: { credential: handle, login: { username: 'kim', password: KIM_PW } } });
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.steps[1].detail, 'pinned');
    assert.equal(r.result.steps[2].detail, 'replaced the old line');
    assert.equal(r.result.publicKey, first);
    assert.deepEqual(d.keys(), before);
  });

  it('without a credential: a new entry without the password; restrictFrom false: no from=; keepPassword keeps a stored one', async () => {
    const d = await dev('dev-13');
    const r = await installed('dev-13', { restrictFrom: false });
    assert.deepEqual(r.from, []);
    assert.ok(r.line.startsWith('no-agent-forwarding,no-X11-forwarding,no-port-forwarding ssh-ed25519 '));
    assert.deepEqual(d.keys(), [r.line]);
    const meta = vault.info(ID, r.credential);
    assert.deepEqual([meta.has.username, meta.has.password, meta.has.privateKey, meta.label], [true, false, true, 'dev-13']);
    await dev('dev-14');
    const cred = vault.put(ID, { username: 'kim', password: KIM_PW });
    const k = await installed('dev-14', { credential: cred.handle, login: {}, keepPassword: true });
    assert.equal(k.credential, cred.handle);
    assert.deepEqual([vault.info(ID, cred.handle).has.password, vault.info(ID, cred.handle).has.privateKey], [true, true]);
    // the comment of the key line (vault.generate comment, version 9)
    const g = await rcall('vault.generate', { comment: 'gatecontrol:dev-99', label: 'x' });
    assert.match(g.result.publicKey, / gatecontrol:dev-99$/);
  });

  it('keyboard-interactive only: the password goes there', async () => {
    const d = await dev('dev-kbd', { kbdOnly: true });
    const r = await installed('dev-kbd');
    assert.equal(r.steps[0].detail, 'keyboard-interactive');
    assert.equal(d.keys().length, 1);
  });

  it('a pool listener: from= carries every gateway of the pool and what the device saw', async () => {
    for (const [id, ip] of [[71, '192.168.2.10'], [72, '192.168.2.11']]) {
      db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (?, ?, ?, 'gateway', ?, 1)").run(id, 'gw' + id, 'pk-gw-' + id, `10.8.0.${id}/32`);
      db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, last_seen_at, created_at, lan_ip)
        VALUES (?, 9876, 'h', 'e', 1, ?, ?, ?)`).run(id, Date.now(), Date.now(), ip);
    }
    const poolId = Number(db.prepare("INSERT INTO gateway_pools (name, failback_cooldown_s) VALUES ('Zuhause', 60)").run().lastInsertRowid);
    db.prepare('INSERT INTO gateway_pool_members (pool_id, peer_id, priority) VALUES (?, 71, 1), (?, 72, 2)').run(poolId, poolId);
    const d = await dev('dev-pool');
    pools.set('dev-pool', poolId);
    const r = await installed('dev-pool');
    assert.deepEqual(r.from, ['127.0.0.1', '192.168.2.10', '192.168.2.11']);
    assert.ok(d.keys()[0].startsWith('from="127.0.0.1,192.168.2.10,192.168.2.11",'));
    assert.deepEqual(keySetup.fromAddresses({ poolId, listener: 'x' }, null), ['192.168.2.10', '192.168.2.11']);
    assert.deepEqual(keySetup.fromAddresses({ poolId: null, listener: null }, null), [targets.hubIp()]);
  });
});

describe('installKey: the host key comes first — no password to a key not confirmed', () => {
  it('unpinned without confirm, a wrong fingerprint, a changed key', async () => {
    const d = await dev('dev-hk');
    const r1 = (await rcall('installKey', { target: target('dev-hk'), opts: { login: { username: 'kim', password: KIM_PW } } })).result;
    assert.equal(r1.ok, false);
    assert.deepEqual(r1.error, { code: 'host_key_unpinned', step: 'hostkey' });
    assert.deepEqual(r1.steps.map((s) => s.state), ['skip', 'fail', 'skip', 'skip']);
    assert.ok(r1.hostKey && r1.hostKey.sha256);
    const r2 = (await rcall('installKey', { target: target('dev-hk'), opts: { login: { username: 'kim', password: KIM_PW }, hostKey: { confirm: 'B'.repeat(43) } } })).result;
    assert.deepEqual(r2.error, { code: 'host_key_rejected', step: 'hostkey' });
    assert.equal(hostKeys.get(ID, 'dev-hk'), null);
    hostKeys.pin(ID, { targetId: 'dev-hk', alg: 'ssh-ed25519', sha256: 'C'.repeat(43) });
    const r3 = (await rcall('installKey', { target: target('dev-hk'), opts: { login: { username: 'kim', password: KIM_PW }, hostKey: { confirm: r1.hostKey.sha256 } } })).result;
    assert.deepEqual(r3.error, { code: 'host_key_mismatch', step: 'hostkey' });
    assert.equal(d.log.passwords, 0);
    assert.ok(!d.log.auth.some((a) => a.endsWith(':password')), JSON.stringify(d.log.auth));
    assert.deepEqual(d.keys(), []);
    assert.equal(r3.attemptsLeft, 2);
  });
});

describe('installKey: errors with their step', () => {
  it('a wrong password; at most 5 attempts in 10 minutes per target', async () => {
    const d = await dev('dev-pw');
    const fp = (await scanned('dev-pw')).sha256;
    const one = async () => (await rcall('installKey', { target: target('dev-pw'), opts: { login: { username: 'kim', password: 'Falsch-123' }, hostKey: { confirm: fp } } })).result;
    const r = await one();
    assert.deepEqual(r.error, { code: 'auth_failed', step: 'connect' });
    assert.deepEqual(r.steps.map((s) => s.state), ['fail', 'done', 'skip', 'skip']);
    assert.equal(r.attemptsLeft, 4);
    for (let i = 0; i < 4; i++) await one();
    const six = await one();
    assert.deepEqual(six.error, { code: 'rate_limited', step: null });
    assert.equal(six.attemptsLeft, 0);
    assert.ok(six.retryAfter > 500 && six.retryAfter <= 600);
    assert.equal(d.log.passwords, 5);
    // another target is not limited by it
    await dev('dev-pw2');
    assert.equal((await installed('dev-pw2')).ok, true);
  });

  it('password login off: found before a password is sent, the line to put in by hand, then testKey', async () => {
    const d = await dev('dev-nopw', { passwordAuth: false });
    const fp = (await scanned('dev-nopw')).sha256;
    const r = (await rcall('installKey', { target: target('dev-nopw'), opts: { login: { username: 'kim', password: KIM_PW }, hostKey: { confirm: fp } } })).result;
    assert.deepEqual(r.error, { code: 'password_auth_off', step: 'connect' });
    assert.equal(d.log.passwords, 0);
    assert.deepEqual(d.log.auth, ['kim:none']);
    assert.equal(r.fromGuessed, true);
    assert.deepEqual(r.from, [targets.hubIp()]);
    assert.match(r.line, /^from="[0-9.]+",no-agent-forwarding,no-X11-forwarding,no-port-forwarding ssh-ed25519 \S+ gatecontrol:dev-nopw$/);
    assert.equal(vault.info(ID, r.credential).publicKey, r.publicKey);
    // before the line is there
    const t0 = (await rcall('testKey', { target: target('dev-nopw'), credential: r.credential })).result;
    assert.deepEqual(t0.error, { code: 'key_test_failed', step: 'connect' });
    // the person puts it in at the console (from= as the device sees it)
    fs.mkdirSync(path.join(d.homes.kim, '.ssh'));
    fs.writeFileSync(path.join(d.homes.kim, '.ssh', 'authorized_keys'), r.line.replace(/from="[^"]+"/, 'from="127.0.0.1"') + '\n');
    const t1 = (await rcall('testKey', { target: target('dev-nopw'), credential: r.credential })).result;
    assert.equal(t1.ok, true, JSON.stringify(t1));
    assert.deepEqual(t1.steps.map((s) => [s.id, s.state]), [['connect', 'done'], ['hostkey', 'done']]);
  });

  it('not a POSIX shell (Windows OpenSSH): not_posix, the line for the copy path', async () => {
    await dev('dev-win', { windows: true });
    const r = await rcall('installKey', { target: target('dev-win'), opts: { login: { username: 'kim', password: KIM_PW }, hostKey: { confirm: (await scanned('dev-win')).sha256 } } });
    assert.deepEqual(r.result.error, { code: 'not_posix', step: 'install' });
    assert.ok(r.result.line);
    assert.deepEqual(r.result.steps.map((s) => s.state), ['done', 'done', 'fail', 'skip']);
  });

  it('authorized_keys cannot be written: write_failed with the device\'s message', async () => {
    const d = await dev('dev-ro');
    fs.writeFileSync(path.join(d.homes.kim, '.ssh'), 'not a directory');
    const r = (await rcall('installKey', { target: target('dev-ro'), opts: { login: { username: 'kim', password: KIM_PW }, hostKey: { confirm: (await scanned('dev-ro')).sha256 } } })).result;
    assert.deepEqual(r.error, { code: 'write_failed', step: 'install' });
    assert.ok(r.steps[2].detail && r.steps[2].detail.length <= 200, JSON.stringify(r.steps[2]));
  });

  it('the key is not accepted: key_test_failed, the line taken out again, the vault unchanged', async () => {
    const d = await dev('dev-nokey', { pubkeyAuth: false });
    fs.mkdirSync(path.join(d.homes.kim, '.ssh'));
    // an older line of GateControl (another key) is put back as it was
    fs.writeFileSync(path.join(d.homes.kim, '.ssh', 'authorized_keys'), 'ssh-rsa AAAAB3Nza kim@old\nfrom="10.8.0.1" ssh-ed25519 AAAAC3OldOldOld gatecontrol:dev-nokey\n');
    const cred = vault.put(ID, { username: 'kim', password: KIM_PW });
    const r = (await rcall('installKey', { target: target('dev-nokey'), opts: { credential: cred.handle, login: { password: KIM_PW }, hostKey: { confirm: (await scanned('dev-nokey')).sha256 } } })).result;
    assert.deepEqual(r.error, { code: 'key_test_failed', step: 'test' });
    assert.equal(r.rolledBack, true);
    assert.match(r.steps[3].detail, /line removed again/);
    assert.deepEqual(d.keys(), ['ssh-rsa AAAAB3Nza kim@old', 'from="10.8.0.1" ssh-ed25519 AAAAC3OldOldOld gatecontrol:dev-nokey']);
    const meta = vault.info(ID, cred.handle);
    assert.deepEqual([meta.has.password, meta.has.privateKey], [true, false]);
  });

  it('an own key in the vault: own_key unless replaceOwnKey', async () => {
    await dev('dev-own');
    const own = sshkeys.generateEd25519('mine');
    const cred = vault.put(ID, { username: 'kim', privateKey: own.privateKey });
    const r = (await rcall('installKey', { target: target('dev-own'), opts: { credential: cred.handle, login: { password: KIM_PW } } })).result;
    assert.deepEqual(r.error, { code: 'own_key', step: null });
    assert.deepEqual(r.steps.map((s) => s.state), ['skip', 'skip', 'skip', 'skip']);
    const r2 = await installed('dev-own', { credential: cred.handle, replaceOwnKey: true });
    assert.notEqual(r2.publicKey.split(' ')[1], own.publicKey.split(' ')[1]);
  });

  it('invalid input is thrown', async () => {
    await dev('dev-inv');
    for (const opts of [
      { login: { username: 'kim', password: 'a\nb' } },
      { login: { username: 'kim; rm -rf', password: KIM_PW } },
      { login: { username: 'kim', password: KIM_PW }, account: 'admin' },
      { login: { username: 'kim', password: KIM_PW }, sudoPassword: 'x' },
      { login: { username: 'kim', password: KIM_PW }, hostKey: { confirm: 'short' } },
      { login: { username: 'kim' } },
    ]) {
      const r = await rcall('installKey', { target: target('dev-inv'), opts });
      assert.equal(r.code, 'ERR_INVALID', JSON.stringify(opts));
    }
    const r = await rcall('installKey', { target: target('dev-inv'), opts: { credential: 'rv_' + '0'.repeat(32), login: { username: 'kim', password: KIM_PW } } });
    assert.equal(r.code, 'ERR_REMOTE_CREDENTIAL_NOT_FOUND');
  });
});

describe('installKey: root through sudo', () => {
  const asRoot = (id, extra = {}) => installed(id, { account: 'root', ...extra });
  const rootTry = async (id, extra = {}) => (await rcall('installKey', { target: target(id), opts: { login: { username: 'kim', password: KIM_PW }, account: 'root', hostKey: { confirm: (await scanned(id)).sha256 }, ...extra } })).result;

  it('sudo with the password of the account: the line in root\'s file, the test logs in as root', async () => {
    const d = await dev('dev-root');
    const r = await asRoot('dev-root');
    assert.equal(r.account, 'root');
    assert.equal(r.user, 'root');
    assert.equal(r.path, path.join(d.homes.root, '.ssh', 'authorized_keys'));
    assert.deepEqual(d.keys('root'), [r.line]);
    assert.deepEqual(d.keys('kim'), []);
    assert.ok(d.log.auth.includes('root:publickey'));
    assert.equal(vault.resolve(ID, r.credential).username, 'root');
    assert.ok(d.fake().some((l) => l.startsWith('sudo n=0 v=0 H=1 sh')), d.fake().join('\n'));
  });

  it('sudo wants another password: sudo_password, then with sudoPassword', async () => {
    const d = await dev('dev-rootpw', { sudoPw: ROOT_SUDO_PW });
    const r = await rootTry('dev-rootpw');
    assert.deepEqual(r.error, { code: 'sudo_password', step: 'install' });
    assert.deepEqual(r.steps.map((s) => s.state), ['done', 'done', 'fail', 'skip']);
    assert.deepEqual(d.keys('root'), []);
    const ok = await asRoot('dev-rootpw', { sudoPassword: ROOT_SUDO_PW });
    assert.deepEqual(d.keys('root'), [ok.line]);
  });

  it('the account may not use sudo: sudo_denied; no sudo at all too', async () => {
    await dev('dev-denied', { sudo: 'denied' });
    assert.deepEqual((await rootTry('dev-denied')).error, { code: 'sudo_denied', step: 'install' });
    await dev('dev-nosudo', { sudo: 'nosudo' });
    const r = await rootTry('dev-nosudo');
    assert.deepEqual(r.error, { code: 'sudo_denied', step: 'install' });
    assert.equal(r.steps[2].detail, 'sudo is not installed');
  });

  it('sudo without a password (NOPASSWD): no password line at all', async () => {
    const d = await dev('dev-nopasswd', { sudo: 'nopasswd' });
    const r = await asRoot('dev-nopasswd');
    assert.deepEqual(d.keys('root'), [r.line]);
  });

  it('a sudo ticket in between: the password line is dropped, never run by a shell', async () => {
    const d = await dev('dev-ticket', { sudo: 'ticket', sudoPw: CANARY_PW });
    const r = await asRoot('dev-ticket', { sudoPassword: CANARY_PW });
    assert.deepEqual(d.keys('root'), [r.line]);
    assert.equal(fs.existsSync(path.join(d.homes.root, 'pwned')), false);
    assert.equal(fs.existsSync(path.join(d.homes.kim, 'pwned')), false);
    assert.ok(!JSON.stringify(r).includes('LEAKED'));
  });
});

describe('removeKey', () => {
  it('logs in with the key and takes only GateControl\'s line out; again: found false', async () => {
    const d = devices.get('dev-12');
    const handle = vault.list(ID).find((m) => m.publicKey && m.publicKey.endsWith('gatecontrol:dev-12')).handle;
    const r = await rcall('removeKey', { target: target('dev-12'), credential: handle });
    assert.deepEqual(r.result, { removedRemote: true, found: true, path: path.join(d.homes.kim, '.ssh', 'authorized_keys') });
    assert.equal(d.keys().length, 1);
    assert.ok(!d.keys()[0].includes('gatecontrol:'));
    // the key no longer gets in
    const again = await rcall('removeKey', { target: target('dev-12'), credential: handle });
    assert.deepEqual(again.result, { removedRemote: false, reason: 'auth_failed' });
  });

  it('a device that is gone: removedRemote false, reason unreachable', async () => {
    const d = await dev('dev-off');
    const r = await installed('dev-off');
    await new Promise((res) => d.srv.close(res));
    const x = await rcall('removeKey', { target: target('dev-off'), credential: r.credential });
    assert.deepEqual(x.result, { removedRemote: false, reason: 'unreachable' });
  });

  it('a key line of root: removed as root', async () => {
    const d = devices.get('dev-root');
    const handle = vault.list(ID).find((m) => m.publicKey && m.publicKey.endsWith('gatecontrol:dev-root')).handle;
    const r = await rcall('removeKey', { target: target('dev-root'), credential: handle });
    assert.equal(r.result.removedRemote, true);
    assert.deepEqual(d.keys('root'), []);
  });

  it('an entry without a key: ERR_REMOTE_CREDENTIAL_REQUIRED', async () => {
    const cred = vault.put(ID, { username: 'kim', password: KIM_PW });
    const r = await rcall('removeKey', { target: target('dev-13'), credential: cred.handle });
    assert.equal(r.code, 'ERR_REMOTE_CREDENTIAL_REQUIRED');
  });
});

describe('the script', () => {
  it('only a checked comment; a line break in the line is refused', () => {
    assert.throws(() => keySetup.keyScript("gatecontrol:x'; rm -rf /; '", null), /comment/);
    assert.throws(() => keySetup.keyScript('gatecontrol:dev-1', 'a\nb'), /line/);
    assert.throws(() => keySetup.keyScript('gatecontrol:dev-1', 'ssh-ed25519 AAAA other'), /line/);
    assert.throws(() => keySetup.keyScript('gatecontrol:dev-1', ['GC_KEY_LINE']), /line/);
    const s = keySetup.keyScript('gatecontrol:dev-1', 'ssh-ed25519 AAAA gatecontrol:dev-1');
    assert.match(s, /^umask 077\n/);
    assert.match(s, /restorecon/);
  });

  it('scrub: control characters out, a message with a secret withheld as a whole', () => {
    assert.equal(keySetup.scrub('sudo:\x1b[31m  wrong\n', [KIM_PW]), 'sudo: [31m wrong');
    assert.equal(keySetup.scrub(`sudo: ${KIM_PW} wrong`, [KIM_PW, null]), 'the message of the device was withheld');
  });
});

describe('tmux: windows and kill', () => {
  const STATE = () => ({
    sessions: [
      { id: '$1', name: 'gc-appserver', created: 1731700000, activity: 1731700300, attached: 0, windows: [
        { id: '@1', index: 0, name: 'bash', active: false, panes: 1, command: 'bash' },
        { id: '@2', index: 1, name: 'logs', active: true, panes: 2, command: 'journalctl' },
      ] },
      { id: '$2', name: 'kims build', created: 1731600000, activity: 1731600100, attached: 1, windows: [
        { id: '@5', index: 0, name: 'make', active: true, panes: 1, command: 'make' },
      ] },
    ],
  });
  let d;
  let cred;
  const list = async () => (await rcall('tmux.listWindows', { target: target('dev-tmux'), credential: cred })).result;
  const kill = (session, window) => rcall('tmux.kill', { target: target('dev-tmux'), credential: cred, session, ...(window ? { window } : {}) });

  before(async () => {
    d = await dev('dev-tmux');
    const r = await installed('dev-tmux');
    cred = r.credential;
  });

  it('list with windows: ids, windows with index, name, active, panes, command; the old answer unchanged', async () => {
    d.tmux(STATE());
    const l = await list();
    assert.deepEqual(l, [
      { name: 'gc-appserver', windowCount: 2, attached: 0, created: new Date(1731700000e3).toISOString(), activity: new Date(1731700300e3).toISOString(), attachable: true, id: '$1', windows: [
        { id: '@1', index: 0, name: 'bash', active: false, panes: 1, command: 'bash' },
        { id: '@2', index: 1, name: 'logs', active: true, panes: 2, command: 'journalctl' },
      ] },
      { name: 'kims build', windowCount: 1, attached: 1, created: new Date(1731600000e3).toISOString(), activity: new Date(1731600100e3).toISOString(), attachable: false, id: '$2', windows: [
        { id: '@5', index: 0, name: 'make', active: true, panes: 1, command: 'make' },
      ] },
    ]);
    const old = (await rcall('tmux.list', { target: target('dev-tmux'), credential: cred })).result;
    assert.deepEqual(old.map((s) => [s.name, s.windows, s.id]), [['gc-appserver', 2, undefined], ['kims build', 1, undefined]]);
  });

  it('kill a session with a space in its name — by its id', async () => {
    d.tmux(STATE());
    const [, s] = await list();
    const r = await kill({ id: s.id, name: s.name, created: s.created });
    assert.deepEqual(r.result, { killed: 'session', session: '$2', window: null, sessionEnded: true });
    assert.deepEqual(d.tmuxNow().sessions.map((x) => x.id), ['$1']);
    assert.ok(d.fake().includes('tmux ["kill-session","-t","$2"]'), d.fake().join('\n'));
  });

  it('kill a window; the last window ends the session', async () => {
    d.tmux(STATE());
    const [s] = await list();
    const r = await kill({ id: s.id, name: s.name, created: s.created }, { id: '@2', index: 1 });
    assert.deepEqual(r.result, { killed: 'window', session: '$1', window: '@2', sessionEnded: false });
    assert.deepEqual(d.tmuxNow().sessions[0].windows.map((w) => w.id), ['@1']);
    const r2 = await kill({ id: s.id, name: s.name, created: s.created }, { id: '@1', index: 0 });
    assert.equal(r2.result.sessionEnded, true);
  });

  it('gone and changed: nothing is killed', async () => {
    d.tmux(STATE());
    const [s] = await list();
    const kills = () => d.fake().filter((l) => l.includes('"kill-')).length;
    const k0 = kills();
    assert.equal((await kill({ id: '$9', name: 'x', created: null })).code, 'ERR_REMOTE_TMUX_GONE');
    assert.equal((await kill({ id: s.id, name: 'other', created: s.created })).code, 'ERR_REMOTE_TMUX_CHANGED');
    assert.equal((await kill({ id: s.id, name: s.name, created: new Date(0).toISOString() })).code, 'ERR_REMOTE_TMUX_CHANGED');
    assert.equal((await kill({ id: s.id, name: s.name, created: s.created }, { id: '@7', index: 0 })).code, 'ERR_REMOTE_TMUX_GONE');
    assert.equal((await kill({ id: s.id, name: s.name, created: s.created }, { id: '@1', index: 3 })).code, 'ERR_REMOTE_TMUX_CHANGED');
    assert.deepEqual(d.tmuxNow(), STATE());
    assert.equal(kills(), k0, 'no kill command ran');
  });

  it('only ids as targets: anything else is ERR_INVALID before connecting', async () => {
    const n = d.log.auth.length;
    for (const [session, window] of [
      [{ id: 'gc-appserver', name: 'gc-appserver', created: null }],
      [{ id: "$1'; touch /tmp/x; '", name: 'a', created: null }],
      [{ id: '$1234567', name: 'a', created: null }],
      [{ id: '$1', name: 'a', created: null }, { id: '1', index: 0 }],
      [{ id: '$1', name: 'a', created: 'yesterday' }],
    ]) {
      assert.equal((await kill(session, window)).code, 'ERR_INVALID', JSON.stringify([session, window]));
    }
    assert.equal(d.log.auth.length, n);
  });

  it('an unpinned host key: no list, no kill', async () => {
    hostKeys.remove(ID, 'dev-tmux');
    assert.equal((await kill({ id: '$1', name: 'gc-appserver', created: null })).code, 'ERR_REMOTE_HOST_KEY_UNPINNED');
    assert.equal((await rcall('tmux.listWindows', { target: target('dev-tmux'), credential: cred })).code, 'ERR_REMOTE_HOST_KEY_UNPINNED');
  });

  it('parsing: control characters and tabs in names, bad ids dropped', () => {
    const term = require('../src/services/remote/term');
    const w = term.parseTmuxWindows('$1\t@1\t0\t1\t1\tbash\tna\tme\n$x\t@2\t0\t0\t1\tsh\tbad\n$1\t@3\t1\t0\t1\tvi\tx\u001b[2J\n');
    assert.deepEqual(w.get('$1').map((x) => [x.id, x.name]), [['@1', 'name'], ['@3', 'x[2J']]);
    const s = term.parseTmuxListWindows('a\tb\t1\t0\t1\t2\t$4\nnoid\t1\t0\t1\t2\tfoo\n', '');
    assert.deepEqual(s.map((x) => [x.name, x.id]), [['ab', '$4']]);
  });
});

describe('enrollment: device codes of the Linux agent, followed by a ticket', () => {
  let ticket, code;

  it('create: only for an administrator in a request — for himself by default', async () => {
    const r = await rcall('enrollment.create', { actorId: adminId, name: 'appserver' });
    assert.equal(r.ok, true, JSON.stringify(r));
    ({ ticket, code } = r.result);
    assert.match(ticket, /^ce_[0-9a-f]{32}$/);
    assert.match(code, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    assert.ok(Date.parse(r.result.expiresAt) > Date.now() + 9 * 60e3);
    assert.equal(r.result.url, new URL(require('../config/default').app.baseUrl).origin);
    const row = db.prepare('SELECT * FROM client_enrollment_codes WHERE ticket = ?').get(ticket);
    assert.deepEqual([row.user_id, row.ticket_plugin, row.kind, row.token_name], [adminId, ID, 'device', 'appserver']);
    const log = db.prepare("SELECT source FROM activity_log WHERE event_type = 'client_enrollment_created' ORDER BY id DESC LIMIT 1").get();
    assert.equal(log.source, 'plugin:' + ID);
    assert.equal((await rcall('enrollment.status', { ticket })).result.state, 'waiting');
  });

  it('not an administrator, not in his request, a disabled owner: refused', async () => {
    const userId = Number(db.prepare("INSERT INTO users (username, password_hash, role, enabled) VALUES ('lena', 'x', 'user', 1)").run().lastInsertRowid);
    assert.equal((await rcall('enrollment.create', { actorId: userId })).code, 'ERR_REMOTE_FORBIDDEN');
    assert.throws(() => require('../src/services/remote/enrollment').create({ id: ID }, { actorId: adminId }), (e) => e.code === 'forbidden');
    db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(userId);
    assert.equal((await rcall('enrollment.create', { actorId: adminId, userId })).code, 'ERR_REMOTE_USER_DISABLED');
    assert.equal((await rcall('enrollment.create', { actorId: adminId, userId: 999999 })).code, 'ERR_NOT_FOUND');
    assert.equal((await rcall('enrollment.create', { actorId: 'x' })).code, 'ERR_INVALID');
  });

  it('redeemed by the agent: peer, VPN address, token device, platform; the handshake after it', async () => {
    const red = await supertest(app).post('/api/v1/client/enroll').send({ code, hostname: 'appserver', platform: 'linux', clientVersion: '1.0.0' });
    assert.equal(red.status, 200, JSON.stringify(red.body));
    const sr = await rcall('enrollment.status', { ticket });
    assert.equal(sr.ok, true, JSON.stringify(sr));
    const st = sr.result;
    assert.equal(st.state, 'redeemed');
    assert.equal(st.peerId, red.body.peerId);
    assert.equal(st.peerName, 'appserver');
    assert.match(st.vpnIp, /^10\.8\.0\.\d+$/);
    assert.equal(st.platform, 'linux');
    const tok = db.prepare('SELECT id, peer_id FROM api_tokens WHERE id = ?').get(st.tokenDeviceId);
    assert.equal(tok.peer_id, st.peerId);
    assert.equal(st.handshakeAt, null);
    const hs = Math.floor(Date.now() / 1000);
    db.prepare('UPDATE peers SET latest_handshake = ? WHERE id = ?').run(hs, st.peerId);
    assert.equal((await rcall('enrollment.status', { ticket })).result.handshakeAt, new Date(hs * 1000).toISOString());
    // revoke after the redeem changes nothing
    assert.deepEqual((await rcall('enrollment.revoke', { ticket })).result, { revoked: false, state: 'redeemed' });
  });

  it('revoke: the code dies, the agent gets invalid_or_expired', async () => {
    const r = (await rcall('enrollment.create', { actorId: adminId, name: 'nas' })).result;
    assert.deepEqual((await rcall('enrollment.revoke', { ticket: r.ticket })).result, { revoked: true, state: 'revoked' });
    const red = await supertest(app).post('/api/v1/client/enroll').send({ code: r.code, hostname: 'nas', platform: 'linux' });
    assert.equal(red.status, 400);
    assert.equal((await rcall('enrollment.status', { ticket: r.ticket })).result.state, 'revoked');
  });

  it('expired; kept for a day although expired codes are cleaned up; unknown and malformed tickets', async () => {
    const r = (await rcall('enrollment.create', { actorId: adminId })).result;
    db.prepare('UPDATE client_enrollment_codes SET expires_at = ? WHERE ticket = ?').run(Date.now() - 1000, r.ticket);
    require('../src/services/clientEnrollment').purgeExpired(db);
    assert.equal((await rcall('enrollment.status', { ticket: r.ticket })).result.state, 'expired');
    db.prepare('UPDATE client_enrollment_codes SET created_at = ? WHERE ticket = ?').run(Date.now() - 25 * 3600e3, r.ticket);
    require('../src/services/clientEnrollment').purgeExpired(db);
    assert.equal((await rcall('enrollment.status', { ticket: r.ticket })).code, 'ERR_NOT_FOUND');
    assert.equal((await rcall('enrollment.status', { ticket: 'ce_' + 'f'.repeat(32) })).code, 'ERR_NOT_FOUND');
    assert.equal((await rcall('enrollment.revoke', { ticket: 'nope' })).code, 'ERR_INVALID');
    // a ticket of another plugin is not this plugin's
    const other = require('../src/services/remote/enrollment');
    assert.throws(() => other.status({ id: 'another-plugin' }, ticket), (e) => e.code === 'not_found');
  });

  it('the migration', () => {
    const m = require('../src/db/migrationList').migrations.find((x) => x.name === 'client_enrollment_tickets');
    assert.equal(m.version, 157);
    assert.equal(m.detect(db), true);
  });
});

describe('secrets', () => {
  it('no password in any answer, the activity log or the vault metadata', () => {
    const all = seen.join('\n');
    for (const pw of [KIM_PW, ROOT_SUDO_PW, CANARY_PW]) assert.ok(!all.includes(pw), 'an answer carries a password');
    const logs = db.prepare('SELECT message, details FROM activity_log').all().map((r) => r.message + ' ' + (r.details || '')).join('\n');
    for (const pw of [KIM_PW, ROOT_SUDO_PW, CANARY_PW]) assert.ok(!logs.includes(pw), 'the activity log carries a password');
  });
});
