'use strict';

// Since 1.225.0 (docs/plugins.md "plugin.json", "User interface"):
//   ui.settingsPages — up to 4 of the plugin's pages (never the first, never
//   ui.settingsPage) as tabs of their own under Einstellungen › Plugins ›
//   <plugin>, right after "Einstellungen", with ?tab=<page> and
//   GC.navigate('<page>'); no longer page tabs on the plugin's own page.
// Older hosts ignore unknown keys of `ui` (a plugin still installs there and
// shows those pages as page tabs).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const PUI = require('../public/js/plugins-ui.js');

let agent, csrf, runtime, plugins, manifest;
const API = '/api/v1/plugins';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const page = (id, de, en) => ({ id, title: { de, en } });

function tabsUi() {
  const ui = clone(helloManifest.ui);
  ui.pages = [page('main', 'Hallo', 'Hello'), page('about', 'Über', 'About'), page('resources', 'Ressourcen', 'Resources'), page('shared', 'Geteilte Postfächer', 'Shared mailboxes')];
  ui.settingsPage = 'about';
  ui.settingsPages = ['resources', 'shared'];
  return ui;
}

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  manifest = require('../src/services/plugins/manifest');
  await install(helloPackage({ overrides: { id: 'hello-tabs', name: { de: 'Hallo Reiter', en: 'Hello tabs' }, ui: tabsUi() } }));
  assert.equal(await runtime.waitRunning('hello-tabs'), true);
});
after(async () => { await plugins.stop(); teardown(); });

describe('plugin.json ui.settingsPages', () => {
  const check = (mut) => { const m = clone(helloManifest); m.ui = tabsUi(); mut(m); return manifest.validate(m); };

  it('pages of ui.pages, never the first nor ui.settingsPage; default []', () => {
    const ok = check(() => {});
    assert.equal(ok.ok, true, ok.errors.join(', '));
    assert.deepEqual(ok.manifest.ui.settingsPages, ['resources', 'shared']);
    assert.deepEqual(manifest.validate(clone(helloManifest)).manifest.ui.settingsPages, []);
    assert.equal(check((m) => { delete m.ui.settingsPage; m.ui.settingsPages = ['about', 'resources']; }).ok, true, 'without a settings page');
    for (const v of [['main'], ['nope'], ['about'], ['resources', 'resources'], 'resources', [3], {}, ['about', 'resources', 'shared', 'x', 'y']]) {
      assert.deepEqual(check((m) => { m.ui.settingsPages = v; }).errors, ['ui.settingsPages: invalid'], JSON.stringify(v));
    }
    assert.equal(manifest.SETTINGS_PAGES_MAX, 4);
  });

  it('an id of the area\'s own tabs is refused (?tab=<id>)', () => {
    const r = check((m) => { m.ui.pages.push(page('log', 'Log', 'Log')); m.ui.settingsPages = ['log']; });
    assert.deepEqual(r.errors, ['ui.settingsPages: reserved']);
    assert.deepEqual([...manifest.SETTINGS_TAB_IDS], PUI.MANAGE_TABS, 'the same ids as the plugin area');
  });

  it('unknown keys of `ui` are ignored — what an older host does with ui.settingsPages', () => {
    const m = clone(helloManifest);
    m.ui.futureKey = ['main'];
    const r = manifest.validate(m);
    assert.equal(r.ok, true, r.errors.join(', '));
    assert.equal(r.manifest.ui.futureKey, undefined, 'not stored');
  });
});

describe('the plugin view and the plugin page', () => {
  it('settings tab pages are no page tabs; the view names them with their titles', () => {
    const v = plugins.list('de').find((p) => p.id === 'hello-tabs');
    assert.deepEqual(v.pages.map((x) => x.id), ['main']);
    assert.deepEqual(v.settingsPage, { id: 'about', title: 'Über' });
    assert.deepEqual(v.settingsPages, [{ id: 'resources', title: 'Ressourcen' }, { id: 'shared', title: 'Geteilte Postfächer' }]);
    assert.deepEqual(plugins.list('en').find((p) => p.id === 'hello-tabs').settingsPages.map((x) => x.title), ['Resources', 'Shared mailboxes']);
    assert.deepEqual(plugins.settingsPageIds({ ui: { settingsPage: 'about', settingsPages: ['resources'] } }), new Set(['about', 'resources']));
    assert.deepEqual(plugins.settingsPageIds({ ui: {} }), new Set(), 'a manifest stored by an older host');
  });

  it('the plugin page: the frame knows the settings tab pages; their old address leads to the tab', async () => {
    const html = (await agent.get('/plugins/hello-tabs').expect(200)).text;
    const frame = /<iframe class="pg-frame"[^>]*>/.exec(html)[0];
    assert.match(frame, /data-plugin-pages="\[&quot;main&quot;\]"/);
    assert.match(frame, /data-plugin-settings-pages="\[&quot;resources&quot;,&quot;shared&quot;\]"/);
    assert.doesNotMatch(html, /class="pg-ptab"/, 'one page left: no page tabs');
    const r = await agent.get('/plugins/hello-tabs/resources').expect(302);
    assert.equal(r.headers.location, '/settings/plugins/manage/hello-tabs?tab=resources');
    await agent.get('/plugins/hello-tabs/nope').expect(404);
  });

  it('the tab\'s frame is the plugin\'s admin page frame (same route, view "page")', async () => {
    const f = await agent.get('/plugins/hello-tabs/frame/resources').expect(200);
    assert.match(f.text, /<p id="view">page:resources<\/p>/);
    assert.match(String(f.headers['content-security-policy'] || ''), /sandbox/);
  });
});

describe('tabs of the plugin area (plugins-ui.js)', () => {
  const p = { status: 'running', settingsPages: [{ id: 'resources', title: 'Ressourcen' }, { id: 'shared', title: 'Geteilte Postfächer' }] };

  it('after "settings", only while the plugin runs; versions only for a catalogue plugin', () => {
    assert.deepEqual(PUI.manageTabs(p, true).map((x) => x.id), ['overview', 'settings', 'resources', 'shared', 'perms', 'license', 'log', 'versions']);
    assert.deepEqual(PUI.manageTabs(p, true)[2], { id: 'resources', page: { id: 'resources', title: 'Ressourcen' } });
    assert.deepEqual(PUI.manageTabs(p, false).map((x) => x.id), ['overview', 'settings', 'resources', 'shared', 'perms', 'license', 'log']);
    const areaTabs = PUI.MANAGE_TABS.filter((x) => x !== 'handbook');
    for (const status of ['starting', 'crashed', 'disabled', 'blocked']) {
      assert.deepEqual(PUI.manageTabs({ ...p, status }, true).map((x) => x.id), areaTabs, status);
    }
    assert.deepEqual(PUI.manageTabs({ status: 'running' }, true).map((x) => x.id), areaTabs, 'an older view without settingsPages');
    assert.deepEqual(PUI.manageTabs({ status: 'running', settingsPages: [{ id: 'log', title: 'x' }, { id: 'a', title: 'A' }, { id: 'a', title: 'A' }] }, false).map((x) => x.id),
      ['overview', 'settings', 'a', 'perms', 'license', 'log'], 'never an area tab twice');
  });

  it('"Handbuch" last, only for a plugin with a handbook (plugin.json handbook), whatever its state', () => {
    assert.deepEqual(PUI.manageTabs({ ...p, handbook: true }, true).map((x) => x.id), ['overview', 'settings', 'resources', 'shared', 'perms', 'license', 'log', 'versions', 'handbook']);
    assert.deepEqual(PUI.manageTabs({ status: 'crashed', handbook: true }, false).map((x) => x.id), ['overview', 'settings', 'perms', 'license', 'log', 'handbook']);
    assert.equal(PUI.manageTab(PUI.manageTabs({ ...p, handbook: true }, false), 'handbook'), 'handbook');
    assert.equal(PUI.manageTab(PUI.manageTabs(p, false), 'handbook'), 'overview', 'no handbook: no tab');
  });

  it('?tab=: a tab the plugin has, else the overview', () => {
    const tabs = PUI.manageTabs(p, false);
    assert.equal(PUI.manageTab(tabs, 'resources'), 'resources');
    assert.equal(PUI.manageTab(tabs, 'perms'), 'perms');
    assert.equal(PUI.manageTab(tabs, 'versions'), 'overview', 'not in the catalogue');
    assert.equal(PUI.manageTab(PUI.manageTabs({ ...p, status: 'crashed' }, false), 'resources'), 'overview');
    assert.equal(PUI.manageTab(tabs, null), 'overview');
  });

  it('plugins-page.js builds the tabs from manageTabs and shows a page as its own frame', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'plugins-page.js'), 'utf8');
    assert.doesNotMatch(js, /const TABS = \[/, 'no fixed list of tabs any more');
    assert.match(js, /const tabs = P\.manageTabs\(p, !!c\);/);
    assert.match(js, /const cur = P\.manageTab\(tabs, mtab\);/);
    assert.match(js, /panel\.appendChild\(pageFrame\(p, page, 'pg-page-frame', 'pgx-page-frame'\)\);/);
    assert.match(js, /'data-plugin-settings-pages': JSON\.stringify\(\(p\.settingsPages \|\| \[\]\)\.map\(\(x\) => x\.id\)\)/);
    assert.match(js, /sandbox: 'allow-scripts allow-forms'/, 'the same sandbox as every plugin frame');
    assert.match(js, /document\.addEventListener\('gc:plugin-tab'/);
  });

  it('plugin-bridge.js: GC.navigate to a settings tab page and GC.openSettings open the tab (admin frames only)', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'plugin-bridge.js'), 'utf8');
    assert.match(js, /frame\.getAttribute\('data-plugin-settings-pages'\)/);
    assert.match(js, /new CustomEvent\('gc:plugin-tab', \{ detail: \{ plugin: pluginId, tab, handled: false \} \}\)/);
    assert.match(js, /window\.location\.assign\('\/settings\/plugins\/manage\/' \+ encodeURIComponent\(pluginId\) \+ '\?tab=' \+ encodeURIComponent\(tab\)\)/);
    assert.match(js, /if \(!pluginId \|\| base\.includes\('\/portal\/'\)\) \{ \/\* admin frames only \*\/ \}\s*else if \(tab\) openPluginTab\(pluginId, tab\);/);
  });
});
