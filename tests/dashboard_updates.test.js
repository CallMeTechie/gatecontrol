'use strict';

// The "Updates" card of the dashboard (services/dashboardUpdates.js,
// GET /api/v1/dashboard/updates): rights, the three states of the card
// (everything current / some updates / could not be checked), the comparison
// of the reported app versions with the newest releases, and that the
// endpoint answers from the caches — it never waits for a fetch and writes
// nothing. Plus what goes with it: the peers API (client_update_available),
// the count of the peers card, the gateways API (time of the last check),
// the page without the quick-add button and with the new left-aligned width.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const argon2 = require('argon2');
const supertest = require('supertest');
const { setup, teardown, getAgent } = require('./helpers/setup');

let app, agent, db, watch, updates, gwRelease, autoUpdate, catalog, registry, pluginUpdates, tokens, pkg;
const restore = [];
function stub(obj, name, fn) { const old = obj[name]; obj[name] = fn; restore.push(() => { obj[name] = old; }); }

before(async () => {
  ({ app } = await setup());
  agent = getAgent();
  db = require('../src/db/connection').getDb();
  watch = require('../src/services/releaseWatch');
  updates = require('../src/services/dashboardUpdates');
  gwRelease = require('../src/services/gatewayRelease');
  autoUpdate = require('../src/services/autoUpdate');
  catalog = require('../src/services/plugins/catalog');
  registry = require('../src/services/plugins/registry');
  pluginUpdates = require('../src/services/plugins/updates');
  tokens = require('../src/services/tokens');
  pkg = require('../package.json');
});
after(() => teardown());

const rel = (tag) => ({ tag_name: tag, html_url: `https://github.com/CallMeTechie/gatecontrol/releases/tag/${tag}` });
const NEXT = '999.0.0';

/** The releases the watch knows: { 'server:stable': 'v1.2.3' | null (fails) }. */
async function knownReleases(map) {
  watch._resetForTest();
  watch._setFetch(async (product, channel) => {
    const tag = map[`${product}:${channel}`];
    return tag ? { ok: true, data: rel(tag) } : { ok: false, data: null, reason: 'unreachable' };
  });
  await watch.refresh(Object.keys(map));
}

function addPeer(name, { version = null, product = null, channel = null, type = 'regular' } = {}) {
  return Number(db.prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type, client_version, client_product, client_platform, update_channel)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`)
    .run(name, crypto.randomBytes(16).toString('base64'), '10.8.7.' + Math.floor(Math.random() * 200 + 10) + '/32', type, version, product,
      product === 'android' ? 'android' : (product ? 'windows' : null), channel).lastInsertRowid);
}
function addGateway(name, version) {
  const id = addPeer(name, { type: 'gateway' });
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, last_health)
    VALUES (?, 9876, ?, 'e', ?, ?)`).run(id, crypto.randomBytes(8).toString('hex'), Date.now(), version ? JSON.stringify({ telemetry: { gateway_version: version } }) : null);
  return id;
}
function auStatus(over = {}) {
  return { status: 'active', mode: 'auto', mode_mismatch: false, mode_pending: false, age_s: 120, last_action: 'noop',
    running_version: pkg.version, window: { enabled: false, start: '03:00', end: '05:00', tz: 'Europe/Berlin' }, window_open: null, ...over };
}
/** Plugins: n installed, `ups` updates in a catalogue fetched at `at`; err = the last fetch failed. */
function pluginState({ installed = 2, ups = [], cached = true, at = new Date().toISOString(), err = null, enabled = true } = {}) {
  stub(registry, 'list', () => Array.from({ length: installed }, (_, i) => ({ id: 'p' + i, name: 'P' + i, version: '1.0.0' })));
  stub(catalog, 'enabled', () => enabled);
  stub(catalog, 'cached', () => (cached ? { plugins: new Map() } : null));
  stub(catalog, 'fetchedAt', () => (cached ? at : null));
  stub(catalog, 'lastError', () => err);
  stub(pluginUpdates, 'available', () => ups);
}

async function loginAs(username, role) {
  const hash = await argon2.hash('Plain!Pass1234', require('../src/utils/argon2Options'));
  db.prepare('INSERT INTO users (username, password_hash, role, self_service_enabled) VALUES (?, ?, ?, ?)').run(username, hash, role, role === 'user' ? 1 : 0);
  const a = supertest.agent(app);
  const page = await a.get('/login').expect(200);
  const csrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
  await a.post('/login').type('form').send({ username, password: 'Plain!Pass1234', _csrf: csrf }).expect(302);
  return a;
}

beforeEach(() => {
  db.prepare('DELETE FROM gateway_meta').run();
  db.prepare('DELETE FROM peers').run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'client_update.%'").run();
  watch._resetForTest();
  updates._resetForTest();
  gwRelease._resetBackoff();
  gwRelease._setTransport(null);
  stub(autoUpdate, 'getStatus', () => auStatus());
});
afterEach(() => { while (restore.length) restore.pop()(); watch._resetForTest(); });

const URL = '/api/v1/dashboard/updates';

describe('GET /api/v1/dashboard/updates — rights', () => {
  it('needs a session or a token', async () => {
    assert.equal((await supertest(app).get(URL)).status, 401);
  });
  it('a member gets 403 (the dashboard and its API are for administrators)', async () => {
    const m = await loginAs('upd-member', 'user');
    assert.equal((await m.get(URL)).status, 403);
    assert.equal((await m.get('/dashboard')).headers.location, '/profile');
  });
  it('a read-only token may read it like the other dashboard endpoints; a token without that scope may not', async () => {
    const ro = tokens.create({ name: 'upd-ro', scopes: ['read-only'] }, '127.0.0.1').rawToken;
    const res = await supertest(app).get(URL).set('X-API-Token', ro);
    assert.equal(res.status, 200);
    assert.ok(['ok', 'updates', 'unknown'].includes(res.body.state));
    const other = tokens.create({ name: 'upd-peers', scopes: ['peers'] }, '127.0.0.1').rawToken;
    assert.equal((await supertest(app).get(URL).set('X-API-Token', other)).status, 403);
    assert.equal((await supertest(app).get('/api/v1/dashboard/stats').set('X-API-Token', other)).status, 403, 'same rule as the other dashboard endpoints');
  });
});

describe('GET /api/v1/dashboard/updates — the three states', () => {
  it('everything current → state "ok" with the numbers of the slim row', async () => {
    await knownReleases({ 'server:stable': 'v' + pkg.version, 'android:stable': 'v1.17.2', 'pro:stable': 'v1.9.6' });
    gwRelease._setCache('1.31.0');
    pluginState({ installed: 4 });
    addGateway('gw-home', '1.31.0');
    addGateway('gw-nas', '1.31.0');
    addPeer('a1', { version: '1.17.2', product: 'android' });
    addPeer('a2', { version: '1.17.2', product: 'android' });
    addPeer('w1', { version: '1.9.6', product: 'pro' });
    const res = await agent.get(URL).expect(200);
    const b = res.body;
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual([b.ok, b.state, b.updates, b.failed_at], [true, 'ok', 0, null]);
    assert.ok(b.checked_at);
    assert.deepEqual([b.server.state, b.server.running_version, b.server.latest_version, b.server.update_available, b.server.check_failed],
      ['current', pkg.version, pkg.version, false, false]);
    assert.deepEqual([b.server.auto.status, b.server.auto.mode, b.server.auto.can_trigger], ['active', 'auto', false]);
    assert.deepEqual([b.plugins.state, b.plugins.installed, b.plugins.updates.length], ['current', 4, 0]);
    assert.deepEqual([b.gateways.state, b.gateways.total, b.gateways.outdated, b.gateways.latest_version], ['current', 2, 0, '1.31.0']);
    assert.deepEqual([b.apps.state, b.apps.total, b.apps.outdated, b.apps.unreported], ['current', 3, 0, 0]);
    assert.deepEqual(b.apps.products.map((p) => [p.product, p.channel, p.latest_version, p.total]), [['android', 'stable', '1.17.2', 2], ['pro', 'stable', '1.9.6', 1]]);
  });

  it('some updates → state "updates": server (waiting for the window), plugins, gateways, apps', async () => {
    await knownReleases({ 'server:stable': 'v' + NEXT, 'android:stable': 'v1.17.2' });
    gwRelease._setCache('1.31.0');
    pluginState({ ups: [{ id: 'cam', name: 'Tür & Kamera', from: '1.3.0', to: '1.4.0', notes: [{ notes: 'x' }], size: 5 }] });
    stub(autoUpdate, 'getStatus', () => auStatus({ last_action: 'waiting_window', window: { enabled: true, start: '03:00', end: '05:00', tz: 'Europe/Berlin' } }));
    addGateway('gw-home', '1.31.0');
    addGateway('gw-nas', '1.30.2');
    addGateway('gw-new', null);
    addPeer('old1', { version: '1.16.0', product: 'android' });
    addPeer('old2', { version: '1.16.0', product: 'android' });
    addPeer('new1', { version: '1.17.2', product: 'android' });
    addPeer('plain', {});
    const b = (await agent.get(URL).expect(200)).body;
    assert.deepEqual([b.state, b.updates], ['updates', 4]);
    assert.deepEqual([b.server.state, b.server.latest_version, b.server.update_available, b.server.release_url],
      ['update', NEXT, true, `https://github.com/CallMeTechie/gatecontrol/releases/tag/v${NEXT}`]);
    assert.deepEqual([b.server.auto.last_action, b.server.auto.can_trigger, b.server.auto.window.start, b.server.auto.window.end], ['waiting_window', true, '03:00', '05:00']);
    assert.deepEqual(b.plugins.updates, [{ id: 'cam', name: 'Tür & Kamera', from: '1.3.0', to: '1.4.0' }], 'only what the card shows');
    assert.deepEqual([b.gateways.state, b.gateways.total, b.gateways.outdated, b.gateways.unreported], ['update', 3, 1, 1]);
    assert.deepEqual(b.gateways.items.map((g) => [g.name, g.version, g.update_available]),
      [['gw-home', '1.31.0', false], ['gw-nas', '1.30.2', true], ['gw-new', null, false]]);
    assert.deepEqual([b.apps.state, b.apps.total, b.apps.outdated, b.apps.unreported], ['update', 3, 2, 1]);
    assert.deepEqual(b.apps.products[0].versions, [{ version: '1.16.0', count: 2 }]);
  });

  it('Manual mode: an update shows although nothing was deployed, with "Jetzt aktualisieren" allowed', async () => {
    await knownReleases({ 'server:stable': 'v' + NEXT });
    pluginState({ installed: 0 });
    stub(autoUpdate, 'getStatus', () => auStatus({ mode: 'manual' }));
    const b = (await agent.get(URL).expect(200)).body;
    assert.deepEqual([b.state, b.server.state, b.server.auto.mode, b.server.auto.can_trigger], ['updates', 'update', 'manual', true]);
    assert.deepEqual([b.plugins.state, b.gateways.state, b.apps.state], ['none', 'none', 'none']);
  });

  it('automatic mode without a window: no "Jetzt aktualisieren" (the same rule as the Server card)', async () => {
    await knownReleases({ 'server:stable': 'v' + NEXT });
    pluginState({ installed: 0 });
    const b = (await agent.get(URL).expect(200)).body;
    assert.deepEqual([b.server.state, b.server.auto.can_trigger], ['update', false]);
  });

  it('"waiting for the window" shows as an update even when the releases could not be asked', async () => {
    await knownReleases({ 'server:stable': null });
    pluginState({ installed: 0 });
    stub(autoUpdate, 'getStatus', () => auStatus({ last_action: 'waiting_window', window: { enabled: true, start: '03:00', end: '05:00' } }));
    const b = (await agent.get(URL).expect(200)).body;
    assert.deepEqual([b.server.state, b.server.latest_version, b.server.update_available, b.server.check_failed], ['update', null, false, true]);
    assert.equal(b.state, 'unknown', 'the failed check is still said');
  });

  it('a newer running version than the newest release is "current" (no downgrade offered)', async () => {
    await knownReleases({ 'server:stable': 'v0.0.1' });
    pluginState({ installed: 0 });
    assert.equal((await agent.get(URL).expect(200)).body.server.state, 'current');
  });

  it('could not be checked → state "unknown" with the last known state of every field', async () => {
    // known from an earlier check …
    await knownReleases({ 'server:stable': 'v' + pkg.version, 'android:stable': 'v1.17.2' });
    gwRelease._setCache('1.31.0');
    // … then GitHub and the catalogue stop answering
    watch._setFetch(async () => ({ ok: false, data: null, reason: 'unreachable' }));
    for (const k of ['server:stable', 'android:stable']) watch._entry(k).fetchedAt = 0;
    await watch.refresh(['server:stable', 'android:stable']);
    gwRelease._setTransport(async () => ({ status: 503, body: '' }));
    gwRelease._fetchLatest();
    await new Promise((r) => setImmediate(r));
    const failedAt = new Date().toISOString();
    pluginState({ at: '2026-11-12T20:04:00.000Z', err: { code: 'catalog_unreachable', at: failedAt } });
    addGateway('gw-home', '1.31.0');
    addPeer('old', { version: '1.16.0', product: 'android' });
    addPeer('cur', { version: '1.17.2', product: 'android' });
    addPeer('silent', {});
    const b = (await agent.get(URL).expect(200)).body;
    assert.equal(b.state, 'unknown');
    assert.ok(b.failed_at, 'when the check failed');
    assert.deepEqual([b.server.state, b.server.check_failed, b.server.latest_version], ['current', true, pkg.version]);
    assert.ok(b.server.checked_at && b.server.failed_at);
    assert.deepEqual([b.plugins.state, b.plugins.check_failed, b.plugins.checked_at, b.plugins.error_code, b.plugins.failed_at],
      ['current', true, '2026-11-12T20:04:00.000Z', 'catalog_unreachable', failedAt]);
    assert.deepEqual([b.gateways.state, b.gateways.check_failed, b.gateways.latest_version], ['current', true, '1.31.0']);
    assert.ok(b.gateways.checked_at && b.gateways.failed_at);
    assert.deepEqual([b.apps.state, b.apps.check_failed, b.apps.outdated, b.apps.total, b.apps.unreported], ['update', true, 1, 2, 1]);
    assert.ok(b.apps.checked_at, 'the state is from the last successful check');
  });

  it('nothing ever checked → every field with something in it is "unknown", none counts as outdated', async () => {
    pluginState({ cached: false });
    addGateway('gw-home', '1.31.0');
    addPeer('a', { version: '1.16.0', product: 'android' });
    // the gateway version cache may hold a value from an earlier test file run: empty it
    const st = gwRelease.getStatus();
    const b = (await agent.get(URL).expect(200)).body;
    assert.equal(b.state, 'unknown');
    assert.deepEqual([b.server.state, b.server.check_failed, b.server.checked_at], ['unknown', false, null]);
    assert.deepEqual([b.plugins.state, b.plugins.check_failed], ['unknown', false]);
    if (!st.version) assert.equal(b.gateways.state, 'unknown');
    assert.deepEqual([b.apps.state, b.apps.outdated, b.apps.unknown, b.apps.total], ['unknown', 0, 1, 1]);
  });

  it('plugin catalogue switched off / no plugin installed are their own quiet states', async () => {
    await knownReleases({ 'server:stable': 'v' + pkg.version });
    pluginState({ enabled: false });
    let b = (await agent.get(URL).expect(200)).body;
    assert.deepEqual([b.plugins.state, b.state], ['off', 'ok']);
    while (restore.length > 1) restore.pop()();
    pluginState({ installed: 0 });
    b = (await agent.get(URL).expect(200)).body;
    assert.deepEqual([b.plugins.state, b.state], ['none', 'ok']);
  });

  it('a field that throws does not take the others down', async () => {
    await knownReleases({ 'server:stable': 'v' + pkg.version });
    stub(registry, 'list', () => { throw new Error('registry broken'); });
    stub(catalog, 'enabled', () => { throw new Error('catalog broken'); });
    const b = (await agent.get(URL).expect(200)).body;
    assert.equal(b.server.state, 'current');
    assert.ok(['none', 'unknown'].includes(b.plugins.state));
  });
});

describe('GET /api/v1/dashboard/updates — never waits, never writes', () => {
  it('answers at once while the fetch hangs, and has started it in the background', async () => {
    pluginState({ installed: 0 });
    addPeer('a', { version: '1.16.0', product: 'android', channel: 'beta' });
    let asked = [];
    let release;
    watch._setFetch((product, channel) => { asked.push(`${product}:${channel}`); return new Promise((r) => { release = r; }); });
    const writes = watch._writeCount();
    const t0 = Date.now();
    const b = (await agent.get(URL).expect(200)).body;
    assert.ok(Date.now() - t0 < 1500, 'did not wait for the fetch');
    assert.equal(b.server.state, 'unknown');
    assert.deepEqual(asked, ['server:stable'], 'the first due entry is being asked, one at a time');
    assert.equal(watch._writeCount(), writes, 'no write on the request');
    // a second request while the first fetch still hangs starts nothing new
    await agent.get(URL).expect(200);
    assert.equal(asked.length, 1);
    release({ ok: true, data: rel('v' + pkg.version) });
    await new Promise((r) => setTimeout(r, 20));
    release({ ok: true, data: rel('v1.18.0-beta.2') });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(asked, ['server:stable', 'android:beta'], 'only the apps and channels in use');
    const after = (await agent.get(URL).expect(200)).body;
    assert.deepEqual([after.server.state, after.apps.state, after.apps.products[0].channel, after.apps.products[0].latest_version], ['current', 'update', 'beta', '1.18.0-beta.2']);
    assert.equal(asked.length, 2, 'fresh entries are not asked again');
  });

  it('?refresh=1 asks again whatever the age — at most once a minute', async () => {
    pluginState({ installed: 0 });
    await knownReleases({ 'server:stable': 'v' + pkg.version });
    let n = 0;
    watch._setFetch(async () => { n += 1; return { ok: true, data: rel('v' + pkg.version) }; });
    await agent.get(URL).expect(200);
    assert.equal(n, 0, 'fresh: nothing asked');
    watch._entry('server:stable').attemptAt = Date.now() - watch.FORCE_MIN_MS - 1000;
    await agent.get(URL + '?refresh=1').expect(200);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(n, 1);
    watch._entry('server:stable').attemptAt = Date.now() - watch.FORCE_MIN_MS - 1000;
    await agent.get(URL + '?refresh=1').expect(200);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(n, 1, 'the second forced check within a minute is not started');
  });

  it('the plugin catalogue is asked in the background only when its copy is over an hour old and the regular check is on', async () => {
    const plugins = require('../src/services/plugins');
    let gets = 0;
    stub(catalog, 'get', () => { gets += 1; return Promise.resolve({ plugins: new Map() }); });
    updates._catalogInTest = true;
    restore.push(() => { updates._catalogInTest = false; });
    pluginState({ at: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
    await agent.get(URL).expect(200);
    assert.equal(gets, 0, 'ten minutes old: left alone');
    stub(catalog, 'fetchedAt', () => new Date(Date.now() - 2 * 3600 * 1000).toISOString());
    await agent.get(URL).expect(200);
    await new Promise((r) => setImmediate(r));
    assert.equal(gets, 1);
    stub(plugins, 'catalogCheck', () => false);
    await agent.get(URL).expect(200);
    await new Promise((r) => setImmediate(r));
    assert.equal(gets, 1, 'regular check switched off: not asked from the dashboard');
    stub(registry, 'list', () => []);
    stub(plugins, 'catalogCheck', () => true);
    await agent.get(URL).expect(200);
    assert.equal(gets, 1, 'no plugin installed: nothing to ask');
  });
});

describe('compareApps — outdated / current / without a version', () => {
  const latest = { 'android:stable': '1.17.2', 'android:beta': '1.18.0-beta.2', 'pro:stable': '1.9.6' };
  const latestOf = (product, channel) => ({ version: latest[`${product}:${channel}`] || null, checked_at: 1700000000000, failed: false, failed_at: null });
  const g = (product, channel, version, count) => ({ product, channel, version, count });

  it('counts per app and channel; only a known older version is outdated', () => {
    const r = updates.compareApps([
      g('android', 'stable', '1.16.0', 2), g('android', 'stable', '1.17.2', 3), g('android', 'stable', '1.17.2-rc.1', 1),
      g('android', 'beta', '1.18.0-beta.1', 1), g('android', 'beta', '1.18.0-beta.2', 1), g('android', 'beta', '1.18.0', 1),
      g('pro', 'stable', '1.9.6', 2), g('pro', 'stable', '2.0.0', 1),
      g('community', 'stable', '1.14.0', 4),       // no release known for this app
      g(null, 'stable', '1.0.0', 2),               // a version without the app's name
    ], 5, latestOf);
    assert.deepEqual([r.state, r.total, r.outdated, r.unknown, r.unreported], ['update', 16, 4, 4, 7]);
    const by = Object.fromEntries(r.products.map((p) => [`${p.product}:${p.channel}`, p]));
    assert.deepEqual(Object.keys(by), ['android:stable', 'android:beta', 'pro:stable', 'community:stable']);
    assert.deepEqual([by['android:stable'].total, by['android:stable'].outdated], [6, 3]);
    assert.deepEqual(by['android:stable'].versions, [{ version: '1.16.0', count: 2 }, { version: '1.17.2-rc.1', count: 1 }]);
    assert.deepEqual([by['android:beta'].total, by['android:beta'].outdated], [3, 1]);
    assert.deepEqual([by['pro:stable'].outdated, by['pro:stable'].versions.length], [0, 0]);
    assert.deepEqual([by['community:stable'].latest_version, by['community:stable'].outdated, by['community:stable'].unknown], [null, 0, 4]);
  });

  it('devices without a version never count as outdated', () => {
    const r = updates.compareApps([], 9, latestOf);
    assert.deepEqual([r.state, r.total, r.outdated, r.unreported], ['none', 0, 0, 9]);
  });

  it('everything on the newest version is "current"; an unreadable version is "unknown", not outdated', () => {
    assert.equal(updates.compareApps([g('android', 'stable', '1.17.2', 2)], 0, latestOf).state, 'current');
    const r = updates.compareApps([g('android', 'stable', '1.17.2', 2), g('android', 'stable', '1.17', 1)], 0, latestOf);
    assert.deepEqual([r.state, r.outdated, r.unknown], ['unknown', 0, 1]);
  });

  it('the per-peer channel decides which release a device is compared with', async () => {
    await knownReleases({ 'android:stable': 'v1.17.2', 'android:beta': 'v1.18.0-beta.2' });
    addPeer('s', { version: '1.17.2', product: 'android' });
    addPeer('b', { version: '1.17.2', product: 'android', channel: 'beta' });
    let r = updates.appsField();
    assert.deepEqual(r.products.map((p) => [p.channel, p.total, p.outdated]), [['stable', 1, 0], ['beta', 1, 1]]);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('client_update.default_channel', 'beta')").run();
    require('../src/services/settings').invalidate && require('../src/services/settings').invalidate();
    r = updates.appsField();
    if (require('../src/services/clientUpdates').getPolicy().defaultChannel === 'beta') {
      assert.deepEqual(r.products.map((p) => [p.channel, p.total, p.outdated]), [['beta', 2, 2]]);
    }
  });
});

describe('what goes with the card', () => {
  it('peers API: client_update_available and client_latest_version from the cached releases', async () => {
    await knownReleases({ 'android:stable': 'v1.17.2' });
    const old = addPeer('old', { version: '1.16.0', product: 'android' });
    const cur = addPeer('cur', { version: '1.17.2', product: 'android' });
    const silent = addPeer('silent', {});
    const win = addPeer('win', { version: '1.0.0', product: 'pro' });
    const list = (await agent.get('/api/v1/peers?type=client').expect(200)).body.peers;
    const of = (id) => list.find((p) => p.id === id);
    assert.deepEqual([of(old).client_update_available, of(old).client_latest_version], [true, '1.17.2']);
    assert.deepEqual([of(cur).client_update_available, of(cur).client_latest_version], [false, '1.17.2']);
    assert.deepEqual([of(silent).client_update_available, of(silent).client_latest_version], [false, null]);
    assert.deepEqual([of(win).client_update_available, of(win).client_latest_version], [false, null], 'no release known for that app');
  });

  it('peers card: "Client veraltet" is the count of the Apps field', async () => {
    await knownReleases({ 'android:stable': 'v1.17.2' });
    addPeer('old', { version: '1.16.0', product: 'android' });
    addPeer('cur', { version: '1.17.2', product: 'android' });
    const c = (await agent.get('/api/v1/dashboard/top-peers').expect(200)).body.clients;
    assert.deepEqual([c.outdated, c.below_min], [1, 0]);
    assert.equal((await agent.get(URL).expect(200)).body.apps.outdated, c.outdated);
  });

  it('gateways API: when the newest version was checked and whether that failed', async () => {
    gwRelease._setCache('1.31.0');
    let b = (await agent.get('/api/v1/gateways?peek=1').expect(200)).body;
    assert.equal(b.latest_version, '1.31.0');
    assert.ok(Date.now() - new Date(b.latest_checked_at).getTime() < 5000);
    assert.equal(b.latest_check_failed, false);
    gwRelease._setTransport(async () => ({ status: 503, body: '' }));
    gwRelease._fetchLatest();
    await new Promise((r) => setImmediate(r));
    b = (await agent.get('/api/v1/gateways?peek=1').expect(200)).body;
    assert.deepEqual([b.latest_version, b.latest_check_failed], ['1.31.0', true]);
  });

  it('the dashboard carries the card frame and its strings in both languages', async () => {
    const res = await agent.get('/dashboard').expect(200);
    assert.match(res.text, /<section class="db-up" id="db-updates" data-view="loading"/);
    assert.ok(res.text.indexOf('id="db-tiles"') < res.text.indexOf('id="db-updates"') && res.text.indexOf('id="db-updates"') < res.text.indexOf('id="db-row-main"'),
      'directly below the tiles, above the traffic row');
    const de = require('../src/i18n/de.json');
    const en = require('../src/i18n/en.json');
    const keys = Object.keys(de).filter((k) => k.startsWith('dashboard.up_'));
    assert.ok(keys.length > 60);
    for (const k of keys) assert.ok(typeof en[k] === 'string' && en[k], `en: ${k}`);
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
    const used = new Set();
    for (const m of js.matchAll(/'(dashboard\.up_[a-z_]+)'/g)) used.add(m[1]);
    for (const k of used) {
      const ok = k in de || (k + '_one') in de || ['dashboard.up_', 'dashboard.up_app_'].includes(k);
      assert.ok(ok, `string used by dashboard.js: ${k}`);
    }
    for (const f of ['server', 'plugins', 'gateways', 'apps']) assert.ok(de['dashboard.up_' + f], f);
    for (const p of ['android', 'pro', 'community']) assert.ok(de['dashboard.up_app_' + p], p);
  });

  it('the quick-add button is gone on every page and for every role; ?action=add still opens the dialogs', async () => {
    for (const url of ['/dashboard', '/peers', '/routes', '/settings', '/gateways', '/users']) {
      const html = (await agent.get(url).expect(200)).text;
      assert.doesNotMatch(html, /fab-btn|fab-wrap|fab-menu|fab-backdrop/, url);
      assert.match(html, /class="bottom-nav"/, url + ': the bottom navigation stays');
    }
    const root = path.join(__dirname, '..');
    assert.equal(fs.existsSync(path.join(root, 'templates', 'aurora', 'partials', 'fab.njk')), false);
    const css = fs.readFileSync(path.join(root, 'public', 'css', 'app.css'), 'utf8');
    assert.doesNotMatch(css, /\.fab\b|\.fab-/);
    const appJs = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
    assert.doesNotMatch(appJs, /fab-btn|fab-wrap|fab-add/);
    assert.match(appJs, /params\.get\('action'\) === 'add'/);
    assert.match(appJs, /getElementById\('btn-add-peer'\)/);
    assert.match(appJs, /getElementById\('zn-add-domain'\)/);
    const dash = (await agent.get('/dashboard').expect(200)).text;
    assert.match(dash, /href="\/peers\?action=add"/);
    assert.match(dash, /href="\/routes\?action=new-host"/);
  });

  it('the dashboard is left-aligned and as wide as the settings (1380px, no auto margin)', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    const page = css.match(/\n\.db-page\{([^}]*)\}/);
    assert.ok(page);
    assert.match(page[1], /max-width:1380px/);
    assert.doesNotMatch(page[1], /margin\s*:/);
    const wrap = css.match(/\n\.pgx-wrap\{([^}]*)\}/);
    assert.match(wrap[1], /max-width:1380px/);
    assert.doesNotMatch(wrap[1], /margin\s*:/);
  });

  it('the peers list knows the filter "App veraltet" (#hints=outdated)', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'peers.js'), 'utf8');
    assert.match(js, /HINT_KEYS = \['update', 'outdated', 'expiring', 'support', 'stale', 'oldname'\]/);
    assert.match(js, /case 'outdated': return outdated\(p\)/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8'), /\/peers#hints=outdated/);
    for (const lang of ['de', 'en']) assert.ok(require(`../src/i18n/${lang}.json`)['pl.h_outdated'], lang);
  });
});
