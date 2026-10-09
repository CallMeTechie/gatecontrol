'use strict';

// Official plugin catalogue (docs/plugins.md "Official plugin catalogue",
// src/services/plugins/catalog.js, src/routes/api/pluginCatalog.js):
// strict validation, choice of the newest compatible stable version, the
// state per plugin, the server-side download (allowed hosts and redirects
// only, size cap, sha256) and that the bytes go through the normal
// inspect → install with the signature checked against the trusted keys.
// The network is a stubbed transport, plus one real HTTPS round trip against
// a local server (certificate made with openssl; skipped without it).

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const supertest = require('supertest');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const { withoutScripts } = require('./helpers/html');
const PUI = require('../public/js/plugins-ui.js');
const de = require('../src/i18n/de.json');

let app, agent, csrf, plugins, catalog, runtime, db;
const API = '/api/v1/plugin-catalog';
const PAPI = '/api/v1/plugins';
const GH = 'https://github.com/CallMeTechie/gatecontrol-plugins/releases/download';
const CDN = 'https://release-assets.githubusercontent.com/github-production-release-asset/1';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function entry(id, version, buf, extra = {}) {
  return {
    schema: 1, id, name: { de: 'Hallo Welt', en: 'Hello World' }, description: { de: 'Beispiel', en: 'Example' }, publisher: 'GateControl Tests',
    version, prerelease: false, gatecontrol: '>=1.0.0', license_required: false, file: `${id}-${version}.gcplugin`,
    size: buf ? buf.length : 1000, sha256: buf ? sha(buf) : 'a'.repeat(64), url: `${GH}/${id}-v${version}/${id}-${version}.gcplugin`,
    signature: { alg: 'Ed25519', key_id: '0000000000000000', public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
    tag: `${id}-v${version}`, release_url: `https://github.com/CallMeTechie/gatecontrol-plugins/releases/tag/${id}-v${version}`,
    published_at: '2026-10-01T10:00:00.000Z', ...extra,
  };
}

function doc(byId) {
  const pluginsOut = {};
  for (const [id, versions] of Object.entries(byId)) {
    pluginsOut[id] = { id, name: versions[0].name, description: versions[0].description, publisher: versions[0].publisher, latest: versions[0], versions };
  }
  return { schema: 1, generated_at: '2026-10-09T00:00:00.000Z', repository: 'CallMeTechie/gatecontrol-plugins', plugins: pluginsOut };
}

// ─── Stubbed network ────────────────────────────
// routes: href → { status, location?, body? } — package urls on github.com
// answer 302 to the CDN like the real release downloads do.
const routes = new Map();
const fetched = [];
function serveCatalog(d) {
  routes.set(catalog.DEFAULT_URL, { status: 200, body: Buffer.from(JSON.stringify(d)) });
}
function servePackage(e, buf) {
  const cdn = `${CDN}/${e.id}-${e.version}?sig=x`;
  routes.set(e.url, { status: 302, location: cdn });
  routes.set(cdn, { status: 200, body: buf });
}
function stub() {
  catalog._setTransport(async (url) => {
    fetched.push(url);
    const r = routes.get(url);
    if (!r) return { status: 404, location: null, body: null };
    return { status: r.status, location: r.location || null, body: r.body || null };
  });
}

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  plugins = require('../src/services/plugins');
  catalog = require('../src/services/plugins/catalog');
  runtime = require('../src/services/plugins/runtime');
  db = require('../src/db/connection').getDb();
  db.prepare("UPDATE users SET language = 'de' WHERE username = 'admin'").run();
});
after(async () => {
  catalog._reset();
  await plugins.stop();
  teardown();
});

// ─── Validation ─────────────────────────────────

describe('catalogue validation', () => {
  const ok = () => doc({ 'gatecontrol-midea': [entry('gatecontrol-midea', '1.0.1'), entry('gatecontrol-midea', '1.0.0')] });
  const invalid = (d) => assert.throws(() => catalog.validate(d), (e) => e.code === 'catalog_invalid');

  it('accepts the published format and sorts the versions newest first', () => {
    const d = ok();
    d.plugins['gatecontrol-midea'].versions.reverse();
    d.plugins['gatecontrol-midea'].unknown_future_field = 1;
    const cat = catalog.validate(d);
    const p = cat.plugins.get('gatecontrol-midea');
    assert.deepEqual(p.versions.map((v) => v.version), ['1.0.1', '1.0.0']);
    assert.deepEqual(p.name, { de: 'Hallo Welt', en: 'Hello World' });
    assert.equal(p.versions[0].url, `${GH}/gatecontrol-midea-v1.0.1/gatecontrol-midea-1.0.1.gcplugin`);
    assert.equal('signature' in p.versions[0], false, 'the catalogue signature fields are not carried on');
  });
  it('bad schema', () => {
    invalid(null);
    invalid([]);
    invalid({ ...ok(), schema: 2 });
    invalid({ ...ok(), plugins: [] });
    const d = ok();
    d.plugins['gatecontrol-midea'].versions = [];
    invalid(d);
    const d2 = ok();
    delete d2.plugins['gatecontrol-midea'].versions[0].sha256;
    invalid(d2);
    const d3 = ok();
    d3.plugins['gatecontrol-midea'].latest = { schema: 1 };
    invalid(d3);
  });
  it('bad plugin id: not by the plugin id rule, or the entry names another plugin', () => {
    for (const bad of ['Bad_ID', '../x', 'a', 'x'.repeat(65), '-x', 'x-']) {
      const d = ok();
      d.plugins[bad] = { ...d.plugins['gatecontrol-midea'], id: bad };
      invalid(d);
    }
    const d = ok();
    d.plugins['gatecontrol-midea'].id = 'gatecontrol-skoda';
    invalid(d);
    const d2 = ok();
    d2.plugins['gatecontrol-midea'].versions[1].id = 'gatecontrol-skoda';
    invalid(d2);
  });
  it('bad host: package urls must be https on github.com / the release CDN', () => {
    for (const url of ['http://github.com/x.gcplugin', 'https://evil.example/x.gcplugin', 'https://github.com.evil.example/x.gcplugin',
      'https://user:pw@github.com/x.gcplugin', 'https://github.com:8443/x.gcplugin', 'file:///etc/passwd', 'not a url']) {
      const d = ok();
      d.plugins['gatecontrol-midea'].versions[0].url = url;
      invalid(d);
    }
    const d = ok();
    d.plugins['gatecontrol-midea'].versions[0].release_url = 'https://evil.example/notes';
    invalid(d);
    const d2 = ok();
    d2.plugins['gatecontrol-midea'].versions[0].url = 'https://objects.githubusercontent.com/github-production-release-asset/1/x';
    assert.ok(catalog.validate(d2));
  });
  it('bad version, range, checksum, size; duplicate versions', () => {
    const mutate = (k, v) => { const d = ok(); d.plugins['gatecontrol-midea'].versions[0][k] = v; return d; };
    invalid(mutate('version', '1.0'));
    invalid(mutate('version', 'v1.0.0'));
    invalid(mutate('gatecontrol', 'banana'));
    invalid(mutate('sha256', 'xyz'));
    invalid(mutate('sha256', 'A'.repeat(64)));
    invalid(mutate('size', 50 * 1024 * 1024));
    invalid(mutate('size', '1000'));
    invalid(mutate('prerelease', 'no'));
    invalid(mutate('license_required', 1));
    invalid(mutate('version', '1.0.0'));
  });
  it('an operator catalogue URL adds its own host; it must be https', () => {
    const before = process.env.GC_PLUGIN_CATALOG_URL;
    try {
      process.env.GC_PLUGIN_CATALOG_URL = 'https://plugins.example.net:8443/catalog.json';
      assert.ok(catalog.allowedHosts().has('plugins.example.net:8443'));
      assert.ok(catalog.allowedUrl('https://plugins.example.net:8443/a.gcplugin'));
      assert.equal(catalog.allowedUrl('https://plugins.example.net/a.gcplugin'), null, 'another port is another host');
      process.env.GC_PLUGIN_CATALOG_URL = 'http://plugins.example.net/catalog.json';
      assert.throws(() => catalog.catalogUrl(), (e) => e.code === 'catalog_config');
    } finally {
      if (before === undefined) delete process.env.GC_PLUGIN_CATALOG_URL; else process.env.GC_PLUGIN_CATALOG_URL = before;
    }
  });
});

describe('choice and state', () => {
  function plugin(versions) {
    return catalog.validate(doc({ x1: versions.map(([v, range, pre]) => entry('x1', v, null, { gatecontrol: range, prerelease: !!pre })) })).plugins.get('x1');
  }
  it('picks the newest non-prerelease version compatible with this GateControl', () => {
    const p = plugin([['3.0.0', '>=9.0.0'], ['2.1.0-rc.1', '>=1.0.0'], ['2.0.1', '>=1.0.0', true], ['2.0.0', '>=1.100.0 <2.0.0'], ['1.0.0', '>=1.0.0']]);
    assert.equal(catalog.pick(p, '1.152.1').version, '2.0.0');
    assert.equal(catalog.pick(p, '1.50.0').version, '1.0.0');
    assert.equal(catalog.pick(p, '0.9.0'), null);
    assert.equal(p.versions.find((v) => v.version === '2.1.0-rc.1').prerelease, true, 'a semver pre-release counts as one whatever the flag says');
  });
  it('state: not installed / installed / update / incompatible', () => {
    const p = plugin([['1.2.0', '>=1.0.0'], ['1.1.0', '>=1.0.0']]);
    assert.equal(catalog.stateOf(p, null, '1.152.1').state, 'not_installed');
    assert.equal(catalog.stateOf(p, { version: '1.2.0' }, '1.152.1').state, 'installed');
    assert.equal(catalog.stateOf(p, { version: '1.3.0' }, '1.152.1').state, 'installed', 'a newer local build is no update');
    const u = catalog.stateOf(p, { version: '1.1.0' }, '1.152.1');
    assert.deepEqual([u.state, u.latest.version, u.installedVersion], ['update', '1.2.0', '1.1.0']);
    const only = plugin([['1.0.0', '>=9.0.0']]);
    const inc = catalog.stateOf(only, null, '1.152.1');
    assert.deepEqual([inc.state, inc.latest, inc.blocked], ['incompatible', null, { version: '1.0.0', gatecontrol: '>=9.0.0' }]);
    const newer = plugin([['2.0.0', '>=9.0.0'], ['1.0.0', '>=1.0.0']]);
    const s = catalog.stateOf(newer, { version: '1.0.0' }, '1.152.1');
    assert.deepEqual([s.state, s.blocked.version], ['installed', '2.0.0'], 'installed, the next version needs a newer GateControl');
  });
  it('the UI helpers map the states to chips and actions', () => {
    assert.equal(PUI.catalogAction({ state: 'not_installed', latest: { version: '1.0.0' } }), 'install');
    assert.equal(PUI.catalogAction({ state: 'update', latest: { version: '1.0.0' } }), 'update');
    assert.equal(PUI.catalogAction({ state: 'installed', latest: { version: '1.0.0' } }), null);
    assert.equal(PUI.catalogAction({ state: 'incompatible', latest: null }), null);
    assert.deepEqual(PUI.catalogChip({ state: 'update' }), { tone: 'info', key: 'plugins.cat.state.update' });
    assert.equal(PUI.catalogChip({ state: 'not_installed' }), null);
    for (const k of ['plugins.cat.state.installed', 'plugins.cat.state.update', 'plugins.cat.state.incompatible']) assert.ok(de[k], k);
  });
  it('permission diff of an update', () => {
    const t = (k, p) => k + (p ? JSON.stringify(p) : '');
    const before = { network: { internet: ['a.example:443'], homeTargets: [], discovery: null }, storage: true, pages: [], portalSections: [] };
    const now = { ...before, network: { ...before.network, internet: ['a.example:443', 'b.example:443'] }, notify: true };
    const d = PUI.permDiff(now, before, t);
    assert.equal(d.changed, 2);
    assert.equal(d.rows.find((r) => r.label === 'plugins.perm.internet').change, 'changed');
    assert.equal(d.rows.find((r) => r.label === 'plugins.perm.notify').change, 'added');
    assert.equal(PUI.permDiff(before, before, t).changed, 0);
    assert.equal(PUI.permDiff(now, null, t).changed, 0);
    assert.deepEqual(PUI.permDiff(before, now, t).removed.map((r) => r.label), ['plugins.perm.notify']);
  });
});

// ─── Download ───────────────────────────────────

describe('download (stubbed transport)', () => {
  const GCV = '1.152.1';
  let buf;
  beforeEach(() => {
    catalog._reset();
    routes.clear();
    fetched.length = 0;
    stub();
    buf = helloPackage();
  });

  it('follows github.com → release CDN, checks the sha256, returns the bytes', async () => {
    const e = entry('hello', '1.0.0', buf);
    serveCatalog(doc({ hello: [e] }));
    servePackage(e, buf);
    const r = await catalog.download('hello', '1.0.0', GCV);
    assert.ok(r.buf.equals(buf));
    assert.deepEqual(fetched, [catalog.DEFAULT_URL, e.url, `${CDN}/hello-1.0.0?sig=x`]);
  });
  it('sha256 mismatch is refused', async () => {
    const e = entry('hello', '1.0.0', buf, { sha256: sha(Buffer.from('something else')) });
    serveCatalog(doc({ hello: [e] }));
    servePackage(e, buf);
    await assert.rejects(catalog.download('hello', '1.0.0', GCV), (err) => err.code === 'catalog_hash_mismatch');
  });
  it('a download larger than the catalogue says is refused', async () => {
    const e = entry('hello', '1.0.0', buf, { size: buf.length - 1 });
    serveCatalog(doc({ hello: [e] }));
    servePackage(e, buf);
    await assert.rejects(catalog.download('hello', '1.0.0', GCV), (err) => err.code === 'catalog_too_large');
  });
  it('a redirect to a host that is not allowed (or to http, or in a loop) is refused — the host is never asked', async () => {
    const e = entry('hello', '1.0.0', buf);
    serveCatalog(doc({ hello: [e] }));
    for (const location of ['https://evil.example/x.gcplugin', 'http://release-assets.githubusercontent.com/x', 'https://127.0.0.1/x', '//evil.example/x']) {
      routes.set(e.url, { status: 302, location });
      fetched.length = 0;
      await assert.rejects(catalog.download('hello', '1.0.0', GCV), (err) => err.code === 'catalog_redirect', location);
      assert.ok(!fetched.some((u) => !/^https:\/\/github\.com\//.test(u)), fetched.join(' '));
    }
    routes.set(e.url, { status: 302, location: e.url });
    await assert.rejects(catalog.download('hello', '1.0.0', GCV), (err) => err.code === 'catalog_redirect');
  });
  it('a redirect of the catalogue itself to a foreign host is refused', async () => {
    routes.set(catalog.DEFAULT_URL, { status: 302, location: 'https://evil.example/catalog.json' });
    await assert.rejects(catalog.get(), (err) => err.code === 'catalog_redirect');
  });
  it('only listed, stable, compatible versions can be downloaded', async () => {
    serveCatalog(doc({ hello: [entry('hello', '2.0.0', buf, { gatecontrol: '>=99.0.0' }), entry('hello', '1.1.0-rc.1', buf), entry('hello', '1.0.0', buf)] }));
    await assert.rejects(catalog.download('hello', '9.9.9', GCV), (err) => err.code === 'catalog_unknown');
    await assert.rejects(catalog.download('other', '1.0.0', GCV), (err) => err.code === 'catalog_unknown');
    await assert.rejects(catalog.download('hello', '1.1.0-rc.1', GCV), (err) => err.code === 'catalog_unknown');
    await assert.rejects(catalog.download('hello', '2.0.0', GCV), (err) => err.code === 'catalog_incompatible');
    assert.ok(!fetched.some((u) => u.endsWith('.gcplugin')), 'nothing downloaded');
  });
  it('caches the catalogue; refresh fetches again; a failure is remembered briefly', async () => {
    serveCatalog(doc({ hello: [entry('hello', '1.0.0', buf)] }));
    await catalog.get();
    await catalog.get();
    assert.equal(fetched.length, 1);
    await catalog.get({ refresh: true });
    assert.equal(fetched.length, 2);
    catalog._reset();
    stub();
    routes.set(catalog.DEFAULT_URL, { status: 500 });
    await assert.rejects(catalog.get(), (err) => err.code === 'catalog_unreachable');
    serveCatalog(doc({ hello: [entry('hello', '1.0.0', buf)] }));
    await assert.rejects(catalog.get(), (err) => err.code === 'catalog_unreachable', 'cached failure');
    assert.ok(await catalog.get({ refresh: true }));
  });
  it('invalid JSON / invalid catalogue', async () => {
    routes.set(catalog.DEFAULT_URL, { status: 200, body: Buffer.from('{nope') });
    await assert.rejects(catalog.get(), (err) => err.code === 'catalog_invalid');
  });
  it('a test run never reaches the internet with the real transport', async () => {
    catalog._reset();
    await assert.rejects(catalog.get(), (err) => err.code === 'catalog_unreachable');
  });
});

// ─── API: install / update through the normal pipeline ─────

describe('catalogue API', () => {
  let v1, v2;
  before(() => {
    catalog._reset();
    routes.clear();
    stub();
    v1 = helloPackage();
    const perms = JSON.parse(JSON.stringify(helloManifest.permissions));
    perms.network.internet.push('api2.example.com:443');
    v2 = helloPackage({ overrides: { version: '1.1.0', permissions: perms } });
    const e1 = entry('hello', '1.0.0', v1);
    servePackage(e1, v1);
    serveCatalog(doc({ hello: [e1] }));
  });
  const post = (body) => agent.post(API + '/install').set('X-CSRF-Token', csrf).send(body);

  it('only for an admin session with CSRF', async () => {
    await supertest(app).get(API).expect(401);
    await supertest(app).post(API + '/install').send({ id: 'hello', version: '1.0.0' }).expect((r) => assert.ok([401, 403].includes(r.status), String(r.status)));
    const noCsrf = await agent.post(API + '/install').send({ id: 'hello', version: '1.0.0' });
    assert.equal(noCsrf.status, 403);
    const { rawToken } = require('../src/services/tokens').create({ name: 'cat', scopes: ['full-access'] }, '127.0.0.1');
    const tok = await supertest(app).post(API + '/install').set('Authorization', 'Bearer ' + rawToken).send({ id: 'hello', version: '1.0.0' });
    assert.equal(tok.status, 403);
    const tokGet = await supertest(app).get(API).set('Authorization', 'Bearer ' + rawToken);
    assert.equal(tokGet.status, 403);
    assert.ok(!fetched.some((u) => u.endsWith('.gcplugin')), 'nothing downloaded');
  });
  it('GitHub not reachable: a state of the card (200, available false), not a failed request', async () => {
    const saved = routes.get(catalog.DEFAULT_URL);
    routes.set(catalog.DEFAULT_URL, { status: 503 });
    const r = await agent.get(API + '?refresh=1').expect(200);
    assert.deepEqual([r.body.ok, r.body.enabled, r.body.available, r.body.code, r.body.plugins], [true, true, false, 'catalog_unreachable', []]);
    assert.equal(r.body.error, de['plugins.err.catalog_unreachable']);
    routes.set(catalog.DEFAULT_URL, saved);
    catalog._reset();
    stub();
  });
  it('lists the catalogue with the state per plugin', async () => {
    const r = await agent.get(API).expect(200);
    assert.equal(r.body.enabled, true);
    assert.equal(r.body.available, true);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.ok(r.headers['ratelimit-policy'] || r.headers['ratelimit-limit'] || r.headers.ratelimit, 'rate-limited');
    assert.deepEqual(r.body.plugins.map((p) => [p.id, p.name, p.state, p.latest.version, p.latest.licenseRequired]), [['hello', 'Hallo Welt', 'not_installed', '1.0.0', false]]);
  });
  it('rejects malformed requests', async () => {
    assert.equal((await post({ id: '../x', version: '1.0.0' }).expect(400)).body.code, 'invalid');
    assert.equal((await post({ id: 'hello', version: 'latest' }).expect(400)).body.code, 'invalid');
  });
  it('a catalogue entry cannot install another plugin id: refused before a staging token exists', async () => {
    const e = entry('other', '1.0.0', v1); // the bytes are "hello"
    servePackage(e, v1);
    serveCatalog(doc({ hello: [entry('hello', '1.0.0', v1)], other: [e] }));
    await agent.get(API + '?refresh=1').expect(200);
    const staged = plugins._staging.size;
    const r = await post({ id: 'other', version: '1.0.0' }).expect(409);
    assert.equal(r.body.code, 'catalog_mismatch');
    assert.equal(r.body.token, undefined);
    assert.equal(plugins._staging.size, staged);
    assert.equal(require('../src/services/plugins/registry').get('hello'), null);
  });
  it('the package signature must be trusted (the catalogue key fields are not)', async () => {
    const stranger = helloPackage({ sign: 'stranger' });
    const e = entry('hello', '1.0.0', stranger, { signature: { alg: 'Ed25519', key_id: 'x', public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } });
    servePackage(e, stranger);
    serveCatalog(doc({ hello: [e] }));
    catalog._reset();
    stub();
    const r = await post({ id: 'hello', version: '1.0.0' }).expect(409);
    assert.equal(r.body.code, 'catalog_untrusted');
  });
  it('install: download → the same checks and token as an upload → the normal install', async () => {
    const e1 = entry('hello', '1.0.0', v1);
    servePackage(e1, v1);
    serveCatalog(doc({ hello: [e1] }));
    catalog._reset();
    stub();
    const r = await post({ id: 'hello', version: '1.0.0' }).expect(200);
    assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
    assert.match(r.body.token, /^[0-9a-f]{32}$/);
    assert.equal(r.body.origin, 'catalog');
    assert.deepEqual(r.body.checks.find((c) => c.key === 'signature'), { key: 'signature', status: 'ok', code: 'trusted', params: { publisher: 'GateControl Tests' } });
    assert.equal(r.body.plugin.verified, true);
    assert.equal(r.body.existing, null);
    assert.ok(r.body.plugin.permissions.network);
    await agent.post(PAPI + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: false }).expect(400);
    await agent.post(PAPI + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
    assert.equal(await runtime.waitRunning('hello'), true);
    const ev = db.prepare("SELECT details FROM activity_log WHERE event_type = 'plugin_installed' ORDER BY id DESC").get();
    assert.match(ev.details, /"source":"catalog"/);
    const list = await agent.get(API).expect(200);
    assert.equal(list.body.plugins[0].state, 'installed');
    assert.equal(list.body.plugins[0].installedVersion, '1.0.0');
  });
  it('update: state "update", the dialog data carries the installed permissions for the diff', async () => {
    const e1 = entry('hello', '1.0.0', v1);
    const e2 = entry('hello', '1.1.0', v2);
    servePackage(e1, v1);
    servePackage(e2, v2);
    serveCatalog(doc({ hello: [e2, e1] }));
    const list = await agent.get(API + '?refresh=1').expect(200);
    assert.deepEqual([list.body.plugins[0].state, list.body.plugins[0].latest.version], ['update', '1.1.0']);
    const r = await post({ id: 'hello', version: '1.1.0' }).expect(200);
    assert.deepEqual(r.body.checks.find((c) => c.key === 'existing'), { key: 'existing', status: 'ok', code: 'update', params: { from: '1.0.0', to: '1.1.0' } });
    assert.equal(r.body.existing.version, '1.0.0');
    assert.deepEqual(r.body.existing.permissions.network.internet, ['api.example.com:443', '*.cloud.example']);
    assert.deepEqual(r.body.plugin.permissions.network.internet, ['api.example.com:443', '*.cloud.example', 'api2.example.com:443']);
    await agent.post(PAPI + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
    assert.equal((await agent.get(PAPI + '/hello').expect(200)).body.plugin.version, '1.1.0');
    assert.equal((await agent.get(API).expect(200)).body.plugins[0].state, 'installed');
  });
  it('Settings → Plugins has the "Offizielle Plugins" card — no raw keys, DOM without innerHTML', async () => {
    const html = withoutScripts((await agent.get('/settings').expect(200)).text);
    const s = html.slice(html.indexOf('id="pg-root"'), html.indexOf('id="pg-security"'));
    assert.match(s, /<section class="st-card pg-cat" id="pg-catalog"/);
    assert.ok(s.includes('Offizielle Plugins'));
    assert.ok(s.includes('Katalog nicht erreichbar – Plugins lassen sich weiterhin hochladen.'));
    assert.match(s, /id="pg-cat-refresh"/);
    assert.doesNotMatch(s, /\b(plugins|st)\.[a-z_]+\.[a-z_.]+/, 'no raw i18n keys');
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'settings-plugins.js'), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.match(src, /\/api\/v1\/plugin-catalog/);
  });
  it('GC_PLUGIN_CATALOG=off: no card, the API says disabled and refuses installs, nothing is fetched', async () => {
    process.env.GC_PLUGIN_CATALOG = 'off';
    try {
      fetched.length = 0;
      const r = await agent.get(API + '?refresh=1').expect(200);
      assert.deepEqual([r.body.enabled, r.body.available, r.body.plugins], [false, false, []]);
      const i = await post({ id: 'hello', version: '1.1.0' }).expect(404);
      assert.equal(i.body.code, 'catalog_disabled');
      assert.deepEqual(fetched, []);
      const html = withoutScripts((await agent.get('/settings').expect(200)).text);
      assert.doesNotMatch(html, /id="pg-catalog"/);
    } finally {
      delete process.env.GC_PLUGIN_CATALOG;
    }
  });
});

// ─── Real HTTPS transport against a local server ─────

function makeCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cat-tls-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  try {
    require('node:child_process').execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('real HTTPS transport (local server)', () => {
  const tls = makeCert();
  let server, base;
  const pkg = helloPackage();
  const big = Buffer.alloc(64 * 1024, 1);

  before(async () => {
    if (!tls) return;
    const https = require('node:https');
    server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
      const u = req.url;
      if (u === '/catalog.json') {
        const cat = doc({ hello: [entry('hello', '1.0.0', pkg, { url: base + '/dl/hello.gcplugin' })], big: [entry('big', '1.0.0', big, { size: 1000, url: base + '/dl/big.gcplugin' })],
          away: [entry('away', '1.0.0', pkg, { url: base + '/dl/away.gcplugin' })] });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(cat));
      }
      if (u === '/dl/hello.gcplugin') { res.writeHead(302, { Location: '/files/hello' }); return res.end(); }
      if (u === '/files/hello') { res.writeHead(200, { 'Content-Length': pkg.length }); return res.end(pkg); }
      if (u === '/dl/big.gcplugin') { res.writeHead(200); res.write(big.subarray(0, 32 * 1024)); return res.end(big.subarray(32 * 1024)); } // chunked, no length
      if (u === '/dl/away.gcplugin') { res.writeHead(301, { Location: 'https://evil.example/hello.gcplugin' }); return res.end(); }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `https://127.0.0.1:${server.address().port}`;
    process.env.GC_PLUGIN_CATALOG_URL = base + '/catalog.json';
    catalog._reset();
    catalog._setAgent(new https.Agent({ ca: tls.cert, keepAlive: false }));
  });
  after(async () => {
    delete process.env.GC_PLUGIN_CATALOG_URL;
    catalog._reset();
    if (server) await new Promise((r) => server.close(r));
  });

  it('fetches the catalogue and a package over https with redirects', { skip: !tls && 'openssl not available' }, async () => {
    const cat = await catalog.get();
    assert.deepEqual([...cat.plugins.keys()].sort(), ['away', 'big', 'hello']);
    const r = await catalog.download('hello', '1.0.0', '1.152.1');
    assert.ok(r.buf.equals(pkg));
  });
  it('stops reading at the size cap (no Content-Length)', { skip: !tls && 'openssl not available' }, async () => {
    await assert.rejects(catalog.download('big', '1.0.0', '1.152.1'), (e) => e.code === 'catalog_too_large');
  });
  it('refuses a redirect to a host that is not allowed', { skip: !tls && 'openssl not available' }, async () => {
    await assert.rejects(catalog.download('away', '1.0.0', '1.152.1'), (e) => e.code === 'catalog_redirect');
  });
  it('an untrusted certificate is an unreachable catalogue', { skip: !tls && 'openssl not available' }, async () => {
    catalog._reset();
    await assert.rejects(catalog.get(), (e) => e.code === 'catalog_unreachable');
  });
});
