'use strict';

// Cloud accounts (docs/cloud-accounts.md): the OAuth apps (admin API,
// secrets write-only and encrypted), the connection flow (state, PKCE,
// browser binding, single use, returnTo), gc.cloud for plugins with
// permissions.cloudImport (available, connectUrl, connections, disconnect,
// list, import with Google export, limits, token refresh, isolation per
// person and plugin), the fixed hosts, and the storage targets "Google
// Drive" / "OneDrive" (connect, folder, check, upload sessions, backup).
// Google and Microsoft are a stub (tests/helpers/cloudFake.js): under
// NODE_ENV=test no provider is ever reached.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');
const { fakeCloud, OOXML, FOLDER } = require('./helpers/cloudFake');

const API = '/api/v1/plugins';
const CL = '/api/v1/cloud-accounts';
const PID = 'hello-cloud';
const PID2 = 'hello-cloud-two';
const PLAIN = 'hello-nocloud';
const DOCX = OOXML + 'wordprocessingml.document';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const MEDIA = { maxBytes: 1024 * 1024, types: ['image/*', 'application/pdf', 'text/plain', DOCX], quotaDefault: '1GB' };
const enc = encodeURIComponent;

let app, agent, csrf, fake, http, media, cloud, anna, ben;

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  return r.body;
}
const gc = async (plugin, fn, ...args) => (await agent.post(`${API}/${plugin}/api/gc`).set('X-CSRF-Token', csrf).send({ fn, args })).body;
const api = (method, p) => agent[method](p).set('X-CSRF-Token', csrf);
const db = () => require('../src/db/connection').getDb();
const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&#x2F;/g, '/').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const refreshOf = (target) => (target.match(/content="1;url=([^"]+)"/) || [])[1];

/** A person connects `provider` for `pid` the way a browser does: start page, Weiter, provider, callback. */
async function connect(pid, uid, provider, returnTo = `/portal?view=import#plg-${pid}`) {
  const r = await gc(pid, 'cloud.connectUrl', { user: uid, provider, returnTo });
  assert.equal(r.ok, true, JSON.stringify(r));
  const u = new URL(r.result.url);
  const browser = supertest.agent(app);
  const page = await browser.get(u.pathname + u.search).expect(200);
  const go = await browser.get(u.pathname + u.search + '&go=1').expect(302);
  const auth = go.headers.location;
  const code = fake.issueCode(provider, auth);
  const state = new URL(auth).searchParams.get('state');
  const cb = await browser.get(`/oauth/cloud/callback?state=${enc(state)}&code=${enc(code)}`).expect(200);
  return { url: r.result.url, page, go, auth, cb, browser, state, code };
}

async function collect(gen) {
  const parts = [];
  for await (const c of gen) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  http = require('../src/services/cloudAccounts/http');
  media = require('../src/services/plugins/media');
  cloud = require('../src/services/cloudAccounts');
  fake = fakeCloud();
  http._setTransportForTest(fake.transport);
  anna = H.makeUser('cloud-anna');
  ben = H.makeUser('cloud-ben');
  const perms = { ...clone(helloManifest.permissions), cloudImport: { purpose: { de: 'Dateien in Drive übernehmen', en: 'Take files into Drive' } } };
  const inspected = await install(helloPackage({ overrides: { id: PID, name: { de: 'Hallo Cloud', en: 'Hello cloud' }, permissions: perms, media: MEDIA } }));
  assert.match(inspected.plugin.permissions.cloudImport.purpose, /^(?:Dateien in Drive übernehmen|Take files into Drive)$/, 'the install dialog names the purpose');
  await install(helloPackage({ overrides: { id: PID2, name: { de: 'Hallo Cloud 2', en: 'Hello cloud 2' }, permissions: perms, media: MEDIA } }));
  await install(helloPackage({ overrides: { id: PLAIN, name: { de: 'Ohne Cloud', en: 'No cloud' }, permissions: clone(helloManifest.permissions), media: MEDIA } }));
  const runtime = require('../src/services/plugins/runtime');
  for (const id of [PID, PID2, PLAIN]) assert.equal(await runtime.waitRunning(id), true, id);
});
after(async () => {
  http._setTransportForTest(null);
  await require('../src/services/plugins').stop();
  teardown();
});

describe('fixed hosts', () => {
  it('only the five provider hosts over https:443; OneDrive storage hosts only for handed-out addresses, never with the token', async () => {
    const ok = (u, c) => http.allowed(new URL(u), c);
    for (const h of ['www.googleapis.com', 'oauth2.googleapis.com', 'accounts.google.com', 'graph.microsoft.com', 'login.microsoftonline.com']) assert.equal(ok(`https://${h}/x`), true, h);
    assert.equal(ok('http://www.googleapis.com/x'), false);
    assert.equal(ok('https://www.googleapis.com:8443/x'), false);
    assert.equal(ok('https://user:pw@graph.microsoft.com/x'), false);
    assert.equal(ok('https://evil.example/x'), false);
    assert.equal(ok('https://contoso-my.sharepoint.com/x'), false, 'not for API calls');
    assert.equal(ok('https://contoso-my.sharepoint.com/x', true), true);
    assert.equal(ok('https://evilsharepoint.com/x', true), false);
    assert.equal(ok('https://sharepoint.com.evil.example/x', true), false);
    await assert.rejects(http.request({ url: 'https://evil.example/' }), { code: 'ERR_CLOUD_PROVIDER' });
    const calls = fake.calls.length;
    await http.request({ url: 'https://contoso-my.sharepoint.com/personal/dl/none', content: true, headers: { authorization: 'Bearer secret' } });
    assert.equal(fake.calls.length, calls + 1);
    assert.equal(fake.calls[calls].headers.authorization, undefined, 'the token never goes to a storage host');
  });

  it('under NODE_ENV=test nothing is reached without the stub', async () => {
    http._setTransportForTest(null);
    try {
      await assert.rejects(http.request({ url: 'https://www.googleapis.com/drive/v3/about' }), (e) => e.code === 'ERR_CLOUD_PROVIDER' && /tests/.test(e.message));
    } finally { http._setTransportForTest(fake.transport); }
  });
});

describe('OAuth apps (admin)', () => {
  it('admin session only; nothing set up yet', async () => {
    const token = require('../src/services/tokens').create({ name: 'full', scopes: ['full-access'] }, '127.0.0.1').rawToken;
    assert.equal((await supertest(app).get(CL).set('Authorization', `Bearer ${token}`)).status, 403);
    const r = await agent.get(CL).expect(200);
    assert.equal(r.body.apps.google.configured, false);
    assert.equal(r.body.apps.microsoft.tenant, 'common');
    assert.match(r.body.redirectUri, /\/oauth\/cloud\/callback$/);
    assert.deepEqual(r.body.apps.google.scopes, { import: 'https://www.googleapis.com/auth/drive.readonly', target: 'https://www.googleapis.com/auth/drive.file' });
    assert.deepEqual(r.body.apps.microsoft.scopes, { import: 'Files.Read offline_access openid profile', target: 'Files.ReadWrite offline_access openid profile' });
    assert.deepEqual((await gc(PID, 'cloud.available')).result, { google: false, microsoft: false });
    const c = await gc(PID, 'cloud.connectUrl', { user: anna, provider: 'google', returnTo: '/portal' });
    assert.equal(c.code, 'ERR_CLOUD_NOT_CONFIGURED');
  });

  it('validates, keeps the secret encrypted and never answers it', async () => {
    assert.equal((await api('put', `${CL}/apps/google`).send({ clientId: 'x', clientSecret: 's' }).expect(400)).body.field, 'clientId');
    assert.equal((await api('put', `${CL}/apps/google`).send({ clientId: '123-abc.apps.googleusercontent.com' }).expect(400)).body.field, 'clientSecret');
    assert.equal((await api('put', `${CL}/apps/dropbox`).send({ clientId: '123-abc.apps', clientSecret: 's' }).expect(400)).body.code, 'ERR_INVALID');
    const g = await api('put', `${CL}/apps/google`).send({ clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'google-secret' }).expect(200);
    assert.equal(g.body.app.configured, true);
    assert.equal(JSON.stringify(g.body).includes('google-secret'), false);
    assert.equal((await api('put', `${CL}/apps/microsoft`).send({ clientId: '11111111-2222-3333-4444-555555555555', clientSecret: 'x', tenant: 'not a tenant' }).expect(400)).body.field, 'tenant');
    await api('put', `${CL}/apps/microsoft`).send({ clientId: '11111111-2222-3333-4444-555555555555', clientSecret: 'microsoft-secret', tenant: 'consumers' }).expect(200);
    const stored = db().prepare("SELECT value FROM settings WHERE key = 'cloud.google.client_secret_encrypted'").get().value;
    assert.equal(stored.includes('google-secret'), false);
    // an empty secret keeps the stored one
    await api('put', `${CL}/apps/google`).send({ clientId: '123-abc.apps.googleusercontent.com', clientSecret: '' }).expect(200);
    assert.equal(cloud.app('google').clientSecret, 'google-secret');
    const all = await agent.get(CL).expect(200);
    assert.equal(JSON.stringify(all.body).includes('secret"'), false);
    assert.equal(JSON.stringify(all.body).match(/google-secret|microsoft-secret/), null);
    assert.equal(all.body.apps.microsoft.tenant, 'consumers');
    assert.deepEqual((await gc(PID, 'cloud.available')).result, { google: true, microsoft: true });
  });

  it('renders the page in the plugin area', async () => {
    const r = await agent.get('/settings/plugins/cloud').expect(200);
    assert.match(r.text, /data-view="cloud"/);
    assert.match(r.text, /href="\/settings\/plugins\/cloud"/);
  });
});

describe('plugin.json permissions.cloudImport', () => {
  const manifest = () => require('../src/services/plugins/manifest');
  const check = (v) => { const m = clone(helloManifest); m.permissions.cloudImport = v; return manifest().validate(m); };
  it('needs a purpose', () => {
    assert.deepEqual(check({ purpose: 'Fotos übernehmen' }).manifest.permissions.cloudImport, { purpose: { de: 'Fotos übernehmen', en: 'Fotos übernehmen' } });
    for (const v of [true, {}, { purpose: '' }, { purpose: 'x', more: 1 }, []]) {
      assert.ok(check(v).errors.some((e) => /permissions\.cloudImport/.test(e)), JSON.stringify(v));
    }
    assert.equal(manifest().validate(clone(helloManifest)).manifest.permissions.cloudImport, null);
  });
  it('gc.cloud is refused without it', async () => {
    for (const fn of ['cloud.available', 'cloud.connections', 'cloud.list']) assert.equal((await gc(PLAIN, fn, { user: anna })).code, 'ERR_CLOUD_DENIED', fn);
  });
});

describe('connecting (Google)', () => {
  let conn;
  it('checks returnTo and the person', async () => {
    for (const returnTo of ['https://evil.example/', '//evil.example/portal', '/settings', '/portal\\@evil', 'javascript:alert(1)', '/portal//x', 'gatecontrol://x//y']) {
      assert.equal((await gc(PID, 'cloud.connectUrl', { user: anna, provider: 'google', returnTo })).code, 'ERR_INVALID', returnTo);
    }
    assert.equal((await gc(PID, 'cloud.connectUrl', { user: 999999, provider: 'google', returnTo: '/portal' })).code, 'ERR_INVALID');
    assert.equal((await gc(PID, 'cloud.connectUrl', { user: anna, provider: 'dropbox', returnTo: '/portal' })).code, 'ERR_INVALID');
    assert.equal((await gc(PID, 'cloud.connectUrl', { user: anna, provider: 'google', returnTo: 'gatecontrol://drive/import?x=1' })).ok, true);
  });

  it('start page, PKCE, state, binding; the connection belongs to the person and the plugin', async () => {
    const c = await connect(PID, anna, 'google');
    assert.match(c.url, /\/oauth\/cloud\/start\?flow=[A-Za-z0-9_-]{32}$/);
    assert.match(c.page.text, /data-cloud-connect="confirm"/);
    assert.match(c.page.text, /cloud-anna/, 'names the person');
    assert.match(c.page.text, /Hallo Cloud|Hello cloud/, 'names the plugin');
    const a = new URL(c.auth);
    assert.equal(a.origin + a.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(a.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.readonly');
    assert.equal(a.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(a.searchParams.get('access_type'), 'offline');
    assert.match(a.searchParams.get('redirect_uri'), /\/oauth\/cloud\/callback$/);
    assert.ok(a.searchParams.get('state').length >= 40);
    assert.match(String(c.go.headers['set-cookie']), /gc\.cloud=.*Path=\/oauth\/cloud.*HttpOnly.*SameSite=Lax/i);
    assert.match(c.cb.text, /data-cloud-connect="done"/);
    const target = unesc(refreshOf(c.cb.text));
    assert.match(target, /^https:\/\/home\.[^/]+\/portal\?view=import&cloud=connected#plg-hello-cloud$/);
    const list = (await gc(PID, 'cloud.connections', { user: anna })).result;
    assert.equal(list.length, 1);
    assert.deepEqual(Object.keys(list[0]).sort(), ['account', 'connectedAt', 'id', 'provider']);
    assert.equal(list[0].provider, 'google');
    assert.equal(list[0].account, 'anna@example.com');
    conn = list[0].id;
    // the token is stored encrypted; nobody else sees the connection
    const row = db().prepare('SELECT token_enc FROM cloud_connections WHERE id = ?').get(conn);
    assert.equal(/acc-|ref-/.test(row.token_enc), false);
    assert.deepEqual((await gc(PID, 'cloud.connections', { user: ben })).result, []);
    assert.deepEqual((await gc(PID2, 'cloud.connections', { user: anna })).result, []);
    assert.equal((await gc(PID2, 'cloud.list', { user: anna, connection: conn })).code, 'ERR_CLOUD_NOT_FOUND');
    assert.equal((await gc(PID, 'cloud.list', { user: ben, connection: conn })).code, 'ERR_CLOUD_NOT_FOUND');
    // the same account again: same connection, new tokens
    await connect(PID, anna, 'google');
    assert.deepEqual((await gc(PID, 'cloud.connections', { user: anna })).result.map((x) => x.id), [conn]);
  });

  it('a link is single use, bound to the browser and the state', async () => {
    const r = await gc(PID, 'cloud.connectUrl', { user: anna, provider: 'google', returnTo: '/portal' });
    const u = new URL(r.result.url);
    const browser = supertest.agent(app);
    const go = await browser.get(u.pathname + u.search + '&go=1').expect(302);
    await browser.get(u.pathname + u.search + '&go=1').expect(400);
    const state = new URL(go.headers.location).searchParams.get('state');
    const code = fake.issueCode('google', go.headers.location);
    // another browser (no cookie): refused, and the flow is used up
    const other = await supertest(app).get(`/oauth/cloud/callback?state=${enc(state)}&code=${code}`).expect(200);
    assert.match(other.text, /data-cloud-connect="error"/);
    assert.match(unesc(refreshOf(other.text)), /cloud=error&cloudError=ERR_CLOUD_FLOW/);
    await browser.get(`/oauth/cloud/callback?state=${enc(state)}&code=${code}`).expect(400);
    await supertest(app).get('/oauth/cloud/callback?state=nope&code=x').expect(400);
    await supertest(app).get('/oauth/cloud/start?flow=nope').expect(400);
  });

  it('the person says no at the provider', async () => {
    const r = await gc(PID, 'cloud.connectUrl', { user: anna, provider: 'google', returnTo: '/portal#plg-hello-cloud' });
    const u = new URL(r.result.url);
    const browser = supertest.agent(app);
    const go = await browser.get(u.pathname + u.search + '&go=1').expect(302);
    const state = new URL(go.headers.location).searchParams.get('state');
    const cb = await browser.get(`/oauth/cloud/callback?state=${enc(state)}&error=access_denied`).expect(200);
    assert.match(unesc(refreshOf(cb.text)), /\/portal\?cloud=error&cloudError=ERR_CLOUD_DENIED#plg-hello-cloud$/);
  });

  describe('list and import', () => {
    before(() => {
      fake.gAdd({ id: 'fold1', name: 'Urlaub', mimeType: FOLDER });
      fake.gAdd({ id: 'pic1', name: 'Strand.jpg', mimeType: 'image/jpeg', data: crypto.randomBytes(70000) });
      fake.gAdd({ id: 'doc1', name: 'Bericht', mimeType: 'application/vnd.google-apps.document' });
      fake.gAdd({ id: 'form1', name: 'Umfrage', mimeType: 'application/vnd.google-apps.form' });
      fake.gAdd({ id: 'big1', name: 'Scan.tif', mimeType: 'image/tiff', size: 5 * 1024 * 1024 * 1024 });
      fake.gAdd({ id: 'zip1', name: 'Archiv.zip', mimeType: 'application/zip', data: Buffer.from('PK') });
      fake.gAdd({ id: 'txt1', name: 'notiz', mimeType: 'application/octet-stream', data: Buffer.from('hallo') });
      fake.gAdd({ id: 'sub1', name: 'Bild.png', mimeType: 'image/png', parents: ['fold1'], data: Buffer.from('png') });
    });

    it('lists a folder: Google Docs with their export type, Forms left out, pages with a cursor', async () => {
      const r = (await gc(PID, 'cloud.list', { user: anna, connection: conn })).result;
      const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));
      assert.deepEqual(byId.fold1, { id: 'fold1', name: 'Urlaub', isDir: true, size: null, mime: null, modifiedAt: '2026-10-01T10:00:00.000Z' });
      assert.deepEqual(byId.pic1, { id: 'pic1', name: 'Strand.jpg', isDir: false, size: 70000, mime: 'image/jpeg', modifiedAt: '2026-10-01T10:00:00.000Z' });
      assert.equal(byId.doc1.name, 'Bericht.docx');
      assert.equal(byId.doc1.mime, DOCX);
      assert.equal(byId.doc1.size, null);
      assert.equal(byId.form1, undefined);
      const sub = (await gc(PID, 'cloud.list', { user: anna, connection: conn, folderId: 'fold1' })).result;
      assert.deepEqual(sub.items.map((i) => i.name), ['Bild.png']);
      assert.equal(sub.next, null);
      for (let i = 0; i < 120; i++) fake.gAdd({ name: `f${i}.txt`, mimeType: 'text/plain', parents: ['fold2'], data: Buffer.from('x') });
      fake.gAdd({ id: 'fold2', name: 'Viele', mimeType: FOLDER });
      const p1 = (await gc(PID, 'cloud.list', { user: anna, connection: conn, folderId: 'fold2' })).result;
      assert.equal(p1.items.length, 100);
      assert.ok(p1.next);
      const p2 = (await gc(PID, 'cloud.list', { user: anna, connection: conn, folderId: 'fold2', cursor: p1.next })).result;
      assert.equal(p2.items.length, 20);
      assert.equal(p2.next, null);
      assert.equal((await gc(PID, 'cloud.list', { user: anna, connection: conn, folderId: "x' or '1'='1" })).code, 'ERR_INVALID');
    });

    it('imports a file into the media store: unclaimed, owned by the person, the bytes unchanged', async () => {
      const r = await gc(PID, 'cloud.import', { user: anna, connection: conn, fileId: 'pic1' });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(Object.keys(r.result).sort(), ['mediaId', 'mime', 'modifiedAt', 'name', 'size']);
      assert.equal(r.result.name, 'Strand.jpg');
      assert.equal(r.result.size, 70000);
      assert.equal(r.result.mime, 'image/jpeg');
      assert.equal(r.result.modifiedAt, '2026-10-01T10:00:00.000Z');
      const row = media.row(PID, r.result.mediaId);
      assert.equal(row.owner_user_id, anna);
      assert.equal(row.ref_count, 0, 'unclaimed (24 h)');
      const back = await collect(media.readRange(row, 0, row.bytes - 1));
      assert.ok(back.equals(fake.google.files.get('pic1').data));
      // a generic type is taken from the file name
      const t = await gc(PID, 'cloud.import', { user: anna, connection: conn, fileId: 'txt1' });
      assert.equal(t.ok, false, 'notiz has no extension → octet-stream, not declared');
      assert.equal(t.code, 'ERR_MEDIA_TYPE');
    });

    it('exports Google Docs as docx', async () => {
      const r = await gc(PID, 'cloud.import', { user: anna, connection: conn, fileId: 'doc1' });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.result.name, 'Bericht.docx');
      assert.equal(r.result.mime, DOCX);
      assert.deepEqual(fake.google.exports.at(-1), { id: 'doc1', mime: DOCX });
    });

    it('refuses before downloading: too large, wrong type, a folder, a form', async () => {
      const before = fake.calls.filter((c) => /alt=media/.test(c.url)).length;
      assert.equal((await gc(PID, 'cloud.import', { user: anna, connection: conn, fileId: 'big1' })).code, 'ERR_CLOUD_TOO_LARGE');
      assert.equal((await gc(PID, 'cloud.import', { user: anna, connection: conn, fileId: 'zip1' })).code, 'ERR_MEDIA_TYPE');
      assert.equal((await gc(PID, 'cloud.import', { user: anna, connection: conn, fileId: 'fold1' })).code, 'ERR_INVALID');
      assert.equal((await gc(PID, 'cloud.import', { user: anna, connection: conn, fileId: 'form1' })).code, 'ERR_CLOUD_NOT_FOUND');
      assert.equal((await gc(PID, 'cloud.import', { user: anna, connection: conn, fileId: 'nope' })).code, 'ERR_CLOUD_NOT_FOUND');
      assert.equal(fake.calls.filter((c) => /alt=media/.test(c.url)).length, before, 'nothing was downloaded');
    });

    it('refreshes an expired token (before the call, and after a 401)', async () => {
      const tokenOf = () => JSON.parse(require('../src/utils/crypto').decrypt(db().prepare('SELECT token_enc FROM cloud_connections WHERE id = ?').get(conn).token_enc));
      const refreshes = () => fake.calls.filter((c) => c.host === 'oauth2.googleapis.com' && c.url.endsWith('/token')).length;
      const t0 = tokenOf();
      // the provider forgot the access token: 401 → refresh → again
      fake.expireAll();
      let n = refreshes();
      assert.equal((await gc(PID, 'cloud.list', { user: anna, connection: conn })).ok, true);
      assert.equal(refreshes(), n + 1);
      const t1 = tokenOf();
      assert.notEqual(t1.access, t0.access);
      assert.equal(t1.refresh, t0.refresh, 'Google keeps the refresh token');
      // our own clock says it ran out: refreshed before the call
      db().prepare('UPDATE cloud_connections SET token_enc = ? WHERE id = ?').run(require('../src/utils/crypto').encrypt(JSON.stringify({ ...t1, expiresAt: 0 })), conn);
      n = refreshes();
      assert.equal((await gc(PID, 'cloud.list', { user: anna, connection: conn })).ok, true);
      assert.equal(refreshes(), n + 1);
    });

    it('the provider asks to wait: ERR_RATE_LIMIT; our own limit too', async () => {
      fake.hook = (req, u) => (u.pathname === '/drive/v3/files' ? { status: 429, headers: { 'retry-after': '30' }, body: { error: { code: 429 } } } : null);
      try {
        const r = await gc(PID, 'cloud.list', { user: anna, connection: conn });
        assert.equal(r.code, 'ERR_RATE_LIMIT');
        assert.match(r.error, /30 s/);
      } finally { fake.hook = null; }
      const plug = require('../src/services/plugins/cloud');
      const saved = plug.LIST_PER_MINUTE;
      try {
        let last;
        for (let i = 0; i < saved + 1; i++) last = await gc(PID2, 'cloud.list', { user: ben, connection: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
        assert.equal(last.code, 'ERR_CLOUD_NOT_FOUND', 'unknown connections are refused before the budget');
      } finally { plug._resetForTest(); }
    });

    it('a refresh token the provider no longer takes: ERR_CLOUD_AUTH, the connection says so', async () => {
      fake.refresh.clear();
      fake.expireAll();
      assert.equal((await gc(PID, 'cloud.list', { user: anna, connection: conn })).code, 'ERR_CLOUD_AUTH');
      const c = (await gc(PID, 'cloud.connections', { user: anna })).result[0];
      assert.equal(c.error, 'auth');
      const adm = await agent.get(CL).expect(200);
      assert.equal(adm.body.connections.find((x) => x.id === conn).error, 'auth');
      // connecting again repairs it
      await connect(PID, anna, 'google');
      assert.equal((await gc(PID, 'cloud.connections', { user: anna })).result[0].error, undefined);
      assert.equal((await gc(PID, 'cloud.list', { user: anna, connection: conn })).ok, true);
    });

    it('disconnect: gone for good, Google forgets the grant', async () => {
      assert.equal((await gc(PID, 'cloud.disconnect', { user: ben, connection: conn })).result, false, 'not ben\'s');
      const revoked = fake.revoked.length;
      assert.equal((await gc(PID, 'cloud.disconnect', { user: anna, connection: conn })).result, true);
      assert.equal(fake.revoked.length, revoked + 1);
      assert.deepEqual((await gc(PID, 'cloud.connections', { user: anna })).result, []);
      assert.equal((await gc(PID, 'cloud.list', { user: anna, connection: conn })).code, 'ERR_CLOUD_NOT_FOUND');
    });
  });
});

describe('connecting and importing (Microsoft)', () => {
  let conn;
  it('connects with the tenant, names the account from the ID token', async () => {
    const c = await connect(PID, ben, 'microsoft', 'gatecontrol://drive/import');
    const a = new URL(c.auth);
    assert.equal(a.origin + a.pathname, 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    assert.equal(a.searchParams.get('scope'), 'Files.Read offline_access openid profile');
    assert.equal(unesc(refreshOf(c.cb.text)), 'gatecontrol://drive/import?cloud=connected');
    const list = (await gc(PID, 'cloud.connections', { user: ben })).result;
    assert.equal(list[0].account, 'ben@contoso.com');
    conn = list[0].id;
  });

  it('lists with a cursor, leaves out OneNote, imports through the storage host without the token', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(3000)]);
    fake.msAdd({ id: 'F1!1', name: 'Rechnung.pdf', data: pdf, mime: 'application/pdf' });
    fake.msAdd({ id: 'D1!1', name: 'Belege', folder: true });
    fake.msAdd({ id: 'N1!1', name: 'Notizbuch', folder: true, package: true });
    for (let i = 0; i < 101; i++) fake.msAdd({ name: `p${i}.png`, data: Buffer.from('x'), mime: 'image/png', parentId: 'D1!1' });
    const r = (await gc(PID, 'cloud.list', { user: ben, connection: conn })).result;
    assert.deepEqual(r.items.map((i) => i.name).sort(), ['Belege', 'Rechnung.pdf']);
    assert.deepEqual(r.items.find((i) => i.id === 'F1!1'), { id: 'F1!1', name: 'Rechnung.pdf', isDir: false, size: pdf.length, mime: 'application/pdf', modifiedAt: '2026-09-30T08:00:00.000Z' });
    const p1 = (await gc(PID, 'cloud.list', { user: ben, connection: conn, folderId: 'D1!1' })).result;
    assert.equal(p1.items.length, 100);
    const p2 = (await gc(PID, 'cloud.list', { user: ben, connection: conn, folderId: 'D1!1', cursor: p1.next })).result;
    assert.equal(p2.items.length, 1);
    const forged = Buffer.from('https://evil.example/v1.0/me/drive/root/children').toString('base64url');
    assert.equal((await gc(PID, 'cloud.list', { user: ben, connection: conn, cursor: forged })).code, 'ERR_INVALID');
    const auths = fake.ms.contentAuth.length;
    const im = await gc(PID, 'cloud.import', { user: ben, connection: conn, fileId: 'F1!1' });
    assert.equal(im.ok, true, JSON.stringify(im));
    assert.equal(im.result.size, pdf.length);
    assert.deepEqual(fake.ms.contentAuth.slice(auths), [null], 'no token to the storage host');
    const row = media.row(PID, im.result.mediaId);
    assert.ok((await collect(media.readRange(row, 0, row.bytes - 1))).equals(pdf));
  });

  it('a redirect to any other host is refused', async () => {
    fake.hook = (req, u) => (/\/content$/.test(u.pathname) ? { status: 302, headers: { location: 'https://evil.example/steal' } } : null);
    try {
      assert.equal((await gc(PID, 'cloud.import', { user: ben, connection: conn, fileId: 'F1!1' })).code, 'ERR_CLOUD_PROVIDER');
      assert.equal(fake.calls.some((c) => c.host === 'evil.example'), false);
    } finally { fake.hook = null; }
  });

  it('the administrator sees and removes connections; uninstalling a plugin drops its connections', async () => {
    const r = await agent.get(CL).expect(200);
    const c = r.body.connections.find((x) => x.id === conn);
    assert.equal(c.user.id, ben);
    assert.match(c.pluginName, /^(?:Hallo Cloud|Hello cloud)$/);
    assert.equal(JSON.stringify(r.body).includes('acc-'), false);
    await connect(PID2, ben, 'microsoft');
    assert.equal((await gc(PID2, 'cloud.connections', { user: ben })).result.length, 1);
    await api('delete', `${CL}/connections/${conn}`).expect(200);
    assert.deepEqual((await gc(PID, 'cloud.connections', { user: ben })).result, []);
    await require('../src/services/plugins').uninstall(PID2, { mode: 'keep' });
    assert.equal(db().prepare('SELECT COUNT(*) AS n FROM cloud_connections WHERE plugin = ?').get(PID2).n, 0);
  });
});

describe('storage targets "Google Drive" and "OneDrive"', () => {
  const targets = () => require('../src/services/storageTargets');

  /** The administrator connects an account for a storage target → the draft id. */
  async function adminConnect(provider, targetId = null) {
    const r = await api('post', `${CL}/connect`).send({ provider, targetId }).expect(200);
    const u = new URL(r.body.url);
    const go = await agent.get(u.pathname + u.search).expect(302);
    const a = new URL(go.headers.location);
    assert.equal(a.searchParams.get('scope'), provider === 'google' ? 'https://www.googleapis.com/auth/drive.file' : 'Files.ReadWrite offline_access openid profile');
    const code = fake.issueCode(provider, go.headers.location);
    const cb = await agent.get(`/oauth/cloud/callback?state=${enc(a.searchParams.get('state'))}&code=${enc(code)}`).expect(200);
    const target = unesc(refreshOf(cb.text));
    const m = /^\/settings\/plugins\/storage\?cloudDraft=([A-Za-z0-9_-]+)$/.exec(target);
    assert.ok(m, target);
    return m[1];
  }

  it('a target flow only starts for the administrator who asked for it', async () => {
    const r = await api('post', `${CL}/connect`).send({ provider: 'google' }).expect(200);
    const u = new URL(r.body.url);
    await supertest(app).get(u.pathname + u.search).expect(400);
  });

  it('Google Drive: connect, create a folder, save, check (write, read, range, delete, free space)', async () => {
    const draft = await adminConnect('google');
    const d = await agent.get(`${CL}/drafts/${draft}`).expect(200);
    assert.deepEqual(d.body.draft, { id: draft, provider: 'google', kind: 'gdrive', account: 'anna@example.com', targetId: null });
    const mk = await api('post', `${CL}/folders`).send({ draft, parent: 'root', name: 'GateControl' }).expect(200);
    const list = await agent.get(`${CL}/folders?draft=${draft}&parent=root`).expect(200);
    assert.ok(list.body.folders.some((f) => f.id === mk.body.folder.id && f.name === 'GateControl'));
    assert.equal((await api('post', '/api/v1/storage-targets').send({ kind: 'gdrive', label: 'Drive', folderId: mk.body.folder.id }).expect(400)).body.field, 'draft');
    const c = await api('post', '/api/v1/storage-targets').send({ kind: 'gdrive', label: 'Google Drive', draft, folderId: mk.body.folder.id, folderPath: '/GateControl' }).expect(201);
    const t = c.body.target;
    assert.equal(t.display, 'Google Drive · anna@example.com · /GateControl');
    assert.equal(t.encrypted, true);
    assert.deepEqual(t.secretSet, {});
    assert.equal(JSON.stringify(t).match(/acc-|ref-/), null);
    assert.equal(cloud.draft(draft), null, 'the draft is used up');
    const ck = await api('post', `/api/v1/storage-targets/${t.id}/check`).expect(200);
    assert.equal(ck.body.check.ok, true, JSON.stringify(ck.body.check));
    assert.equal(ck.body.check.free, 16106127360 - 1073741824);
    // the test file went into a folder of its own, and is gone again
    assert.equal([...fake.google.files.values()].some((f) => f.name.startsWith('.gatecontrol-check')), false);
    // a key with folders, put twice (the second replaces), ranges
    const drv = await targets().open(t.id);
    const data = crypto.randomBytes(200000);
    await drv.put('plug/area/ab/abcdef', targets().bufferSource(data));
    await drv.put('plug/area/ab/abcdef', targets().bufferSource(data));
    assert.equal([...fake.google.files.values()].filter((f) => f.name === 'abcdef').length, 1);
    assert.equal((await drv.head('plug/area/ab/abcdef')).size, data.length);
    assert.ok((await collect(await drv.get('plug/area/ab/abcdef', { start: 1000, end: 1999 }))).equals(data.subarray(1000, 2000)));
    assert.equal(await drv.remove('plug/area/ab/abcdef'), true);
    assert.equal(await drv.head('plug/area/ab/abcdef'), null);
    assert.equal(await drv.remove('plug/area/ab/abcdef'), false);
    // media areas keep sealed blocks only there
    assert.equal(targets().BLOCKS_ONLY.has('gdrive'), true);
    // the OAuth app cannot go while a target uses it
    assert.equal((await api('delete', `${CL}/apps/google`).expect(409)).body.code, 'ERR_IN_USE');
  });

  it('OneDrive: connect, choose a folder, check, large files through an upload session', async () => {
    const draft = await adminConnect('microsoft');
    const list = await agent.get(`${CL}/folders?draft=${draft}`).expect(200);
    assert.equal(list.body.driveId, 'drive-ben');
    const belege = list.body.folders.find((f) => f.name === 'Belege');
    assert.ok(belege);
    const c = await api('post', '/api/v1/storage-targets').send({ kind: 'onedrive', label: 'OneDrive', draft, folderId: belege.id, folderPath: '/Belege', driveId: list.body.driveId }).expect(201);
    const t = c.body.target;
    assert.equal(t.config.driveId, 'drive-ben');
    const ck = await api('post', `/api/v1/storage-targets/${t.id}/check`).expect(200);
    assert.equal(ck.body.check.ok, true, JSON.stringify(ck.body.check));
    const drv = await targets().open(t.id);
    const big = crypto.randomBytes(5 * 1024 * 1024 + 7);
    await drv.put('plug/area/cd/big', targets().bufferSource(big));
    assert.ok(fake.ms.contentAuth.length > 0);
    assert.equal(fake.ms.contentAuth.every((a) => a === null), true, 'never a token to the storage hosts');
    assert.equal((await drv.head('plug/area/cd/big')).size, big.length);
    assert.ok((await collect(await drv.get('plug/area/cd/big', { start: 65530, end: 65540 }))).equals(big.subarray(65530, 65541)));
    assert.equal(await drv.remove('plug/area/cd/big'), true);
    // reconnect: a new draft for this target keeps folder and place
    const again = await adminConnect('microsoft', t.id);
    assert.equal((await agent.get(`${CL}/drafts/${again}`).expect(200)).body.draft.targetId, t.id);
    const p = await api('patch', `/api/v1/storage-targets/${t.id}`).send({ label: 'OneDrive Ben', draft: again, folderId: belege.id, folderPath: '/Belege', driveId: 'drive-ben' }).expect(200);
    assert.equal(p.body.target.label, 'OneDrive Ben');
    // the stored token keeps working after the provider dropped the access token
    fake.expireAll();
    assert.equal((await api('post', `/api/v1/storage-targets/${t.id}/check`).expect(200)).body.check.ok, true);
  });

  it('backup: the targets come back with their token as stored', async () => {
    const backup = require('../src/services/backup');
    const before = targets().list().filter((x) => x.kind === 'gdrive' || x.kind === 'onedrive');
    const b = JSON.parse(JSON.stringify(backup.createBackup()));
    assert.equal(b.data.settings.some((s) => s.key === 'cloud.google.client_secret_encrypted'), true);
    const n = b.data.storage_targets.filter((x) => x.kind === 'gdrive' || x.kind === 'onedrive').length;
    assert.equal(n, before.length);
    assert.equal(JSON.stringify(b.data.storage_targets).match(/acc-|ref-/), null);
    db().prepare("DELETE FROM storage_targets WHERE kind IN ('gdrive', 'onedrive')").run();
    await backup.restoreBackup(b);
    const back = targets().list().filter((x) => x.kind === 'gdrive' || x.kind === 'onedrive');
    assert.deepEqual(back.map((x) => x.label).sort(), before.map((x) => x.label).sort());
    assert.equal(back.every((x) => !x.needsSecret), true);
  });
});
