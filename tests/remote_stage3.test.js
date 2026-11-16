'use strict';

// gc.remote, version 3 (stage 3 of the plugin "Fernzugriff", docs/plugins.md "Remote access",
// docs/feature-remote-access.md): the SSH terminal of the core (ssh2, gc-term.v1 on
// /api/v1/remote/ssh-tunnel), tmux, pinned host keys (trust on first use with a confirmation, a
// different key blocks), keys made in the vault, recordings (asciicast of the terminal, guacd's
// files sealed on the drive), playback through the session page, the native app token, and the
// drive in docker-compose.yml / update.sh. A real ssh2 server on 127.0.0.1 plays the device.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const supertest = require('supertest');
const WebSocket = require('ws');
const { Server: SshServer, utils: sshUtils } = require('ssh2');
const { remotePackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

const ID = 'gatecontrol-remote';
const PASSWORD = 'Ssh-Geheim-91c2!';
const USERNAME = 'ops';
const ROOT = path.join(__dirname, '..');

let app, agent, csrf, plugins, db, adminId, sessions, term, recordings, hostKeys, sshkeys, targets, server, port;
const call = async (api, args = {}) => (await agent.post(`/api/v1/plugins/${ID}/api/call`).set('X-CSRF-Token', csrf).send({ api, args }).expect(200)).body;
const pget = async (p) => (await agent.get(`/api/v1/plugins/${ID}/api${p}`).expect(200)).body;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── the device: an ssh2 server ───
const devices = new Map(); // target id → { port, server, log }
const TMUX_LS = 'work\t2\t1\t1731700000\t1731700300\nmy notes\t1\t0\t1731600000\t1731600100\n';

function sshDevice(hostKeyPem, { tmux = true } = {}) {
  const log = { execs: [], shells: 0, auth: [] };
  const srv = new SshServer({ hostKeys: [hostKeyPem] }, (client) => {
    client.on('authentication', (ctx) => {
      const pubOk = srv._pubKey;
      log.auth.push(ctx.method);
      if (ctx.method === 'password' && ctx.username === USERNAME && ctx.password === PASSWORD) return ctx.accept();
      if (ctx.method === 'publickey' && ctx.username === USERNAME && pubOk) {
        const k = sshUtils.parseKey(pubOk);
        if (ctx.key.algo === k.type && ctx.key.data.equals(k.getPublicSSH())) {
          if (!ctx.signature) return ctx.accept();
          if (k.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.accept();
        }
      }
      return ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const s = accept();
        s.on('pty', (ok) => { if (ok) ok(); });
        s.on('window-change', (ok, no, info) => { log.resized = info; if (ok) ok(); });
        s.on('exec', (ok, no, info) => {
          const ch = ok();
          log.execs.push(info.command);
          if (info.command === 'tmux -V') { if (tmux) { ch.write('tmux 3.3a\n'); ch.exit(0); } else ch.exit(127); ch.end(); return; }
          if (info.command.startsWith('tmux ls -F')) { if (tmux) { ch.write(TMUX_LS); ch.exit(0); } else ch.exit(127); ch.end(); return; }
          if (info.command.startsWith('tmux new -A -s ')) {
            ch.write('[tmux ' + info.command.slice('tmux new -A -s '.length) + ']\r\n');
            ch.on('data', (d) => { if (String(d).includes('exit')) { ch.exit(0); ch.end(); } else ch.write('> ' + d); });
            return;
          }
          ch.exit(127);
          ch.end();
        });
        s.on('shell', (ok) => {
          const ch = ok();
          log.shells++;
          ch.write('$ ');
          ch.on('data', (d) => { if (String(d).includes('exit')) { ch.exit(0); ch.end(); } else ch.write('> ' + d); });
        });
      });
    });
    client.on('error', () => { /* the test closed it */ });
  });
  // publickey: the server learns the key the test generated (srv._pubKey)
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, log })));
}

function pageCfg(html, id) {
  const m = html.match(new RegExp(`id="${id}"[^>]*>([^<]+)<`));
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, '&'));
}

/** A WebSocket client of gc-term.v1 that keeps what came. */
function termClient(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/remote/ssh-tunnel`, ['gc-term.v1', 'token.' + token]);
  const c = { ws, frames: [], out: '', closed: false, status: null };
  ws.on('message', (d, bin) => { if (bin) c.out += d.toString('utf8'); else c.frames.push(JSON.parse(String(d))); });
  ws.on('close', () => { c.closed = true; });
  ws.on('unexpected-response', (req, res) => { c.status = res.statusCode; c.closed = true; });
  ws.on('error', () => { c.closed = true; });
  c.open = () => new Promise((resolve) => { if (ws.readyState === 1) resolve(true); ws.once('open', () => resolve(true)); ws.once('close', () => resolve(false)); ws.once('unexpected-response', () => resolve(false)); });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(c); if (v) return v; await wait(20); } throw new Error('timeout; frames ' + JSON.stringify(c.frames) + ' out ' + JSON.stringify(c.out)); };
  c.frame = (t) => c.until(() => c.frames.find((f) => f.t === t));
  return c;
}

async function install(buf) {
  const r = await agent.post('/api/v1/plugins/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await agent.post('/api/v1/plugins/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}

async function secondBrowser() {
  const a = supertest.agent(app);
  const page = await a.get('/login');
  const m = page.text.match(/name="_csrf"\s+value="([^"]+)"/);
  await a.post('/login').type('form').send({ username: 'admin', password: 'TestPass123!', _csrf: m ? m[1] : '' }).expect(302);
  return a;
}

/** Ticket → page → token (the browser's way). */
async function browserToken(ref) {
  const page = await agent.get('/remote/session/' + ref).expect(200);
  const cfg = pageCfg(page.text, 'rterm-cfg');
  const t = await agent.post(`/remote/session/${ref}/token`).set('X-CSRF-Token', cfg.csrf).expect(200);
  return { page, cfg, token: t.body };
}

let origEndpoint;
let devA, devB, cred, keyCred;
const recDir = () => require('../config/default').remoteRecordings.dir;

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  plugins = require('../src/services/plugins');
  db = require('../src/db/connection').getDb();
  sessions = require('../src/services/remote/sessions');
  term = require('../src/services/remote/term');
  recordings = require('../src/services/remote/recordings');
  hostKeys = require('../src/services/remote/hostKeys');
  sshkeys = require('../src/services/remote/sshkeys');
  targets = require('../src/services/remote/targets');
  adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  // the device(s): a target id "ssh-*" is the local ssh2 server of that id
  origEndpoint = targets.endpoint;
  targets.endpoint = async (plugin, t) => (devices.has(t.id) ? { host: '127.0.0.1', port: devices.get(t.id).port, gatewayPeerId: null, lanHost: null, lanPort: null, listener: null } : origEndpoint(plugin, t));
  devA = await sshDevice(sshkeys.generateEd25519('device-a').privateKey);
  devB = await sshDevice(sshkeys.generateEd25519('device-b').privateKey, { tmux: false });
  devices.set('ssh-a', devA);
  devices.set('ssh-b', devB);
  server = http.createServer(app);
  require('../src/tunnel/termTunnel').attachTermTunnel(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  await install(remotePackage());
  for (let i = 0; i < 50; i++) { try { if ((await pget('/has')).version === 3) break; } catch { /* starting */ } await wait(100); }
});

after(async () => {
  targets.endpoint = origEndpoint;
  for (const d of [devA, devB]) { try { d.srv.close(); } catch { /* closed */ } }
  await new Promise((r) => server.close(r));
  await plugins.stop();
  teardown();
});

describe('keys: generated in the core, the private half never leaves it', () => {
  it('an OpenSSH ed25519 key that ssh2 reads; the fingerprint is the one of ssh-keygen -l', () => {
    const k = sshkeys.generateEd25519('Büro <pc>');
    const priv = sshUtils.parseKey(k.privateKey);
    assert.equal(priv.type, 'ssh-ed25519');
    assert.match(k.publicKey, /^ssh-ed25519 AAAA[A-Za-z0-9+/=]+ Bro pc$/);
    const pub = sshUtils.parseKey(k.publicKey);
    assert.ok(pub.getPublicSSH().equals(priv.getPublicSSH()));
    assert.equal(k.fingerprint.sha256, require('node:crypto').createHash('sha256').update(pub.getPublicSSH()).digest('base64').replace(/=+$/, ''));
    assert.equal(sshkeys.algOf(Buffer.from('xx')), null);
  });
  it('gc.remote.vault.generate answers the public key only', async () => {
    const r = await call('vault.generate', { kind: 'ed25519', label: 'Pi', username: USERNAME });
    assert.equal(r.ok, true, JSON.stringify(r));
    keyCred = r.result.handle;
    assert.match(r.result.publicKey, /^ssh-ed25519 /);
    assert.equal(r.result.kind, 'ssh_key');
    assert.ok(!JSON.stringify(r).includes('PRIVATE KEY'));
    assert.equal((await call('vault.info', { handle: keyCred })).result.publicKey, r.result.publicKey);
    assert.match(require('../src/services/remote/vault').resolve(ID, keyCred).privateKey, /BEGIN OPENSSH PRIVATE KEY/);
    assert.equal((await call('vault.generate', { kind: 'rsa' })).code, 'ERR_INVALID');
    devA.srv._pubKey = r.result.publicKey;
    cred = (await call('vault.put', { username: USERNAME, password: PASSWORD, label: 'ops' })).result.handle;
  });
});

describe('host keys: pin, list, remove, check', () => {
  it('checks the input; a pin replaces the old one; a mismatch is logged', async () => {
    assert.equal((await call('hostKeys.pin', { targetId: 'x y', alg: 'ssh-ed25519', sha256: 'A'.repeat(43) })).code, 'ERR_INVALID');
    assert.equal((await call('hostKeys.pin', { targetId: 'x', alg: 'ssh-ed25519', sha256: 'short' })).code, 'ERR_INVALID');
    const p = await call('hostKeys.pin', { targetId: 'dev-9', alg: 'ssh-ed25519', sha256: 'SHA256:' + 'B'.repeat(43) });
    assert.deepEqual([p.result.targetId, p.result.sha256, p.result.source], ['dev-9', 'B'.repeat(43), 'plugin']);
    assert.equal(hostKeys.check(ID, 'dev-9', { alg: 'ssh-ed25519', sha256: 'B'.repeat(43) }), 'ok');
    assert.equal(hostKeys.check(ID, 'dev-9', { alg: 'ssh-ed25519', sha256: 'C'.repeat(43) }), 'mismatch');
    assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE event_type = 'remote_host_key_changed'").get(), 'logged');
    assert.equal(hostKeys.check(ID, 'dev-10', { alg: 'ssh-ed25519', sha256: 'B'.repeat(43) }), 'unpinned');
    assert.equal((await call('hostKeys.list')).result.length, 1);
    assert.deepEqual((await call('hostKeys.remove', { targetId: 'dev-9' })).result, { removed: true });
  });
});

describe('tmux names: strictly checked, never a shell word', () => {
  it('only letters, digits, _ and -', () => {
    for (const ok of ['work', 'gc-pi4', 'a_1', 'X']) assert.doesNotThrow(() => term.cleanTmux({ attach: ok }), ok);
    for (const bad of ["a'; rm -rf / #", 'a b', 'a.b', 'a:b', '-x', '', 'x'.repeat(33), '$(id)', 'ä']) {
      assert.throws(() => term.cleanTmux({ create: bad }), /tmux/, bad);
    }
    assert.throws(() => term.cleanTmux({ attach: 'a', create: 'b' }));
    assert.throws(() => term.cleanTmux('work'));
    assert.equal(term.tmuxCommand('work'), "tmux new -A -s 'work'");
    assert.throws(() => term.tmuxCommand("x'y"));
    assert.deepEqual(term.parseTmuxList(TMUX_LS + 'bad line\n').map((s) => [s.name, s.windows, s.attached, s.attachable]), [['work', 2, 1, true], ['my notes', 1, 0, false]]);
  });
});

describe('tickets of the terminal (engine term)', () => {
  it('ssh only, a credential with username and secret, tmux checked, recording only with the drive', async () => {
    const T = { id: 'ssh-a', name: 'Pi', host: '10.8.0.50', port: 22 };
    assert.equal((await call('session', { user: adminId, protocol: 'rdp', engine: 'term', target: T, credential: cred })).code, 'ERR_INVALID');
    assert.equal((await call('session', { user: adminId, protocol: 'ssh', engine: 'xterm', target: T, credential: cred })).code, 'ERR_INVALID');
    assert.equal((await call('session', { user: adminId, protocol: 'ssh', engine: 'term', target: T })).code, 'ERR_REMOTE_CREDENTIAL_REQUIRED');
    const onlyUser = (await call('vault.put', { username: 'x' })).result.handle;
    assert.equal((await call('session', { user: adminId, protocol: 'ssh', engine: 'term', target: T, credential: onlyUser })).code, 'ERR_REMOTE_CREDENTIAL_REQUIRED');
    assert.equal((await call('session', { user: adminId, protocol: 'ssh', engine: 'term', target: T, credential: cred, options: { tmux: { attach: "x'; id" } } })).code, 'ERR_INVALID');
    assert.equal((await call('session', { user: adminId, protocol: 'ssh', target: T, credential: cred, options: { tmux: { attach: 'work' } } })).code, 'ERR_INVALID', 'tmux needs the terminal');
    assert.equal((await call('session', { user: adminId, protocol: 'ssh', engine: 'term', target: T, credential: cred, record: true })).code, 'ERR_REMOTE_RECORDING_UNAVAILABLE');
    const r = await call('session', { user: adminId, protocol: 'ssh', engine: 'term', target: T, credential: cred });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.result.engine, r.result.record], ['term', false]);
    await call('end', { ref: r.result.ref });
  });
});

describe('the terminal: host key on first use, tmux, a different key blocks', () => {
  let ref;
  it('the page is the terminal; the token is a gc-term.v1 token, single use', async () => {
    const r = await call('session', { user: adminId, protocol: 'ssh', engine: 'term', target: { id: 'ssh-a', name: 'Pi', host: '10.8.0.50', port: 22 }, credential: cred, options: { tmux: { create: 'work' } } });
    ref = r.result.ref;
    const { page, cfg, token } = await browserToken(ref);
    assert.match(page.text, /id="rterm-host"/);
    assert.match(page.text, /\/vendor\/xterm\/xterm\.js/);
    assert.doesNotMatch(page.text, /cdn\.|unpkg|jsdelivr/);
    assert.equal(cfg.tmux, 'work');
    assert.equal(token.wsPath, '/api/v1/remote/ssh-tunnel');
    assert.equal(token.engine, 'term');
    assert.equal(token.ttl, 60);
    assert.ok(!JSON.stringify(token).includes(PASSWORD));
    // without the token, a wrong one, or the token in the address: refused
    const bad = termClient('A'.repeat(43));
    assert.equal(await bad.open(), false);
    assert.equal(bad.status, 401);
    // another browser: the ticket is bound to the first one
    const other = await secondBrowser();
    const p2 = await other.get('/dashboard');
    const c2 = (p2.text.match(/csrfToken:\s*'([^']+)'/) || [])[1];
    await other.post(`/remote/session/${ref}/token`).set('X-CSRF-Token', c2).expect(404);
    // the token works once
    const c = termClient(token.token);
    assert.equal(await c.open(), true);
    c.ws.close();
    await c.until((x) => x.closed);
    const again = termClient(token.token);
    assert.equal(await again.open(), false);
  });
  it('first connection: the fingerprint, trust → pinned, ready with tmux; input and output flow; bye → exit', async () => {
    const { token } = await browserToken(ref);
    const c = termClient(token.token);
    assert.equal(await c.open(), true);
    c.send({ t: 'hello', cols: 100, rows: 30, term: 'xterm-256color' });
    const hk = await c.frame('hostkey');
    assert.equal(hk.hostKey.alg, 'ssh-ed25519');
    assert.match(hk.hostKey.sha256, /^[A-Za-z0-9+/]{43}$/);
    c.send({ t: 'trust' });
    const ready = await c.frame('ready');
    assert.deepEqual([ready.hostKeyNew, ready.tmux, ready.recording, ready.mode], [true, { available: true, session: 'work' }, false, 'control']);
    assert.ok(devA.log.execs.includes("tmux new -A -s 'work'"), JSON.stringify(devA.log.execs));
    const pin = hostKeys.get(ID, 'ssh-a');
    assert.deepEqual([pin.sha256, pin.source, pin.pinnedBy], [hk.hostKey.sha256, 'trust', adminId]);
    await c.until((x) => x.out.includes('[tmux'));
    c.ws.send(Buffer.from('ls\n'));
    await c.until((x) => x.out.includes('> ls'));
    c.send({ t: 'resize', cols: 120, rows: 40 });
    await c.until(() => devA.log.resized && devA.log.resized.cols === 120);
    c.send({ t: 'ping' });
    await c.frame('pong');
    const live = (await call('sessions', { active: true })).result.find((s) => s.engine === 'term');
    assert.deepEqual([live.targetId, live.via, live.protocol], ['ssh-a', 'browser', 'ssh']);
    c.send({ t: 'bye' });
    const ex = await c.frame('exit');
    assert.equal(ex.reason, 'client');
    await c.until((x) => x.closed);
    let ev = [];
    for (let i = 0; i < 50 && !ev.some((e) => e.phase === 'end' && e.engine === 'term'); i++) { ev = (await pget('/events')).result; await wait(50); }
    const start = ev.find((e) => e.phase === 'start' && e.engine === 'term');
    assert.equal(start.hostKey.sha256, hk.hostKey.sha256);
    assert.ok(!JSON.stringify(ev).includes(PASSWORD));
  });
  it('the pinned key connects without a question; a key login works as well', async () => {
    const r = await call('session', { user: adminId, protocol: 'ssh', engine: 'term', target: { id: 'ssh-a', name: 'Pi', host: '10.8.0.50', port: 22 }, credential: keyCred });
    const { token } = await browserToken(r.result.ref);
    const c = termClient(token.token);
    await c.open();
    c.send({ t: 'hello', cols: 80, rows: 24 });
    const ready = await c.frame('ready');
    assert.equal(ready.hostKeyNew, false);
    assert.equal(c.frames.some((f) => f.t === 'hostkey'), false);
    assert.equal(ready.tmux.available, null, 'no tmux asked for: a plain shell');
    assert.ok(devA.log.auth.includes('publickey'));
    c.ws.send(Buffer.from('exit\n'));
    const ex = await c.frame('exit');
    assert.equal(ex.code, 0);
    await call('end', { ref: r.result.ref });
  });
  it('a different key on the same target blocks (host_key_mismatch), no "connect anyway"', async () => {
    // the device at ssh-a now presents another key: the pin of ssh-a meets the server of ssh-b
    devices.set('ssh-a', devB);
    try {
      const r = await call('session', { user: adminId, protocol: 'ssh', engine: 'term', target: { id: 'ssh-a', name: 'Pi', host: '10.8.0.50', port: 22 }, credential: cred });
      const { token } = await browserToken(r.result.ref);
      const c = termClient(token.token);
      await c.open();
      c.send({ t: 'hello', cols: 80, rows: 24 });
      const err = await c.frame('error');
      assert.equal(err.code, 'host_key_mismatch');
      c.send({ t: 'trust' });
      await c.until((x) => x.closed);
      assert.equal(c.frames.some((f) => f.t === 'ready'), false);
      assert.equal(devB.log.shells, 0, 'no shell on the wrong device');
      const n = db.prepare("SELECT COUNT(*) AS c FROM activity_log WHERE event_type = 'remote_host_key_changed'").get().c;
      assert.ok(n >= 2);
      await call('end', { ref: r.result.ref });
    } finally { devices.set('ssh-a', devA); }
  });
  it('declining the fingerprint connects nothing and pins nothing; tmux missing → a shell and a hint', async () => {
    const r = await call('session', { user: adminId, protocol: 'ssh', engine: 'term', target: { id: 'ssh-b', name: 'NAS', host: '10.8.0.51', port: 22 }, credential: cred, options: { tmux: { attach: 'work' } } });
    let { token } = await browserToken(r.result.ref);
    let c = termClient(token.token);
    await c.open();
    c.send({ t: 'hello', cols: 80, rows: 24 });
    await c.frame('hostkey');
    c.send({ t: 'distrust' });
    assert.equal((await c.frame('error')).code, 'host_key_rejected');
    assert.equal(hostKeys.get(ID, 'ssh-b'), null);
    ({ token } = await browserToken(r.result.ref));
    c = termClient(token.token);
    await c.open();
    c.send({ t: 'hello', cols: 80, rows: 24 });
    await c.frame('hostkey');
    c.send({ t: 'trust' });
    const ready = await c.frame('ready');
    assert.deepEqual(ready.tmux, { available: false, session: null });
    assert.equal(devB.log.shells, 1);
    await call('end', { ref: r.result.ref });
    await c.until((x) => x.closed);
  });
});

describe('gc.remote.tmux.list', () => {
  it('needs a pinned key; lists the sessions; no tmux → ERR_REMOTE_TMUX_UNAVAILABLE', async () => {
    const l = await call('tmux.list', { target: { id: 'ssh-a', host: '10.8.0.50', port: 22 }, credential: cred });
    assert.equal(l.ok, true, JSON.stringify(l));
    assert.deepEqual(l.result.map((s) => [s.name, s.attachable]), [['work', true], ['my notes', false]]);
    assert.equal(l.result[0].created, new Date(1731700000 * 1000).toISOString());
    assert.equal((await call('tmux.list', { target: { id: 'ssh-b', host: '10.8.0.51', port: 22 }, credential: cred })).code, 'ERR_REMOTE_TMUX_UNAVAILABLE');
    await call('hostKeys.remove', { targetId: 'ssh-b' });
    assert.equal((await call('tmux.list', { target: { id: 'ssh-b', host: '10.8.0.51', port: 22 }, credential: cred })).code, 'ERR_REMOTE_HOST_KEY_UNPINNED');
    assert.equal((await call('tmux.list', { target: { id: 'ssh-a', host: '10.8.0.50', port: 22 } })).code, 'ERR_REMOTE_CREDENTIAL_REQUIRED');
  });
});

describe('recordings', () => {
  before(() => fs.mkdirSync(recDir(), { recursive: true }));

  it('available with the drive; guacd only once update.sh saw its mount', async () => {
    const a = (await call('recordings.available')).result;
    assert.deepEqual([a.available, a.reason, a.engines], [true, null, { term: true, guac: false }]);
    assert.equal(a.days, 30);
    fs.writeFileSync(path.join(process.env.GC_DATA_PATH || process.env.GC_DATA_DIR, '.remote-recordings-state.json'), JSON.stringify({ guacd: true, compose: true }));
    assert.equal((await call('recordings.available')).result.engines.guac, true);
  });

  let recId;
  it('a recorded terminal: the hint on the page, ready.recording, asciicast of the output only, encrypted at rest', async () => {
    const r = await call('session', { user: adminId, protocol: 'ssh', engine: 'term', target: { id: 'ssh-a', name: 'Pi', host: '10.8.0.50', port: 22 }, credential: cred, record: true });
    assert.equal(r.result.record, true);
    const { page, token } = await browserToken(r.result.ref);
    assert.match(page.text, /id="rterm-recnote"/);
    assert.match(page.text, /id="rterm-recbadge"/);
    const c = termClient(token.token);
    await c.open();
    c.send({ t: 'hello', cols: 90, rows: 25 });
    const ready = await c.frame('ready');
    assert.equal(ready.recording, true);
    c.ws.send(Buffer.from('hello\n'));
    await c.until((x) => x.out.includes('> hello'));
    c.ws.send(Buffer.from('exit\n'));
    await c.frame('exit');
    await c.until((x) => x.closed);
    const list = (await call('recordings.list', { targetId: 'ssh-a' })).result;
    assert.equal(list.length, 1);
    recId = list[0].id;
    assert.deepEqual([list[0].format, list[0].status, list[0].protocol, list[0].userId], ['asciicast', 'ready', 'ssh', adminId]);
    assert.ok(list[0].bytes > 0);
    assert.ok(!JSON.stringify(list).includes(PASSWORD), 'no secret in the metadata');
    const file = recordings.sealedPath(recId, 'asciicast');
    const raw = fs.readFileSync(file);
    assert.equal(raw.subarray(0, 4).toString('latin1'), 'GCR1');
    assert.ok(!raw.includes(Buffer.from('"version":2')), 'encrypted at rest');
    let text = '';
    for await (const ch of recordings.content(ID, recId).chunks()) text += ch.toString('utf8');
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual([lines[0].version, lines[0].width, lines[0].height, Object.keys(lines[0].env)], [2, 90, 25, ['TERM']]);
    assert.ok(lines.slice(1).every((l) => Array.isArray(l) && (l[1] === 'o' || l[1] === 'r')));
    assert.ok(text.includes('$ '), 'the output is there');
    const sess = (await call('sessions', {})).result.find((s) => s.recordingId === recId);
    assert.equal(sess.record, true);
  });

  it('playback: a ticket for that person, the page plays it, logged and reported; another browser gets nothing', async () => {
    assert.equal((await call('recordings.stream', { id: recId })).code, 'ERR_INVALID', 'the person is required');
    const s = await call('recordings.stream', { id: recId, user: adminId });
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.match(s.result.url, /^\/remote\/session\/[A-Za-z0-9_-]{43}$/);
    assert.equal(s.result.format, 'asciicast');
    const other = await secondBrowser();
    const page = await agent.get(s.result.url).expect(200);
    assert.match(page.text, /id="rrec-host"/);
    await other.get(s.result.url).expect(404);
    const data = await agent.get(s.result.url + '/recording').buffer(true).parse((res, cb) => { const b = []; res.on('data', (d) => b.push(d)); res.on('end', () => cb(null, Buffer.concat(b))); }).expect(200);
    assert.equal(data.headers['content-type'], 'application/x-asciicast');
    assert.match(data.body.toString('utf8'), /^\{"version":2/);
    await other.get(s.result.url + '/recording').expect(404);
    // a playback ticket is no session ticket
    const t = sessions._ticketForTest(s.result.url.split('/').pop());
    assert.deepEqual(await sessions.mint(t, {}), { ok: false, status: 404, code: 'not_found' });
    assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE event_type = 'remote_recording_viewed'").get());
    let ev = [];
    for (let i = 0; i < 50 && !ev.some((e) => e.phase === 'recording_viewed'); i++) { ev = (await pget('/events')).result; await wait(50); }
    assert.equal(ev.find((e) => e.phase === 'recording_viewed').recordingId, recId);
  });

  it('guacd: the token carries the recording settings (no keystrokes); the row comes with the tunnel; the file is sealed after the session', async () => {
    const r = await call('session', { user: adminId, protocol: 'rdp', target: { id: 'dev-r', name: 'PC', host: '10.8.0.60', port: 3389 }, record: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    const page = await agent.get(r.result.url).expect(200);
    assert.match(page.text, /id="rdp-rec-overlay"/);
    const t = sessions._ticketForTest(r.result.ref);
    const m = await sessions.mint(t, {});
    const conn = require('../src/services/guacToken').verifyAndConsume(m.token).connection;
    assert.equal(conn.settings['recording-include-keys'], 'false');
    assert.equal(conn.settings['recording-path'], recordings.guacDir());
    assert.match(conn.remoteRecording, recordings.ID_RE);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM remote_recordings WHERE id = ?').get(conn.remoteRecording).c, 0, 'no row for an unused token');
    const sid = sessions.opened(conn, { close: () => {} });
    // guacd writes its file …
    const plain = Buffer.alloc(200 * 1024, 7);
    plain.write('4.size,1.0,4.1024,3.768;');
    fs.writeFileSync(recordings.rawGuacPath(conn.remoteRecording), plain);
    sessions.end(sid, 'normal');
    await recordings._idleForTest();
    const row = db.prepare('SELECT * FROM remote_recordings WHERE id = ?').get(conn.remoteRecording);
    assert.deepEqual([row.status, row.format, row.session_id, row.plain_bytes], ['ready', 'guac', sid, plain.length]);
    assert.equal(fs.existsSync(recordings.rawGuacPath(conn.remoteRecording)), false, 'the plain file is gone');
    const back = [];
    for await (const ch of recordings.content(ID, conn.remoteRecording).chunks()) back.push(ch);
    assert.ok(Buffer.concat(back).equals(plain));
    await call('end', { ref: r.result.ref });
  });

  it('sealing works on the opened file only: a missing guacd file fails the recording, a link is never followed; leftovers are swept', async () => {
    const id = 'rr_' + '1'.repeat(32);
    recordings.startGuac(id, { pluginId: ID, targetId: 'dev-r', userId: adminId, protocol: 'rdp' });
    recordings.finishGuac(id);
    await recordings._idleForTest();
    assert.equal(db.prepare('SELECT status FROM remote_recordings WHERE id = ?').get(id).status, 'failed');
    const id2 = 'rr_' + '2'.repeat(32);
    const target = path.join(recDir(), 'outside.txt');
    fs.writeFileSync(target, 'not a recording');
    fs.symlinkSync(target, recordings.rawGuacPath(id2));
    recordings.startGuac(id2, { pluginId: ID, targetId: 'dev-r', userId: adminId, protocol: 'rdp' });
    recordings.finishGuac(id2);
    await recordings._idleForTest();
    assert.equal(db.prepare('SELECT status FROM remote_recordings WHERE id = ?').get(id2).status, 'failed');
    assert.equal(fs.existsSync(recordings.sealedPath(id2, 'guac')), false);
    assert.equal(fs.readdirSync(path.dirname(recordings.sealedPath(id2, 'guac'))).filter((f) => f.endsWith('.part')).length, 0, 'no half-written file');
    // an unknown plain file older than an hour goes, the link stays untouched by the age check
    const orphan = path.join(recordings.guacDir(), 'rr_' + '3'.repeat(32) + '.guac');
    fs.writeFileSync(orphan, 'x');
    const old = (Date.now() - 2 * 3600 * 1000) / 1000;
    fs.utimesSync(orphan, old, old);
    recordings.sweep();
    assert.equal(fs.existsSync(orphan), false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'not a recording');
    fs.unlinkSync(recordings.rawGuacPath(id2));
    db.prepare('DELETE FROM remote_recordings WHERE id IN (?, ?)').run(id, id2);
  });

  it('remove, retention, a full drive', async () => {
    const all = (await call('recordings.list')).result;
    assert.equal(all.length, 2);
    assert.deepEqual((await call('recordings.remove', { id: all[0].id })).result, { removed: true });
    assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE event_type = 'remote_recording_deleted'").get());
    db.prepare("UPDATE remote_recordings SET created_at = datetime('now', '-40 days')").run();
    assert.equal(recordings.sweep(), 1);
    assert.equal((await call('recordings.list')).result.length, 0);
    db.prepare("INSERT INTO remote_recordings (id, plugin_id, format, bytes, status) VALUES ('rr_" + 'f'.repeat(32) + "', ?, 'asciicast', ?, 'ready')").run(ID, 11 * 1024 * 1024 * 1024);
    const a = (await call('recordings.available')).result;
    assert.deepEqual([a.available, a.reason], [false, 'full']);
    db.prepare("DELETE FROM remote_recordings WHERE id = 'rr_" + 'f'.repeat(32) + "'").run();
  });
});

describe('the native terminals of the apps: POST /api/v1/client/remote/term-token', () => {
  const H = require('./helpers/notify');
  let anna, phone;
  before(() => {
    anna = H.makeUser('term-anna');
    phone = H.makeDevice(anna, { name: 'term-phone', platform: 'android' });
  });
  it('an app token of the ticket\'s person only; bound to that app; the WebSocket opens with it', async () => {
    const r = await call('session', { user: anna, protocol: 'ssh', engine: 'term', target: { id: 'ssh-a', name: 'Pi', host: '10.8.0.50', port: 22 }, credential: cred });
    const ref = r.result.ref;
    const post = (tok, body) => supertest(app).post('/api/v1/client/remote/term-token').set('X-API-Token', tok).set('X-Client-Platform', 'android').send(body);
    await post(phone.raw, { ref: 'x' }).expect(404);
    const other = H.makeDevice(H.makeUser('term-bob'), { name: 'bob-phone', platform: 'android' });
    await post(other.raw, { ref }).expect(404);
    const ok = await post(phone.raw, { ref }).expect(200);
    assert.deepEqual([ok.body.wsPath, ok.body.ttl], ['/api/v1/remote/ssh-tunnel', 60]);
    assert.ok(!JSON.stringify(ok.body).includes(PASSWORD));
    // the browser cannot take an app's ticket afterwards
    await agent.get('/remote/session/' + ref).expect(404);
    const c = termClient(ok.body.token);
    await c.open();
    c.send({ t: 'hello', cols: 80, rows: 24 });
    await c.frame('ready');
    const live = (await call('sessions', { active: true })).result.find((s) => s.userId === anna);
    assert.equal(live.via, 'app');
    c.send({ t: 'bye' });
    await c.until((x) => x.closed);
    // a guacd ticket is no terminal
    const g = await call('session', { user: anna, protocol: 'rdp', target: { id: 'dev-x', host: '10.8.0.61', port: 3389 } });
    await post(phone.raw, { ref: g.result.ref }).expect(404);
    await call('end', { ref }); await call('end', { ref: g.result.ref });
  });
});

describe('the drive in the release files', () => {
  it('both compose files mount remote-recordings in gatecontrol and guacd', () => {
    for (const f of ['docker-compose.yml', 'deploy/docker-compose.yml']) {
      const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const block = (name) => {
        const rest = s.slice(s.indexOf(`\n  ${name}:\n`) + 1);
        const end = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
        return end < 0 ? rest : rest.slice(0, end + 1);
      };
      assert.match(block('gatecontrol'), /- remote-recordings:\/recordings/, f);
      assert.match(block('guacd'), /- remote-recordings:\/recordings/, f);
      assert.match(s, /\nvolumes:\n(?:.*\n)*?  remote-recordings:/, f);
    }
  });
  it('update.sh (marker 9) reports the mounts and restarts nothing for it', () => {
    const s = fs.readFileSync(path.join(ROOT, 'update.sh'), 'utf8');
    assert.match(s, /^# gc-update-sh: 9$/m);
    assert.match(s, /REC_STATE="\$DATA_DIR\/\.remote-recordings-state\.json"/);
    assert.match(s, /sync_bridges \|\| true\nsync_recordings \|\| true\n/);
    assert.match(s, /ensure_guacd \|\| true; sync_recordings \|\| true;/);
    const fn = s.slice(s.indexOf('sync_recordings() {'), s.indexOf('\n}\n', s.indexOf('sync_recordings() {')));
    assert.doesNotMatch(fn, /docker (compose )?(up|restart|rm|stop)/);
  });
});
