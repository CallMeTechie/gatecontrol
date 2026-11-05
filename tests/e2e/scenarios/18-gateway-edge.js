'use strict';

// Gateways › detail › tabs "Edge-Plugins" and "MQTT" (public/js/gateway-edge.js,
// docs/plugins.md "Edge part" › "Administration").
//
// Part 1 — the real API on the seeded gateway "e2e-gw-home": the tab is part of
// the address (#gw/<id>/edge survives a reload), "Edge ist aus" → switch edge on,
// MQTT: create an account (device template, extra topic) → the password shown
// exactly once and gone from the page after "Fertig", lock, new password (gone
// after Escape), delete; keyboard on the tab bar.
//
// Part 2 — a mocked fleet (page.route): "Pi Keller" with plugins in every
// state, the RAM hint, the capabilities dialog (checkbox, exact list, 409
// caps_mismatch → current list), "Unsignierte Edge-Teile" with the typed word,
// the log dialog (filter, "Ältere laden" → before=), MQTT with TLS
// "Zertifikat fehlt" and the account table; "NAS" (gateway 1.18.0) → "Gateway zu
// alt" with the page's update action. Light/dark, 390 px.

const fs = require('node:fs');
const path = require('node:path');

function enableSeededGateways(ids) {
  const file = process.env.GC_DB_PATH || path.join(process.env.GC_DATA_DIR || '.', 'gatecontrol.db');
  if (!fs.existsSync(file)) return 0;
  const Database = require('better-sqlite3');
  const db = new Database(file);
  try {
    db.pragma('busy_timeout = 5000');
    const st = db.prepare("UPDATE peers SET enabled = 1 WHERE id = ? AND peer_type = 'gateway'");
    return ids.reduce((n, id) => n + st.run(id).changes, 0);
  } finally { db.close(); }
}

const PI = 9001;
const NAS = 9002;
const HOUR = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function cap(key, text, warning) { return warning ? { key, text, warning: true } : { key, text }; }
const CAPS = {
  mdns: cap('mdns:_shelly._tcp', 'Geräte suchen per mDNS: _shelly._tcp'),
  coap: cap('udp.port:5683', 'UDP-Port 5683 im Heimnetz (senden/empfangen)'),
  mqtt: cap('mqtt.topic:shellies/#', 'MQTT-Themen shellies/# am lokalen Broker'),
  http: cap('http.lan', 'HTTP-Anfragen an Geräte im Heimnetz'),
  // the server marks no capability with `warning` at the moment; the dialog shows such a mark
  // generically (red row), so the mock carries one to keep that path covered
  warn: cap('udp.multicast:239.255.255.250', 'Multicast-Gruppe 239.255.255.250', true),
  tcp: cap('tcp.lan', 'TCP-Verbindungen zu Geräten im Heimnetz'),
  ipp: cap('mdns:_ipp._tcp', 'Geräte suchen per mDNS: _ipp._tcp'),
  zigbee: cap('serial:zigbee', 'Serielles Gerät „zigbee“'),
};

function plugin(id, name, version, opts) {
  const o = opts || {};
  const caps = o.caps || [];
  return {
    id, name, version, verified: o.verified !== false, signature: o.verified === false ? 'unsigned' : 'trusted', enabled: true,
    edge: { memoryMb: o.memoryMb || 48, minGateway: o.minGateway || null, capabilities: caps },
    assignment: o.state ? {
      pluginId: id, enabled: o.enabled !== false, state: o.state,
      approved: { capabilities: (o.approved || caps).map((c) => c.key), version, at: iso(Date.now() - 48 * HOUR), by: 'e2e_admin' },
      newCapabilities: o.fresh || [],
      status: o.status || null,
    } : null,
  };
}

function piData() {
  const now = Date.now();
  return {
    id: PI, name: 'Pi Keller',
    settings: { edgeEnabled: true, mqttEnabled: true, mqttTls: true, allowUnsignedEdge: false },
    connection: { online: true, connectedAt: iso(now - 2 * HOUR), lastSeen: iso(now - 5000) },
    gateway: { version: '1.19.0', edgeHost: '1.0.2', mqttAvailable: true, fence: { active: true, backend: 'nftables' },
      hardware: { model: 'Raspberry Pi 3 Model B Plus Rev 1.3', mem_total: 1024 * 1024 * 1024, mdns_name: 'pi-keller.local' }, at: iso(now - 2 * HOUR) },
    support: { gatewayVersion: '1.19.0', edgeSupported: true, edgeMinGateway: '1.19.0' },
    plugins: [
      plugin('smarthome', 'Smart Home', '2.4.0', { state: 'running', caps: [CAPS.mdns, CAPS.coap, CAPS.mqtt], memoryMb: 64,
        status: { state: 'running', version: '2.4.0', rssMb: 46, restarts: 0, lastError: null, throttled: false, buffered: null, at: iso(now) } }),
      plugin('hello', 'Hallo Welt', '1.1.0', { state: 'update_pending', caps: [CAPS.mdns, CAPS.http, CAPS.warn], approved: [CAPS.mdns], fresh: [CAPS.http, CAPS.warn], memoryMb: 32 }),
      plugin('print', 'Drucken & Scannen', '0.4.0', { state: 'crashed', caps: [CAPS.ipp, CAPS.tcp],
        status: { state: 'crashed', version: '0.4.0', rssMb: 38, restarts: 3, lastError: 'connect ECONNREFUSED 192.168.1.40:631', throttled: false, buffered: 12, at: iso(now) } }),
      plugin('zigbee-bridge', 'Zigbee-Brücke', '1.2.0', { state: 'gateway_too_old', caps: [CAPS.zigbee], minGateway: '1.20.0' }),
      plugin('mytest', 'Mein Testplugin', '0.1.0-dev', { verified: false, caps: [CAPS.http] }),
    ],
    mqtt: {
      status: { running: true, tls: 'missing_cert', clients: 5, accounts: [
        { user: 'smarthome-shelly-wz', connected: true }, { user: 'smarthome-tasmota-keller', connected: true }, { user: 'homeassistant', connected: true }] },
      accounts: [
        { id: 3, gatewayId: PI, username: 'esp-test', label: 'ESP32 Bastelei', acl: [{ access: 'readwrite', topic: 'devices/esp-test/#' }], pluginId: null, locked: true, createdAt: iso(now - 96 * HOUR), createdBy: 'e2e_admin' },
        { id: 2, gatewayId: PI, username: 'homeassistant', label: 'Home Assistant', acl: [{ access: 'readwrite', topic: 'devices/homeassistant/#' }, { access: 'readwrite', topic: 'homeassistant/homeassistant/#' }, { access: 'read', topic: 'shellies/#' }], pluginId: null, locked: false, createdAt: iso(now - 50 * HOUR), createdBy: 'e2e_admin' },
        { id: 1, gatewayId: PI, username: 'smarthome-shelly-wz', label: 'Shelly Plus 1 Wohnzimmer', acl: [{ access: 'readwrite', topic: 'shellies/shelly-wz/#' }], pluginId: 'smarthome', locked: false, createdAt: iso(now - 30 * HOUR), createdBy: 'plugin:smarthome' },
        { id: 4, gatewayId: PI, username: 'smarthome-tasmota-keller', label: 'Steckdose Keller', acl: [{ access: 'readwrite', topic: 'tasmota/tasmota-keller/#' }], pluginId: 'smarthome', locked: false, createdAt: iso(now - 20 * HOUR), createdBy: 'plugin:smarthome' },
      ],
    },
  };
}

function nasData() {
  return {
    id: NAS, name: 'NAS Wohnzimmer', settings: { edgeEnabled: false, mqttEnabled: false, mqttTls: false, allowUnsignedEdge: false },
    connection: { online: false, connectedAt: null, lastSeen: null }, gateway: null,
    support: { gatewayVersion: '1.18.0', edgeSupported: false, edgeMinGateway: '1.19.0' }, plugins: [], mqtt: { status: null, accounts: [] },
  };
}

function fleet() {
  const now = Date.now();
  const tel = (v, model, mem, lan) => ({ gateway_version: v, node_version: 'v22.22.0', cpu_cores: 4, cpu_load_avg: [0.2, 0.3, 0.3], mem_total: mem, mem_used: mem / 3,
    hardware: { model, mem_total: mem }, lan_ip: lan, state_dir_writable: true, disk: { total: 32e9, used: 9e9 } });
  const gw = (id, name, host, ip, telemetry, upd) => ({
    peer_id: id, name, hostname: host, ip, api_port: 9876, status: 'online', last_seen_at: now - 12000, latest_handshake: now - 12000,
    health: { overall_healthy: true, http_proxy_healthy: true, api_healthy: true, dns_resolve_ok: true, route_reachability: [], telemetry },
    routes: [], update_state: 'idle', update_target_version: null, platform: 'rpi', created_at: now - 900 * HOUR, first_seen_at: now - 900 * HOUR,
    never_connected: false, discovery: { enabled: 0, active_scan: 0 }, update_available: upd,
  });
  return { gateways: [
    gw(NAS, 'NAS Wohnzimmer', 'nas', '10.8.0.15', tel('1.18.0', 'DS920+', 4 * 1024 ** 3, '192.168.1.5'), true),
    gw(PI, 'Pi Keller', 'gw-pi-keller', '10.8.0.14', tel('1.19.0', 'Raspberry Pi 3 Model B Plus Rev 1.3', 1024 ** 3, '192.168.1.23'), false),
  ], latest_version: '1.19.0' };
}

function logEntries(from, n, kind) {
  const kinds = ['system', 'log', 'event', 'log'];
  const levels = ['info', 'error', 'info', 'warn'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = from - i;
    const k = kind || kinds[id % 4];
    out.push({ id, pluginId: 'print', kind: k, level: kind ? 'info' : levels[id % 4], at: iso(Date.now() - (from - id) * 60000),
      message: k === 'event' ? 'printer.offline → handed to GateControl' : k === 'system' ? `state running → crashed (#${id})` : `connect ECONNREFUSED 192.168.1.40:631 (#${id})` });
  }
  return out;
}

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, visible, shot, api } = ctx;
  const until = (page, fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const theme = async (page, mode) => {
    await page.evaluate((m) => { try { localStorage.setItem('gc-theme-mode', m); } catch (_) { /* ignore */ } document.documentElement.setAttribute('data-theme', m); }, mode);
    await page.waitForTimeout(150);
  };
  const fresh = (page) => page.evaluate(() => { const c = window.GCGatewayEdge && window.GCGatewayEdge._cache; if (c) Object.keys(c).forEach((k) => delete c[k]); });
  const goTab = async (page, id, tab) => {
    await page.evaluate(([i, t]) => { location.hash = '#gw/' + i + (t === 'overview' ? '' : '/' + t); }, [id, tab]);
    return until(page, ([t]) => { const b = document.getElementById('gwe-tab-' + t); return b && b.getAttribute('aria-selected') === 'true' && !document.querySelector('#gwe-tabpanel .gwe-loading'); }, [tab]);
  };
  const okButton = (page) => page.locator('.gcd-dialog .gcd-ok').last();

  return {
    async gatewayedge(page) {
      const GW = FIXTURES.gateways;
      const ping = await page.request.fetch(BASE + '/api/v1/ping');
      if (ping.status() !== 200) await ctx.login(page);
      await page.setViewportSize({ width: 1440, height: 1000 });
      step('edge: seeded gateways enabled', enableSeededGateways([GW.home, GW.nas]) === 2);
      // a clean start, whatever an earlier run left
      await page.goto(BASE + '/gateways');
      await api(page, 'PUT', `/api/v1/edge/gateways/${GW.home}/settings`, { edgeEnabled: false, mqttEnabled: false });
      for (const a of ((await api(page, 'GET', `/api/v1/edge/gateways/${GW.home}/mqtt/accounts`)).body || {}).accounts || []) {
        await api(page, 'DELETE', `/api/v1/edge/gateways/${GW.home}/mqtt/accounts/${a.id}`);
      }

      // ── Part 1: real API ──
      await page.goto(`${BASE}/gateways#gw/${GW.home}/edge`);
      await theme(page, 'dark');
      step('edge: #gw/<id>/edge opens the detail on the tab "Edge-Plugins"',
        await until(page, () => document.getElementById('gwe-tab-edge') && document.getElementById('gwe-tab-edge').getAttribute('aria-selected') === 'true'));
      step('edge: tab bar is a tablist with five tabs, the panel is labelled by the selected one', await page.evaluate(() => {
        const tl = document.querySelector('.gwe-tabs[role="tablist"]');
        const tabs = tl ? [...tl.querySelectorAll('[role="tab"]')] : [];
        const p = document.getElementById('gwe-tabpanel');
        return tabs.length === 5 && p && p.getAttribute('role') === 'tabpanel' && p.getAttribute('aria-labelledby') === 'gwe-tab-edge'
          && tabs.filter((t) => t.tabIndex === 0).length === 1;
      }));
      step('edge: switched off → "Edge ist aus" with a button to switch it on', await visible(page, '#gwe-tabpanel .gwe-big button.btn-primary'));
      await page.click('#gwe-tabpanel .gwe-big button.btn-primary');
      step('edge: switched on (real PUT) → the edge card with its switch',
        await until(page, () => { const s = document.querySelector('#gwe-tabpanel [data-fk="gwe-edge-sw"]'); return s && s.getAttribute('aria-checked') === 'true' && s.getAttribute('role') === 'switch'; }));
      step('edge: no plugin with an edge part installed → empty list with a link to the catalogue', await visible(page, '#gwe-tabpanel .gwe-plugins .gwe-empty a[href="/settings/plugins/catalog"]'));
      await page.reload();
      step('edge: the tab survives a reload', await until(page, () => { const b = document.getElementById('gwe-tab-edge'); return b && b.getAttribute('aria-selected') === 'true'; }));
      // keyboard: arrow right on the tab bar → MQTT, focus follows
      await page.focus('#gwe-tab-edge');
      await page.keyboard.press('ArrowRight');
      step('edge: ArrowRight on the tab bar → MQTT tab, address #gw/<id>/mqtt, focus on the tab',
        await until(page, (id) => location.hash === '#gw/' + id + '/mqtt' && document.activeElement && document.activeElement.id === 'gwe-tab-mqtt', GW.home));

      // MQTT: broker on (real PUT)
      await until(page, () => document.querySelector('#gwe-tabpanel [data-fk="gwe-mqtt-sw"]'));
      await page.click('#gwe-tabpanel [data-fk="gwe-mqtt-sw"]');
      step('mqtt: broker switch on (real PUT)', await until(page, () => (document.querySelector('[data-fk="gwe-mqtt-sw"]') || {}).getAttribute && document.querySelector('[data-fk="gwe-mqtt-sw"]').getAttribute('aria-checked') === 'true'));
      step('mqtt: accounts "0 von 256" and the empty note', await until(page, () => /\b0\b.*\b256\b/.test((document.querySelector('.gwe-accounts .gwe-sum') || {}).textContent || '') && document.querySelector('.gwe-accounts .gwe-empty')));

      // create an account
      await page.click('[data-fk="gwe-acc-new"]');
      step('mqtt: "Konto anlegen" dialog, focus on the device template', await until(page, () => document.activeElement && document.activeElement.id === 'gwe-acc-tpl'));
      await page.selectOption('#gwe-acc-tpl', 'shelly');
      await page.click('.gwe-newacc .gcd-foot .btn-primary');
      step('mqtt: without a user name → field error, nothing sent', await until(page, () => { const e = document.getElementById('gwe-acc-user-err'); return e && !e.hidden && document.getElementById('gwe-acc-user').getAttribute('aria-invalid') === 'true'; }));
      await page.fill('#gwe-acc-user', 'Bad Name');
      await page.click('.gwe-newacc .gcd-foot .btn-primary');
      step('mqtt: invalid user name → field error', await until(page, () => !document.getElementById('gwe-acc-user-err').hidden));
      await page.fill('#gwe-acc-user', 'e2e-shelly');
      await page.fill('#gwe-acc-label', 'Shelly Flur');
      step('mqtt: the template adds shellies/<user>/#, devices/<user>/# is always there', await until(page, () => {
        const t = [...document.querySelectorAll('.gwe-topic code')].map((c) => c.textContent);
        return t.includes('shellies/e2e-shelly/#') && t.includes('devices/e2e-shelly/#');
      }));
      await page.fill('#gwe-acc-topic', '#');
      await page.click('.gwe-topic-add button');
      step('mqtt: a bare # is refused', await until(page, () => !document.getElementById('gwe-acc-topic-err').hidden));
      await page.fill('#gwe-acc-topic', 'shellies/announce');
      await page.selectOption('#gwe-acc-access', 'read');
      await page.click('.gwe-topic-add button');
      step('mqtt: extra topic added', await until(page, () => [...document.querySelectorAll('.gwe-topic code')].some((c) => c.textContent === 'shellies/announce')));
      const created = page.waitForResponse((r) => r.url().endsWith(`/api/v1/edge/gateways/${GW.home}/mqtt/accounts`) && r.request().method() === 'POST');
      await page.click('.gwe-newacc .gcd-foot .btn-primary');
      const cr = await created;
      const sent = JSON.parse(cr.request().postData() || '{}');
      const crBody = await cr.json().catch(() => ({}));
      step('mqtt: POST { username, label, topics, vendorPrefix: "shellies" } → 201 with the password once',
        cr.status() === 201 && sent.username === 'e2e-shelly' && sent.vendorPrefix === 'shellies'
        && sent.topics.some((x) => x.topic === 'shellies/announce' && x.access === 'read') && typeof crBody.password === 'string', JSON.stringify(sent));
      const pw = crBody.password || '';
      step('mqtt: password dialog shows server, user, password, topic prefix — with "Kopieren" (server unknown here: no copy)', await until(page, (p) => {
        const box = document.querySelector('.gwe-pwdlg');
        return box && box.querySelector('.gwe-secret') && box.querySelector('.gwe-secret').textContent === p && box.querySelectorAll('.gwe-pw-row').length === 4
          && box.querySelectorAll('.gwe-pw-row .gwe-copy').length >= 3 && /shellies\/e2e-shelly/.test(box.textContent) && !/\bnull\b/.test(box.textContent);
      }, pw));
      await page.waitForTimeout(400); // the dialog's fade-in
      await shot(page, 'gwe-mqtt-password-dark', false);
      await page.click('.gwe-pwdlg .gcd-foot .btn-primary');
      step('mqtt: after "Fertig" the password is nowhere in the page', await until(page, (p) => !document.querySelector('.gwe-pwdlg') && !document.documentElement.outerHTML.includes(p), pw));
      step('mqtt: the account is listed (by "Admin")', await until(page, () => document.querySelector('.gwe-table tr[data-account="e2e-shelly"]')));

      // lock (asks first) and unlock
      await page.click('tr[data-account="e2e-shelly"] [data-fk^="lock:"]');
      await okButton(page).click();
      step('mqtt: lock → asked first, then "gesperrt" (real PUT)', await until(page, () => {
        const r = document.querySelector('tr[data-account="e2e-shelly"]');
        return r && r.querySelector('.tag-grey') && r.querySelector('[data-fk^="lock:"]').getAttribute('aria-label') !== null && /unlock|entsperren/i.test(r.querySelector('[data-fk^="lock:"]').getAttribute('aria-label'));
      }));
      // new password: confirm, shown once, gone after Escape
      await page.click('tr[data-account="e2e-shelly"] [data-fk^="pw:"]');
      const reset = page.waitForResponse((r) => /\/mqtt\/accounts\/\d+\/password$/.test(r.url()));
      await okButton(page).click();
      const rr = await reset;
      const pw2 = ((await rr.json().catch(() => ({}))) || {}).password || '';
      step('mqtt: new password → a different one, shown in the dialog', !!pw2 && pw2 !== pw && await until(page, (p) => (document.querySelector('.gwe-pwdlg .gwe-secret') || {}).textContent === p, pw2));
      await page.keyboard.press('Escape');
      step('mqtt: Escape closes it — the new password is gone too', await until(page, (p) => !document.querySelector('.gwe-pwdlg') && !document.documentElement.outerHTML.includes(p), pw2));
      // delete (danger)
      await page.click('tr[data-account="e2e-shelly"] [data-fk^="del:"]');
      step('mqtt: delete asks with the red button', await until(page, () => document.querySelector('.gcd-dialog .gcd-ok.btn-danger')));
      await okButton(page).click();
      step('mqtt: deleted (real DELETE)', await until(page, () => !document.querySelector('tr[data-account="e2e-shelly"]') && document.querySelector('.gwe-accounts .gwe-empty')));
      await api(page, 'PUT', `/api/v1/edge/gateways/${GW.home}/settings`, { edgeEnabled: false, mqttEnabled: false });

      // ── Part 2: mocked fleet ──
      let pi = piData();
      let enableCalls = [];
      let settingsCalls = [];
      let logCalls = [];
      await page.route(/\/api\/v1\/gateways(\?.*)?$/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fleet()) }));
      await page.route(/\/api\/v1\/edge\/gateways\/900[12](\/.*)?(\?.*)?$/, async (r) => {
        const u = new URL(r.request().url());
        const m = r.request().method();
        const json = (status, body) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (u.pathname === `/api/v1/edge/gateways/${NAS}`) return json(200, { ok: true, gateway: nasData() });
        const rest = u.pathname.replace(`/api/v1/edge/gateways/${PI}`, '');
        if (rest === '' && m === 'GET') return json(200, { ok: true, gateway: pi });
        if (rest === '/settings' && m === 'PUT') {
          const b = JSON.parse(r.request().postData() || '{}');
          settingsCalls.push(b);
          if (b.allowUnsignedEdge === true && !['ERLAUBEN', 'ALLOW'].includes(b.confirm)) return json(400, { ok: false, code: 'confirm_mismatch', error: 'type ERLAUBEN to confirm' });
          Object.keys(b).forEach((k) => { if (k in pi.settings) pi.settings[k] = b[k]; });
          if (b.allowUnsignedEdge === true) pi.plugins.find((p) => p.id === 'mytest').assignment = null;
          return json(200, { ok: true, settings: pi.settings });
        }
        let mm = /^\/plugins\/([a-z0-9-]+)\/(enable|disable)$/.exec(rest);
        if (mm && m === 'POST') {
          const p = pi.plugins.find((x) => x.id === mm[1]);
          if (mm[2] === 'disable') { p.assignment.enabled = false; p.assignment.state = 'disabled'; return json(200, { ok: true, assignment: p.assignment }); }
          const b = JSON.parse(r.request().postData() || '{}');
          enableCalls.push(b.capabilities);
          if (enableCalls.length === 1) {
            // meanwhile the plugin was updated once more: one capability more
            p.edge.capabilities = [CAPS.mdns, CAPS.http, CAPS.warn, CAPS.tcp];
            p.assignment.newCapabilities = [CAPS.http, CAPS.warn, CAPS.tcp];
            return json(409, { ok: false, code: 'caps_mismatch', error: 'confirm the current list of capabilities', capabilities: p.edge.capabilities.map((c) => c.key).sort() });
          }
          const want = p.edge.capabilities.map((c) => c.key).sort();
          const got = [...(b.capabilities || [])].sort();
          if (JSON.stringify(want) !== JSON.stringify(got)) return json(409, { ok: false, code: 'caps_mismatch', error: 'mismatch', capabilities: want });
          p.assignment = { ...p.assignment, enabled: true, state: 'starting', newCapabilities: [], approved: { capabilities: want, version: p.version, at: iso(Date.now()), by: 'e2e_admin' } };
          return json(200, { ok: true, assignment: p.assignment });
        }
        if (rest === '/logs' && m === 'GET') {
          logCalls.push(Object.fromEntries(u.searchParams));
          const before = Number(u.searchParams.get('before')) || 1000;
          const kind = u.searchParams.get('kind');
          const n = before <= 900 ? 37 : 100;
          return json(200, { ok: true, entries: logEntries(before - 1, n, kind) });
        }
        return json(404, { ok: false, code: 'not_found', error: 'not mocked: ' + m + ' ' + rest });
      });

      await page.goto(`${BASE}/gateways#gw/${PI}/edge`);
      await theme(page, 'light');
      step('mock: Pi Keller → edge tab with the badge "1 prüfen"/"laufen"', await until(page, () => {
        const b = document.querySelector('[data-gwe-badge="edge"]');
        return document.querySelectorAll('#gwe-tabpanel .gwe-prow').length === 5 && b && b.textContent.length > 0;
      }));
      step('mock: MQTT tab badge "5 Clients"', await until(page, () => /5/.test((document.querySelector('[data-gwe-badge="mqtt"]') || {}).textContent || '')));
      step('mock: fence and connection chips, RAM hint for 1 GB', await page.evaluate(() => {
        const t = document.querySelector('#gwe-tabpanel .gwe-card').textContent;
        return /nftables/.test(t) && document.querySelectorAll('#gwe-tabpanel .gwe-chip-ok').length >= 2 && /1 GB RAM/.test(t) && document.querySelector('#gwe-tabpanel .gwe-note-warn');
      }));
      step('mock: rows carry their state (running, update_pending, crashed, gateway_too_old, unsigned)', await page.evaluate(() => {
        const st = (id) => (document.querySelector(`.gwe-prow[data-plugin="${id}"]`) || {}).dataset || {};
        return st('smarthome').state === 'running' && st('hello').state === 'update_pending' && st('print').state === 'crashed'
          && st('zigbee-bridge').state === 'gateway_too_old' && st('mytest').state === 'unsigned';
      }));
      step('mock: crashed row shows restarts and the last error in mono', await page.evaluate(() => {
        const r = document.querySelector('.gwe-prow[data-plugin="print"]');
        return /3/.test(r.textContent) && r.querySelector('code.gwe-mono').textContent.includes('ECONNREFUSED');
      }));
      step('mock: unsigned plugin → disabled switch; update_pending → "Prüfen und einschalten"', await page.evaluate(() => {
        const sw = document.querySelector('.gwe-prow[data-plugin="mytest"] [role="switch"]');
        return sw && sw.disabled && document.querySelector('.gwe-prow[data-plugin="hello"] [data-fk="review:hello"]');
      }));
      step('mock: no raw i18n keys on the tab', await page.evaluate(() => !/\bgwe\.[a-z_]+\.[a-z_.]+/.test(document.getElementById('gwe-tabpanel').textContent)));
      await shot(page, 'gwe-edge-light');
      await theme(page, 'dark');
      await shot(page, 'gwe-edge-dark');

      // every state renders as a labelled pill
      const states = ['running', 'starting', 'pending', 'crashed', 'denied', 'stopped', 'offline', 'disabled', 'update_pending', 'unsigned', 'plugin_off', 'gateway_too_old'];
      const labels = {};
      for (const s of states) {
        pi.plugins[0].assignment.state = s;
        await fresh(page);
        await goTab(page, PI, 'mqtt');
        await goTab(page, PI, 'edge');
        labels[s] = await page.evaluate((x) => {
          const r = document.querySelector(`.gwe-prow[data-plugin="smarthome"][data-state="${x}"] .tag`);
          return r ? r.textContent.trim() : null;
        }, s);
      }
      pi.plugins[0].assignment.state = 'running';
      step('mock: every state has its own label', states.every((s) => labels[s] && !/^gwe\./.test(labels[s])) && new Set(Object.values(labels)).size === states.length, JSON.stringify(labels));

      // capabilities dialog
      await fresh(page);
      await goTab(page, PI, 'mqtt');
      await goTab(page, PI, 'edge');
      await page.click('[data-fk="review:hello"]');
      step('caps: dialog lists every capability, new ones marked, the warning in red', await until(page, () => {
        const box = document.querySelector('.gwe-caps');
        if (!box) return false;
        const rows = [...box.querySelectorAll('.gwe-cap')];
        return rows.length === 3 && box.querySelectorAll('.gwe-cap .tag-amber').length === 2 && box.querySelectorAll('.gwe-cap .tag-grey').length === 1
          && box.querySelector('.gwe-cap-warn[data-key="udp.multicast:239.255.255.250"]');
      }));
      step('caps: "Zustimmen" disabled until "gelesen" is ticked; focus on the checkbox', await page.evaluate(() =>
        document.querySelector('.gwe-caps .gcd-foot .btn-primary').disabled && document.activeElement.id === 'gwe-caps-read'));
      await page.waitForTimeout(400); // the dialog's fade-in
      await shot(page, 'gwe-caps-dark', false);
      await page.check('#gwe-caps-read');
      await page.click('.gwe-caps .gcd-foot .btn-primary');
      step('caps: 409 caps_mismatch → the dialog shows the current list again, unticked', await until(page, () => {
        const box = document.querySelector('.gwe-caps');
        return box && box.querySelectorAll('.gwe-cap').length === 4 && box.querySelector('.gwe-cap[data-key="tcp.lan"]')
          && !document.getElementById('gwe-caps-read').checked && box.querySelector('.gwe-status').textContent.length > 0;
      }));
      step('caps: first request sent exactly the list shown', JSON.stringify(enableCalls[0]) === JSON.stringify(['mdns:_shelly._tcp', 'http.lan', 'udp.multicast:239.255.255.250']), JSON.stringify(enableCalls[0]));
      ctx.allow((p) => (p.kind === 'http' && p.status === 409 && /\/plugins\/hello\/enable/.test(p.url)) || (p.kind === 'console' && /409/.test(p.text)));
      await page.check('#gwe-caps-read');
      await page.click('.gwe-caps .gcd-foot .btn-primary');
      step('caps: second request with the current list → switched on, dialog closed', await until(page, () => !document.querySelector('.gwe-caps')
        && (document.querySelector('.gwe-prow[data-plugin="hello"]') || {}).dataset.state === 'starting'));
      step('caps: the second list is the current one', JSON.stringify(enableCalls[1]) === JSON.stringify(['mdns:_shelly._tcp', 'http.lan', 'udp.multicast:239.255.255.250', 'tcp.lan']), JSON.stringify(enableCalls[1]));

      // unsigned: typed word
      await page.click('[data-fk="gwe-uns"]');
      const word = await page.evaluate(() => (document.querySelector('.gwe-uns .gwe-word') || {}).textContent);
      await page.fill('#gwe-uns-word', word.slice(0, -1));
      step('unsigned: "Erlauben" stays disabled until the word is complete', await page.evaluate(() => document.querySelector('.gwe-uns .gcd-foot .btn-danger').disabled));
      await page.fill('#gwe-uns-word', word);
      await page.click('.gwe-uns .gcd-foot .btn-danger');
      step('unsigned: PUT { allowUnsignedEdge: true, confirm: <word> } → "erlaubt"', await until(page, () => !document.querySelector('.gwe-uns') && /^(erlaubt|allowed)$/.test(document.querySelector('[aria-labelledby="gwe-h-uns"] .top .tag').textContent))
        && settingsCalls.some((b) => b.allowUnsignedEdge === true && b.confirm === word));

      // log dialog
      await page.click('[data-fk="log:print"]');
      step('log: dialog with filter, 100 entries, "Ältere laden"', await until(page, () => document.querySelectorAll('.gwe-logdlg .gwe-ln').length === 100
        && !document.querySelector('.gwe-logdlg .gwe-more button').hidden && document.querySelector('.gwe-logdlg .gwe-seg-b[aria-pressed="true"]')));
      await page.click('.gwe-logdlg .gwe-more button');
      step('log: "Ältere laden" asks with before=<oldest id> and appends', await until(page, () => document.querySelectorAll('.gwe-logdlg .gwe-ln').length === 137)
        && logCalls[logCalls.length - 1].before === '900' && logCalls[logCalls.length - 1].plugin === 'print', JSON.stringify(logCalls.slice(-1)));
      step('log: fewer than a page → no "Ältere laden"', await page.evaluate(() => document.querySelector('.gwe-logdlg .gwe-more button').hidden));
      await page.click('.gwe-logdlg .gwe-seg-b[data-filter="event"]');
      step('log: filter "Ereignisse" → kind=event, from the newest again', await until(page, () => document.querySelectorAll('.gwe-logdlg .gwe-ln').length === 100
        && [...document.querySelectorAll('.gwe-logdlg .gwe-ln')].every((l) => l.dataset.kind === 'event'))
        && logCalls[logCalls.length - 1].kind === 'event' && !logCalls[logCalls.length - 1].before);
      await page.waitForTimeout(400); // the dialog's fade-in
      await shot(page, 'gwe-log-dark', false);
      await page.keyboard.press('Escape');

      // MQTT tab (mock)
      await goTab(page, PI, 'mqtt');
      step('mqtt mock: status "läuft", 5 clients, address with copy, mDNS name', await page.evaluate(() => {
        const t = document.getElementById('gwe-tabpanel').textContent;
        return /192\.168\.1\.23:1883/.test(t) && /pi-keller\.local/.test(t) && document.querySelector('#gwe-tabpanel [aria-labelledby="gwe-h-broker"] .gwe-copy');
      }));
      step('mqtt mock: TLS on, gateway reports missing_cert → "Zertifikat fehlt"', await page.evaluate(() => !!document.querySelector('[aria-labelledby="gwe-h-tls"] .gwe-note-warn')));
      step('mqtt mock: table with 4 accounts, plugin/admin, locked one offers "entsperren", every account can be deleted', await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.gwe-table tbody tr')];
        const esp = document.querySelector('tr[data-account="esp-test"] [data-fk^="lock:"]');
        return rows.length === 4 && /4\D+256/.test(document.querySelector('.gwe-accounts .gwe-sum').textContent) && esp && /entsperren|unlock/i.test(esp.getAttribute('aria-label'))
          && rows.every((r) => r.querySelector('[data-fk^="del:"]'));
      }));
      await shot(page, 'gwe-mqtt-dark');
      await theme(page, 'light');
      await shot(page, 'gwe-mqtt-light');

      // NAS: gateway too old → the page's update action
      await goTab(page, NAS, 'edge');
      step('too old: "Edge braucht Gateway 1.19.0" with the update button of the page', await until(page, () => {
        const b = document.querySelector('#gwe-tabpanel .gwe-big [data-act="update"]');
        return b && /1\.19\.0/.test(document.querySelector('#gwe-tabpanel .gwe-big').textContent);
      }));
      await page.click('#gwe-tabpanel .gwe-big [data-act="update"]');
      step('too old: the button opens the page\'s update confirmation', await visible(page, '.gcd-dialog .gcd-ok'));
      await page.keyboard.press('Escape');
      await goTab(page, NAS, 'mqtt');
      step('too old: the MQTT tab says the same', await visible(page, '#gwe-tabpanel .gwe-big'));
      await shot(page, 'gwe-too-old-light', false);

      // 390 px
      await page.setViewportSize({ width: 390, height: 844 });
      await fresh(page);
      await goTab(page, PI, 'edge');
      await page.waitForTimeout(200);
      step('390 px: edge tab does not scroll sideways', (await overflow(page)) <= 1, String(await overflow(page)));
      await shot(page, 'gwe-edge-390-light');
      await goTab(page, PI, 'mqtt');
      await page.waitForTimeout(200);
      step('390 px: MQTT tab does not scroll sideways (the table scrolls in its box)', (await overflow(page)) <= 1 && await page.evaluate(() => {
        const w = document.querySelector('.gwe-table-wrap');
        return w && w.scrollWidth > w.clientWidth;
      }), String(await overflow(page)));
      await theme(page, 'dark');
      await shot(page, 'gwe-mqtt-390-dark');
      await page.click('[data-fk="gwe-acc-new"]');
      await page.waitForTimeout(150);
      step('390 px: "Konto anlegen" fits', (await overflow(page)) <= 1);
      await page.waitForTimeout(400); // the dialog's fade-in
      await shot(page, 'gwe-newacc-390-dark', false);
      await page.keyboard.press('Escape');
      await page.unroute(/\/api\/v1\/gateways(\?.*)?$/);
      await page.unroute(/\/api\/v1\/edge\/gateways\/900[12](\/.*)?(\?.*)?$/);
      await page.setViewportSize({ width: 1440, height: 1000 });
    },
  };
};

// the mocked data, also for hand-made screenshots
module.exports.mock = { piData, nasData, fleet };
