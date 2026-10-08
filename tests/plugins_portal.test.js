'use strict';

// What plugins add to the portal (docs/plugins.md "Portal",
// src/services/plugins/portal.js): sections inside GateControl's "Zuhause" /
// "Fahrzeug" tab (own sandboxed frames), declarative Start tiles and search
// results — per viewer, with a timeout per plugin, a misbehaving plugin only
// losing its own part.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let agent, csrf, runtime, plugins, portal, manifest, adminId;
const API = '/api/v1/plugins';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));

// "hello-sec": the example plugin without a tab of its own, with a section in "Zuhause"
function sectionOverrides() {
  const ui = JSON.parse(JSON.stringify(helloManifest.ui));
  ui.portal = { sections: [{ id: 'garden', tab: 'home', title: { de: 'Garten', en: 'Garden' }, order: 30 }, { id: 'garage', tab: 'car', title: 'Garage' }] };
  return { id: 'hello-sec', name: { de: 'Hallo Abschnitt', en: 'Hello section' }, ui };
}

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}
const kv = (id, key, value) => agent.post(`${API}/${id}/api/kv`).set('X-CSRF-Token', csrf).send({ key, value }).expect(200);
const viewer = () => ({ id: adminId, name: 'admin', role: 'admin', portal: true });

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  portal = require('../src/services/plugins/portal');
  manifest = require('../src/services/plugins/manifest');
  adminId = require('../src/db/connection').getDb().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  await install(helloPackage());
  await install(helloPackage({ overrides: sectionOverrides() }));
  assert.equal(await runtime.waitRunning('hello'), true);
  assert.equal(await runtime.waitRunning('hello-sec'), true);
});
after(async () => { await plugins.stop(); teardown(); });

describe('plugin.json ui.portal.sections', () => {
  const base = () => JSON.parse(JSON.stringify(helloManifest));
  it('sections of GateControl tabs are accepted; a portal entry needs a label or sections', () => {
    const m = base();
    m.ui.portal = { sections: [{ id: 'garden', tab: 'home', title: 'Garten' }] };
    const r = manifest.validate(m);
    assert.equal(r.ok, true, r.errors.join(', '));
    assert.deepEqual(r.manifest.ui.portal, { label: null, icon: 'M4 4h16v16H4z', sections: [{ id: 'garden', tab: 'home', title: { de: 'Garten', en: 'Garten' }, order: 100 }] });
    const bad = (portalUi) => { const x = base(); x.ui.portal = portalUi; return manifest.validate(x).ok; };
    assert.equal(bad({}), false, 'neither label nor sections');
    assert.equal(bad({ sections: [{ id: 'a', tab: 'net', title: 'x' }] }), false, 'not a tab that takes sections');
    assert.equal(bad({ sections: [{ id: 'A b', tab: 'home', title: 'x' }] }), false, 'id is a slug');
    assert.equal(bad({ sections: [{ id: 'a', tab: 'home', title: 'x' }, { id: 'a', tab: 'car', title: 'y' }] }), false, 'duplicate');
    assert.equal(bad({ sections: [{ id: 'a', tab: 'home', title: 'x', order: 1.5 }] }), false, 'order is an integer');
    assert.equal(bad({ label: 'Tab', sections: [{ id: 'a', tab: 'car', title: 'x', order: 5 }] }), true, 'tab and sections together');
  });
});

describe('sections in GateControl tabs', () => {
  it('contributions: own tabs and ordered sections per GateControl tab, for this viewer', async () => {
    const c = await portal.contributions(viewer(), 'en');
    assert.deepEqual(c.tabs.map((t) => t.key), ['plg-hello']);
    assert.deepEqual(c.sections.home.map((s) => [s.key, s.title, s.goto]), [['plg-hello-sec-garden', 'Garden', 'zuhause']]);
    assert.deepEqual(c.sections.car.map((s) => s.key), ['plg-hello-sec-garage']);
    assert.deepEqual(plugins.portalTabs('en').map((t) => t.id), ['hello'], 'a plugin with sections only has no tab of its own');
  });

  it('the portal shows the sections inside "Zuhause"/"Fahrzeug" — and hides the tab when no contributor has anything', async () => {
    let page = (await agent.get('/portal').expect(200)).text;
    assert.match(page, /id="tab-zuhause"/);
    assert.match(page, /id="pt-sec-plg-hello-sec-garden"[^>]*>\s*<iframe class="pt-plugin-frame" title="(?:Garten|Garden)" src="\/portal\/plugins\/hello-sec\/frame\?section=garden" sandbox="allow-scripts allow-forms"/);
    assert.match(page, /id="tab-fahrzeug"/);
    assert.match(page, /src="\/portal\/plugins\/hello-sec\/frame\?section=garage"/);
    assert.doesNotMatch(page, /id="tab-plg-hello-sec"/);
    assert.match(page, /\/js\/plugin-bridge\.js/);
    await kv('hello-sec', 'section-viewers', [999]);
    page = (await agent.get('/portal').expect(200)).text;
    assert.doesNotMatch(page, /id="tab-zuhause"/, 'nothing for this viewer → no "Zuhause" tab');
    assert.doesNotMatch(page, /pt-sec-plg-hello-sec/);
    await kv('hello-sec', 'section-viewers', null);
  });

  it('a section frame is rendered for its section only', async () => {
    const fr = await agent.get('/portal/plugins/hello-sec/frame?section=garden').expect(200);
    assert.match(fr.headers['content-security-policy'], /sandbox allow-scripts allow-forms/);
    assert.match(fr.text, /id="view">portal:/);
    await agent.get('/portal/plugins/hello-sec/frame?section=nope').expect(404);
    await agent.get('/portal/plugins/hello-sec/frame').expect(404); // no tab of its own
    await agent.get('/portal/plugins/hello/frame').expect(200);
  });
});

describe('Start tiles', () => {
  const start = () => agent.get('/api/v1/portal/plugins/start').expect(200);

  it('declarative tiles, sanitised and linked to the section / tab, with the viewer passed to the plugin', async () => {
    await kv('hello-sec', 'portal-tiles', [
      { section: 'garden', title: 'Lampe', value: 'An', state: 'on', icon: 'M4 12h16' },
      { section: 'garden', title: 'Temp', value: 21.5, unit: '°C', state: 'bogus', icon: '<script>' },
      { section: 'garage', title: '$viewer' },
      { section: 'unknown', title: 'dropped: not a section of this plugin' },
      { title: '' }, null, 'x',
      { title: 'T'.repeat(200) },
    ]);
    await kv('hello', 'portal-tiles', [{ title: 'Hallo', value: 3 }]);
    const r = await start();
    const by = (t) => r.body.tiles.find((x) => x.title === t);
    assert.deepEqual(by('Lampe'), { plugin: 'hello-sec', title: 'Lampe', value: 'An', unit: null, state: 'on', icon: 'M4 12h16', goto: 'zuhause', anchor: 'pt-sec-plg-hello-sec-garden', area: 'home' });
    assert.deepEqual([by('Temp').value, by('Temp').unit, by('Temp').state, by('Temp').icon], ['21.5', '°C', null, null]);
    assert.deepEqual([by(`viewer ${adminId}`).goto, by(`viewer ${adminId}`).anchor], ['fahrzeug', 'pt-sec-plg-hello-sec-garage']);
    assert.equal(r.body.tiles.filter((x) => x.plugin === 'hello-sec').length, 4);
    assert.ok(r.body.tiles.some((x) => x.plugin === 'hello-sec' && x.title.length === 60 && x.goto === 'zuhause'), 'no section → the first visible one, title capped');
    assert.deepEqual(by('Hallo'), { plugin: 'hello', title: 'Hallo', value: '3', unit: null, state: null, icon: null, goto: 'plg-hello', anchor: null, area: 'plg-hello' });
  });

  it('only for what the viewer may see', async () => {
    await kv('hello-sec', 'section-viewers', [999]);
    const r = await start();
    assert.deepEqual(r.body.tiles.map((x) => x.plugin), ['hello'], 'tiles of a hidden section are dropped');
    await kv('hello-sec', 'section-viewers', null);
  });

  it('a slow, throwing or garbage-answering plugin does not break Start', async () => {
    for (const mode of ['slow', 'throw', 'garbage']) {
      await kv('hello', 'portal-mode', mode);
      const t0 = Date.now();
      const r = await start();
      assert.ok(Date.now() - t0 < 4500, `${mode}: answered after the timeout, not after the plugin`);
      assert.ok(r.body.tiles.some((x) => x.title === 'Lampe'), `${mode}: the other plugin's tiles are there`);
      assert.ok(!r.body.tiles.some((x) => x.plugin === 'hello'), `${mode}: nothing from the misbehaving plugin`);
    }
    await kv('hello', 'portal-mode', null);
  });
});

describe('search', () => {
  const search = (q) => agent.get('/api/v1/portal/plugins/search').query({ q }).expect(200);

  it('declarative results of every plugin, linked to its section', async () => {
    await kv('hello-sec', 'portal-results', [{ title: 'Stehlampe', subtitle: 'Licht', section: 'garden' }, { title: 'Stehtisch', section: 'elsewhere' }, { title: 'Bad' }]);
    await kv('hello', 'portal-results', [{ title: 'Stehpult', subtitle: 'Hallo' }]);
    const r = await search('steh');
    assert.deepEqual(r.body.results.map((x) => [x.plugin, x.title, x.subtitle, x.goto, x.anchor]).sort(), [
      ['hello', 'Stehpult', 'Hallo', 'plg-hello', null],
      ['hello-sec', 'Stehlampe', 'Licht', 'zuhause', 'pt-sec-plg-hello-sec-garden'],
    ]);
    assert.deepEqual((await search('s')).body.results, [], 'at least two characters');
    assert.deepEqual((await search('x'.repeat(300))).body.results, []);
  });

  it('a slow plugin times out alone; a hidden section gives no results', async () => {
    await kv('hello', 'portal-mode', 'slow');
    const t0 = Date.now();
    const r = await search('steh');
    assert.ok(Date.now() - t0 < 4500);
    assert.deepEqual(r.body.results.map((x) => x.title), ['Stehlampe']);
    await kv('hello', 'portal-mode', null);
    await kv('hello-sec', 'section-viewers', [999]);
    assert.deepEqual((await search('steh')).body.results.map((x) => x.title), ['Stehpult']);
    await kv('hello-sec', 'section-viewers', null);
  });

  it('portal.js renders tiles and results itself (declarative, no plugin HTML)', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'portal.js'), 'utf8');
    assert.match(js, /\/api\/v1\/portal\/plugins\/start/);
    assert.match(js, /\/api\/v1\/portal\/plugins\/search\?q=' \+ encodeURIComponent/);
    assert.doesNotMatch(js, /\.innerHTML\s*=/);
  });
});
