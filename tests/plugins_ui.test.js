'use strict';

// Plugin UI (docs/plugins.md): Settings → Plugins, the sidebar section, a
// plugin's page with its sandboxed frame, the "derzeit deaktiviert" page,
// portal tabs, and the pure helpers of public/js/plugins-ui.js.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { helloPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const { withoutScripts } = require('./helpers/html');
const PUI = require('../public/js/plugins-ui.js');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

let agent, csrf, runtime, plugins;
const API = '/api/v1/plugins';

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  // German UI (the mockups' texts)
  require('../src/db/connection').getDb().prepare("UPDATE users SET language = 'de' WHERE username = 'admin'").run();
});
after(async () => { await plugins.stop(); teardown(); });

function section(html, id) {
  const a = html.indexOf(`<section class="st-section" data-section="${id}"`);
  return html.slice(a, html.indexOf('<section class="st-section"', a + 10));
}

describe('the plugin area', () => {
  it('Settings → Plugins points to the plugin area; old links are forwarded', async () => {
    const html = (await agent.get('/settings').expect(200)).text;
    const s = section(withoutScripts(html), 'plugins');
    assert.match(s, /id="pg-moved-card"/);
    assert.match(s, /<a class="st-btn st-btn-primary" href="\/settings\/plugins" id="pg-to-area">/);
    assert.doesNotMatch(s, /\b(plugins|st)\.[a-z_]+\.[a-z_.]+/, 'no raw i18n keys');
    assert.match(withoutScripts(html), /class="st-nav-item" data-section="plugins"/);
    assert.match(html, /<script src="\/js\/settings-plugins\.js[^"]*"><\/script>\s*<script src="\/js\/settings\.js/);
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'settings-plugins.js'), 'utf8');
    assert.match(js, /location\.hash === '#plugins'/);
    assert.match(js, /BASE = '\/settings\/plugins'/);
    assert.match(js, /BASE \+ '\/manage\/' \+ encodeURIComponent\(plugin\)/);
    assert.match(js, /BASE \+ '\/catalog\/' \+ encodeURIComponent\(install\)/);
    assert.match(js, /\.st-nav-item\[data-section="plugins"\]/, 'the settings entry opens the plugin page');
  });
  const B = '/settings/plugins';
  for (const [url, view, tab] of [[B, 'installed', 'installed'], [B + '/catalog', 'catalog', 'catalog'], [B + '/updates', 'updates', 'updates'],
    [B + '/licenses', 'licenses', 'licenses'], [B + '/security', 'security', 'security'], [B + '/log', 'log', 'log'], [B + '/catalog/gatecontrol-familie', 'catalogItem', null]]) {
    it(`${url}: the ${view} view with its tab — no raw keys`, async () => {
      const html = (await agent.get(url).expect(200)).text;
      const page = withoutScripts(html);
      assert.match(page, new RegExp(`<div class="pgx" id="pgx" data-view="${view}"`));
      if (tab) assert.match(page, new RegExp(`<a class="pgx-sl" href="[^"]+" data-tab="${tab}" aria-current="page">`));
      else assert.doesNotMatch(page, /class="pgx-side"/, 'one plugin: no side column');
      assert.match(page, /class="nav-item active" id="nav-settings"/, 'under Einstellungen');
      assert.match(page, /<h1 class="page-crumb">Einstellungen \/ Plugins<\/h1>/);
      assert.doesNotMatch(page, /\b(plugins|nav)\.[a-z_]+\.[a-z_.]+/, 'no raw i18n keys');
      assert.match(html, /<script src="\/js\/plugins-ui\.js[^"]*"><\/script>\s*<script src="\/js\/plugins-page\.js/);
      const island = JSON.parse(/<script type="application\/json" id="pgx-i18n"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1]);
      assert.ok(island['plugins.x.attention'] && island['plugins.lic.state.valid'] && island['common.cancel']);
    });
  }
  it('manage/<id> of a plugin that is not installed is a 404; members are sent to their profile', async () => {
    await agent.get('/settings/plugins/manage/not-installed').expect(404);
    await agent.get('/settings/plugins/catalog/..%2Fx').expect(404);
  });
  it('the old addresses (/plugins, /plugins/catalog …) lead to the same view under Einstellungen › Plugins', async () => {
    for (const [from, to] of [['/plugins', '/settings/plugins'], ['/plugins/catalog?cat=home', '/settings/plugins/catalog?cat=home'], ['/plugins/updates', '/settings/plugins/updates'],
      ['/plugins/licenses', '/settings/plugins/licenses'], ['/plugins/security', '/settings/plugins/security'], ['/plugins/catalog/gatecontrol-familie', '/settings/plugins/catalog/gatecontrol-familie'],
      ['/plugins/manage/hello?tab=log', '/settings/plugins/manage/hello?tab=log']]) {
      assert.equal((await agent.get(from).expect(302)).headers.location, to, from);
    }
    await agent.get('/plugins/manage/..%2Fx').expect(404);
  });
  it('the page scripts build the DOM without innerHTML', () => {
    const src = ['settings-plugins.js', 'plugins-page.js', 'plugin-bridge.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8')).join('\n');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
  it('every string the page script asks for exists in both languages', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'plugins-page.js'), 'utf8');
    const keys = new Set([...src.matchAll(/t\('((?:plugins|common|nav)\.[a-z0-9_.]*[a-z0-9])'/g)].map((m) => m[1]));
    assert.ok(keys.size > 150);
    for (const l of ['de', 'en']) {
      const t = require(`../src/i18n/${l}.json`);
      for (const k of keys) assert.ok(t[k], `${l}: ${k}`);
    }
  });
  it('the list API carries what the cards need', async () => {
    const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(helloPackage()).expect(200);
    await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
    assert.equal(await runtime.waitRunning('hello'), true);
    const p = (await agent.get(API).expect(200)).body.plugins[0];
    for (const k of ['id', 'name', 'names', 'version', 'publisher', 'verified', 'status', 'reason', 'license', 'permissions', 'nav', 'pages', 'portal', 'installedAt']) assert.ok(k in p, k);
    assert.equal(p.name, 'Hallo Welt');
    assert.deepEqual(PUI.statusChip(p), { tone: 'good', key: 'plugins.state.running' });
  });
});

describe('sidebar, plugin page, frame', () => {
  it('the sidebar lists the plugin under "Integrationen"', async () => {
    const html = withoutScripts((await agent.get('/dashboard').expect(200)).text);
    assert.match(html, /<div class="nav-section-label">Integrationen<\/div>\s*<a href="\/plugins\/hello" class="nav-item" data-plugin-nav="hello">/);
    assert.ok(!html.includes('>Plugins</div>'), 'no separate "Plugins" group');
  });
  it('the page embeds the plugin in a sandboxed frame (no allow-same-origin)', async () => {
    const html = withoutScripts((await agent.get('/plugins/hello').expect(200)).text);
    const frame = /<iframe class="pg-frame"[^>]*>/.exec(html)[0];
    assert.match(frame, /sandbox="allow-scripts allow-forms"/);
    assert.doesNotMatch(frame, /allow-same-origin|allow-top-navigation|allow-popups/);
    assert.match(frame, /src="\/plugins\/hello\/frame\/main"/);
    assert.match(frame, /data-plugin-api="\/api\/v1\/plugins\/hello\/api\/"/);
    assert.match(html, /aria-current="page">Hallo<\/a>/, 'page tabs');
    await agent.get('/plugins/hello/nope').expect(404);
    await agent.get('/plugins/not-installed').expect(404);
  });
  it('the frame document: plugin HTML under a sandbox CSP, rendered for the user', async () => {
    const r = await agent.get('/plugins/hello/frame/about').expect(200);
    const csp = r.headers['content-security-policy'];
    assert.match(csp, /sandbox allow-scripts allow-forms/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.match(r.text, /<h1 id="hello">Hallo (admin|Administrator)<\/h1>/);
    assert.match(r.text, /<p id="view">page:about<\/p>/);
    assert.match(r.text, /window\.GC = Object\.freeze/);
  });
  it('a switched-off plugin: greyed nav entry "aus" and the "derzeit deaktiviert" page', async () => {
    await agent.post(API + '/hello/disable').set('X-CSRF-Token', csrf).send({}).expect(200);
    const dash = withoutScripts((await agent.get('/dashboard').expect(200)).text);
    assert.match(dash, /class="nav-item nav-item-off" data-plugin-nav="hello">[\s\S]*?<span class="nav-tag-off">aus<\/span>/);
    const page = withoutScripts((await agent.get('/plugins/hello').expect(200)).text);
    assert.doesNotMatch(page, /<iframe/);
    assert.match(page, /id="pg-off" data-reason="disabled"/);
    assert.ok(page.includes('Hallo Welt ist derzeit deaktiviert'));
    assert.ok(page.includes('Deine Daten sind gespeichert.'));
    assert.match(page, /href="\/settings\/plugins\/manage\/hello"/);
    const fr = await agent.get('/plugins/hello/frame/main').expect(503);
    assert.match(fr.headers['content-security-policy'], /sandbox/);
    await agent.post(API + '/hello/enable').set('X-CSRF-Token', csrf).send({}).expect(200);
    assert.equal(await runtime.waitRunning('hello'), true);
  });
  it('portal: running plugins with the portal permission get a tab', () => {
    assert.deepEqual(plugins.portalTabs('en'), [{ id: 'hello', key: 'plg-hello', label: 'Hello', icon: 'M4 12h16' }]);
    const tpl = fs.readFileSync(path.join(__dirname, '..', 'templates', 'portal', 'portal.njk'), 'utf8');
    // popups only for ui.maps plugins (docs/plugins.md "Maps")
    assert.match(tpl, /src="\/portal\/plugins\/\{\{ pt\.id \}\}\/frame" sandbox="allow-scripts allow-forms\{% if pt\.maps %\} allow-popups allow-popups-to-escape-sandbox\{% endif %\}\{% if pt\.media %\} allow-downloads\{% endif %\}"/);
  });
});

describe('frame bridge → plugin API', () => {
  function runBridge() {
    const vm = require('node:vm');
    const calls = [];
    const replies = [];
    const handlers = {};
    const attrs = { 'data-plugin-api': '/api/v1/plugins/hello/api/', 'data-plugin-id': 'hello', 'data-plugin-pages': '[]' };
    const frame = { contentWindow: { postMessage: (m) => replies.push(m) }, getAttribute: (k) => attrs[k] || null, addEventListener() {}, style: {} };
    const ctx = {
      window: { GC: { csrfToken: 'tok' }, addEventListener: (type, fn) => { handlers[type] = fn; } },
      document: { readyState: 'complete', documentElement: { getAttribute: () => 'dark' }, querySelectorAll: () => [frame], getElementById: () => null },
      MutationObserver: class { observe() {} },
      fetch: async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'plugin-bridge.js'), 'utf8'), ctx);
    const send = async (data) => {
      handlers.message({ source: frame.contentWindow, origin: 'null', data: { type: 'gc-call', id: 1, ...data } });
      await new Promise((r) => setImmediate(r));
    };
    return { calls, replies, send };
  }

  it('a call without a body sends no body (the strict JSON parser rejects a bare null)', async () => {
    const b = runBridge();
    await b.send({ method: 'POST', path: 'sync' });
    assert.equal(b.calls.length, 1);
    assert.equal(b.calls[0].url, '/api/v1/plugins/hello/api/sync');
    assert.equal(b.calls[0].opts.body, undefined);
    assert.equal(b.calls[0].opts.headers['Content-Type'], undefined);
    assert.equal(b.calls[0].opts.headers['X-CSRF-Token'], 'tok');
    await b.send({ method: 'POST', path: 'save', body: { a: 1 } });
    assert.equal(b.calls[1].opts.body, '{"a":1}');
    assert.equal(b.calls[1].opts.headers['Content-Type'], 'application/json');
  });
  it('a POST without a body reaches the plugin', async () => {
    const r = await agent.post(API + '/hello/api/ping').set('X-CSRF-Token', csrf).expect(200);
    assert.equal(r.body.method, 'POST');
  });
  it('a malformed JSON body is a 400, not an internal server error', async () => {
    const r = await agent.post(API + '/hello/api/ping').set('X-CSRF-Token', csrf).set('Content-Type', 'application/json').send('null').expect(400);
    assert.equal(r.body.code, 'invalid_json');
    assert.notEqual(r.body.error, 'Internal server error');
  });
});

describe('plugins-ui helpers', () => {
  const t = (k, p) => {
    let s = de[k] || k;
    for (const [a, b] of Object.entries(p || {})) s = s.split('{{' + a + '}}').join(String(b));
    return s;
  };
  it('permission rows in human terms (install step "Berechtigungen")', () => {
    const rows = PUI.permRows({
      network: { internet: ['identity.vwgroup.io', 'mysmob.api.connect.skoda-auto.cz'],
        homeTargets: [{ id: 'gateway', label: 'deCONZ-Gateway', protocols: ['http'] }], discovery: { udp: ['6445', '20086'] } },
      storage: true, users: true, pages: ['Fahrzeuge'], portalTab: 'Fahrzeug', settings: 3, background: 300, notify: false,
    }, t);
    const m = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    assert.equal(m.Internet, 'identity.vwgroup.io, mysmob.api.connect.skoda-auto.cz');
    assert.equal(m.Heimnetz, '1 Ziel, das du nach der Installation zuweist: deCONZ-Gateway (HTTP)');
    assert.equal(m['Lokale Suche'], 'Geräte im lokalen Netz suchen (UDP 6445, 20086) – nur wenn du es erlaubst');
    assert.equal(m.Hintergrund, 'läuft alle 300 Sekunden');
    assert.equal(PUI.protoText('udp:6445,20086'), 'UDP 6445, 20086');
  });
  it('every state, check and reason the server can send has a text in both languages', () => {
    const keys = [];
    for (const s of ['running', 'starting', 'crashed', 'disabled', 'unsigned', 'incompatible', 'broken']) keys.push('plugins.state.' + s);
    for (const s of ['valid', 'not_required', 'expiring', 'unreachable', 'unreachable_new', 'grace_over', 'missing', 'expired', 'invalid', 'bound_elsewhere', 'wrong_plugin']) keys.push('plugins.lic.state.' + s);
    for (const c of ['signature.trusted', 'signature.untrusted', 'signature.unsigned', 'signature.tampered', 'integrity.unchanged', 'compatibility.compatible', 'compatibility.incompatible',
      'existing.new', 'existing.update', 'existing.reinstall', 'existing.downgrade', 'existing.signed_to_unsigned', 'data.kept_data', 'manifest.invalid', 'migrations.invalid', 'license.server_missing']) {
      const k = PUI.checkKeys({ key: c.split('.')[0], code: c.split('.')[1] });
      keys.push(k.title, k.detail);
    }
    for (const r of ['disabled', 'license', 'unsigned', 'incompatible', 'files_missing', 'broken', 'crashed', 'starting']) keys.push('plugins.reason.' + r, 'plugins.page.off_reason.' + r);
    for (const k of keys) assert.ok(de[k] && en[k], k);
  });
  it('wipe confirmation: the plugin name in either language', () => {
    const p = { name: 'Hallo Welt', names: { de: 'Hallo Welt', en: 'Hello World' } };
    assert.equal(PUI.wipeConfirmed(p, ' Hello World '), true);
    assert.equal(PUI.wipeConfirmed(p, 'hallo welt'), false);
    assert.equal(PUI.fmtBytes(1536), '1.5 KB');
  });
});

describe('plugin area helpers (plugins-ui.js)', () => {
  const ps = [
    { id: 'a', name: 'Familie', status: 'running', category: 'family' },
    { id: 'b', name: 'Klimaanlage', status: 'crashed', process: { lastError: 'x' } },
    { id: 'c', name: 'NAS', status: 'blocked', reason: 'license', license: { required: true, state: 'missing' } },
    { id: 'd', name: 'Tür', status: 'disabled' },
    { id: 'e', name: 'Fahrzeuge', status: 'running', license: { required: true, state: 'expiring', expiresAt: '2026-10-28' } },
  ];
  it('attention: problems per plugin, expiring licences, one entry for all updates', () => {
    assert.deepEqual(PUI.attention(ps, [{ id: 'a', state: 'update' }, { id: 'x', state: 'installed' }]), [
      { kind: 'crashed', id: 'b' }, { kind: 'license', id: 'c' }, { kind: 'expiring', id: 'e' }, { kind: 'updates', ids: ['a'] }]);
    assert.deepEqual(PUI.attention([], []), []);
  });
  it('filterInstalled', () => {
    assert.deepEqual(PUI.filterInstalled(ps, 'active').map((p) => p.id), ['a', 'e']);
    assert.deepEqual(PUI.filterInstalled(ps, 'problems').map((p) => p.id), ['b', 'c', 'e']);
    assert.deepEqual(PUI.filterInstalled(ps, 'off').map((p) => p.id), ['d']);
    assert.equal(PUI.filterInstalled(ps, 'all').length, 5);
  });
  it('matches: words in name, summary and keywords, without accents and case', () => {
    const it2 = { id: 'gatecontrol-door', name: 'Tür & Kamera', summary: 'Nuki und Ring', keywords: ['klingel'] };
    assert.equal(PUI.matches(it2, 'tur KLIN'), true);
    assert.equal(PUI.matches(it2, 'ring'), true);
    assert.equal(PUI.matches(it2, 'nas'), false);
    assert.equal(PUI.matches(it2, '  '), true);
  });
  it('groupByCategory keeps the display order and leaves empty groups out', () => {
    const g = PUI.groupByCategory([{ id: 'x', category: 'infrastructure' }, { id: 'y' }, { id: 'z', category: 'family' }], (i) => i);
    assert.deepEqual(g.map((x) => [x.category, x.items.map((i) => i.id)]), [['family', ['z']], ['infrastructure', ['x']], ['other', ['y']]]);
  });
  it('sortCatalog: recommended / recent / name', () => {
    const items = [
      { id: 'a', name: 'B', state: 'installed', latest: { publishedAt: '2026-10-01' } },
      { id: 'b', name: 'A', state: 'not_installed', latest: { publishedAt: '2026-09-01' } },
      { id: 'c', name: 'C', state: 'update', latest: { publishedAt: '2026-10-10' } },
    ];
    assert.deepEqual(PUI.sortCatalog(items, 'recommended').map((x) => x.id), ['b', 'c', 'a']);
    assert.deepEqual(PUI.sortCatalog(items, 'recent').map((x) => x.id), ['c', 'a', 'b']);
    assert.deepEqual(PUI.sortCatalog(items, 'name').map((x) => x.id), ['b', 'a', 'c']);
  });
  it('updateKind, iconPath, categoryOf', () => {
    assert.deepEqual([PUI.updateKind('1.4.2', '1.4.3'), PUI.updateKind('1.4.2', '1.5.0'), PUI.updateKind('1.4.2', '2.0.0'), PUI.updateKind('x', '1.0.0')], ['patch', 'minor', 'major', 'major']);
    assert.equal(PUI.iconPath({ icon: 'car' }, null), PUI.ICON_PATHS.car);
    assert.equal(PUI.iconPath({ icon: 'unknown' }, { nav: { icon: 'M1 1' } }), 'M1 1');
    assert.equal(PUI.iconPath(null, null), PUI.ICON_PATHS.puzzle);
    assert.equal(PUI.categoryOf({ category: 'weapons' }), 'other');
  });
  it('noteLines: CHANGELOG markdown as plain lines', () => {
    assert.deepEqual(PUI.noteLines('Braucht **GC ≥ 1.169**.\n- **Behoben:** a\n  - `dings` [Link](https://x)\n    weiter\n## Kopf\n\n- b'), [
      { kind: 'p', level: 0, text: 'Braucht GC ≥ 1.169.' }, { kind: 'li', level: 0, text: 'Behoben: a' },
      { kind: 'li', level: 1, text: 'dings Link weiter' }, { kind: 'li', level: 0, text: 'b' }]);
    assert.equal(PUI.noteLines('- a\n- b\n- c', 2).length, 2);
  });
  it('sensitivePerms', () => {
    assert.deepEqual(PUI.sensitivePerms({ network: { internet: [], homeTargets: [{}] }, actions: true, criticalTopics: ['x'] }),
      ['plugins.perm.lan', 'plugins.perm.actions', 'plugins.perm.notify_critical']);
    assert.deepEqual(PUI.sensitivePerms(null), []);
  });
});
