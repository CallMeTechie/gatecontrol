'use strict';

// Plugins in the GateControl apps and maps in plugin frames (docs/plugins.md
// "App" and "Maps"): permissions.app / ui.app / ui.maps in plugin.json,
// GET /api/v1/client/plugins, the forwarded client plugin API
// /api/v1/client/plugins/:id/api/* (src/routes/api/client/plugins.js), the
// relaxed frame CSP and the shared Leaflet of ui.maps plugins.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const { withoutScripts } = require('./helpers/html');
const H = require('./helpers/notify');
const PUI = require('../public/js/plugins-ui.js');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

let app, agent, csrf, runtime, plugins, manifest, frame, anna, annaDev, benEn, adminId;
const API = '/api/v1/plugins';
const LIST = '/api/v1/client/plugins';
const ICON = 'M4 12h16M12 4v16';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

// "hello": app tab + maps; "hello-api": the app API without a tab; "hello-np": no permissions.app
function appOverrides() {
  const permissions = { ...clone(helloManifest.permissions), app: true };
  const ui = { ...clone(helloManifest.ui), app: { label: { de: 'Hallo-App', en: 'Hello app' }, icon: ICON }, maps: true };
  return { permissions, ui };
}
function apiOnlyOverrides() {
  return { id: 'hello-api', name: { de: 'Nur API', en: 'API only' }, permissions: { ...clone(helloManifest.permissions), app: true } };
}
function noAppOverrides() { return { id: 'hello-np', name: 'Ohne App' }; }

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  return r.body;
}
const kv = (id, key, value) => agent.post(`${API}/${id}/api/kv`).set('X-CSRF-Token', csrf).send({ key, value }).expect(200);
const kvGet = async (id, key) => (await agent.get(`${API}/${id}/api/kv`).query({ key }).expect(200)).body.value;

const list = (dev, q = {}) => supertest(app).get(LIST).query(q).set('X-API-Token', dev.raw);
const call = (dev, method, plugin, p) => supertest(app)[method](`${LIST}/${plugin}/api/${p}`).set('X-API-Token', dev.raw);

let inspected;
before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  manifest = require('../src/services/plugins/manifest');
  frame = require('../src/services/plugins/frame');
  adminId = H.db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  anna = H.makeUser('app-anna', { language: 'de' });
  annaDev = H.makeDevice(anna, { name: 'app-anna-phone' });
  benEn = H.makeDevice(H.makeUser('app-ben', { language: 'en' }), { name: 'app-ben-phone' });
  inspected = await install(helloPackage({ overrides: appOverrides() }));
  await install(helloPackage({ overrides: apiOnlyOverrides() }));
  await install(helloPackage({ overrides: noAppOverrides() }));
  for (const id of ['hello', 'hello-api', 'hello-np']) assert.equal(await runtime.waitRunning(id), true, id);
});
after(async () => { await plugins.stop(); teardown(); });

describe('plugin.json permissions.app, ui.app, ui.maps', () => {
  const base = () => clone(helloManifest);
  const check = (mut) => { const m = base(); mut(m); return manifest.validate(m); };

  it('ui.app { label, icon } needs permissions.app; without ui.app the plugin is API-only', () => {
    let r = check((m) => { m.permissions.app = true; m.ui.app = { label: 'Hallo', icon: ICON }; });
    assert.equal(r.ok, true, r.errors.join(', '));
    assert.equal(r.manifest.permissions.app, true);
    assert.deepEqual(r.manifest.ui.app, { label: { de: 'Hallo', en: 'Hallo' }, icon: ICON });
    r = check((m) => { m.permissions.app = true; m.ui.app = { label: { de: 'Familie', en: 'Family' } }; });
    assert.deepEqual(r.manifest.ui.app, { label: { de: 'Familie', en: 'Family' }, icon: 'M4 4h16v16H4z' }, 'icon optional like ui.nav.icon');
    r = check((m) => { m.permissions.app = true; });
    assert.equal(r.ok, true);
    assert.equal(r.manifest.ui.app, null);
    r = check(() => {});
    assert.equal(r.manifest.permissions.app, false);
    assert.equal(r.manifest.ui.maps, false);

    assert.deepEqual(check((m) => { m.ui.app = { label: 'Hallo' }; }).errors, ['ui.app: needs permissions.app']);
    assert.deepEqual(check((m) => { m.permissions.app = 'yes'; }).errors, ['permissions.app: invalid']);
    for (const bad of [{}, 'Hallo', [], { label: '' }, { label: 'x'.repeat(41) }, { label: 'Hallo', icon: '<script>' }, { label: 'Hallo', icon: 7 },
      { label: 'Hallo', icon: 'M' + '1'.repeat(600) }, { label: 'Hallo', route: '/x' }]) {
      assert.deepEqual(check((m) => { m.permissions.app = true; m.ui.app = bad; }).errors, ['ui.app: invalid'], JSON.stringify(bad));
    }
  });

  it('ui.maps is a boolean', () => {
    assert.equal(check((m) => { m.ui.maps = true; }).manifest.ui.maps, true);
    assert.deepEqual(check((m) => { m.ui.maps = 'yes'; }).errors, ['ui.maps: invalid']);
  });

  it('the install dialog names the app permission, the app tab and maps', () => {
    const perm = inspected.plugin.permissions;
    assert.equal(perm.app, true);
    assert.equal(perm.maps, true);
    assert.ok(['Hallo-App', 'Hello app'].includes(perm.appTab));
    const t = (k, p) => { let s = de[k] || k; for (const [a, b] of Object.entries(p || {})) s = s.split('{{' + a + '}}').join(String(b)); return s; };
    const rows = Object.fromEntries(PUI.permRows({ ...perm, appTab: 'Familie' }, t).map((r) => [r.label, r.value]));
    assert.equal(rows.App, 'Daten für die GateControl-App bereitstellen');
    assert.match(rows['Oberfläche'], /App-Tab „Familie“/);
    assert.match(rows.Karten, /OpenStreetMap/);
    const adds = PUI.addsOf({ app: { label: 'Familie' } }, t);
    assert.deepEqual(adds.map((a) => a.title), ['App-Tab „Familie“']);
    for (const k of ['plugins.perm.app', 'plugins.perm.app_on', 'plugins.perm.ui_app', 'plugins.perm.maps', 'plugins.perm.maps_on', 'plugins.adds.app', 'plugins.adds.app_d']) assert.ok(de[k] && en[k], k);
    assert.equal(en['plugins.perm.app_on'], 'Provide data to the GateControl app');
  });

  it('the plugin view carries the app tab and the maps flag', async () => {
    const p = (await agent.get(`${API}/hello`).expect(200)).body.plugin;
    assert.ok(p.app && p.app.icon === ICON);
    assert.equal(p.maps, true);
    const np = (await agent.get(`${API}/hello-np`).expect(200)).body.plugin;
    assert.deepEqual([np.app, np.maps, np.permissions.app], [null, false, false]);
  });
});

describe('GET /api/v1/client/plugins', () => {
  it('lists usable plugins with permissions.app; tab from ui.app, null without', async () => {
    await kv('hello', 'app-hidden', null);
    const r = await list(annaDev).expect(200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(r.body, { ok: true, plugins: [
      { id: 'hello', name: 'Hallo Welt', version: '1.0.0', tab: { label: 'Hallo-App', icon: ICON } },
      { id: 'hello-api', name: 'Nur API', version: '1.0.0', tab: null },
    ] });
    assert.deepEqual(await kvGet('hello', 'app-last'), { id: anna, name: 'app-anna', role: 'user', portal: true, loggedIn: true, app: true },
      'appVisible gets the token owner as the viewer');
  });

  it('language: ?lang, else the owner\'s setting, else Accept-Language', async () => {
    const tab = (r) => r.body.plugins.find((p) => p.id === 'hello');
    assert.deepEqual([tab(await list(benEn).expect(200)).name, tab(await list(benEn).expect(200)).tab.label], ['Hello World', 'Hello app']);
    assert.equal(tab(await list(benEn, { lang: 'de' }).expect(200)).tab.label, 'Hallo-App');
    assert.equal(tab(await list(annaDev).set('Accept-Language', 'en').expect(200)).name, 'Hallo Welt', 'the owner\'s setting wins over the header');
  });

  it('appVisible false, an error or no answer within 3 s → tab null (still listed)', async () => {
    await kv('hello', 'app-hidden', [anna]);
    let r = await list(annaDev).expect(200);
    assert.deepEqual(r.body.plugins.map((p) => [p.id, p.tab]), [['hello', null], ['hello-api', null]]);
    assert.notEqual((await list(benEn).expect(200)).body.plugins[0].tab, null, 'per viewer');
    await kv('hello', 'app-hidden', null);
    for (const mode of ['throw', 'slow']) {
      await kv('hello', 'app-mode', mode);
      const t0 = Date.now();
      r = await list(annaDev).expect(200);
      assert.ok(Date.now() - t0 < 4500, `${mode}: answered after the timeout, not after the plugin`);
      assert.deepEqual(r.body.plugins.map((p) => [p.id, p.tab]), [['hello', null], ['hello-api', null]], mode);
    }
    await kv('hello', 'app-mode', null);
  });

  it('a disabled plugin is not listed and its API answers 404', async () => {
    await agent.post(`${API}/hello-api/disable`).set('X-CSRF-Token', csrf).expect(200);
    try {
      assert.deepEqual((await list(annaDev).expect(200)).body.plugins.map((p) => p.id), ['hello']);
      assert.deepEqual((await call(annaDev, 'get', 'hello-api', 'ping').expect(404)).body, { ok: false, code: 'not_found' });
    } finally {
      await agent.post(`${API}/hello-api/enable`).set('X-CSRF-Token', csrf).expect(200);
      assert.equal(await runtime.waitRunning('hello-api'), true);
    }
  });

  it('auth: 401 without a token, 403 for a session and for tokens without the client scope; a token without an owner gets []', async () => {
    await supertest(app).get(LIST).expect(401);
    await supertest(app).get(`${LIST}/hello/api/ping`).expect(401);
    assert.equal((await agent.get(LIST).expect(403)).body.error, 'token_required');
    assert.equal((await agent.get(`${LIST}/hello/api/ping`).expect(403)).body.error, 'token_required');
    const peersOnly = H.makeDevice(anna, { name: 'app-peers', scopes: ['peers'] });
    await list(peersOnly).expect(403);
    const ro = H.makeDevice(adminId, { name: 'app-ro', scopes: ['read-only'] });
    assert.equal((await list(ro).expect(403)).body.error, 'scope_required');
    await call(ro, 'get', 'hello', 'ping').expect(403);
    const full = H.makeDevice(adminId, { name: 'app-full', scopes: ['full-access'] });
    assert.equal((await list(full).expect(200)).body.plugins.length, 2);
    const noOwner = H.makeDevice(null, { name: 'app-noowner', app: false });
    assert.deepEqual((await list(noOwner).expect(200)).body, { ok: true, plugins: [] });
  });

  it('machine binding like the other client routes', async () => {
    const tokens = require('../src/services/tokens');
    const dev = H.makeDevice(anna, { name: 'app-bound' });
    const fp = 'a'.repeat(64);
    tokens.bindMachineFingerprint(dev.tokenId, fp);
    const m = mock.method(tokens, 'machineBindingState', () => ({ licensed: true, mode: 'global' }));
    try {
      await list(dev).expect(403);
      await call(dev, 'get', 'hello', 'ping').expect(403);
      await list(dev).set('X-Machine-Fingerprint', 'b'.repeat(64)).expect(403);
      await list(dev).set('X-Machine-Fingerprint', fp).expect(200);
      await call(dev, 'get', 'hello', 'ping').set('X-Machine-Fingerprint', fp).expect(200);
    } finally { m.mock.restore(); }
  });
});

describe('ALL /api/v1/client/plugins/:id/api/*', () => {
  it('forwards to request() as the token owner with user.app, the query, the body and the language', async () => {
    const r = await call(annaDev, 'post', 'hello', 'ping?x=1').send({ items: [1, 2] }).expect(200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(r.body, { ok: true, method: 'POST', user: { id: anna, name: 'app-anna', role: 'user', portal: true, loggedIn: true, app: true },
      query: { x: '1' }, body: { items: [1, 2] }, lang: 'de' });
    assert.equal((await call(benEn, 'get', 'hello-api', 'ping').expect(200)).body.lang, 'en', 'API-only plugins too; owner language');
    assert.equal((await call(benEn, 'get', 'hello', 'ping?lang=de').expect(200)).body.lang, 'de');
    for (const m of ['put', 'patch', 'delete']) assert.equal((await call(annaDev, m, 'hello', 'ping').send({}).expect(200)).body.method, m.toUpperCase());
    assert.deepEqual((await call(annaDev, 'get', 'hello', 'nope').expect(404)).body, { ok: false, error: 'not_found' }, 'the plugin\'s own answer');
  });

  it('a hidden tab keeps the API usable', async () => {
    await kv('hello', 'app-hidden', [anna]);
    try { await call(annaDev, 'get', 'hello', 'ping').expect(200); } finally { await kv('hello', 'app-hidden', null); }
  });

  it('404 not_found: unknown plugin, bad id, no permissions.app; 403 no_user without an owner', async () => {
    for (const id of ['nope', 'hello-np', 'Hello', '_shared']) {
      assert.deepEqual((await call(annaDev, 'get', id, 'ping').expect(404)).body, { ok: false, code: 'not_found' }, id);
    }
    assert.equal(await kvGet('hello-np', 'app-last'), null);
    const noOwner = H.makeDevice(null, { name: 'app-noowner2', app: false });
    assert.deepEqual((await call(noOwner, 'get', 'hello', 'ping').expect(403)).body, { ok: false, code: 'no_user' });
  });

  it('JSON bodies up to 64 KB', async () => {
    const ok = 'x'.repeat(60 * 1024);
    assert.equal((await call(annaDev, 'post', 'hello', 'ping').send({ ok }).expect(200)).body.body.ok.length, ok.length);
    const big = 'x'.repeat(65 * 1024);
    assert.deepEqual((await call(annaDev, 'post', 'hello', 'ping').send({ big }).expect(413)).body, { ok: false, code: 'too_large' });
  });

  it('own limiter: 240 requests per minute and token, not the general API budget', async () => {
    const dev = H.makeDevice(anna, { name: 'app-rate' });
    const first = await call(dev, 'get', 'hello', 'ping').expect(200);
    assert.equal(first.headers['ratelimit-limit'], '240');
    assert.equal(first.headers['x-ratelimit-limit'], undefined, 'the apiLimiter (legacy headers) does not run');
    for (let i = 1; i < 240; i += 1) await call(dev, 'get', 'nope', 'ping').expect(404); // failed requests count too
    const r = await call(dev, 'get', 'hello', 'ping').expect(429);
    assert.equal(r.body.code, 'rate_limited');
    assert.equal(r.body.ok, false);
    await call(annaDev, 'get', 'hello', 'ping').expect(200);
  });
});

describe('maps in plugin frames (ui.maps)', () => {
  it('admin frame of a ui.maps plugin: tiles, the shared Leaflet of this origin, popups, origin-only referrer', async () => {
    const r = await agent.get('/plugins/hello/frame/main').set('Host', 'gc.example.com:8443').expect(200);
    const csp = r.headers['content-security-policy'];
    const origin = 'http://gc.example.com:8443';
    assert.match(csp, new RegExp(`script-src 'unsafe-inline' ${origin}/plugins/_shared/leaflet/leaflet\\.js;`));
    assert.match(csp, new RegExp(`style-src 'unsafe-inline' ${origin}/plugins/_shared/leaflet/leaflet\\.css;`));
    assert.match(csp, new RegExp(`img-src data: https://tile\\.openstreetmap\\.org ${origin}/plugins/_shared/leaflet/images/;`));
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox$/);
    assert.doesNotMatch(csp, /allow-same-origin|'self' 'unsafe|script-src[^;]*'self'/);
    assert.equal(r.headers['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.match(r.text, /<meta name="referrer" content="strict-origin-when-cross-origin">/);
    const page = withoutScripts((await agent.get('/plugins/hello').expect(200)).text);
    assert.match(/<iframe class="pg-frame"[^>]*>/.exec(page)[0], /sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"/);
  });

  it('a Host header that is not a plain host gets the tiles but no shared Leaflet', async () => {
    const r = await agent.get('/plugins/hello/frame/main').set('Host', 'evil.example;script-src *').expect(200);
    const csp = r.headers['content-security-policy'];
    assert.match(csp, /script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:\/\/tile\.openstreetmap\.org;/);
    assert.equal(frame.originOf({ protocol: 'https', get: () => 'GC.Example.com' }), 'https://gc.example.com');
    assert.equal(frame.originOf({ protocol: 'https', get: () => 'a b' }), null);
    assert.equal(frame.originOf({ protocol: 'ftp', get: () => 'gc.example.com' }), null);
  });

  it('plugins without ui.maps keep the strict frame', async () => {
    const r = await agent.get('/plugins/hello-np/frame/main').expect(200);
    assert.equal(r.headers['content-security-policy'], frame.CSP);
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.doesNotMatch(r.headers['content-security-policy'], /openstreetmap|allow-popups/);
    const page = withoutScripts((await agent.get('/plugins/hello-np').expect(200)).text);
    const tag = /<iframe class="pg-frame"[^>]*>/.exec(page)[0];
    assert.match(tag, /sandbox="allow-scripts allow-forms"/);
    assert.doesNotMatch(tag, /allow-popups/);
  });

  it('portal: the tab of a ui.maps plugin gets the relaxed frame and sandbox, others do not', async () => {
    const page = (await agent.get('/portal').expect(200)).text;
    assert.match(page, /src="\/portal\/plugins\/hello\/frame" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"/);
    assert.match(page, /src="\/portal\/plugins\/hello-np\/frame" sandbox="allow-scripts allow-forms" referrerpolicy/);
    const fr = await agent.get('/portal/plugins/hello/frame').expect(200);
    assert.match(fr.headers['content-security-policy'], /img-src data: https:\/\/tile\.openstreetmap\.org http:\/\/127\.0\.0\.1:\d+\/plugins\/_shared\/leaflet\/images\//);
    assert.match(fr.headers['content-security-policy'], /allow-popups-to-escape-sandbox$/);
    assert.equal((await agent.get('/portal/plugins/hello-np/frame').expect(200)).headers['content-security-policy'], frame.CSP);
  });

  it('the shared Leaflet is served without a session, loadable from an opaque-origin frame', async () => {
    const js = await supertest(app).get('/plugins/_shared/leaflet/leaflet.js').expect(200);
    assert.match(js.headers['content-type'], /javascript/);
    assert.equal(js.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.equal(js.headers['x-content-type-options'], 'nosniff');
    assert.equal(Buffer.byteLength(js.text), fs.statSync(path.join(__dirname, '..', 'public', 'vendor', 'leaflet', 'leaflet.js')).size);
    const css = await supertest(app).get('/plugins/_shared/leaflet/leaflet.css').expect(200);
    assert.match(css.headers['content-type'], /text\/css/);
    assert.equal(css.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.match(css.text, /\.leaflet-container/);
    assert.match(css.text, /url\(images\/marker-icon\.png\)/);
    assert.doesNotMatch(css.text, /url\(\/vendor|\.up-page|\.ud-map/, 'only the Leaflet section of app.css, image URLs relative');
    const png = await supertest(app).get('/plugins/_shared/leaflet/images/marker-icon.png').expect(200);
    assert.equal(png.headers['content-type'], 'image/png');
    assert.equal(png.headers['cross-origin-resource-policy'], 'cross-origin');
    for (const bad of ['images/nope.png', 'images/..%2fleaflet.js', 'LICENSE', 'README.md']) await supertest(app).get('/plugins/_shared/leaflet/' + bad).expect(404);
  });
});
