'use strict';

// Since 1.188.0 (docs/plugins.md "plugin.json", "User interface"):
//   * ui.portal.profileSections — a plugin's sections on the viewer's own
//     profile in the portal ("Meine Geräte", below picture and colour), for a
//     signed-in person only (never a kiosk device or device trust);
//   * ui.settingsPage — one of the plugin's pages shown in its settings tab
//     (Einstellungen › Plugins › <plugin> › Einstellungen) instead of as a page tab;
//   * ui.camera — <iframe allow="camera *"> on the plugin's frames.
// Older hosts ignore the three keys (a plugin still installs there).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const frame = require('../src/services/plugins/frame');
const PUI = require('../public/js/plugins-ui.js');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

let agent, csrf, runtime, plugins, manifest, portal, adminId, inspected;
const API = '/api/v1/plugins';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

function profileOverrides() {
  const ui = clone(helloManifest.ui);
  ui.settingsPage = 'about';
  ui.camera = true;
  ui.portal = { label: { de: 'Hallo', en: 'Hello' }, icon: 'M4 12h16', profileSections: [{ id: 'me', title: { de: 'Mein Hallo', en: 'My hello' }, order: 20 }] };
  return { id: 'hello-prof', name: { de: 'Hallo Profil', en: 'Hello profile' }, ui };
}

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  return r.body;
}

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  manifest = require('../src/services/plugins/manifest');
  portal = require('../src/services/plugins/portal');
  adminId = require('../src/db/connection').getDb().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  inspected = await install(helloPackage({ overrides: profileOverrides() }));
  await install(helloPackage());
  assert.equal(await runtime.waitRunning('hello-prof'), true);
  assert.equal(await runtime.waitRunning('hello'), true);
});
after(async () => { await plugins.stop(); teardown(); });

describe('plugin.json', () => {
  const check = (mut) => { const m = clone(helloManifest); mut(m); return manifest.validate(m); };

  it('ui.settingsPage: one of the pages, never the first; default null', () => {
    const ok = check((m) => { m.ui.settingsPage = 'about'; });
    assert.equal(ok.ok, true, ok.errors.join(', '));
    assert.equal(ok.manifest.ui.settingsPage, 'about');
    assert.equal(check(() => {}).manifest.ui.settingsPage, null);
    for (const v of ['main', 'nope', 3, '']) assert.deepEqual(check((m) => { m.ui.settingsPage = v; }).errors, ['ui.settingsPage: invalid'], String(v));
  });

  it('ui.camera: a boolean, default false', () => {
    assert.equal(check((m) => { m.ui.camera = true; }).manifest.ui.camera, true);
    assert.equal(check(() => {}).manifest.ui.camera, false);
    assert.deepEqual(check((m) => { m.ui.camera = 'yes'; }).errors, ['ui.camera: invalid']);
  });

  it('ui.portal.profileSections: normalised to sections of the tab "profile"; ids shared with the other sections', () => {
    const r = check((m) => { m.ui.portal = { profileSections: [{ id: 'me', title: 'Ich' }] }; });
    assert.equal(r.ok, true, r.errors.join(', '));
    assert.deepEqual(r.manifest.ui.portal.sections, [{ id: 'me', tab: 'profile', title: { de: 'Ich', en: 'Ich' }, order: 100 }], 'a profile section alone is a portal entry');
    const both = check((m) => { m.ui.portal.sections = [{ id: 'garden', tab: 'home', title: 'Garten' }]; m.ui.portal.profileSections = [{ id: 'me', title: 'Ich', order: 5 }]; });
    assert.deepEqual(both.manifest.ui.portal.sections.map((s) => [s.id, s.tab, s.order]), [['garden', 'home', 100], ['me', 'profile', 5]]);
    // the first error is the one about profileSections (an invalid list also makes ui.portal invalid)
    const bad = (ps, sections) => check((m) => { m.ui.portal.profileSections = ps; if (sections) m.ui.portal.sections = sections; }).errors.slice(0, 1);
    assert.deepEqual(bad([{ id: 'me', title: 'x', tab: 'home' }]), ['ui.portal.profileSections: invalid'], 'no tab of its own');
    assert.deepEqual(bad([{ id: 'A b', title: 'x' }]), ['ui.portal.profileSections: invalid']);
    assert.deepEqual(bad([{ id: 'a', title: 'x' }, { id: 'b', title: 'x' }, { id: 'c', title: 'x' }, { id: 'd', title: 'x' }, { id: 'e', title: 'x' }]), ['ui.portal.profileSections: invalid'], 'at most 4');
    assert.deepEqual(bad([{ id: 'a', title: 'x' }, { id: 'a', title: 'y' }]), ['ui.portal.profileSections: duplicate']);
    assert.deepEqual(bad([{ id: 'garden', title: 'x' }], [{ id: 'garden', tab: 'home', title: 'Garten' }]), ['ui.portal.profileSections: duplicate']);
    assert.equal(check((m) => { m.ui.portal.sections = [{ id: 'x', tab: 'profile', title: 'x' }]; }).ok, false, '"profile" is no tab of ui.portal.sections');
  });
});

describe('the settings page and the camera', () => {
  it('the plugin view: the settings page is no page tab; allow carries the camera', () => {
    const v = plugins.list('de').find((p) => p.id === 'hello-prof');
    assert.deepEqual(v.pages.map((x) => x.id), ['main']);
    assert.deepEqual(v.settingsPage, { id: 'about', title: 'Über' });
    assert.equal(v.camera, true);
    assert.equal(v.allow, 'camera *');
    const plain = plugins.list('de').find((p) => p.id === 'hello');
    assert.deepEqual([plain.settingsPage, plain.camera, plain.allow, plain.pages.length], [null, false, '', 2]);
    assert.equal(frame.allowAttr({ media: true, geolocation: true, camera: true }), 'microphone *; geolocation *; camera *');
    assert.equal(frame.allowAttr({}), '');
  });

  it('the plugin page: no tab for the settings page, the frame may use the camera; the settings page frame is served', async () => {
    const page = (await agent.get('/plugins/hello-prof').expect(200)).text;
    assert.doesNotMatch(page, /class="pg-ptab"/, 'one page left: no page tabs');
    assert.match(/<iframe class="pg-frame"[^>]*>/.exec(page)[0], /referrerpolicy="no-referrer" allow="camera \*"/);
    const f = await agent.get('/plugins/hello-prof/frame/about').expect(200);
    assert.match(f.text, /<p id="view">page:about<\/p>/);
    assert.match((await agent.get('/plugins/hello').expect(200)).text, /class="pg-ptab"/, 'other plugins keep their tabs');
  });

  it('the plugin area loads the bridge, the settings tab adds the frame and attaches it', async () => {
    const area = (await agent.get('/settings/plugins/manage/hello-prof').expect(200)).text;
    assert.match(area, /\/js\/plugin-bridge\.js/);
    const bridge = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'plugin-bridge.js'), 'utf8');
    assert.match(bridge, /window\.GCPluginBridge = Object\.freeze\(\{ attach \}\)/);
    assert.match(bridge, /if \(!frame \|\| frame\.__gcBridge\) return;/, 'a frame is attached once');
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'plugins-page.js'), 'utf8');
    assert.match(js, /function settingsFrame\(p\)/);
    assert.match(js, /if \(p\.settingsPage && p\.status === 'running'\) panel\.appendChild\(settingsFrame\(p\)\);/);
    assert.match(js, /'\/plugins\/' \+ enc\(p\.id\) \+ '\/frame\/' \+ enc\(p\.settingsPage\.id\)/);
  });

  it('the install dialog names the camera (sensitive), in German and English', () => {
    assert.equal(inspected.plugin.permissions.camera, true);
    for (const t of [de, en]) {
      const rows = PUI.permRows(inspected.plugin.permissions, (k, p) => {
        assert.ok(t[k], 'missing ' + k);
        return t[k].replace(/\{\{(\w+)\}\}/g, (_, x) => (p && p[x] != null ? String(p[x]) : ''));
      });
      assert.ok(rows.some((x) => x.label === t['plugins.perm.camera'] && x.value === t['plugins.perm.camera_on']));
      assert.ok(rows.some((x) => x.value.includes(t['plugins.portal_tab.profile'])), 'the profile section is listed');
      assert.equal(new Set(rows.map((x) => x.label)).size, rows.length);
    }
    assert.ok(PUI.sensitivePerms(inspected.plugin.permissions).includes('plugins.perm.camera'));
  });
});

describe('profile sections in the portal', () => {
  const viewer = (extra) => ({ id: adminId, name: 'admin', role: 'admin', portal: true, loggedIn: true, ...extra });

  it('contributions: only for a signed-in person, never a kiosk device or device trust', async () => {
    const c = await portal.contributions(viewer(), 'de');
    assert.deepEqual(c.sections.profile.map((s) => [s.key, s.title, s.goto, s.allow]), [['plg-hello-prof-me', 'Mein Hallo', 'geraete', 'camera *']]);
    assert.deepEqual(c.tabs.find((x) => x.id === 'hello-prof').allow, 'camera *');
    assert.deepEqual((await portal.contributions(viewer({ loggedIn: false }), 'de')).sections.profile, []);
    assert.deepEqual((await portal.contributions(viewer({ kiosk: true }), 'de')).sections.profile, []);
    assert.equal(portal.profileViewer(viewer()), true);
    assert.equal(portal.profileViewer(viewer({ kiosk: true })), false);
    assert.equal(portal.profileViewer(null), false);
  });

  it('the portal shows the section on "Meine Geräte", below picture and colour, with the camera', async () => {
    const page = (await agent.get('/portal').expect(200)).text;
    const geraete = page.slice(page.indexOf('id="panel-geraete"'));
    const i = geraete.indexOf('id="pt-sec-plg-hello-prof-me"');
    assert.ok(i > 0, 'in the panel "Meine Geräte"');
    assert.ok(geraete.indexOf('id="pt-c-look"') < i, 'after the own picture and colour');
    assert.match(geraete, /<section class="pt-plugin-section pt-narrow" id="pt-sec-plg-hello-prof-me"[^>]*>\s*<iframe class="pt-plugin-frame" title="(?:Mein Hallo|My hello)" src="\/portal\/plugins\/hello-prof\/frame\?section=me" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" loading="lazy" allow="camera \*"/);
    assert.match(page, /src="\/portal\/plugins\/hello-prof\/frame" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" loading="lazy" allow="camera \*"/, 'its own tab too');
    const f = await agent.get('/portal/plugins/hello-prof/frame?section=me').expect(200);
    assert.match(f.text, /<p id="view">portal:<\/p>/);
  });
});
