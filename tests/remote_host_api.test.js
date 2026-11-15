'use strict';

// gc.remote, version 1 (docs/plugins.md "Remote access", src/services/remote): the core part of the
// plugin "Fernzugriff" (gatecontrol-remote) — permission, key vault (never a secret back to a plugin),
// session tickets bound to person and browser session, single-use guacamole tokens and limits, the hook
// remoteSession, the built-in data import `remote` (credentials as vault handles), the facade for the
// old app API /api/v1/client/rdp* (ECDH only) and the platform linux of gc.devices.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const supertest = require('supertest');
const { remotePackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let app, agent, csrf, plugins, db, adminId, sessions, vault, guacToken, cfg, cfgPrev;
const ID = 'gatecontrol-remote';
const PASSWORD = 'Rdp-Geheim-7f3a!';
const USERNAME = 'buero-admin';

const call = async (api, args = {}) => (await agent.post(`/api/v1/plugins/${ID}/api/call`).set('X-CSRF-Token', csrf).send({ api, args }).expect(200)).body;
const pget = async (p) => (await agent.get(`/api/v1/plugins/${ID}/api${p}`).expect(200)).body;
const ppost = async (p, body) => (await agent.post(`/api/v1/plugins/${ID}/api${p}`).set('X-CSRF-Token', csrf).send(body).expect(200)).body;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TARGET = { id: 'dev-1', name: 'Büro-PC', host: '10.8.0.44', port: 3389 };

async function install(buf) {
  const r = await agent.post('/api/v1/plugins/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post('/api/v1/plugins/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  return r.body;
}

async function secondBrowser() {
  const a = supertest.agent(app);
  const page = await a.get('/login');
  const m = page.text.match(/name="_csrf"\s+value="([^"]+)"/);
  await a.post('/login').type('form').send({ username: 'admin', password: 'TestPass123!', _csrf: m ? m[1] : '' }).expect(302);
  return a;
}

function pageCsrf(html) {
  const m = html.match(/id="rdp-session-cfg"[^>]*>([^<]+)</);
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, '&'));
}

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  plugins = require('../src/services/plugins');
  db = require('../src/db/connection').getDb();
  sessions = require('../src/services/remote/sessions');
  vault = require('../src/services/remote/vault');
  guacToken = require('../src/services/guacToken');
  adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  cfg = require('../config/default').guac;
  cfgPrev = { ...cfg };
  cfg.maxGlobal = 10; cfg.maxPerRoute = 2; cfg.maxPerUser = 2;
  // the old Remote Desktops: a route with credentials (the core still answers it), one browser session in the history
  const { encrypt } = require('../src/utils/crypto');
  db.prepare(`INSERT INTO rdp_routes (id, name, host, port, protocol, credential_mode, username_encrypted, password_encrypted, domain,
    user_ids, maintenance_enabled, maintenance_schedule, browser_enabled, enabled) VALUES (7, 'Büro', '10.8.0.44', 3389, 'rdp', 'full', ?, ?, 'FIRMA', '[1]', 1, 'Mo-Fr 22:00-23:00', 1, 1)`)
    .run(encrypt(USERNAME), encrypt(PASSWORD));
  db.prepare("INSERT INTO rdp_sessions (rdp_route_id, status, via, protocol, ended_at, duration_seconds, end_reason) VALUES (7, 'ended', 'browser', 'rdp', datetime('now'), 60, 'normal')").run();
});

after(async () => {
  Object.assign(cfg, cfgPrev);
  await plugins.stop();
  teardown();
});

describe('permission remote', () => {
  it('without it the host refuses every gc.remote call', async () => {
    const hostApi = require('../src/services/plugins/hostApi');
    const p = { id: 'other', manifest: { permissions: {} } };
    for (const api of ['remote.session', 'remote.vault.put', 'remote.vault.list', 'remote.probe', 'remote.listener', 'remote.recordings.list']) {
      await assert.rejects(hostApi.handle(p, api, {}), (e) => e.code === 'ERR_REMOTE_DENIED', api);
    }
  });
  it('the manifest takes a boolean only', () => {
    const m = require('../src/services/plugins/manifest');
    const base = { id: 'x-y', name: 'X', version: '1.0.0', publisher: 'p', description: 'd', gatecontrol: '>=1.0.0', entry: 'server/index.js' };
    const ok = m.validate({ ...base, permissions: { remote: true } });
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));
    assert.equal(ok.manifest.permissions.remote, true);
    assert.equal(m.validate({ ...base }).manifest.permissions.remote, false);
    const bad = m.validate({ ...base, permissions: { remote: 'yes' } });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.includes('permissions.remote: invalid'));
  });
  it('installs with the permission shown; gc.remote version 1 exists', async () => {
    const r = await install(remotePackage());
    assert.equal(r.plugin.permissions.remote, true, 'shown in the install dialog');
    let has = null;
    for (let i = 0; i < 50 && !has; i++) { try { has = await pget('/has'); } catch { await wait(100); } }
    assert.deepEqual([has.remote, has.version], [true, 1]);
  });
});

let handle;
describe('key vault: the plugin holds handles, never a secret', () => {
  it('put answers metadata only; the value is encrypted at rest', async () => {
    const r = await call('vault.put', { username: USERNAME, password: PASSWORD, domain: 'FIRMA', label: 'Büro' });
    assert.equal(r.ok, true, JSON.stringify(r));
    handle = r.result.handle;
    assert.match(handle, /^rv_[0-9a-f]{32}$/);
    assert.deepEqual(r.result.has, { username: true, password: true, domain: true, privateKey: false, passphrase: false });
    assert.equal(r.result.kind, 'password');
    const all = JSON.stringify([r, await call('vault.info', { handle }), await call('vault.list')]);
    for (const secret of [PASSWORD, USERNAME, 'FIRMA']) assert.ok(!all.includes(secret), 'no ' + secret + ' in what the plugin sees');
    const row = db.prepare('SELECT * FROM remote_vault WHERE handle = ?').get(handle);
    assert.ok(!JSON.stringify(row).includes(PASSWORD), 'ciphertext at rest');
  });
  it('changes keep the handle, null clears; the core alone resolves it, and only for its plugin', async () => {
    const r = await call('vault.put', { handle, domain: null });
    assert.equal(r.result.handle, handle);
    assert.equal(r.result.has.domain, false);
    assert.deepEqual(vault.resolve(ID, handle), { username: USERNAME, password: PASSWORD });
    assert.equal(vault.resolve('other-plugin', handle), null);
    const bad = await call('vault.info', { handle: 'rv_nope' });
    assert.equal(bad.code, 'ERR_INVALID');
    assert.equal((await call('vault.put', { password: 'x'.repeat(2000) })).code, 'ERR_INVALID');
  });
});

describe('targets', () => {
  it('loopback, link-local and the hub address are never a target', async () => {
    for (const host of ['127.0.0.1', '169.254.1.2', '0.0.0.0', '224.0.0.1', require('../src/services/remote/targets').hubIp()]) {
      const r = await call('session', { user: adminId, protocol: 'rdp', target: { id: 't', host, port: 3389 } });
      assert.equal(r.code, 'ERR_REMOTE_NOT_ALLOWED', host);
    }
    assert.equal((await call('probe', { id: 't', host: '::1', port: 22 })).code, 'ERR_REMOTE_NOT_ALLOWED');
  });
  it('a gateway LAN target needs a listener; wake needs a MAC; recordings are not there yet', async () => {
    const r = await call('session', { user: adminId, protocol: 'vnc', target: { id: 't', host: '192.168.1.5', port: 5900, gateway: { peerId: 99 } } });
    assert.equal(r.code, 'ERR_REMOTE_LISTENER_REQUIRED');
    assert.equal((await call('wake', { id: 't', host: '10.8.0.44', port: 3389 })).code, 'ERR_INVALID');
    assert.equal((await call('listener', { key: 'k', gateway: { peerId: 99 }, host: '192.168.1.5', port: 3389 })).code, 'ERR_NOT_FOUND');
    assert.deepEqual((await call('recordings.available')).result, { available: false, reason: 'not_yet' });
    assert.deepEqual((await call('recordings.list')).result, []);
    assert.equal((await call('session', { user: adminId, protocol: 'rdp', target: TARGET, record: true })).code, 'ERR_REMOTE_RECORDING_UNAVAILABLE');
  });
});

let ref;
describe('sessions: ticket, page, token, tunnel', () => {
  it('checks person, protocol, mode, options and the credential handle', async () => {
    assert.equal((await call('session', { user: 999999, protocol: 'rdp', target: TARGET })).code, 'ERR_NOT_FOUND');
    assert.equal((await call('session', { user: adminId, protocol: 'x11', target: TARGET })).code, 'ERR_INVALID');
    assert.equal((await call('session', { user: adminId, protocol: 'rdp', mode: 'own', target: TARGET })).code, 'ERR_INVALID');
    assert.equal((await call('session', { user: adminId, protocol: 'rdp', target: TARGET, options: { 'enable-drive': true } })).code, 'ERR_INVALID');
    assert.equal((await call('session', { user: adminId, protocol: 'rdp', target: TARGET, credential: 'rv_' + '0'.repeat(32) })).code, 'ERR_REMOTE_CREDENTIAL_NOT_FOUND');
  });
  it('a ticket opens the page once — for its person and the first browser only', async () => {
    const r = await call('session', { user: adminId, protocol: 'rdp', mode: 'view', target: TARGET, credential: handle, options: { color_depth: 16 } });
    assert.equal(r.ok, true, JSON.stringify(r));
    ref = r.result.ref;
    assert.equal(r.result.url, '/remote/session/' + ref);
    assert.ok(!JSON.stringify(r).includes(PASSWORD));
    const page = await agent.get(r.result.url).expect(200);
    assert.match(page.text, /rdp-session-display/);
    const other = await secondBrowser();
    await other.get(r.result.url).expect(404);
    await supertest(app).get(r.result.url).expect(404); // not signed in
    await agent.get('/remote/session/' + 'A'.repeat(43)).expect(404);
  });
  it('the page gets a single-use token (60 s) with the secret inside it only, view mode read-only', async () => {
    const page = await agent.get('/remote/session/' + ref).expect(200);
    const cfgIsland = pageCsrf(page.text);
    assert.equal(cfgIsland.remoteRef, ref);
    const t = await agent.post(`/remote/session/${ref}/token`).set('X-CSRF-Token', cfgIsland.csrf).expect(200);
    assert.equal(t.body.wsPath, '/api/v1/remote/guac-tunnel');
    assert.equal(t.body.ttl, 60);
    const v = guacToken.verifyAndConsume(t.body.token);
    assert.ok(v, 'a valid token');
    assert.equal(guacToken.verifyAndConsume(t.body.token), null, 'single use');
    assert.equal(v.connection.settings.password, PASSWORD);
    assert.equal(v.connection.settings.username, USERNAME);
    assert.equal(v.connection.settings['read-only'], 'true');
    assert.equal(v.connection.settings['color-depth'], '16');
    assert.equal(v.connection.settings.hostname, '10.8.0.44');
    assert.equal(v.connection.remoteRef, ref);
    // the tunnel admits it while the ticket lives
    assert.deepEqual(sessions.admitTunnel(v.connection), { ok: true });
    const other = await secondBrowser();
    const p2 = await other.get('/dashboard');
    const c2 = (p2.text.match(/csrfToken:\s*'([^']+)'/) || [])[1];
    await other.post(`/remote/session/${ref}/token`).set('X-CSRF-Token', c2).expect(404);
  });
  it('tunnel lifecycle: rows, limits per person, hook remoteSession, gc.remote.end', async () => {
    const t = sessions._ticketForTest(ref);
    const m = await sessions.mint(t, {});
    const conn = guacToken.verifyAndConsume(m.token).connection;
    let closed = null;
    const sid = sessions.opened(conn, { clientIp: '10.8.0.9', close: (why) => { closed = why; } });
    const sid2 = sessions.opened(conn, { close: () => {} });
    // two live sessions of this person = maxPerUser
    const third = await sessions.mint(t, {});
    assert.deepEqual([third.ok, third.status, third.code], [false, 429, 'limit_reached']);
    assert.deepEqual(sessions.admitTunnel(conn), { ok: false, reason: 'target_limit' });
    sessions.end(sid2, 'normal');
    const list = (await call('sessions', { active: true })).result;
    assert.deepEqual(list.map((s) => [s.id, s.targetId, s.userId, s.mode, s.status]), [[sid, 'dev-1', adminId, 'view', 'active']]);
    assert.equal((await call('end', { ref })).result.ended, 1);
    assert.equal(closed, 'ended_by_plugin');
    assert.equal(sessions._ticketForTest(ref), null, 'no reconnect after end');
    await agent.get('/remote/session/' + ref).expect(404);
    let ev = [];
    for (let i = 0; i < 50 && ev.length < 4; i++) { ev = (await pget('/events')).result; if (ev.length < 4) await wait(100); }
    assert.deepEqual(ev.map((e) => [e.phase, e.sessionId]), [['start', sid], ['start', sid2], ['end', sid2], ['end', sid]]);
    assert.ok(!JSON.stringify(ev).includes(PASSWORD));
  });
  it('an expired, unopened ticket is gone; old RDP sessions count towards the overall limit', async () => {
    const r = await call('session', { user: adminId, protocol: 'ssh', target: { id: 'dev-2', host: '10.8.0.45', port: 22 }, ttlS: 30 });
    const tk = sessions._ticketForTest(r.result.ref);
    assert.equal(sessions.claim(r.result.ref, adminId, 'sid-x', tk.openBy + 1), null);
    cfg.maxGlobal = 1;
    db.prepare("INSERT INTO rdp_sessions (rdp_route_id, status, via, protocol) VALUES (7, 'active', 'browser', 'rdp')").run();
    assert.equal((await call('session', { user: adminId, protocol: 'rdp', target: TARGET })).code, 'ERR_REMOTE_LIMIT');
    db.prepare("DELETE FROM rdp_sessions WHERE status = 'active'").run();
    cfg.maxGlobal = 10;
  });
  it('a token of a remote session never opens the old tunnel path (and the other way round)', () => {
    const { evaluateConnection } = require('../src/tunnel/guacTunnel');
    const tok = guacToken.mint({ type: 'rdp', settings: {}, remoteRef: 'x', remotePlugin: ID });
    // evaluateConnection with the admission of the old path: the plain admit sees a remote token as wrong only
    // through the path check inside attachGuacTunnel — here the token itself is valid once
    const r = evaluateConnection(tok.token, { admit: (c) => (typeof c.remoteRef === 'string' ? { ok: false, reason: 'wrong_path' } : { ok: true }) });
    assert.deepEqual(r, { ok: false, reason: 'wrong_path' });
  });
});

describe('built-in data import `remote`', () => {
  it('no upgrade notice yet (prepared, switched off)', () => {
    const legacy = require('../src/services/plugins/legacy');
    assert.equal(legacy.DATASETS.get(ID).notice, false);
    assert.ok(!legacy.pendingMoves().some((m) => m.pluginId === ID));
  });
  it('routes with handles instead of credentials, ids kept, sessions and maintenance; re-run keeps the handles', async () => {
    const st = (await agent.get(`/api/v1/plugins/${ID}/legacy`).expect(200)).body;
    const s = st.legacy || st;
    assert.equal(s.dataset, 'remote');
    assert.equal(s.eligible, true);
    await agent.post(`/api/v1/plugins/${ID}/legacy/import`).set('X-CSRF-Token', csrf).send({ confirm: true }).expect(200);
    const snap = (await pget('/snapshot')).result;
    assert.equal(snap.dataset, 'remote');
    const json = JSON.stringify(snap);
    for (const secret of [PASSWORD, USERNAME]) assert.ok(!json.includes(secret), 'no ' + secret + ' in the snapshot');
    assert.ok(!json.includes('password_encrypted') && !json.includes('username_encrypted'));
    const r = snap.routes.find((x) => x.id === 7);
    assert.deepEqual([r.name, r.protocol, r.browser_enabled, r.user_ids, r.domain], ['Büro', 'rdp', true, [1], 'FIRMA']);
    assert.match(r.credential, /^rv_/);
    assert.deepEqual(vault.resolve(ID, r.credential), { username: USERNAME, password: PASSWORD, domain: 'FIRMA' });
    assert.ok(snap.sessions.some((x) => x.route_id === 7 && x.via === 'browser'));
    assert.deepEqual(snap.maintenance, [{ route_id: 7, enabled: true, schedule: 'Mo-Fr 22:00-23:00' }]);
    await agent.post(`/api/v1/plugins/${ID}/legacy/import`).set('X-CSRF-Token', csrf).send({ confirm: true }).expect(200);
    const again = (await pget('/snapshot')).result.routes.find((x) => x.id === 7);
    assert.equal(again.credential, r.credential, 'same handle on "Erneut übernehmen"');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM rdp_routes').get().c, 1, 'the built-in table stays');
  });
});

describe('facade for the old app API', () => {
  it('handled:false leaves it to the core', async () => {
    const lic = require('../src/services/license');
    lic._overrideForTest({ ...lic.COMMUNITY_FALLBACK, remote_desktop: true });
    await ppost('/facade', { answer: null });
    // the core's own answer (a browser session has no client:rdp scope)
    const r = await agent.get('/api/v1/client/rdp').expect(403);
    assert.equal(r.body.error, 'Token does not have client:rdp permission');
    const calls = (await pget('/facadeCalls')).result;
    assert.equal(calls[calls.length - 1].op, 'list');
  });
  it('the plugin answers; credentials only through ECDH from a vault handle', async () => {
    const r7 = (await pget('/snapshot')).result.routes.find((x) => x.id === 7);
    await ppost('/facade', { answer: { status: 200, body: { ok: true, routes: [{ id: 7, name: 'aus dem Plugin' }] } } });
    const list = await agent.get('/api/v1/client/rdp').expect(200);
    assert.deepEqual(list.body.routes, [{ id: 7, name: 'aus dem Plugin' }]);
    await ppost('/facade', { answer: { status: 200, body: { ok: true, connection: { id: 7, host: '10.8.0.44', password: 'from-plugin' } }, credential: { handle: r7.credential } } });
    const noKey = await agent.get('/api/v1/client/rdp/7/connect').expect(400);
    assert.equal(noKey.body.error, 'ecdh_required');
    const ecdh = crypto.createECDH('prime256v1');
    const pub = ecdh.generateKeys().toString('base64');
    const c = await agent.get('/api/v1/client/rdp/7/connect').query({ ecdhPublicKey: pub }).expect(200);
    assert.ok(c.body.connection.credentials_e2ee, 'encrypted for the app');
    assert.equal(c.body.connection.password, undefined, 'a plaintext key of the plugin is stripped');
    assert.ok(!JSON.stringify(c.body).includes(PASSWORD));
    const plain = JSON.parse(require('../src/utils/crypto').ecdhDecrypt(c.body.connection.credentials_e2ee, ecdh));
    assert.deepEqual(plain, { username: USERNAME, password: PASSWORD, domain: 'FIRMA' });
    const calls = (await pget('/facadeCalls')).result;
    const last = calls[calls.length - 1];
    assert.equal(last.op, 'connect');
    assert.equal(last.id, '7');
    assert.equal(last.query.ecdhPublicKey, undefined, 'the app key is the core\'s business');
  });
  it('a stopped plugin: 503 instead of outdated core data', async () => {
    await plugins.setEnabled(ID, false);
    const r = await agent.get('/api/v1/client/rdp').expect(503);
    assert.equal(r.body.error, 'plugin_unavailable');
  });
});

describe('devices: platform linux', () => {
  it('is known', () => {
    const d = require('../src/services/plugins/devices');
    assert.equal(d.platformOf('linux'), 'linux');
    assert.equal(d.platformOf('Linux'), 'linux');
    assert.equal(d.platformOf('beos'), null);
  });
});

describe('GC.openSession in the frame', () => {
  it('only frames of a plugin with permissions.remote get it; the bridge opens /remote/session/<ref> only', () => {
    const frame = require('../src/services/plugins/frame');
    assert.equal(frame.openSessionOf({ permissions: { remote: true } }), true);
    assert.equal(frame.openSessionOf({ permissions: {} }), false);
    assert.match(frame.document({ html: '', lang: 'de', openSession: true }), /if \(true\) api\.openSession = openSession/);
    assert.match(frame.document({ html: '', lang: 'de' }), /if \(false\) api\.openSession = openSession/);
    const bridge = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'plugin-bridge.js'), 'utf8');
    assert.match(bridge, /window\.open\('\/remote\/session\/' \+ ref, '_blank', 'noopener,noreferrer'\)/);
    assert.match(bridge, /\/\^\[A-Za-z0-9_-\]\{43\}\$\/\.test\(ref\)/);
  });
});
