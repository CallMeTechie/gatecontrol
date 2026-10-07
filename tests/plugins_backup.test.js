'use strict';

// Plugins in GateControl backups (docs/plugins.md "Backup"): code, database
// snapshot, files, enabled state, licence, access targets and secrets survive
// a backup → wipe → restore; signatures are verified again on restore and the
// "unsigned plugins" switch is never taken from a backup.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { helloPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let app, agent, csrf, runtime, plugins, backup, constants, db;
const API = '/api/v1/plugins';
const call = (id, p, method = 'get', body) => {
  const r = agent[method](`${API}/${id}/api${p}`);
  if (method !== 'get') r.set('X-CSRF-Token', csrf);
  return body ? r.send(body) : r;
};
async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}
const policy = (on) => agent.put(API + '/policy').set('X-CSRF-Token', csrf).send(on ? { allowUnsigned: true, confirm: 'ERLAUBEN' } : { allowUnsigned: false }).expect(200);
// A restore replaces the users table (new ids): sign in again.
async function relogin() {
  agent = require('supertest').agent(app);
  const page = await agent.get('/login').expect(200);
  const c = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
  await agent.post('/login').type('form').send({ username: 'admin', password: 'TestPass123!', _csrf: c }).expect(302);
  csrf = (await agent.get('/dashboard').expect(200)).text.match(/csrfToken:\s*'([^']+)'/)[1];
}
const view = async (id) => (await agent.get(`${API}/${id}`).expect(200)).body.plugin;

let snapshot;

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  backup = require('../src/services/backup');
  constants = require('../src/services/plugins/constants');
  db = require('../src/db/connection').getDb();
  require('../src/services/peers').rewriteWgConfig = async () => {};
  require('../src/services/routes').syncToCaddy = async () => {};
});
after(async () => { await plugins.stop(); teardown(); });

describe('backup', () => {
  it('prepares three plugins: signed + data, signed but switched off, unsigned', async () => {
    await install(helloPackage());
    assert.equal(await runtime.waitRunning('hello'), true);
    await call('hello', '/greetings', 'post', { text: 'kept' }).expect(201);
    await call('hello', '/kv', 'post', { key: 'k', value: 42 }).expect(200);
    await call('hello', '/file', 'post', { text: 'from files/' }).expect(200);
    await agent.put(API + '/hello/settings').set('X-CSRF-Token', csrf).send({ values: { greeting: 'Servus', token: 'tok-123' } }).expect(200);
    const rid = Number(db.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, enabled) VALUES ('phoscon.home.example', '192.168.1.50', 80, 'http', 1)").run().lastInsertRowid);
    await agent.put(API + '/hello/targets/gateway').set('X-CSRF-Token', csrf).send({ assigned: [{ kind: 'route', routeId: rid }] }).expect(200);

    await install(helloPackage({ overrides: { id: 'hello-off', name: 'Hallo Aus' } }));
    await agent.post(API + '/hello-off/disable').set('X-CSRF-Token', csrf).send({}).expect(200);

    await policy(true);
    await install(helloPackage({ sign: false, overrides: { id: 'hello-u', name: 'Hallo U' } }));
    assert.equal(await runtime.waitRunning('hello-u'), true);
  });
  it('the backup (format 5) carries code with signature, a database snapshot, files, state, targets, secrets', () => {
    snapshot = backup.createBackup();
    assert.equal(snapshot.version, 5);
    const p = Object.fromEntries(snapshot.data.plugins.map((x) => [x.id, x]));
    assert.deepEqual(Object.keys(p).sort(), ['hello', 'hello-off', 'hello-u']);
    assert.ok(p.hello.files['server/index.js'] && p.hello.files.signature);
    assert.equal(p['hello-u'].files.signature, undefined);
    assert.equal(Buffer.from(p.hello.db, 'base64').subarray(0, 15).toString('latin1'), 'SQLite format 3');
    assert.equal(Buffer.from(p.hello.data_files['notes/a.txt'], 'base64').toString(), 'from files/');
    assert.deepEqual([p.hello.enabled, p['hello-off'].enabled], [true, false]);
    assert.deepEqual(p.hello.targets, [{ target_id: 'gateway', idx: 0, assignment: { kind: 'route', route_domain: 'phoscon.home.example', route_type: 'http', l4_listen_port: null } }]);
    assert.match(p.hello.secret_settings.token, /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/, 'secret as a normal encrypted backup field');
    assert.equal(backup.validateBackup(snapshot).length, 0);
    assert.equal(backup.getBackupSummary(snapshot).plugins, 3);
    assert.ok(snapshot.data.settings.some((s) => s.key === 'plugins.allow_unsigned' && s.value === '1'));
  });
  it('off-site re-key converts the plugin secrets too', () => {
    const { rekeyBackup } = require('../src/services/offsite/rekey');
    const from = require('../config/default').encryption.key;
    const r = rekeyBackup({ data: { plugins: snapshot.data.plugins } }, from, 'ab'.repeat(32));
    assert.ok(r.converted >= 1);
    const tok = (b) => b.data.plugins.find((x) => x.id === 'hello').secret_settings.token;
    assert.notEqual(tok(r.backup), tok(snapshot));
  });
});

describe('restore', () => {
  it('wipe everything, switch unsigned plugins off, restore', async () => {
    for (const [id, name] of [['hello', 'Hallo Welt'], ['hello-off', 'Hallo Aus'], ['hello-u', 'Hallo U']]) {
      await agent.post(`${API}/${id}/uninstall`).set('X-CSRF-Token', csrf).send({ mode: 'wipe', confirm: name }).expect(200);
      assert.equal(fs.existsSync(constants.dataDir(id)), false);
    }
    await policy(false);
    const res = await backup.restoreBackup(JSON.parse(JSON.stringify(snapshot)));
    assert.equal(res.plugins, 3);
    assert.deepEqual(res.plugins_skipped, []);
    await relogin();
  });
  it('the signed plugin is back with its data, files, settings, secret and re-mapped target', async () => {
    assert.equal(await runtime.waitRunning('hello'), true);
    const v = await view('hello');
    assert.deepEqual([v.status, v.verified], ['running', true]);
    assert.deepEqual((await call('hello', '/greetings').expect(200)).body.rows.map((r) => r.text), ['first', 'kept']);
    assert.equal((await call('hello', '/kv?key=k').expect(200)).body.value, 42);
    assert.equal((await call('hello', '/file').expect(200)).body.text, 'from files/');
    const s = (await call('hello', '/settings').expect(200)).body.values;
    assert.deepEqual([s.greeting, s.token], ['Servus', 'tok-123']);
    const t = (await agent.get(API + '/hello/targets').expect(200)).body.declared.find((d) => d.id === 'gateway');
    assert.deepEqual(t.assigned.map((a) => a.display), ['phoscon.home.example']);
    const rid = db.prepare("SELECT id FROM routes WHERE domain = 'phoscon.home.example'").get().id;
    assert.equal(t.assigned[0].routeId, rid, 'new route id after the restore');
  });
  it('a plugin that was switched off stays off', async () => {
    const v = await view('hello-off');
    assert.deepEqual([v.enabled, v.status], [false, 'disabled']);
    assert.equal(runtime.info('hello-off').state, 'stopped');
  });
  it('the unsigned plugin is restored but stays off — the switch is not taken from the backup', async () => {
    assert.equal(plugins.allowUnsigned(), false);
    const v = await view('hello-u');
    assert.deepEqual([v.enabled, v.status, v.reason, v.verified], [true, 'blocked', 'unsigned', false]);
    assert.equal(runtime.info('hello-u').state, 'stopped');
  });
  it('a changed package in a backup is not restored (signature checked again)', async () => {
    const bad = JSON.parse(JSON.stringify(snapshot));
    const e = bad.data.plugins.find((x) => x.id === 'hello');
    e.files['server/index.js'] = Buffer.from('module.exports = { request: () => ({ json: "pwned" }) };').toString('base64');
    await agent.post(`${API}/hello/uninstall`).set('X-CSRF-Token', csrf).send({ mode: 'wipe', confirm: 'Hallo Welt' }).expect(200);
    const res = await backup.restoreBackup(bad);
    await relogin();
    assert.deepEqual(res.plugins_skipped, [{ id: 'hello', reason: 'tampered' }]);
    await agent.get(API + '/hello').expect(404);
  });
  it('an older backup (format 4, no plugins) restores and leaves installed plugins alone', async () => {
    const old = JSON.parse(JSON.stringify(snapshot));
    old.version = 4;
    delete old.data.plugins;
    const res = await backup.restoreBackup(old);
    assert.equal(res.plugins, 0);
    assert.ok(plugins.get('hello-off') && plugins.get('hello-u'));
  });
});
