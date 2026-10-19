'use strict';

// The plugin area (docs/plugins.md "Plugin area", "Updates"): store
// metadata and release notes of the catalogue, the updates of the installed
// plugins, the regular update check, the nightly automatic update (never with
// other permissions), the history, the restart, the licence key without a
// plugin, the reserved path segments and the sidebar badge.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const { withoutScripts } = require('./helpers/html');

let agent, csrf, plugins, catalog, updates, runtime, licensing, db;
const API = '/api/v1/plugins';
const CAPI = '/api/v1/plugin-catalog';
const GH = 'https://github.com/CallMeTechie/gatecontrol-plugins/releases/download';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function entry(version, buf, extra = {}) {
  return {
    schema: 1, id: 'hello', name: { de: 'Hallo Welt', en: 'Hello World' }, description: { de: 'Beispiel', en: 'Example' }, publisher: 'GateControl Tests',
    version, prerelease: false, gatecontrol: '>=1.0.0', license_required: false, file: `hello-${version}.gcplugin`,
    size: buf ? buf.length : 1000, sha256: buf ? sha(buf) : 'a'.repeat(64), url: `${GH}/hello-v${version}/hello-${version}.gcplugin`,
    published_at: '2026-10-01T10:00:00.000Z', notes: `- **Neu:** Version ${version}\n  - Detail`, ...extra,
  };
}

function doc(versions, meta = {}) {
  return { schema: 1, generated_at: '2026-10-09T00:00:00.000Z', plugins: { hello: {
    id: 'hello', name: versions[0].name, description: versions[0].description, publisher: versions[0].publisher, latest: versions[0], versions,
    category: 'family', icon: 'chat', summary: { de: 'Kurz', en: 'Short' }, audience: 'admins', keywords: ['Gruss', 'hallo'], related: ['other-plugin', 'hello'],
    highlight: { version: '1.1.0', title: { de: 'Neu!', en: 'New!' }, text: { de: 'Text', en: 'Text' } }, ...meta,
  } } };
}

const routes = new Map();
function serve(d, pkgs) {
  routes.clear();
  routes.set(catalog.DEFAULT_URL, { status: 200, body: Buffer.from(JSON.stringify(d)) });
  for (const [e, buf] of pkgs) routes.set(e.url, { status: 200, body: buf });
}

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  plugins = require('../src/services/plugins');
  catalog = require('../src/services/plugins/catalog');
  updates = require('../src/services/plugins/updates');
  runtime = require('../src/services/plugins/runtime');
  licensing = require('../src/services/plugins/licensing');
  db = require('../src/db/connection').getDb();
  catalog._setTransport(async (url) => {
    const r = routes.get(url);
    return r ? { status: r.status, location: null, body: r.body } : { status: 404, location: null, body: null };
  });
});
after(async () => {
  catalog._reset();
  await plugins.stop();
  teardown();
});

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  return agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}

describe('catalogue: store metadata and release notes', () => {
  it('keeps valid metadata, drops what is malformed instead of the catalogue', () => {
    const cat = catalog.validate(doc([entry('1.0.0')]));
    const p = cat.plugins.get('hello');
    assert.deepEqual(p.meta.category, 'family');
    assert.deepEqual(p.meta.keywords, ['gruss', 'hallo']);
    assert.deepEqual(p.meta.related, ['other-plugin'], 'no self reference');
    assert.match(p.versions[0].notes, /^- \*\*Neu:\*\*/);
    const bad = catalog.validate(doc([entry('1.0.0', null, { notes: 42 })], { category: 'weapons', icon: '<svg>', summary: 7, audience: 'x', keywords: 'a', related: ['../x'], highlight: { version: 'x' } }));
    assert.deepEqual(bad.plugins.get('hello').meta, {});
    assert.equal(bad.plugins.get('hello').versions[0].notes, null);
  });
  it('view / detail / notesBetween', () => {
    const cat = catalog.validate(doc([entry('1.2.0'), entry('1.1.0'), entry('1.0.1'), entry('1.0.0')]));
    const v = catalog.view(cat, 'en', () => ({ version: '1.0.0' }), '1.181.0')[0];
    assert.deepEqual([v.category, v.icon, v.summary, v.audience, v.highlight.title, v.state], ['family', 'chat', 'Short', 'admins', 'New!', 'update']);
    assert.match(v.latest.notes, /Version 1\.2\.0/);
    const d = catalog.detail(cat, 'hello', 'de', () => null, '1.181.0');
    assert.deepEqual(d.versions.map((x) => x.version), ['1.2.0', '1.1.0', '1.0.1', '1.0.0']);
    assert.equal(catalog.detail(cat, 'nope', 'de', () => null, '1.181.0'), null);
    assert.deepEqual(catalog.notesBetween(cat, 'hello', '1.0.1', '1.2.0').map((x) => x.version), ['1.2.0', '1.1.0']);
  });
  it('detail page metadata: adds, permissions, shows, needs, languages, highlight tags — lenient', () => {
    const T = (de, en) => ({ de, en: en || de });
    const cat = catalog.validate(doc([entry('1.0.0')], {
      adds: [{ icon: 'page', title: T('Admin-Seite', 'Admin page'), text: T('Nodes') }, { icon: '<x>', title: T('Ohne Symbol') }, { title: 7 }],
      permissions: [{ icon: 'network', title: T('Heimnetz'), text: T('nur der Host'), tag: T('Netzwerk', 'Network') }],
      shows: [{ kind: 'tile', caption: T('Startkachel'), value: '3/3' }, { kind: 'video', caption: T('x') }, { kind: 'widget', caption: T('Widget'), value: 'way too long value' }],
      needs: T('API-Token'), languages: ['de', 'en', 'fr', 'de'],
      highlight: { version: '1.1.0', title: T('Neu!'), tags: [{ icon: 'clock', text: T('Sonntag') }, 'Montag', { icon: 'nope', text: T('Ohne') }, 5] },
    }));
    const v = catalog.view(cat, 'en', () => null, '1.181.0')[0];
    assert.deepEqual(v.adds, [{ icon: 'page', title: 'Admin page', text: 'Nodes' }, { icon: null, title: 'Ohne Symbol', text: '' }]);
    assert.deepEqual(v.permissions, [{ icon: 'network', title: 'Heimnetz', text: 'nur der Host', tag: 'Network' }]);
    assert.deepEqual(v.shows, [{ kind: 'tile', caption: 'Startkachel', value: '3/3' }, { kind: 'widget', caption: 'Widget', value: null }]);
    assert.deepEqual([v.needs, v.languages], ['API-Token', ['de', 'en']]);
    assert.deepEqual(v.highlight.tags, [{ icon: 'clock', text: 'Sonntag' }, { icon: null, text: 'Montag' }, { icon: null, text: 'Ohne' }]);
    const bad = catalog.validate(doc([entry('1.0.0')], { adds: 'x', permissions: {}, shows: [1], needs: 3, languages: 'de' }));
    for (const k of ['adds', 'permissions', 'shows', 'needs', 'languages']) assert.equal(k in bad.plugins.get('hello').meta, false, k);
  });
  it('an old catalogue without metadata still works (category "other")', () => {
    const d = doc([entry('1.0.0')]);
    for (const k of ['category', 'icon', 'summary', 'audience', 'keywords', 'related', 'highlight']) delete d.plugins.hello[k];
    const v = catalog.view(catalog.validate(d), 'de', () => null, '1.181.0')[0];
    assert.deepEqual([v.category, v.icon, v.summary, v.highlight, v.keywords], ['other', null, '', null, []]);
  });
});

describe('updates, history, restart', () => {
  let v100; let v101; let v110; let v111perm;
  before(() => {
    v100 = helloPackage();
    v101 = helloPackage({ overrides: { version: '1.0.1' } });
    v110 = helloPackage({ overrides: { version: '1.1.0' } });
    const perms = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8')).permissions;
    perms.network.internet.push('new.example.com:443');
    v111perm = helloPackage({ overrides: { version: '1.1.1', permissions: perms } });
  });

  it('install records the history; the list carries errors7d, uses and usedBy', async () => {
    await install(v100);
    assert.equal(await runtime.waitRunning('hello'), true);
    const h = (await agent.get(API + '/history').expect(200)).body.history;
    assert.deepEqual([h[0].action, h[0].id, h[0].to, h[0].by, h[0].source], ['install', 'hello', '1.0.0', 'admin', 'upload']);
    assert.ok(h[0].user, 'the acting administrator');
    const p = (await agent.get(API).expect(200)).body.plugins.find((x) => x.id === 'hello');
    assert.deepEqual([p.errors7d, p.uses, p.usedBy], [0, [], []]);
    assert.ok(p.events24h >= 1, 'log entries of the last 24 h');
  });

  it('GET /contributions: quick actions and widgets per plugin (none for a plugin without the hook)', async () => {
    const r = (await agent.get(API + '/contributions').expect(200)).body;
    assert.equal(r.ok, true);
    assert.equal(typeof r.counts, 'object');
    for (const c of Object.values(r.counts)) assert.ok(c.actions >= c.widgets);
  });

  it('GET /plugin-catalog/updates: kind and the notes of every version in between', async () => {
    const e101 = entry('1.0.1', v101);
    const e110 = entry('1.1.0', v110);
    serve(doc([e110, e101, entry('1.0.0', v100)]), [[e101, v101], [e110, v110]]);
    const r = (await agent.get(CAPI + '/updates?refresh=1').expect(200)).body;
    assert.equal(r.available, true);
    assert.deepEqual(r.updates.map((u) => [u.id, u.from, u.to, u.kind]), [['hello', '1.0.0', '1.1.0', 'minor']]);
    assert.deepEqual(r.updates[0].notes.map((n) => n.version), ['1.1.0', '1.0.1']);
    assert.equal(r.autoUpdate, 'off');
    const d = (await agent.get(CAPI + '/hello').expect(200)).body.plugin;
    assert.deepEqual([d.state, d.installedVersion, d.versions.length], ['update', '1.0.0', 3]);
    await agent.get(CAPI + '/no-such-plugin').expect(404);
  });

  it('the sidebar badge counts the cached update; the plugin area page renders', async () => {
    const html = withoutScripts((await agent.get('/settings/plugins').expect(200)).text);
    assert.match(html, /id="nav-settings">[\s\S]*?<span class="nav-badge amber" id="pg-nav-badge"[^>]*>1<\/span>/);
    assert.doesNotMatch(html, /id="nav-plugins"/, 'no entry of its own in the sidebar');
    // Settings › Plugins marks it too
    assert.match(withoutScripts((await agent.get('/settings').expect(200)).text), /data-section="plugins"[\s\S]*?<span class="st-nav-dot" data-dot>/);
  });

  it('regular check: reported once per new version', async () => {
    const before = () => db.prepare("SELECT COUNT(*) AS c FROM activity_log WHERE event_type = 'plugin_update_available'").get().c;
    const n0 = before();
    assert.equal((await updates.checkCatalog()).length, 1);
    assert.equal(before(), n0 + 1);
    await updates.checkCatalog();
    assert.equal(before(), n0 + 1, 'not again for the same version');
    await agent.put(API + '/policy').set('X-CSRF-Token', csrf).send({ catalogCheck: false }).expect(200);
    assert.equal(await updates.checkCatalog(), null);
    await agent.put(API + '/policy').set('X-CSRF-Token', csrf).send({ catalogCheck: true }).expect(200);
  });

  it('policy: autoUpdate off | patch | all, nothing else', async () => {
    await agent.put(API + '/policy').set('X-CSRF-Token', csrf).send({ autoUpdate: 'sometimes' }).expect(400);
    await agent.put(API + '/policy').set('X-CSRF-Token', csrf).send({ catalogCheck: 'yes' }).expect(400);
    const r = await agent.put(API + '/policy').set('X-CSRF-Token', csrf).send({ autoUpdate: 'patch' }).expect(200);
    assert.deepEqual([r.body.autoUpdate, r.body.catalogCheck], ['patch', true]);
    assert.equal((await agent.get(API).expect(200)).body.autoUpdate, 'patch');
  });

  it('automatic update "patch": a minor update waits; only inside the night window, once a day', async () => {
    assert.deepEqual(await updates.autoUpdateTick(new Date(2026, 9, 20, 3, 30).getTime(), { force: true }), []);
    assert.equal(plugins.get('hello').version, '1.0.0');
    // outside the window nothing happens
    await agent.put(API + '/policy').set('X-CSRF-Token', csrf).send({ autoUpdate: 'all' }).expect(200);
    assert.deepEqual(await updates.autoUpdateTick(new Date(2026, 9, 20, 14, 0).getTime()), []);
    assert.equal(updates.inNightWindow(new Date(2026, 9, 20, 4, 59).getTime()), true);
    assert.equal(updates.inNightWindow(new Date(2026, 9, 20, 5, 0).getTime()), false);
  });

  it('automatic update "all": same permissions → installed, logged as automatic', async () => {
    const res = await updates.autoUpdateTick(new Date(2026, 9, 21, 3, 10).getTime());
    assert.deepEqual(res.map((r) => [r.id, r.result, r.to]), [['hello', 'updated', '1.1.0']]);
    assert.equal(plugins.get('hello').version, '1.1.0');
    assert.deepEqual(await updates.autoUpdateTick(new Date(2026, 9, 21, 4, 10).getTime()), [], 'once per night');
    const h = (await agent.get(API + '/history').expect(200)).body.history[0];
    assert.deepEqual([h.action, h.from, h.to, h.by, h.user], ['update', '1.0.0', '1.1.0', 'auto', null]);
    const ev = db.prepare("SELECT message FROM activity_log WHERE event_type = 'plugin_auto_updated' ORDER BY id DESC LIMIT 1").get();
    assert.match(ev.message, /Hallo Welt 1\.1\.0/);
    assert.equal(await runtime.waitRunning('hello'), true);
  });

  it('automatic update: other permissions → never installed, the administrator is told once', async () => {
    const e = entry('1.1.1', v111perm);
    serve(doc([e, entry('1.1.0', v110)]), [[e, v111perm]]);
    const count = () => db.prepare("SELECT COUNT(*) AS c FROM activity_log WHERE event_type = 'plugin_update_needs_approval'").get().c;
    const n0 = count();
    let res = await updates.runAutoUpdate('all');
    assert.deepEqual(res.map((r) => [r.id, r.result]), [['hello', 'needs_approval']]);
    res = await updates.runAutoUpdate('all');
    assert.deepEqual(res.map((r) => r.result), ['needs_approval']);
    assert.equal(count(), n0 + 1);
    assert.equal(plugins.get('hello').version, '1.1.0');
    const u = (await agent.get(CAPI + '/updates').expect(200)).body.updates[0];
    assert.deepEqual([u.to, u.kind, u.needsApproval], ['1.1.1', 'patch', true]);
    // an administrator updates by hand: the approval is gone
    const r = await agent.post(CAPI + '/install').set('X-CSRF-Token', csrf).send({ id: 'hello', version: '1.1.1' }).expect(200);
    assert.equal(updates.samePermissions(r.body), false);
    await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
    assert.equal(JSON.parse(require('../src/services/settings').get('plugins.update_approval', '{}')).hello, undefined);
    await agent.put(API + '/policy').set('X-CSRF-Token', csrf).send({ autoUpdate: 'off' }).expect(200);
  });

  it('POST /:id/restart stops and starts the plugin again', async () => {
    assert.equal(await runtime.waitRunning('hello'), true);
    const pid = runtime.info('hello').pid;
    const r = await agent.post(API + '/hello/restart').set('X-CSRF-Token', csrf).send({}).expect(200);
    assert.equal(r.body.plugin.id, 'hello');
    assert.equal(await runtime.waitRunning('hello'), true);
    assert.notEqual(runtime.info('hello').pid, pid);
    await agent.post(API + '/nope/restart').set('X-CSRF-Token', csrf).send({}).expect(404);
  });

  it('/settings/plugins/manage/hello renders; uninstall is recorded in the history', async () => {
    const html = withoutScripts((await agent.get('/settings/plugins/manage/hello').expect(200)).text);
    assert.match(html, /data-view="manage" data-target="hello"/);
    await agent.post(API + '/hello/uninstall').set('X-CSRF-Token', csrf).send({ mode: 'keep' }).expect(200);
    const h = (await agent.get(API + '/history').expect(200)).body.history[0];
    assert.deepEqual([h.action, h.from, h.to, h.mode], ['uninstall', '1.1.1', null, 'keep']);
    await agent.get('/settings/plugins/manage/hello').expect(404);
  });
});

describe('licence key without a plugin', () => {
  it('maskMatches', () => {
    assert.equal(licensing.maskMatches('GCP-7HQ2-••••-K2M8', 'gcp-7hq2-abcd-k2m8'), true);
    assert.equal(licensing.maskMatches('GCP-••••-K2M8', 'GCP-7HQ2-ABCD-K2M8'), true);
    assert.equal(licensing.maskMatches('GCP-••••-K2M9', 'GCP-7HQ2-ABCD-K2M8'), false);
    assert.equal(licensing.maskMatches('••••8', 'GCP-7HQ2-ABCD-K2M8'), false, 'too little visible');
    assert.equal(licensing.maskMatches(null, 'GCP-1'), false);
  });
  it('POST /license-key: the licence server names the plugin; an invalid key is not kept', async () => {
    const license = require('../src/services/license');
    const orig = license.refreshLicenseInBackground;
    let answer = [];
    license.refreshLicenseInBackground = async () => { license._setPluginEntitlementsForTest(answer); };
    try {
      answer = [{ slug: 'gatecontrol-proxmox', name: 'Proxmox VE', source: 'license', key_masked: 'GCPX-••••-9Z9Z', valid: true, error: null }];
      let r = await agent.post(API + '/license-key').set('X-CSRF-Token', csrf).send({ key: 'GCPX-AAAA-BBBB-9Z9Z' }).expect(200);
      assert.deepEqual([r.body.pluginId, r.body.installed, r.body.valid], ['gatecontrol-proxmox', false, true]);
      assert.ok(license.getPluginKeys().includes('GCPX-AAAA-BBBB-9Z9Z'));
      answer = [{ slug: 'gatecontrol-skoda', name: 'Fahrzeuge', source: 'license', key_masked: 'GCPY-••••-0000', valid: false, error: 'invalid' }];
      r = await agent.post(API + '/license-key').set('X-CSRF-Token', csrf).send({ key: 'GCPY-1111-2222-0000' }).expect(200);
      assert.deepEqual([r.body.pluginId, r.body.valid, r.body.error], ['gatecontrol-skoda', false, 'invalid']);
      assert.ok(!license.getPluginKeys().includes('GCPY-1111-2222-0000'), 'not kept');
      answer = [];
      r = await agent.post(API + '/license-key').set('X-CSRF-Token', csrf).send({ key: 'GCPZ-1111-2222-3333' }).expect(400);
      assert.equal(r.body.code, 'license_pending');
      await agent.post(API + '/license-key').set('X-CSRF-Token', csrf).send({ key: 'x' }).expect(400);
    } finally {
      license.refreshLicenseInBackground = orig;
      license._setPluginEntitlementsForTest([]);
    }
  });
});

describe('reserved path segments', () => {
  it('a plugin cannot be called like a page of the plugin area', () => {
    const manifest = require('../src/services/plugins/manifest');
    for (const id of ['catalog', 'updates', 'licenses', 'security', 'manage']) {
      const r = manifest.validate({ id, name: 'X', version: '1.0.0', publisher: 'X', gatecontrol: '>=1.0.0', entry: 'server/index.js' }, { files: new Set(['server/index.js']) });
      assert.equal(r.ok, false);
      assert.ok(r.errors.includes('id: reserved'), id);
    }
  });
});
