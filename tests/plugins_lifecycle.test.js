'use strict';

// Plugin lifecycle through the admin API (docs/plugins.md): upload → checks →
// install, the plugin process (isolation, host API, crash/restart, background
// run), signatures × "Unsignierte Plugins erlauben", update, uninstall keep vs
// wipe, migrations, and who may use the routes.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const { helloPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let app, agent, csrf;
let runtime, hostApi, netPolicy, plugins, constants;

const API = '/api/v1/plugins';

function inspect(buf) {
  return agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf);
}
async function installPkg(buf, extra = {}) {
  const r = await inspect(buf);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  const res = await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true, ...extra });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}
const call = (id, p, method = 'get', body) => {
  const req = agent[method](`${API}/${id}/api${p}`);
  if (method !== 'get') req.set('X-CSRF-Token', csrf);
  return body ? req.send(body) : req;
};
const checkOf = (body, key) => body.checks.find((c) => c.key === key);

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  hostApi = require('../src/services/plugins/hostApi');
  netPolicy = require('../src/services/plugins/netPolicy');
  plugins = require('../src/services/plugins');
  constants = require('../src/services/plugins/constants');
  runtime._setBackoffForTest([150]);
});
after(async () => {
  hostApi._lookup = null;
  hostApi._udpTargets = null;
  netPolicy._setTestPrivateForTest(null);
  await plugins.stop();
  teardown();
});

describe('install a signed plugin', () => {
  it('inspect shows the four kinds of checks and a token; nothing is written yet', async () => {
    const r = await inspect(helloPackage());
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-ratelimit-limit'], '15', 'upload limiter');
    assert.equal(r.body.canInstall, true);
    assert.match(r.body.token, /^[0-9a-f]{32}$/);
    assert.deepEqual(r.body.checks.map((c) => `${c.key}.${c.code}.${c.status}`),
      ['signature.trusted.ok', 'integrity.unchanged.ok', 'compatibility.compatible.ok', 'existing.new.ok']);
    assert.equal(r.body.plugin.verified, true);
    assert.deepEqual(r.body.plugin.permissions.network.internet, ['api.example.com:443', '*.cloud.example']);
    assert.deepEqual(r.body.plugin.permissions.network.discovery, { udp: ['6445', '20086'] });
    assert.equal(fs.existsSync(path.join(constants.pluginsRoot(), 'hello')), false);
  });
  it('install needs the accepted permissions', async () => {
    const r = await inspect(helloPackage());
    const res = await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'accept_required');
  });
  it('installs, applies the migrations and starts the process', async () => {
    const body = await installPkg(helloPackage());
    assert.equal(body.plugin.id, 'hello');
    assert.equal(await runtime.waitRunning('hello'), true);
    assert.ok(fs.existsSync(path.join(constants.codeDir('hello', '1.0.0'), 'server', 'index.js')));
    assert.equal(fs.existsSync(path.join(constants.codeDir('hello', '1.0.0'), 'signature')), false);
    const g = await call('hello', '/greetings').expect(200);
    assert.deepEqual(g.body.rows.map((x) => x.text), ['first']);
    await call('hello', '/greetings', 'post', { text: 'second' }).expect(201);
    const list = await agent.get(API).expect(200);
    const v = list.body.plugins.find((p) => p.id === 'hello');
    assert.equal(v.status, 'running');
    assert.equal(v.verified, true);
    const act = require('../src/db/connection').getDb().prepare("SELECT event_type FROM activity_log WHERE event_type LIKE 'plugin_%'").all().map((x) => x.event_type);
    assert.ok(act.includes('plugin_installed'));
  });
  it('requests reach the plugin with the acting user, never more', async () => {
    const r = await call('hello', '/ping?x=1', 'post', { a: 1 }).expect(200);
    assert.equal(r.body.method, 'POST');
    assert.equal(r.body.user.role, 'admin');
    assert.deepEqual(r.body.query, { x: '1' });
    assert.deepEqual(r.body.body, { a: 1 });
    await agent.get(`${API}/hello/api/../../settings`).expect(404);
    await agent.post(`${API}/hello/api/ping`).send({}).expect(403); // CSRF of the host
  });
});

describe('isolation of the plugin process', () => {
  it('cannot read files, start processes, open sockets, signal the server or load node:sqlite', async () => {
    const r = await call('hello', '/escape').expect(200);
    for (const [k, v] of Object.entries(r.body.results)) {
      if (k === 'env') continue;
      assert.match(v, /^denied:/, `${k}: ${v}`);
    }
    assert.equal(r.body.results.env, 'GC_PLUGIN_ID,NODE_ENV,TZ', 'no server secrets in the environment');
  });
  it('runs with the permission model and only its own folders', () => {
    const args = runtime.execArgvFor({ id: 'hello', version: '1.0.0' });
    assert.ok(args.includes('--permission') || args.includes('--experimental-permission'));
    assert.ok(!args.some((a) => /allow-(child-process|worker|addons|wasi|inspector)/.test(a)));
    const reads = args.filter((a) => a.startsWith('--allow-fs-read=')).map((a) => a.slice(16));
    const writes = args.filter((a) => a.startsWith('--allow-fs-write=')).map((a) => a.slice(17));
    assert.deepEqual(writes, [constants.filesDir('hello')]);
    assert.deepEqual(reads, [runtime.BOOTSTRAP, constants.codeDir('hello', '1.0.0'), constants.filesDir('hello')]);
  });
});

describe('host API permissions', () => {
  it('http.fetch: hosts outside the allowlist are refused', async () => {
    hostApi._lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const r = await call('hello', '/fetch?url=' + encodeURIComponent('https://evil.example/')).expect(502);
    assert.equal(r.body.code, 'ERR_NET_DENIED');
    assert.match(r.body.error, /not_allowed/);
    hostApi._lookup = null;
  });
  it('http.fetch: an allowed host resolving to loopback or the WireGuard network is refused', async () => {
    hostApi._lookup = async () => [{ address: '127.0.0.1', family: 4 }];
    let r = await call('hello', '/fetch?url=' + encodeURIComponent('https://api.example.com/x')).expect(502);
    assert.match(r.body.error, /blocked_address/);
    hostApi._lookup = async () => [{ address: '10.8.0.9', family: 4 }];
    r = await call('hello', '/fetch?url=' + encodeURIComponent('https://api.example.com/x')).expect(502);
    assert.match(r.body.error, /not_public/);
    hostApi._lookup = null;
  });
  it('database: only the plugin’s own file — ATTACH, PRAGMA, VACUUM INTO and _gc_ tables are refused', async () => {
    for (const sql of ["ATTACH DATABASE '/etc/passwd' AS x", 'PRAGMA writable_schema = 1', "VACUUM INTO '/tmp/x.db'", 'SELECT * FROM _gc_settings', "SELECT load_extension('x')"]) {
      const r = await call('hello', '/sql', 'post', { sql }).expect(400);
      assert.match(r.body.error, /not allowed/, sql);
    }
    const ok = await call('hello', '/sql', 'post', { sql: 'SELECT count(*) AS n FROM greetings' }).expect(200);
    assert.equal(ok.body.result.rows[0].n, 2);
  });
  it('users, notify, licence status, storage', async () => {
    const u = await call('hello', '/users').expect(200);
    assert.deepEqual(Object.keys(u.body.users[0]).sort(), ['id', 'name', 'role']);
    await call('hello', '/notify', 'post', {}).expect(200);
    const row = require('../src/db/connection').getDb().prepare("SELECT message FROM activity_log WHERE event_type = 'plugin_notice'").get();
    assert.match(row.message, /hello from the plugin/);
    const l = await call('hello', '/license').expect(200);
    assert.deepEqual(l.body.license, { required: false, licensed: true, state: 'not_required', expiresAt: null });
    await call('hello', '/kv', 'post', { key: 'k', value: { a: [1, 2] } }).expect(200);
    assert.deepEqual((await call('hello', '/kv?key=k').expect(200)).body.value, { a: [1, 2] });
  });
});

describe('settings, background runs, crash and restart', () => {
  it('declared settings: typed, validated, secrets never leave the server', async () => {
    const s = await agent.get(API + '/hello/settings').expect(200);
    assert.deepEqual(s.body.defs.map((d) => d.key), ['greeting', 'loud', 'repeat', 'token']);
    assert.equal(s.body.values.greeting, 'Hallo');
    const bad = await agent.put(API + '/hello/settings').set('X-CSRF-Token', csrf).send({ values: { repeat: 9, nope: 1 } }).expect(400);
    assert.deepEqual(bad.body.fields, { repeat: 'invalid', nope: 'unknown' });
    const ok = await agent.put(API + '/hello/settings').set('X-CSRF-Token', csrf).send({ values: { greeting: 'Moin', repeat: 3, token: 's3cret' } }).expect(200);
    assert.deepEqual(ok.body.values.token, { set: true });
    assert.ok(!JSON.stringify(ok.body).includes('s3cret'));
    const seen = await call('hello', '/settings').expect(200);
    assert.equal(seen.body.values.token, 's3cret', 'the plugin gets the decrypted secret');
    assert.equal(seen.body.values.greeting, 'Moin');
  });
  it('a background run is scheduled by the host', async () => {
    await runtime.get('hello').runTick();
    await runtime.get('hello').runTick();
    assert.equal((await call('hello', '/ticks').expect(200)).body.ticks, 2);
  });
  it('a crashed process is restarted with backoff', async () => {
    const pid = runtime.info('hello').pid;
    await call('hello', '/crash', 'post', {}).expect(200);
    await new Promise((r) => setTimeout(r, 100));
    assert.notEqual(runtime.info('hello').state, 'running');
    assert.equal(await runtime.waitRunning('hello', 8000), true);
    assert.notEqual(runtime.info('hello').pid, pid);
    assert.equal(runtime.info('hello').crashes, 1);
    await call('hello', '/ping').expect(200);
    const logs = (await agent.get(API + '/hello/logs').expect(200)).body.logs.map((l) => l.message);
    assert.ok(logs.some((m) => /process ended/.test(m)), logs.join(' | '));
  });
});

describe('enable / disable', () => {
  it('disable stops the process, keeps the data; requests answer 503; enable starts it again', async () => {
    const pid = runtime.info('hello').pid;
    await agent.post(API + '/hello/disable').set('X-CSRF-Token', csrf).send({}).expect(200);
    assert.equal(runtime.info('hello').state, 'stopped');
    assert.throws(() => process.kill(pid, 0), 'process is gone');
    const r = await call('hello', '/ping').expect(503);
    assert.equal(r.body.code, 'not_running');
    await agent.post(API + '/hello/enable').set('X-CSRF-Token', csrf).send({}).expect(200);
    assert.equal(await runtime.waitRunning('hello'), true);
    assert.equal((await call('hello', '/greetings').expect(200)).body.rows.length, 2);
  });
});

describe('signatures × "Unsignierte Plugins erlauben"', () => {
  const unsigned = () => helloPackage({ sign: false, overrides: { id: 'hello-x', name: 'Hallo X' } });
  it('off (default): unsigned and foreign-key packages are rejected', async () => {
    let r = await inspect(unsigned()).expect(200);
    assert.equal(r.body.canInstall, false);
    assert.equal(r.body.token, null);
    assert.deepEqual(checkOf(r.body, 'signature'), { key: 'signature', status: 'fail', code: 'unsigned', params: { publisher: 'GateControl Tests' } });
    r = await inspect(helloPackage({ sign: 'stranger', overrides: { id: 'hello-x' } })).expect(200);
    assert.equal(checkOf(r.body, 'signature').code, 'untrusted');
    assert.equal(r.body.canInstall, false);
  });
  it('switching on needs ERLAUBEN (checked by the server)', async () => {
    let r = await agent.put(API + '/policy').set('X-CSRF-Token', csrf).send({ allowUnsigned: true }).expect(400);
    assert.equal(r.body.code, 'confirm_mismatch');
    r = await agent.put(API + '/policy').set('X-CSRF-Token', csrf).send({ allowUnsigned: true, confirm: 'erlauben' }).expect(400);
    r = await agent.put(API + '/policy').set('X-CSRF-Token', csrf).send({ allowUnsigned: true, confirm: 'ERLAUBEN' }).expect(200);
    assert.equal(r.body.allowUnsigned, true);
  });
  it('on: unsigned packages install with a warning and run', async () => {
    const r = await inspect(unsigned()).expect(200);
    assert.equal(checkOf(r.body, 'signature').status, 'warn');
    await installPkg(unsigned());
    assert.equal(await runtime.waitRunning('hello-x'), true);
  });
  it('a changed signed package is rejected even when unsigned plugins are allowed', async () => {
    const zlib = require('node:zlib');
    const pkgLib = require('../src/services/plugins/package');
    const files = pkgLib.decode(helloPackage({ overrides: { id: 'hello-t' } }));
    files.set('server/index.js', Buffer.from('module.exports = { request: () => ({ json: "pwned" }) };'));
    const r = await inspect(pkgLib.encode(files)).expect(200);
    assert.deepEqual([checkOf(r.body, 'signature').code, checkOf(r.body, 'signature').status], ['tampered', 'fail']);
    assert.equal(r.body.canInstall, false);
    assert.ok(zlib);
  });
  it('a signed plugin cannot be replaced by an unsigned build of the same id', async () => {
    const r = await inspect(helloPackage({ sign: false, overrides: { version: '1.2.0' } })).expect(200);
    assert.deepEqual([checkOf(r.body, 'existing').code, checkOf(r.body, 'existing').status], ['signed_to_unsigned', 'fail']);
  });
  it('off again: installed unsigned plugins are switched off, their data stays', async () => {
    await agent.put(API + '/policy').set('X-CSRF-Token', csrf).send({ allowUnsigned: false }).expect(200);
    const list = (await agent.get(API).expect(200)).body.plugins;
    const x = list.find((p) => p.id === 'hello-x');
    assert.deepEqual([x.status, x.reason, x.enabled], ['blocked', 'unsigned', true]);
    assert.equal(runtime.info('hello-x').state, 'stopped');
    assert.ok(fs.existsSync(constants.dataDir('hello-x')));
    assert.equal(list.find((p) => p.id === 'hello').status, 'running');
    const ev = require('../src/db/connection').getDb().prepare("SELECT event_type FROM activity_log WHERE event_type LIKE 'plugin_unsigned_%' ORDER BY id").all().map((e) => e.event_type);
    assert.deepEqual(ev, ['plugin_unsigned_allowed', 'plugin_unsigned_blocked']);
  });
});

describe('compatibility and update', () => {
  it('a package for another GateControl version is rejected', async () => {
    const r = await inspect(helloPackage({ overrides: { id: 'hello-new', gatecontrol: '>=99.0.0' } })).expect(200);
    assert.deepEqual([checkOf(r.body, 'compatibility').code, checkOf(r.body, 'compatibility').status], ['incompatible', 'fail']);
    assert.equal(r.body.canInstall, false);
  });
  it('update: same id, new migration applied in order, old version folder removed', async () => {
    const extra = new Map([['migrations/002_more.sql', "ALTER TABLE greetings ADD COLUMN lang TEXT DEFAULT 'de'; INSERT INTO greetings (text) VALUES ('from 1.1.0');"]]);
    const buf = helloPackage({ overrides: { version: '1.1.0' }, extra });
    const r = await inspect(buf).expect(200);
    assert.deepEqual([checkOf(r.body, 'existing').code, checkOf(r.body, 'existing').params], ['update', { from: '1.0.0', to: '1.1.0' }]);
    await installPkg(buf);
    assert.equal(await runtime.waitRunning('hello'), true);
    assert.equal(fs.existsSync(constants.codeDir('hello', '1.0.0')), false);
    const rows = (await call('hello', '/greetings').expect(200)).body.rows.map((x) => x.text);
    assert.deepEqual(rows, ['first', 'second', 'from 1.1.0']);
    const mig = await require('../src/services/plugins/storage').forPlugin('hello').call('migrations', {});
    assert.deepEqual(mig.list.map((m) => m.version), [1, 2]);
  });
  it('a failing migration leaves the installed version untouched', async () => {
    const extra = new Map([['migrations/002_more.sql', 'SELECT 1;'], ['migrations/003_broken.sql', 'CREATE TABLE greetings (x);']]);
    const r = await inspect(helloPackage({ overrides: { version: '1.2.0' }, extra })).expect(200);
    const res = await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true });
    assert.equal(res.status, 500);
    assert.equal((await agent.get(API + '/hello').expect(200)).body.plugin.version, '1.1.0');
    assert.equal(await runtime.waitRunning('hello'), true);
  });
});

describe('uninstall', () => {
  it('keep: code and registry entry go, data stays and is found again on reinstall', async () => {
    await agent.post(API + '/hello/uninstall').set('X-CSRF-Token', csrf).send({ mode: 'keep' }).expect(200);
    assert.equal(runtime.info('hello').state, 'stopped');
    assert.equal(fs.existsSync(path.join(constants.pluginsRoot(), 'hello')), false);
    assert.ok(fs.existsSync(path.join(constants.dbDir('hello'), 'plugin.db')));
    await agent.get(API + '/hello').expect(404);
    const r = await inspect(helloPackage({ overrides: { version: '1.1.0' }, extra: new Map([['migrations/002_more.sql', "ALTER TABLE greetings ADD COLUMN lang TEXT DEFAULT 'de'; INSERT INTO greetings (text) VALUES ('from 1.1.0');"]]) })).expect(200);
    assert.deepEqual(checkOf(r.body, 'data'), { key: 'data', status: 'ok', code: 'kept_data', params: {} });
    await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
    assert.equal(await runtime.waitRunning('hello'), true);
    assert.equal((await call('hello', '/greetings').expect(200)).body.rows.length, 3, 'migrations are not run twice');
  });
  it('wipe: needs the typed name, then removes everything', async () => {
    let r = await agent.post(API + '/hello/uninstall').set('X-CSRF-Token', csrf).send({ mode: 'wipe', confirm: 'hello' }).expect(400);
    assert.equal(r.body.code, 'confirm_mismatch');
    assert.equal(runtime.info('hello').state, 'running', 'nothing happened');
    r = await agent.post(API + '/hello/uninstall').set('X-CSRF-Token', csrf).send({ mode: 'wipe', confirm: 'Hallo Welt' }).expect(200);
    assert.equal(fs.existsSync(constants.dataDir('hello')), false);
    assert.equal(fs.existsSync(path.join(constants.pluginsRoot(), 'hello')), false);
    const ev = require('../src/db/connection').getDb().prepare("SELECT details FROM activity_log WHERE event_type = 'plugin_uninstalled' ORDER BY id DESC").get();
    assert.match(ev.details, /"mode":"wipe"/);
  });
});

describe('who may use the plugin routes', () => {
  async function member() {
    const argon2 = require('argon2');
    const hash = await argon2.hash('Plain!Pass1234', require('../src/utils/argon2Options'));
    require('../src/db/connection').getDb().prepare("INSERT INTO users (username, password_hash, role, self_service_enabled) VALUES ('pl-member', ?, 'user', 1)").run(hash);
    const a = supertest.agent(app);
    const page = await a.get('/login').expect(200);
    const c = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
    await a.post('/login').type('form').send({ username: 'pl-member', password: 'Plain!Pass1234', _csrf: c }).expect(302);
    return a;
  }
  it('members get 403 on the API and no plugin pages; anonymous gets 401', async () => {
    const m = await member();
    await m.get(API).expect(403);
    await m.get(API + '/hello-x/api/ping').expect(403);
    const page = await m.get('/plugins/hello-x');
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, '/profile');
    await supertest(app).get(API).expect(401);
  });
  it('every plugin route is rate-limited', async () => {
    const r = await agent.get(API).expect(200);
    assert.ok(r.headers['ratelimit-policy'] || r.headers['ratelimit-limit'] || r.headers.ratelimit, 'RateLimit headers present');
    const f = await agent.get('/plugins/hello-x/frame/main');
    assert.ok(f.headers['ratelimit-policy'] || f.headers['ratelimit-limit'] || f.headers.ratelimit, 'frame limiter');
  });
});
