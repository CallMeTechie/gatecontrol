'use strict';

// Hook devicesChanged({ removed, added }) of plugins with permissions.devices
// (docs/plugins.md "Devices", since 1.322.0): a device token created, revoked
// (administration, "Meine Geräte"), moved to another owner, its person
// disabled / enabled / deleted; batched, a create + revoke in one batch
// cancel out; only plugins with the permission; a failing or slow plugin
// never holds up the change and lands in the plugin's log.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');

const API = '/api/v1/plugins';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

const HOOK_JS = `'use strict';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = {
  async request(req, gc) {
    if (req.path === '/kv') {
      if (req.method === 'POST') { await gc.storage.set(String(req.body.key), req.body.value); return { json: { ok: true } }; }
      return { json: { ok: true, value: await gc.storage.get(String(req.query.key)) } };
    }
    return { status: 404, json: { ok: false } };
  },
  async render() { return { html: '<p>devices</p>' }; },
  async devicesChanged(payload, gc) {
    const mode = await gc.storage.get('mode');
    if (mode === 'throw') throw new Error('broken on purpose');
    if (mode === 'slow') await wait(5000);
    const prev = (await gc.storage.get('seen')) || [];
    await gc.storage.set('seen', prev.concat([payload]));
  },
};
`;

let agent, csrf, runtime, plugins, registry, tokens, users, devices;

function pkg(id, withDevices) {
  const permissions = { ...clone(helloManifest.permissions), devices: withDevices };
  return helloPackage({ overrides: { id, name: { de: id, en: id }, entry: 'server/devices.js', permissions }, extra: new Map([['server/devices.js', HOOK_JS]]) });
}
async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}
const kv = (id, key, value) => agent.post(`${API}/${id}/api/kv`).set('X-CSRF-Token', csrf).send({ key, value }).expect(200);
const kvGet = async (id, key) => (await agent.get(`${API}/${id}/api/kv`).query({ key }).expect(200)).body.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(50);
  }
}
/** All entries the plugin got so far: { removed: [...], added: [...] } merged. */
async function seen(id) {
  const list = (await kvGet(id, 'seen')) || [];
  return { calls: list.length, removed: list.flatMap((p) => p.removed), added: list.flatMap((p) => p.added) };
}
const PLUGINS = ['dc-hook', 'dc-none', 'dc-broken'];

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  registry = require('../src/services/plugins/registry');
  tokens = require('../src/services/tokens');
  users = require('../src/services/users');
  devices = require('../src/services/plugins/devices');
  devices._batchMs = 30;
  await install(pkg('dc-hook', true));
  await install(pkg('dc-none', false));
  await install(pkg('dc-broken', true));
  for (const id of PLUGINS) assert.equal(await runtime.waitRunning(id), true, id);
});
after(async () => { devices._batchMs = null; devices._hookMs = null; await plugins.stop(); teardown(); });
beforeEach(async () => {
  devices.flush();
  devices._batchMs = 30;
  devices._hookMs = null;
  for (const id of PLUGINS) { await kv(id, 'seen', null); await kv(id, 'mode', null); }
});

describe('hook devicesChanged', () => {
  it('a token revoked in the administration → removed (reason revoked), only to plugins with permissions.devices', async () => {
    const anna = H.makeUser('dc-anna');
    const phone = H.makeDevice(anna, { name: 'dc-anna-phone', platform: 'android' });
    await sleep(100); // the 'created' batch of makeDevice
    await kv('dc-hook', 'seen', null);
    await agent.delete(`/api/v1/tokens/${phone.tokenId}`).set('X-CSRF-Token', csrf).expect(200);
    const got = await until(async () => { const s = await seen('dc-hook'); return s.removed.length ? s : null; });
    assert.ok(got, 'dc-hook got the removal');
    const e = got.removed.find((x) => x.id === String(phone.tokenId));
    assert.equal(e.userId, anna);
    assert.equal(e.reason, 'revoked');
    assert.equal(e.platform, 'android');
    assert.deepEqual(Object.keys(e).sort(), ['clientType', 'id', 'name', 'platform', 'reason', 'userId']);
    await sleep(200);
    assert.equal((await seen('dc-none')).calls, 0, 'no permission, no hook');
  });

  it('a token revoked by its person ("Meine Geräte", source user) → removed', async () => {
    const ben = H.makeUser('dc-ben');
    const tv = H.makeDevice(ben, { name: 'dc-ben-tv', platform: 'android-tv' });
    await sleep(100);
    await kv('dc-hook', 'seen', null);
    tokens.revoke(tv.tokenId, '127.0.0.1', { source: 'user' });
    const got = await until(async () => { const s = await seen('dc-hook'); return s.removed.length ? s : null; });
    const e = got.removed.find((x) => x.id === String(tv.tokenId));
    assert.deepEqual([e.userId, e.reason, e.platform, e.clientType], [ben, 'revoked', 'android', 'android-tv']);
  });

  it('a new app token of a person → added (created); admin / automation tokens are not devices', async () => {
    const carla = H.makeUser('dc-carla');
    const app1 = tokens.create({ name: 'dc-carla-app', scopes: ['client'], userId: carla }, '127.0.0.1');
    const admin = tokens.create({ name: 'dc-carla-script', scopes: ['full-access'], userId: carla }, '127.0.0.1');
    const loose = tokens.create({ name: 'dc-loose', scopes: ['client'] }, '127.0.0.1');
    const got = await until(async () => { const s = await seen('dc-hook'); return s.added.length ? s : null; });
    assert.deepEqual(got.added.map((x) => [x.id, x.userId, x.name, x.reason]), [[String(app1.token.id), carla, 'dc-carla-app', 'created']]);
    assert.ok(!got.added.some((x) => x.id === String(admin.token.id) || x.id === String(loose.token.id)));
    assert.deepEqual(got.removed, []);
  });

  it('a token created and removed again in one batch (a failed enrollment) is never announced', async () => {
    const dora = H.makeUser('dc-dora');
    devices._batchMs = 60000;
    const t = tokens.create({ name: 'dc-dora-app', scopes: ['client'], userId: dora }, '127.0.0.1');
    tokens.revoke(t.token.id, '127.0.0.1');
    devices.flush();
    await sleep(300);
    assert.equal((await seen('dc-hook')).calls, 0);
  });

  it('a person disabled → all devices removed (user_disabled); enabled again → added (user_enabled); deleted → removed', async () => {
    const emil = H.makeUser('dc-emil');
    const a = H.makeDevice(emil, { name: 'dc-emil-phone' });
    const b = H.makeDevice(emil, { name: 'dc-emil-pc', platform: 'windows' });
    await sleep(100);
    await kv('dc-hook', 'seen', null);
    const ids = [String(a.tokenId), String(b.tokenId)].sort();

    users.toggle(emil);
    let got = await until(async () => { const s = await seen('dc-hook'); return s.removed.length >= 2 ? s : null; });
    assert.deepEqual(got.removed.map((x) => x.id).sort(), ids);
    assert.ok(got.removed.every((x) => x.reason === 'user_disabled' && x.userId === emil));

    await kv('dc-hook', 'seen', null);
    users.toggle(emil);
    got = await until(async () => { const s = await seen('dc-hook'); return s.added.length >= 2 ? s : null; });
    assert.deepEqual(got.added.map((x) => x.id).sort(), ids);
    assert.ok(got.added.every((x) => x.reason === 'user_enabled'));

    await kv('dc-hook', 'seen', null);
    users.remove(emil);
    got = await until(async () => { const s = await seen('dc-hook'); return s.removed.length >= 2 ? s : null; });
    assert.deepEqual(got.removed.map((x) => x.id).sort(), ids);
    assert.ok(got.removed.every((x) => x.reason === 'user_deleted'));
  });

  it('a token moved to another person → removed for the old owner, added for the new one (owner_changed)', async () => {
    const fritz = H.makeUser('dc-fritz');
    const gina = H.makeUser('dc-gina');
    const t = H.makeDevice(fritz, { name: 'dc-fritz-phone' });
    await sleep(100);
    await kv('dc-hook', 'seen', null);
    tokens.update(t.tokenId, { userId: gina });
    const got = await until(async () => { const s = await seen('dc-hook'); return s.added.length && s.removed.length ? s : null; });
    assert.deepEqual(got.removed.map((x) => [x.id, x.userId, x.reason]), [[String(t.tokenId), fritz, 'owner_changed']]);
    assert.deepEqual(got.added.map((x) => [x.id, x.userId, x.reason]), [[String(t.tokenId), gina, 'owner_changed']]);
  });

  it('a failing or slow plugin never holds up the change; the failure lands in its log, the others still get it', async () => {
    devices._hookMs = 500;
    const hans = H.makeUser('dc-hans');
    const t1 = H.makeDevice(hans, { name: 'dc-hans-1' });
    const t2 = H.makeDevice(hans, { name: 'dc-hans-2' });
    await sleep(100);
    for (const id of ['dc-hook', 'dc-broken']) await kv(id, 'seen', null);

    await kv('dc-broken', 'mode', 'throw');
    const since = Date.now();
    let t0 = Date.now();
    tokens.revoke(t1.tokenId, '127.0.0.1');
    assert.ok(Date.now() - t0 < 200, 'the revoke does not wait for the plugins');
    assert.ok(await until(async () => (await seen('dc-hook')).removed.length === 1), 'dc-hook got it');
    const failed = await until(() => registry.logs('dc-broken').find((l) => l.created_at >= since && /devicesChanged failed: .*broken on purpose/.test(l.message)));
    assert.ok(failed, 'the error is in the plugin log');
    assert.equal(failed.level, 'warn');

    await kv('dc-broken', 'mode', 'slow');
    await kv('dc-hook', 'seen', null);
    t0 = Date.now();
    tokens.revoke(t2.tokenId, '127.0.0.1');
    assert.ok(Date.now() - t0 < 200);
    assert.equal(tokens.getById(t2.tokenId), null, 'the token is gone at once');
    assert.ok(await until(async () => (await seen('dc-hook')).removed.length === 1));
    assert.ok(await until(() => registry.logs('dc-broken').some((l) => l.created_at >= since && /devicesChanged failed/.test(l.message) && !/broken on purpose/.test(l.message))), 'the timeout is logged');
  });

  it('announce never throws and ignores entries without a known reason', () => {
    assert.doesNotThrow(() => devices.announce(null));
    assert.doesNotThrow(() => devices.announce({ removed: [null, { id: '1' }, { id: '2', reason: 'whatever' }] }));
    assert.deepEqual(devices.entriesFor({}, 'revoked'), []);
    assert.deepEqual(devices.entriesFor({ tokenIds: ['x', -1] }, 'revoked'), []);
  });
});
