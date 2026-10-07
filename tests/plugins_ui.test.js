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

describe('Settings → Plugins', () => {
  it('renders the section: upload, list, security switch — no raw keys', async () => {
    const html = (await agent.get('/settings').expect(200)).text;
    const s = section(withoutScripts(html), 'plugins');
    assert.match(s, /id="pg-drop"/);
    assert.match(s, /<input type="file" id="pg-file"[^>]*accept=".gcplugin/);
    assert.match(s, /id="pg-grid"/);
    assert.match(s, /role="switch" aria-checked="false" id="pg-unsigned"/);
    assert.ok(s.includes('Unsignierte Plugins erlauben') || s.includes('Allow unsigned plugins'));
    assert.doesNotMatch(s, /\b(plugins|st)\.[a-z_]+\.[a-z_.]+/, 'no raw i18n keys');
    assert.match(withoutScripts(html), /class="st-nav-item" data-section="plugins"/);
    assert.match(html, /<script src="\/js\/plugins-ui\.js[^"]*"><\/script>\s*<script src="\/js\/settings-plugins\.js[^"]*"><\/script>\s*<script src="\/js\/settings\.js/);
    const island = /id="st-i18n" data-prefixes="([^"]+)"/.exec(html)[1].split(' ');
    assert.ok(island.includes('plugins.'));
  });
  it('the settings script builds the DOM without innerHTML', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'settings-plugins.js'), 'utf8')
      + fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'plugin-bridge.js'), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
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
  it('the sidebar lists the plugin under "Plugins"', async () => {
    const html = withoutScripts((await agent.get('/dashboard').expect(200)).text);
    assert.match(html, /<a href="\/plugins\/hello" class="nav-item" data-plugin-nav="hello">/);
    assert.ok(html.includes('>Plugins</div>'));
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
    assert.match(page, /href="\/settings\?plugin=hello#plugins"/);
    const fr = await agent.get('/plugins/hello/frame/main').expect(503);
    assert.match(fr.headers['content-security-policy'], /sandbox/);
    await agent.post(API + '/hello/enable').set('X-CSRF-Token', csrf).send({}).expect(200);
    assert.equal(await runtime.waitRunning('hello'), true);
  });
  it('portal: running plugins with the portal permission get a tab', () => {
    assert.deepEqual(plugins.portalTabs('en'), [{ id: 'hello', key: 'plg-hello', label: 'Hello', icon: 'M4 12h16' }]);
    const tpl = fs.readFileSync(path.join(__dirname, '..', 'templates', 'portal', 'portal.njk'), 'utf8');
    assert.match(tpl, /src="\/portal\/plugins\/\{\{ pt\.id \}\}\/frame" sandbox="allow-scripts allow-forms"/);
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
