'use strict';

// Presence over the home network (phase 3a, docs/plugins.md "Presence over the
// home network"): the manifest permission homePresence, gc.homeNetwork in a
// real plugin process, consent only by the person themselves (inside their
// own changing request), MACs only of people who agreed in the config pull,
// gateway reports → state per person → the plugin's on() handler, and never a
// MAC or IP address in anything a plugin gets.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { presencePackage, helloPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let app, agent, csrf, db, gw, runtime, plugins, users;
let annaId;
const P = 'presence-demo';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PHONE = '3c:22:fb:00:00:02';
const IPAD = '3c:22:fb:00:00:03';
const ANNA = 'da:a1:19:00:00:01';

async function installPkg(buf) {
  const r = await agent.post('/api/v1/plugins/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  const res = await agent.post('/api/v1/plugins/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { inspect: r.body, install: res.body };
}

async function api(method, path, body) {
  const req = method === 'get' ? agent.get(`/api/v1/plugins/${P}/api${path}`) : agent[method](`/api/v1/plugins/${P}/api${path}`).set('X-CSRF-Token', csrf).send(body || {});
  const r = await req;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

function gwPost(path, body) {
  return supertest(app).post('/api/v1/gateway' + path).set('Authorization', 'Bearer ' + gw.apiToken).send(body);
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(40);
  }
}

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  require('../src/services/license')._overrideForTest({ gateway_peers: 10 });
  const gateways = require('../src/services/gateways');
  gateways.notifyConfigChanged = async () => {};
  gw = await gateways.createGateway({ name: 'Pi Keller' });
  db = require('../src/db/connection').getDb();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  users = require('../src/services/users');
  const anna = await users.create({ username: 'anna', password: 'AnnaPass123!x', role: 'user', display_name: 'Anna' });
  annaId = anna.id;
  // the inventory and the phones: Marc (admin, id 1) with phone + iPad, Anna with a phone
  await gwPost('/netwatch', { full: true, devices: [
    { mac: PHONE, ip: '192.168.1.104', vendor: 'Apple', hostname: 'Marcs-iPhone', randomMac: false, online: true, firstSeen: Date.now(), lastSeen: Date.now(), ports: [] },
    { mac: IPAD, ip: '192.168.1.105', vendor: 'Apple', hostname: 'Marcs-iPad', randomMac: false, online: true, firstSeen: Date.now(), lastSeen: Date.now(), ports: [] },
    { mac: ANNA, ip: '192.168.1.118', vendor: 'Google', hostname: 'Pixel', randomMac: true, online: true, firstSeen: Date.now(), lastSeen: Date.now(), ports: [] },
  ] }).expect(200);
  const id = (mac) => db.prepare('SELECT id FROM netwatch_devices WHERE mac = ?').get(mac).id;
  const put = (mac, body) => agent.put(`/api/v1/gateways/${gw.peer.id}/netwatch/devices/${id(mac)}`).set('X-CSRF-Token', csrf).send(body).expect(200);
  await put(PHONE, { name: 'Marcs iPhone', ownerUserId: 1, presence: true });
  await put(IPAD, { name: 'Marcs iPad', ownerUserId: 1, presence: false });
  await put(ANNA, { name: 'Annas Pixel', ownerUserId: annaId, presence: true });
});

after(async () => {
  await plugins.stop();
  teardown();
});

describe('manifest: permissions.homePresence', () => {
  it('a boolean, shown in the install dialog', async () => {
    const manifest = require('../src/services/plugins/manifest');
    const base = { id: 'x-y', name: 'X', version: '1.0.0', publisher: 'T', description: 'd', gatecontrol: '>=1.0.0', entry: 'server/index.js' };
    assert.equal(manifest.validate({ ...base, permissions: { homePresence: true } }).manifest.permissions.homePresence, true);
    assert.equal(manifest.validate({ ...base }).manifest.permissions.homePresence, false);
    const bad = manifest.validate({ ...base, permissions: { homePresence: 'yes' } });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => /homePresence/.test(e)));
    const { inspect } = await installPkg(presencePackage());
    assert.equal(inspect.plugin.permissions.homePresence, true);
    assert.equal(await runtime.waitRunning(P), true);
  });

  it('gc.homeNetwork exists only with the permission', async () => {
    assert.equal((await api('get', '/has')).homeNetwork, true);
    const fake = { id: 'nope', manifest: { permissions: {} } };
    const hostApi = require('../src/services/plugins/hostApi');
    await assert.rejects(hostApi.handle(fake, 'homeNetwork.presence.list', {}), (e) => e.code === 'ERR_HOME_PRESENCE_DENIED');
    await installPkg(helloPackage());
    assert.equal(await runtime.waitRunning('hello'), true);
  });
});

describe('consent only by the person themselves', () => {
  it('not for somebody else, not in a GET, not outside a request', async () => {
    let r = await api('post', '/consent', { userId: annaId, enabled: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ERR_NOT_PERSON');
    r = await api('get', '/consent?userId=1&set=1');
    assert.equal(r.code, 'ERR_NOT_PERSON', 'a GET request does not change anything');
    await api('post', '/later', { userId: 1 });
    const later = await waitFor(async () => (await api('get', '/later-result')).result);
    assert.equal(later.ok, false);
    assert.equal(later.code, 'ERR_NOT_PERSON');
    assert.equal(require('../src/services/homePresence').consentOf(1), false);
  });

  it('nothing goes to the gateway without consent', async () => {
    const r = await supertest(app).get('/api/v1/gateway/config').set('Authorization', 'Bearer ' + gw.apiToken).expect(200);
    assert.deepEqual(r.body.features.presence.macs, []);
  });

  it('the person switches it on in their own request → only their counting phone goes to the gateway', async () => {
    const r = await api('post', '/consent', { userId: 1, enabled: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.result, { consent: true });
    const c = await supertest(app).get('/api/v1/gateway/config').set('Authorization', 'Bearer ' + gw.apiToken).expect(200);
    assert.deepEqual(c.body.features.presence.macs, [PHONE], 'not the iPad (does not count), not Anna (no consent)');
    assert.equal((await api('get', '/consent?userId=1')).result.consent, true);
    assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE event_type = 'presence_consent_on'").get());
  });
});

describe('reports of the gateway → state per person → plugins', () => {
  it('an unknown or not-watched MAC is ignored; a wrong shape is 400', async () => {
    await gwPost('/presence', { events: [{ mac: ANNA, online: true, at: Date.now() }, { mac: '00:00:00:00:00:99', online: true, at: Date.now() }] }).expect(200);
    assert.deepEqual((await api('get', '/list')).result, []);
    await gwPost('/presence', { events: [{ mac: 'x', online: true }] }).expect(400);
    await gwPost('/presence', { events: Array.from({ length: 257 }, () => ({ mac: PHONE, online: true })) }).expect(400);
  });

  it('home, then away: list and on() get it — without addresses', async () => {
    const t0 = Date.now() - 1000;
    await gwPost('/presence', { events: [{ mac: PHONE, online: true, at: t0 }] }).expect(200);
    const list = (await api('get', '/list')).result;
    assert.deepEqual(list, [{ userId: 1, home: true, since: new Date(t0).toISOString(), source: 'wifi' }]);
    const ev = await waitFor(async () => (await api('get', '/events')).events.find((e) => e.userId === 1 && e.home === true));
    assert.ok(ev, 'the plugin got the event');
    // an older report does not win
    await gwPost('/presence', { events: [{ mac: PHONE, online: false, at: t0 - 5000 }] }).expect(200);
    assert.equal((await api('get', '/list')).result[0].home, true);
    await gwPost('/presence', { events: [{ mac: PHONE, online: false, at: t0 + 500 }] }).expect(200);
    assert.equal((await api('get', '/list')).result[0].home, false);
    const all = JSON.stringify(await api('get', '/events')) + JSON.stringify(await api('get', '/list'));
    for (const s of [PHONE, IPAD, ANNA, '192.168.1.', PHONE.toUpperCase()]) assert.equal(all.includes(s), false, s);
  });

  it('devices(): the person\'s own devices, names and times, never addresses', async () => {
    const r = await api('post', '/devices', { userId: 1 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.result.map((d) => [d.name, d.counts, d.gateway]), [['Marcs iPad', false, 'Pi Keller'], ['Marcs iPhone', true, 'Pi Keller']]);
    for (const d of r.result) assert.deepEqual(Object.keys(d).sort(), ['counts', 'gateway', 'id', 'lastSeen', 'name']);
    const s = JSON.stringify(r);
    assert.equal(s.includes(PHONE) || s.includes('192.168.'), false);
    assert.equal((await api('post', '/devices', { userId: annaId })).code, 'ERR_NOT_PERSON');
  });

  it('setCounts(): only the person, only their device', async () => {
    const ipad = db.prepare('SELECT id FROM netwatch_devices WHERE mac = ?').get(IPAD).id;
    const anna = db.prepare('SELECT id FROM netwatch_devices WHERE mac = ?').get(ANNA).id;
    assert.equal((await api('post', '/counts', { userId: 1, deviceId: anna, counts: true })).code, 'ERR_NOT_FOUND');
    assert.equal((await api('post', '/counts', { userId: annaId, deviceId: anna, counts: false })).code, 'ERR_NOT_PERSON');
    const r = await api('post', '/counts', { userId: 1, deviceId: ipad, counts: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    const c = await supertest(app).get('/api/v1/gateway/config').set('Authorization', 'Bearer ' + gw.apiToken).expect(200);
    assert.deepEqual(c.body.features.presence.macs, [PHONE, IPAD].sort());
  });

  it('switching off the network watch or presence on the gateway sends no MACs', async () => {
    await agent.put(`/api/v1/gateways/${gw.peer.id}/features`).set('X-CSRF-Token', csrf).send({ presence: { enabled: false } }).expect(200);
    let c = await supertest(app).get('/api/v1/gateway/config').set('Authorization', 'Bearer ' + gw.apiToken).expect(200);
    assert.deepEqual(c.body.features.presence, { enabled: false, macs: [] });
    await agent.put(`/api/v1/gateways/${gw.peer.id}/features`).set('X-CSRF-Token', csrf).send({ presence: { enabled: true } }).expect(200);
    c = await supertest(app).get('/api/v1/gateway/config').set('Authorization', 'Bearer ' + gw.apiToken).expect(200);
    assert.equal(c.body.features.presence.macs.length, 2);
  });

  it('withdrawing consent: MACs gone, state gone, the plugin hears home: null', async () => {
    const r = await api('post', '/consent', { userId: 1, enabled: false });
    assert.equal(r.ok, true);
    const c = await supertest(app).get('/api/v1/gateway/config').set('Authorization', 'Bearer ' + gw.apiToken).expect(200);
    assert.deepEqual(c.body.features.presence.macs, []);
    assert.deepEqual((await api('get', '/list')).result, []);
    const ev = await waitFor(async () => (await api('get', '/events')).events.find((e) => e.userId === 1 && e.home === null));
    assert.ok(ev);
  });
});

describe('person context (plugins/personContext.js)', () => {
  it('counts nested requests and separates read from write', async () => {
    const ctx = require('../src/services/plugins/personContext');
    assert.equal(ctx.has('p', 5), false);
    await ctx.run('p', 5, false, async () => {
      assert.equal(ctx.has('p', 5), true);
      assert.equal(ctx.has('p', 5, { write: true }), false);
      await ctx.run('p', 5, true, async () => { assert.equal(ctx.has('p', 5, { write: true }), true); });
      assert.equal(ctx.has('p', 5, { write: true }), false);
      assert.equal(ctx.has('other', 5), false);
    });
    assert.equal(ctx.has('p', 5), false);
    await assert.rejects(ctx.run('p', 5, true, async () => { throw new Error('x'); }));
    assert.equal(ctx.has('p', 5), false, 'released after an error');
  });
});
