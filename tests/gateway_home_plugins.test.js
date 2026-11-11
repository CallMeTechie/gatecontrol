'use strict';

// Plugin APIs of phase 3b (docs/plugins.md "Internet at home", "Home cache"):
// the manifest permissions homeInternet / homeCache, gc.homeNetwork.internet
// in a real plugin process — changes only inside a changing request of a
// signed-in person (that person is the actor in the activity log), never a
// MAC address for the plugin — and gc.homeCache: offering the plugin's own
// media to the gateways' stock (only gateways of the people named), the lan
// hint only for the request the plugin answers (req.homeRef) — and, since
// 1.249.0, GateControl's previews of that media (offer({ preview }), the
// plaintext JPEG served to the gateway, lanHint / lanHints for them).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const supertest = require('supertest');
const { homePackage, presencePackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let app, agent, csrf, db, gw, gw2, runtime, plugins, timId;
const P = 'home-demo';
const MIN = 60 * 1000;
const TIM = 'da:a1:19:00:00:05';
const TIM_TAB = 'da:a1:19:00:00:06';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(40);
  }
}

const pushed = [];

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  require('../src/services/license')._overrideForTest({ gateway_peers: 10 });
  const gateways = require('../src/services/gateways');
  gateways.notifyConfigChanged = async (id) => { pushed.push(id); };
  gw = await gateways.createGateway({ name: 'Pi Keller' });
  gw2 = await gateways.createGateway({ name: 'NAS Buero' });
  db = require('../src/db/connection').getDb();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  const users = require('../src/services/users');
  timId = (await users.create({ username: 'tim', password: 'TimPass123!xy', role: 'user', displayName: 'Tim' })).id;
  const now = Date.now();
  await supertest(app).post('/api/v1/gateway/netwatch').set('Authorization', 'Bearer ' + gw.apiToken).send({ full: true, devices: [
    { mac: TIM, ip: '192.168.1.120', vendor: 'Samsung', hostname: null, randomMac: false, online: true, firstSeen: now - MIN, lastSeen: now, ports: [] },
    { mac: TIM_TAB, ip: '192.168.1.121', vendor: 'Apple', hostname: null, randomMac: false, online: true, firstSeen: now - MIN, lastSeen: now, ports: [] },
  ] }).expect(200);
  for (const mac of [TIM, TIM_TAB]) {
    const id = db.prepare('SELECT id FROM netwatch_devices WHERE mac = ?').get(mac).id;
    await agent.put(`/api/v1/gateways/${gw.peer.id}/netwatch/devices/${id}`).set('X-CSRF-Token', csrf).send({ ownerUserId: timId }).expect(200);
  }
  await agent.put(`/api/v1/gateways/${gw.peer.id}/dns`).set('X-CSRF-Token', csrf).send({ enabled: true }).expect(200);
});

after(async () => {
  await plugins.stop();
  teardown();
});

describe('manifest: permissions.homeInternet and homeCache', () => {
  it('booleans, shown in the install dialog', async () => {
    const manifest = require('../src/services/plugins/manifest');
    const base = { id: 'x-y', name: 'X', version: '1.0.0', publisher: 'T', description: 'd', gatecontrol: '>=1.0.0', entry: 'server/index.js' };
    const m = manifest.validate({ ...base, permissions: { homeInternet: true, homeCache: true } }).manifest.permissions;
    assert.equal(m.homeInternet, true);
    assert.equal(m.homeCache, true);
    assert.equal(manifest.validate({ ...base }).manifest.permissions.homeInternet, false);
    assert.equal(manifest.validate({ ...base }).manifest.permissions.homeCache, false);
    for (const k of ['homeInternet', 'homeCache']) {
      const bad = manifest.validate({ ...base, permissions: { [k]: 'yes' } });
      assert.equal(bad.ok, false);
      assert.ok(bad.errors.some((e) => e.includes(k)), k);
    }
    const { inspect } = await installPkg(homePackage());
    assert.equal(inspect.plugin.permissions.homeInternet, true);
    assert.equal(inspect.plugin.permissions.homeCache, true);
    assert.equal(await runtime.waitRunning(P), true);
  });

  it('gc.homeNetwork.internet / gc.homeCache exist only with the permission; requests carry a homeRef', async () => {
    assert.deepEqual(await api('get', '/has'), { ok: true, internet: true, presence: false, cache: true, homeRef: true });
    const hostApi = require('../src/services/plugins/hostApi');
    const fake = { id: 'nope', manifest: { permissions: {} } };
    await assert.rejects(hostApi.handle(fake, 'homeNetwork.internet.status', { userId: timId }), (e) => e.code === 'ERR_HOME_INTERNET_DENIED');
    await assert.rejects(hostApi.handle(fake, 'homeCache.offer', {}), (e) => e.code === 'ERR_HOME_CACHE_DENIED');
    // a plugin with presence only has no gc.homeNetwork.internet
    await installPkg(presencePackage());
    assert.equal(await runtime.waitRunning('presence-demo'), true);
    const r = await agent.get('/api/v1/plugins/presence-demo/api/has').expect(200);
    assert.equal(r.body.homeNetwork, true);
  });
});

describe('gc.homeNetwork.internet', () => {
  it('status: the profile and the times, a count of devices, never an address', async () => {
    const r = await api('get', `/status?userId=${timId}`);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(Object.keys(r.result).sort(), ['devices', 'extended', 'filtered', 'nextSchedule', 'paused', 'profile', 'userId']);
    assert.equal(r.result.filtered, true);
    assert.equal(r.result.devices, 2);
    assert.equal(r.result.profile.id, 'default');
    assert.equal(r.result.profile.gateway, 'Pi Keller');
    assert.equal(r.result.paused, null);
    assert.equal((await api('get', '/status?userId=99999')).code, 'ERR_INVALID');
  });

  it('pause in a changing request of a signed-in person: the actor is logged, the gateway gets the MACs', async () => {
    pushed.length = 0;
    const r = await api('post', '/pause', { userId: timId, until: 45 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(Date.parse(r.result.paused) > Date.now() + 44 * MIN);
    assert.deepEqual(pushed, [gw.peer.id], 'only the gateway with his devices, at once');
    const c = await supertest(app).get('/api/v1/gateway/config').set('Authorization', 'Bearer ' + gw.apiToken).expect(200);
    assert.deepEqual(c.body.features.dns.pauses, [{ macs: [TIM, TIM_TAB].sort(), until: r.result.paused }]);
    const a = db.prepare("SELECT message, details, source FROM activity_log WHERE event_type = 'home_internet_paused' ORDER BY id DESC").get();
    const det = JSON.parse(a.details);
    assert.deepEqual(det.actor_user_ids, [1]);
    assert.equal(det.plugin_id, P);
    assert.equal(det.user_id, timId);
    assert.match(a.message, /Tim/);
    assert.equal(JSON.stringify(det).includes(TIM), false, 'no MAC in the log');
    // an ISO time works as well
    const until = new Date(Date.now() + 90 * MIN).toISOString();
    assert.equal((await api('post', '/pause', { userId: timId, until })).result.paused, until);
  });

  it('not in a GET, not a moment after the answer, not too far ahead, not for unknown people', async () => {
    assert.equal((await api('get', `/pause?userId=${timId}`)).code, 'ERR_NOT_PERSON');
    await api('post', '/later', { userId: timId });
    const later = await waitFor(async () => (await api('get', '/later-result')).result);
    assert.equal(later.ok, false);
    assert.equal(later.code, 'ERR_NOT_PERSON');
    assert.equal((await api('post', '/pause', { userId: timId, until: 8 * 24 * 60 })).code, 'ERR_INVALID');
    assert.equal((await api('post', '/pause', { userId: timId, until: new Date(Date.now() - MIN).toISOString() })).code, 'ERR_INVALID');
    assert.equal((await api('post', '/pause', { userId: timId, until: 'soon' })).code, 'ERR_INVALID');
    assert.equal((await api('post', '/pause', { userId: 99999, until: 10 })).code, 'ERR_INVALID');
  });

  it('extend adds up from a running extension, 0 ends it; resume ends the pause', async () => {
    const a = await api('post', '/extend', { userId: timId, minutes: 30 });
    assert.equal(a.ok, true, JSON.stringify(a));
    const b = await api('post', '/extend', { userId: timId, minutes: 30 });
    const diff = Date.parse(b.result.extended) - Date.parse(a.result.extended);
    assert.ok(diff >= 30 * MIN - 2000 && diff <= 30 * MIN + 2000, String(diff));
    assert.equal((await api('post', '/extend', { userId: timId, minutes: 25 * 60 })).code, 'ERR_INVALID');
    assert.equal((await api('post', '/extend', { userId: timId, minutes: 0 })).result.extended, null);
    const r = await api('post', '/resume', { userId: timId });
    assert.equal(r.result.paused, null);
    const c = await supertest(app).get('/api/v1/gateway/config').set('Authorization', 'Bearer ' + gw.apiToken).expect(200);
    assert.deepEqual([c.body.features.dns.pauses, c.body.features.dns.extensions], [[], []]);
    assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE event_type = 'home_internet_resumed'").get());
  });

  it('{ actor }: an automation acts for the person who set it up — outside a request, logged as automatic', async () => {
    assert.equal((await api('get', '/actors')).actors, true);
    const users = require('../src/services/users');
    const annaId = (await users.create({ username: 'anna-actor', password: 'AnnaPass123!xy', role: 'user', displayName: 'Anna' })).id;
    const result = async () => waitFor(async () => (await api('get', '/later-result')).result);
    // a moment after the answer: no request of a person in flight, the plugin names the actor
    pushed.length = 0;
    await api('post', '/later', { userId: timId, actor: annaId });
    const later = await result();
    assert.equal(later.ok, true, JSON.stringify(later));
    assert.ok(Date.parse(later.result.paused) > Date.now() + 9 * MIN);
    assert.deepEqual(pushed, [gw.peer.id], 'the gateway is told like for a person\'s own change');
    const a = db.prepare("SELECT message, details FROM activity_log WHERE event_type = 'home_internet_paused' ORDER BY id DESC").get();
    const det = JSON.parse(a.details);
    assert.deepEqual([det.actor_user_ids, det.actors, det.automated, det.plugin_id], [[annaId], ['Anna'], true, P]);
    assert.match(a.message, /automatically for Anna, plugin home-demo/);
    assert.equal(db.prepare("SELECT actor_user_id FROM home_internet WHERE user_id = ? AND kind = 'pause'").get(timId).actor_user_id, annaId);
    // resume and extend the same way
    await api('post', '/later', { userId: timId, actor: annaId, op: 'resume' });
    assert.equal((await result()).result.paused, null);
    assert.match(db.prepare("SELECT message FROM activity_log WHERE event_type = 'home_internet_resumed' ORDER BY id DESC").get().message, /automatically for Anna/);
    await api('post', '/later', { userId: timId, actor: annaId, op: 'extend', minutes: 20 });
    assert.ok(Date.parse((await result()).result.extended) > Date.now() + 19 * MIN);
    await api('post', '/later', { userId: timId, actor: annaId, op: 'extend', minutes: 0 });
    assert.equal((await result()).result.extended, null);
    // inside a request of somebody else the named person is the actor, not the one in the request (the admin, id 1)
    const r = await api('post', '/pause', { userId: timId, until: 15, actor: annaId });
    assert.equal(r.ok, true, JSON.stringify(r));
    const det2 = JSON.parse(db.prepare("SELECT details FROM activity_log WHERE event_type = 'home_internet_paused' ORDER BY id DESC").get().details);
    assert.deepEqual([det2.actor_user_ids, det2.automated], [[annaId], true]);
    // a person's own change is not marked
    await api('post', '/pause', { userId: timId, until: 15 });
    const det3 = JSON.parse(db.prepare("SELECT details FROM activity_log WHERE event_type = 'home_internet_paused' ORDER BY id DESC").get().details);
    assert.deepEqual([det3.actor_user_ids, 'automated' in det3], [[1], false]);
    // an actor must be an enabled person; without one nothing changes outside a request
    for (const actor of [99999, 0, 'anna', 1.5]) {
      await api('post', '/later', { userId: timId, actor });
      assert.equal((await result()).code, 'ERR_INVALID', String(actor));
    }
    db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(annaId);
    await api('post', '/later', { userId: timId, actor: annaId });
    assert.equal((await result()).code, 'ERR_INVALID', 'a disabled account acts for nobody');
    await api('post', '/later', { userId: timId, actor: null });
    assert.equal((await result()).code, 'ERR_NOT_PERSON');
    await api('post', '/resume', { userId: timId });
  });

  it('writers(): the people with a changing request in flight', async () => {
    const ctx = require('../src/services/plugins/personContext');
    assert.deepEqual(ctx.writers('q'), []);
    await ctx.run('q', 7, false, async () => {
      assert.deepEqual(ctx.writers('q'), []);
      await ctx.run('q', 9, true, async () => { assert.deepEqual(ctx.writers('q'), [9]); });
    });
    assert.deepEqual(ctx.writers('q'), []);
  });
});

describe('gc.homeCache', () => {
  let media;
  let blob;
  before(async () => {
    const reg = require('../src/services/plugins/registry');
    blob = crypto.randomBytes(64 * 1024);
    media = await require('../src/services/plugins/media').storeBuffer(reg.get(P), blob, { mime: 'application/octet-stream', name: 'urlaub.jpg' });
    await agent.put(`/api/v1/gateways/${gw.peer.id}/cache`).set('X-CSRF-Token', csrf).send({ enabled: true }).expect(200);
    await agent.put(`/api/v1/gateways/${gw2.peer.id}/cache`).set('X-CSRF-Token', csrf).send({ enabled: true }).expect(200);
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(JSON.stringify({
      telemetry: { gateway_version: '1.22.0', lan_ip: '192.168.1.23', cache: { running: true, port: 8443, tlsSha256: 'cd'.repeat(32) } },
    }), gw.peer.id);
  });

  it('offer: sha256 and size from the stored file; only gateways of the people named keep it', async () => {
    const sha = crypto.createHash('sha256').update(blob).digest('hex');
    const r = await api('post', '/offer', { mediaId: media.mediaId, kind: 'photos', userIds: [timId], priority: 70 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.result, { sha256: sha, size: blob.length, offered: true });
    const want = (g) => supertest(app).get('/api/v1/gateway/cache/want').set('Authorization', 'Bearer ' + g.apiToken).expect(200).then((x) => x.body.items);
    assert.deepEqual(await want(gw), [{ sha256: sha, size: blob.length, kind: 'photos', priority: 70 }]);
    assert.deepEqual(await want(gw2), [], 'Tim has no devices at the NAS');
    // the bytes for the gateway come from the plugin's media
    const got = await supertest(app).get('/api/v1/gateway/cache/blob/' + sha).set('Authorization', 'Bearer ' + gw.apiToken)
      .buffer(true).parse((res, cb) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    assert.ok(Buffer.compare(got.body, blob) === 0);
    await supertest(app).get('/api/v1/gateway/cache/blob/' + sha).set('Authorization', 'Bearer ' + gw2.apiToken).expect(404);
    assert.equal((await api('post', '/offer', { mediaId: media.mediaId, kind: 'music' })).code, 'ERR_INVALID');
    assert.equal((await api('post', '/offer', { mediaId: 'f'.repeat(32), kind: 'drive' })).code, 'ERR_NOT_FOUND');
    assert.equal((await api('post', '/offer', { mediaId: media.mediaId, kind: 'drive', sha256: '0'.repeat(64) })).code, 'ERR_INVALID');
  });

  it('lanHint: only in the request it answers, only at the gateway\'s site, only when the gateway holds it', async () => {
    const sha = crypto.createHash('sha256').update(blob).digest('hex');
    const hn = require('../src/services/homeNetwork');
    const orig = hn.check;
    hn.check = async (ip, peerId, opts) => (opts.local === '192.168.1.60' ? { same_lan: true, site: { type: 'gateway', gatewayId: gw.peer.id, name: 'Pi Keller' } } : { same_lan: false, site: null });
    try {
      assert.equal((await api('post', '/hint?local=192.168.1.60', { mediaId: media.mediaId })).result, null, 'the gateway does not hold it yet');
      await supertest(app).post('/api/v1/gateway/cache').set('Authorization', 'Bearer ' + gw.apiToken).send({ have: [sha] }).expect(200);
      // offered for Tim only: the admin in this request is not one of the people
      assert.equal((await api('post', '/hint?local=192.168.1.60', { mediaId: media.mediaId })).result, null);
      assert.equal((await api('post', '/offer', { mediaId: media.mediaId, kind: 'photos', userIds: [timId, 1], priority: 70 })).ok, true);
      const r = await api('post', '/hint?local=192.168.1.60', { mediaId: media.mediaId });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.result.sha256, sha);
      assert.equal(r.result.tlsSha256, 'cd'.repeat(32));
      const secret = require('../src/services/homeCache').secretOf(gw.peer.id, false);
      const sig = crypto.createHmac('sha256', secret).update(sha + '\n' + r.result.exp).digest('hex');
      assert.equal(r.result.url, `https://192.168.1.23:8443/blob/${sha}?exp=${r.result.exp}&sig=${sig}`);
      // by sha256 as well; away from home: null
      const bySha = await api('post', '/hint?local=192.168.1.60', { sha256: sha });
      assert.equal(bySha.ok, true, JSON.stringify(bySha));
      assert.ok(bySha.result, JSON.stringify(bySha));
      assert.equal(bySha.result.sha256, sha);
      assert.equal((await api('post', '/hint?local=10.1.1.1', { sha256: sha })).result, null);
      // a sha256 the plugin did not offer (an app update, another plugin's file): null
      assert.equal((await api('post', '/hint?local=192.168.1.60', { sha256: 'a'.repeat(64) })).result, null);
      // without the request: refused
      assert.equal((await api('post', '/hint-noreq', { sha256: sha })).code, 'ERR_NOT_IN_REQUEST');
    } finally { hn.check = orig; }
  });

  it('withdraw: out of the stock', async () => {
    assert.deepEqual((await api('post', '/withdraw', { mediaId: media.mediaId })).result, { removed: true });
    const items = (await supertest(app).get('/api/v1/gateway/cache/want').set('Authorization', 'Bearer ' + gw.apiToken).expect(200)).body.items;
    assert.deepEqual(items, []);
  });

  it('request refs are valid only in flight and only for their plugin', async () => {
    const refs = require('../src/services/plugins/requestRefs');
    let seen = null;
    await refs.run('a-b', { ip: '1.2.3.4', userId: 5 }, async (ref) => {
      seen = ref;
      assert.equal(refs.get('a-b', ref).userId, 5);
      assert.equal(refs.get('other', ref), null);
    });
    assert.equal(refs.get('a-b', seen), null);
    assert.equal(refs.get('a-b', 'x'), null);
  });
});

describe('gc.homeCache: previews', () => {
  let photo;
  let doc;
  let smallSha;
  let small;
  const hn = require('../src/services/homeNetwork');
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const want = (g = gw) => supertest(app).get('/api/v1/gateway/cache/want').set('Authorization', 'Bearer ' + g.apiToken).expect(200).then((x) => x.body.items);
  const blob = (h, range) => {
    let r = supertest(app).get('/api/v1/gateway/cache/blob/' + h).set('Authorization', 'Bearer ' + gw.apiToken);
    if (range) r = r.set('Range', range);
    return r.buffer(true).parse((res, cb) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
  };
  const atHome = async (fn) => {
    const orig = hn.check;
    hn.check = async (ip, peerId, opts) => (opts.local === '192.168.1.60' ? { same_lan: true, site: { type: 'gateway', gatewayId: gw.peer.id, name: 'Pi Keller' } } : { same_lan: false, site: null });
    try { return await fn(); } finally { hn.check = orig; }
  };

  before(async () => {
    const reg = require('../src/services/plugins/registry');
    const media = require('../src/services/plugins/media');
    const jpeg = await require('sharp')({ create: { width: 900, height: 600, channels: 3, background: { r: 30, g: 120, b: 200 } } }).jpeg().toBuffer();
    photo = await media.storeBuffer(reg.get(P), jpeg, { mime: 'image/jpeg', name: 'see.jpg' });
    doc = await media.storeBuffer(reg.get(P), crypto.randomBytes(2048), { mime: 'application/octet-stream', name: 'daten.bin' });
  });

  it('gc.homeCache says it takes previews (previews: true, lanHints)', async () => {
    assert.deepEqual(await api('get', '/previews'), { ok: true, previews: true, lanHints: true });
  });

  it('offer({ preview }): made first (ERR_PREVIEW_PENDING), then its plaintext JPEG in the stock', async () => {
    const first = await api('post', '/offer', { mediaId: photo.mediaId, preview: 'small', kind: 'photos', userIds: [timId, 1], priority: 95 });
    assert.equal(first.code, 'ERR_PREVIEW_PENDING', JSON.stringify(first));
    await require('../src/services/plugins/mediaPreviews').idle();
    const r = await api('post', '/offer', { mediaId: photo.mediaId, preview: 'small', kind: 'photos', userIds: [timId, 1], priority: 95 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.offered, true);
    assert.equal(r.result.preview, 'small');
    smallSha = r.result.sha256;
    // the bytes the gateway gets: GateControl's small preview (JPEG, ≤ 320 px), checked against the sha256
    const got = await blob(smallSha).expect(200);
    small = got.body;
    assert.equal(sha(small), smallSha);
    assert.equal(small.length, r.result.size);
    const meta = await require('sharp')(small).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.ok(meta.width <= 320 && meta.height <= 320, `${meta.width}×${meta.height}`);
    const part = await blob(smallSha, 'bytes=0-9').expect(206);
    assert.ok(Buffer.compare(part.body, small.subarray(0, 10)) === 0);
    // in the stock like a file of its kind, the highest priority first
    assert.deepEqual((await want()).find((x) => x.sha256 === smallSha), { sha256: smallSha, size: small.length, kind: 'photos', priority: 95 });
    // the large one is other content
    const large = await api('post', '/offer', { mediaId: photo.mediaId, preview: 'large', kind: 'photos', userIds: [timId, 1], priority: 45 });
    assert.equal(large.ok, true, JSON.stringify(large));
    assert.notEqual(large.result.sha256, smallSha);
    assert.ok(large.result.size > small.length);
  });

  it('offer({ preview }) refuses what has none, a vault, wrong sizes', async () => {
    assert.equal((await api('post', '/offer', { mediaId: doc.mediaId, preview: 'small', kind: 'drive' })).code, 'ERR_NOT_FOUND');
    assert.equal((await api('post', '/offer', { mediaId: photo.mediaId, preview: 'small', kind: 'vault' })).code, 'ERR_INVALID');
    assert.equal((await api('post', '/offer', { mediaId: photo.mediaId, preview: 'huge', kind: 'photos' })).code, 'ERR_INVALID');
    assert.equal((await api('post', '/offer', { mediaId: photo.mediaId, preview: 'small', kind: 'photos', sha256: '0'.repeat(64) })).code, 'ERR_INVALID');
    assert.equal((await api('post', '/offer', { mediaId: 'f'.repeat(32), preview: 'small', kind: 'photos' })).code, 'ERR_NOT_FOUND');
    // a plugin without media.previews
    const hostApi = require('../src/services/plugins/hostApi');
    const fake = { id: P, manifest: { permissions: { homeCache: true }, media: { maxBytes: 1024, types: ['image/*'] } } };
    await assert.rejects(hostApi.handle(fake, 'homeCache.offer', { mediaId: photo.mediaId, preview: 'small', kind: 'photos' }), (e) => e.code === 'ERR_MEDIA_DENIED');
  });

  it('lanHint({ mediaId, preview }) and lanHints: only previews offered and held, the original apart', async () => {
    await atHome(async () => {
      assert.equal((await api('post', '/hint?local=192.168.1.60', { mediaId: photo.mediaId, preview: 'small' })).result, null, 'not held yet');
      await supertest(app).post('/api/v1/gateway/cache').set('Authorization', 'Bearer ' + gw.apiToken).send({ have: [smallSha] }).expect(200);
      const r = await api('post', '/hint?local=192.168.1.60', { mediaId: photo.mediaId, preview: 'small' });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.result.sha256, smallSha);
      const secret = require('../src/services/homeCache').secretOf(gw.peer.id, false);
      assert.equal(r.result.url, `https://192.168.1.23:8443/blob/${smallSha}?exp=${r.result.exp}&sig=${crypto.createHmac('sha256', secret).update(smallSha + '\n' + r.result.exp).digest('hex')}`);
      // the original was never offered: no hint for it
      assert.equal((await api('post', '/hint?local=192.168.1.60', { mediaId: photo.mediaId })).result, null);
      // many at once, in order; what is not offered, not held or wrong is null
      const many = await api('post', '/hints?local=192.168.1.60', { items: [
        { mediaId: photo.mediaId, preview: 'small' }, { mediaId: photo.mediaId, preview: 'large' }, { mediaId: photo.mediaId },
        { mediaId: doc.mediaId, preview: 'small' }, smallSha, 'kein-sha', { mediaId: photo.mediaId, preview: 'huge' },
      ] });
      assert.equal(many.ok, true, JSON.stringify(many));
      assert.equal(many.result.length, 7);
      assert.equal(many.result[0].sha256, smallSha);
      assert.deepEqual(many.result.slice(1), [null, null, null, many.result[4], null, null]);
      assert.equal(many.result[4].sha256, smallSha);
      // away from home: all null
      assert.deepEqual((await api('post', '/hints?local=10.1.1.1', { items: [{ mediaId: photo.mediaId, preview: 'small' }] })).result, [null]);
      assert.equal((await api('post', '/hints?local=192.168.1.60', { items: new Array(501).fill(smallSha) })).code, 'ERR_INVALID');
    });
  });

  it('withdraw(mediaId, { preview }) takes only that preview; the hourly clean-up drops previews that are gone', async () => {
    const hc = require('../src/services/homeCache');
    assert.deepEqual((await api('post', '/withdraw', { mediaId: photo.mediaId })).result, { removed: false }, 'the file itself was not offered');
    assert.ok((await want()).some((x) => x.sha256 === smallSha), 'its previews stay');
    assert.deepEqual((await api('post', '/withdraw', { mediaId: photo.mediaId, preview: 'large' })).result, { removed: true });
    assert.equal((await want()).filter((x) => x.priority === 45).length, 0);
    assert.ok((await want()).some((x) => x.sha256 === smallSha));
    // unchanged preview: kept
    assert.equal(await hc.refreshPreviewOffers(), 0);
    // its preview files gone (e.g. "Alles löschen" of the previews): out of the stock, the gateway gets 404
    require('../src/services/plugins/mediaPreviews').drop(P, photo.mediaId);
    await blob(smallSha).expect(404);
    assert.equal(await hc.refreshPreviewOffers(), 1);
    assert.equal((await want()).some((x) => x.sha256 === smallSha), false);
  });
});
