'use strict';

// Release B §8 (docs/feature-release-b.md): grouped sidebar, mobile bottom
// nav, the quick search (public/js/command-palette.js) — pure core, layout
// wiring, i18n block placement and the shared stylesheet public/css/nav.css.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nunjucks = require('nunjucks');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');
const P = require('../public/js/command-palette.js');

const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(ROOT, 'templates')), { autoescape: true });
env.addFilter('bytes', (v) => String(v || 0) + ' B');
env.addFilter('reltime', () => '—');
env.addFilter('truncate', (s) => s || '');
function t(key) { return de[key] !== undefined ? de[key] : key; }
function renderLayout(activeNav, features) {
  const src = '{% extends "aurora/layout.njk" %}{% block content %}<p>x</p>{% endblock %}';
  return env.renderString(src, {
    theme: 'aurora', language: 'de', t, availableLanguages: ['de', 'en'],
    license: { features: features || {}, hasFeature: () => false },
    cspNonce: 'N', csrfToken: 'c', appVersion: '9.9.9', appName: 'GateControl', baseUrl: 'https://gc.example.com',
    user: { username: 'admin', display_name: 'Admin' }, title: 'T', activeNav, flash: {}, peerCount: 2, routeCount: 7,
  });
}
const ALL = { gateway_pools: true, internal_dns: true, pihole_integration: true, waf: true, midea_integration: true, skoda_integration: true, smarthome: true };

function sidebarGroups(html) {
  const nav = html.slice(html.indexOf('<nav class="sidebar"'), html.indexOf('</nav>', html.indexOf('<nav class="sidebar"')));
  const out = [];
  const re = /<div class="nav-section-label">([^<]*)<\/div>|<a href="([^"]+)" class="nav-item[^"]*"/g;
  let m;
  while ((m = re.exec(nav))) {
    if (m[1] !== undefined) out.push({ label: m[1], hrefs: [] });
    else out[out.length - 1].hrefs.push(m[2]);
  }
  return out;
}

describe('sidebar groups (§8)', () => {
  it('Übersicht · Netzwerk · Sicherheit · Integrationen · System with every licensed item', () => {
    const g = sidebarGroups(renderLayout('dashboard', ALL));
    assert.deepEqual(g.map((x) => x.label), ['Übersicht', 'Netzwerk', 'Sicherheit', 'Integrationen', 'System']);
    assert.deepEqual(g.map((x) => x.hrefs), [
      ['/dashboard'],
      ['/peers', '/routes', '/gateways', '/gateway-pools', '/rdp', '/dns', '/pihole'],
      ['/security', '/certificates', '/waf', '/users'],
      ['/midea', '/skoda', '/smarthome'],
      ['/logs', '/settings'],
    ]);
  });

  it('licence conditions unchanged; the integrations label only with an integration', () => {
    const g = sidebarGroups(renderLayout('dashboard', {}));
    assert.deepEqual(g.map((x) => x.label), ['Übersicht', 'Netzwerk', 'Sicherheit', 'System']);
    assert.deepEqual(g[1].hrefs, ['/peers', '/routes', '/gateways', '/rdp']);
    assert.deepEqual(g[2].hrefs, ['/security', '/certificates', '/users'], 'Sicherheits-Check needs no licence');
    const one = sidebarGroups(renderLayout('dashboard', { skoda_integration: true }));
    assert.deepEqual(one.find((x) => x.label === 'Integrationen').hrefs, ['/skoda']);
  });

  it('badges and active state', () => {
    const html = renderLayout('security', ALL);
    assert.match(html, /<a href="\/security" class="nav-item active">/);
    assert.match(html, /id="peer-count-badge">2</);
    assert.match(html, /id="route-count-badge">7</);
    assert.equal(de['nav.security_check'], 'Sicherheits-Check');
  });

  it('bottom nav: Dashboard · Domains · Peers · Sicherheit · Mehr (button for the drawer)', () => {
    const html = renderLayout('waf', ALL);
    const bn = html.slice(html.indexOf('<nav class="bottom-nav">'), html.indexOf('</nav>', html.indexOf('<nav class="bottom-nav">')));
    assert.deepEqual(Array.from(bn.matchAll(/href="([^"]+)"/g)).map((m) => m[1]), ['/dashboard', '/routes', '/peers', '/security']);
    assert.match(bn, /<a href="\/security" class="bn-item active">/, 'security group pages mark "Sicherheit"');
    assert.match(bn, /<button type="button" class="bn-item bn-more\s*" id="bn-more" aria-controls="sidebar"/);
    assert.match(renderLayout('logs', ALL), /class="bn-item bn-more active"/, 'other pages mark "Mehr"');
  });
});

describe('layout wiring', () => {
  const layout = read('templates/aurora/layout.njk');
  it('nav.css after aurora.css (feature stylesheets follow it); command-palette.js after app.js', () => {
    const aurora = layout.indexOf('/css/aurora.css?v=');
    const nav = layout.indexOf('/css/nav.css?v=');
    assert.ok(aurora > 0 && nav > aurora, 'nav.css is linked after aurora.css');
    assert.ok(layout.slice(aurora, nav).split('\n').slice(1, -1).every((l) => !l.trim() || /<link rel="stylesheet" href="\/css\/[a-z-]+\.css\?v=/.test(l.trim())), 'only feature stylesheets in between');
    assert.match(layout, /app\.js\?v=\{\{ appVersion \}\}"><\/script>\n<script src="\/js\/command-palette\.js\?v=\{\{ appVersion \}\}"><\/script>/);
  });
  it('every palette.* key and the settings tab labels are in the GC.t whitelist', () => {
    const js = read('public/js/command-palette.js');
    const keys = new Set(Array.from(js.matchAll(/'((?:palette|settings)\.[a-z0-9_.]+)'/g)).map((m) => m[1]).filter((k) => !/[._]$/.test(k)));
    for (const g of ['recent', 'pages', 'actions', 'settings', 'hosts', 'entries', 'peers', 'gateways']) keys.add('palette.group_' + g);
    for (const k of keys) assert.ok(layout.includes(`'${k}':`), `layout GC.t has ${k}`);
    for (const k of ['common.close', 'nav.settings', 'gateways.online']) assert.ok(layout.includes(`'${k}':`), k);
  });
  it('topbar search button (touch entry point)', () => {
    const html = renderLayout('dashboard', ALL);
    assert.match(html, /<button type="button" class="cp-trigger" id="cp-open" aria-haspopup="dialog" aria-keyshortcuts="Control\+K Meta\+K \/"/);
    assert.match(html, /<kbd class="cp-kbd" id="cp-kbd">Strg K<\/kbd>/);
  });
  it('no innerHTML in the palette', () => {
    const src = read('public/js/command-palette.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
  it('localStorage / sessionStorage only inside try', () => {
    const src = read('public/js/command-palette.js');
    for (const m of src.matchAll(/(local|session)Storage\.(get|set|remove)Item/g)) {
      const line = src.slice(src.lastIndexOf('\n', m.index), src.indexOf('\n', m.index));
      assert.match(line, /try \{/, line.trim());
    }
  });
});

describe('command palette: pure core', () => {
  const items = [
    { key: 'page:/gateways', kind: 'page', label: 'Gateways', sub: 'Netzwerk', showEmpty: true },
    { key: 'page:/gateway-pools', kind: 'page', label: 'Gateway-Pools', sub: 'Netzwerk', showEmpty: true },
    { key: 'page:/certificates', kind: 'page', label: 'SSL / Zertifikate', sub: 'Sicherheit', showEmpty: true },
    { key: 'gateway:84', kind: 'gateway', label: 'DS918 Gateway', sub: '10.8.0.2' },
    { key: 'setting:backup', kind: 'setting', label: 'Backup', sub: 'Einstellungen', keywords: ['backup'] },
    { key: 'host:1', kind: 'host', label: 'nas.domaincaster.com', sub: '192.168.2.228', keywords: ['nas', '5001'] },
    { key: 'entry:9', kind: 'entry', ownOnly: true, label: 'HTTPS 443 → 5001', sub: 'nas.domaincaster.com', keywords: ['5001', 'http https'] },
    { key: 'peer:3', kind: 'peer', label: 'Müller Laptop', sub: '10.8.0.9' },
  ].map(P.prep);

  it('norm folds case and diacritics', () => {
    assert.equal(P.norm('Müller ÉTÉ Straße'), 'muller ete strasse');
    assert.deepEqual(P.tokens('  NAS   5001 '), ['nas', '5001']);
  });

  it('prefix beats word start beats inside; every token must match', () => {
    const g = P.search(items, 'gatew');
    assert.equal(g[0].group, 'pages');
    assert.equal(g[0].items[0].item.key, 'page:/gateways');
    assert.equal(g[0].items[1].item.key, 'page:/gateway-pools');
    assert.equal(P.search(items, 'gatew').find((x) => x.group === 'gateways').items[0].item.key, 'gateway:84');
    assert.equal(P.search(items, 'nas zzz').length, 0);
    assert.ok(P.scoreItem(items[0], ['gateways']) > P.scoreItem(items[0], ['gate']));
  });

  it('entries need a token of their own (a host name alone does not list its entries)', () => {
    const g = P.search(items, 'nas');
    assert.ok(g.some((x) => x.group === 'hosts'));
    assert.ok(!g.some((x) => x.group === 'entries'));
    const g2 = P.search(items, 'nas 5001');
    assert.equal(g2.find((x) => x.group === 'entries').items[0].item.key, 'entry:9');
  });

  it('diacritics-insensitive match on peers', () => {
    assert.equal(P.search(items, 'muller').find((x) => x.group === 'peers').items[0].item.key, 'peer:3');
  });

  it('empty query: recent first, then pages; groups capped', () => {
    const recent = [{ key: 'host:1', kind: 'host', label: 'nas.domaincaster.com' }];
    const g = P.search(items, '', { recent });
    assert.deepEqual(g.map((x) => x.group), ['recent', 'pages']);
    const many = Array.from({ length: 20 }, (_, i) => P.prep({ key: 'page:' + i, kind: 'page', label: 'Seite ' + i, showEmpty: true }));
    assert.equal(P.search(many, '')[0].items.length, 8);
  });

  it('shortcuts: Ctrl/⌘+K anywhere, "/" only outside text fields', () => {
    const input = { tagName: 'INPUT', type: 'text' };
    const cb = { tagName: 'INPUT', type: 'checkbox' };
    assert.equal(P.shortcutOf({ key: 'k', ctrlKey: true, target: input }), 'toggle');
    assert.equal(P.shortcutOf({ key: 'K', metaKey: true, target: {} }), 'toggle');
    assert.equal(P.shortcutOf({ key: 'k', ctrlKey: true, shiftKey: true, target: {} }), null);
    assert.equal(P.shortcutOf({ key: '/', target: { tagName: 'BODY' } }), 'open');
    assert.equal(P.shortcutOf({ key: '/', target: cb }), 'open');
    assert.equal(P.shortcutOf({ key: '/', target: input }), null);
    assert.equal(P.shortcutOf({ key: '/', target: { tagName: 'TEXTAREA' } }), null);
    assert.equal(P.shortcutOf({ key: '/', target: { tagName: 'DIV', isContentEditable: true } }), null);
    assert.equal(P.shortcutOf({ key: '/', ctrlKey: true, target: {} }), null);
    assert.equal(P.shortcutOf({ key: 'k', ctrlKey: true, defaultPrevented: true, target: {} }), null);
  });

  it('recent list: newest first, unique, capped, serialisable', () => {
    let list = [];
    for (let i = 0; i < 10; i++) list = P.pushRecent(list, { key: 'k' + i, kind: 'page', label: 'L' + i, href: '/x', run: () => {} });
    assert.equal(list.length, P.RECENT_MAX);
    assert.equal(list[0].key, 'k9');
    list = P.pushRecent(list, { key: 'k5', kind: 'page', label: 'L5' });
    assert.equal(list[0].key, 'k5');
    assert.equal(list.filter((x) => x.key === 'k5').length, 1);
    assert.deepEqual(Object.keys(list[0]).sort(), ['href', 'key', 'kind', 'label', 'sub']);
    assert.deepEqual(P.pushRecent('garbage', { key: 'a', kind: 'page', label: 'A' }).length, 1);
  });

  it('item builders from /zones, /peers, /gateways', () => {
    const zones = {
      zones: [{ domain_id: 2, hosts: [{ id: 5, fqdn: 'nas.domaincaster.com', subdomain: 'nas', lan_host: '192.168.2.228', description: 'DS218+',
        entries: [{ id: 201, route_type: 'http', https_enabled: 1, target_kind: 'gateway', target_lan_port: 5001 },
          { id: 202, route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '4450', target_kind: 'gateway', target_lan_port: 445 },
          { id: 203, route_type: 'l4', rdp_owned: true, l4_listen_port: '3392' }] }] }],
      unassigned: [{ id: 9, fqdn: null, name: 'Game server', entries: [] }],
    };
    const hi = P.hostItems(zones, (k) => (k === 'palette.unassigned' ? 'Ohne Domain' : k));
    assert.deepEqual(hi.map((x) => x.key), ['host:5', 'entry:201', 'entry:202', 'host:9']);
    assert.equal(hi[1].label, 'HTTPS 443 → 5001');
    assert.equal(hi[2].label, 'TCP 4450 → 445');
    assert.equal(hi[0].domainId, 2);
    assert.equal(hi[3].domainId, null);
    assert.match(hi[3].sub, /Ohne Domain/);
    const pe = P.peerItems({ peers: [{ id: 1, name: 'Tablet', allowed_ips: '10.8.0.5/32' }, { id: 2, name: 'GW', peer_type: 'gateway' }] });
    assert.deepEqual(pe.map((x) => [x.key, x.sub]), [['peer:1', '10.8.0.5']]);
    const gw = P.gatewayItems({ gateways: [{ peer_id: 84, name: 'DS918 Gateway', ip: '10.8.0.2', status: 'online' }] }, (k) => (k === 'gateways.online' ? 'Online' : k));
    assert.equal(gw[0].href, '/gateways#gw/84');
    assert.equal(gw[0].sub, '10.8.0.2 · Online');
    assert.equal(P.gatewayItems({ gateways: [{ peer_id: 1, name: 'x', status: 'unknown' }] }, (k) => k)[0].sub, '', 'untranslated status left out');
  });

  it('settings sections match the settings page tabs', () => {
    const njk = read('templates/aurora/pages/settings.njk');
    for (const s of P.SETTINGS) assert.ok(njk.includes(`data-settings-tab="${s.tab}"`), s.tab);
  });
});

describe('i18n block (nav.* + palette.* + zones.filter./wafdef + shield.* + bulk.*)', () => {
  const BLOCK = /^(nav\.(group_network|group_security|group_integrations|security_check|more|search)|palette\.|zones\.filter\.|zones\.select_|zones\.wafdef\.|shield\.|bulk\.)/;
  it('one contiguous block right after nav.skoda in both files, same keys and placeholders', () => {
    for (const [name, loc] of [['de', de], ['en', en]]) {
      const keys = Object.keys(loc);
      const first = keys.findIndex((k) => BLOCK.test(k));
      assert.equal(keys[first - 1], 'nav.skoda', `${name}: after nav.skoda`);
      let i = first;
      while (i < keys.length && BLOCK.test(keys[i])) i++;
      assert.ok(i - first >= 90, `${name}: block size ${i - first}`);
      assert.ok(!keys.slice(i).some((k) => BLOCK.test(k)), `${name}: no block key elsewhere`);
    }
    const pick = (o) => Object.keys(o).filter((k) => BLOCK.test(k));
    assert.deepEqual(pick(de), pick(en));
    for (const k of pick(de)) {
      const ph = (s) => (s.match(/\{\{\w+\}\}/g) || []).sort().join();
      assert.equal(ph(de[k]), ph(en[k]), k);
    }
  });
  it('the waf.* block is still the tail of both files', () => {
    for (const loc of [de, en]) {
      const keys = Object.keys(loc);
      const first = keys.indexOf('nav.waf');
      assert.ok(keys.slice(first).every((k) => k === 'nav.waf' || k.startsWith('waf.')));
    }
  });
});
