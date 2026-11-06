'use strict';

// Gateways › detail › card "Funktionen dieses Gateways" (tab "Übersicht") and
// the tabs "Netzwerk" and "Internet" (public/js/gateway-net.js, phase 3a).
//
// No mocks: the seeded gateway "e2e-gw-home" gets a known gateway token in the
// test database and reports like a real gateway through the gateway API —
// heartbeat (Pi 3 B+, Zigbee radio, UPS), the network watch (inventory, then
// two new devices, a printer with telnet open), the internet quality (24 h of
// 5-minute values, outages, a speed test). The admin side then works with the
// real admin API: switches, the UPS dialog (wrong address → message), the
// tab badge "2 neu", search and filter, "Neues Gerät" → "Ist meins", editing a
// device ("zählt für Anwesenheit" only with an owner), the history (24 h /
// 7 days, chart / table), the speed-test plan. "Jetzt scannen" reaches no
// gateway here (502, expected). Light/dark, 390 px without sideways scroll.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function withDb(fn) {
  const file = process.env.GC_DB_PATH || path.join(process.env.GC_DATA_DIR || '.', 'gatecontrol.db');
  if (!fs.existsSync(file)) return null;
  const Database = require('better-sqlite3');
  const db = new Database(file);
  try { db.pragma('busy_timeout = 5000'); return fn(db); } finally { db.close(); }
}

const MIN = 60 * 1000;

function devices(now) {
  const d = (mac, ip, vendor, hostname, ports, extra) => ({ mac, ip, vendor, hostname, randomMac: false, online: true, firstSeen: now - 40 * 24 * 60 * MIN, lastSeen: now - MIN, ports, ...extra });
  return [
    d('00:11:32:aa:bb:01', '192.168.1.10', 'Synology', 'diskstation', [{ port: 443, service: 'https' }, { port: 445, service: 'smb' }, { port: 5001, service: null }]),
    d('30:05:5c:11:22:33', '192.168.1.40', 'Brother', 'BRN30055C', [{ port: 80, service: 'http' }, { port: 631, service: 'ipp' }, { port: 23, service: 'telnet' }]),
    d('a8:23:fe:44:55:66', '192.168.1.55', 'LG Electronics', 'LGwebOSTV', [{ port: 3000, service: null }, { port: 8001, service: null }]),
    d('3c:22:fb:00:00:02', '192.168.1.104', 'Apple', 'Marcs-iPhone', [], { randomMac: false }),
    d('f0:9f:c2:00:00:07', '192.168.1.2', 'Ubiquiti', 'unifi-ap', [{ port: 22, service: 'ssh' }], { online: false, lastSeen: now - 3 * 60 * MIN }),
  ];
}

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, visible, shot, api, allow } = ctx;
  const until = (page, fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const theme = async (page, mode) => {
    await page.evaluate((m) => { try { localStorage.setItem('gc-theme-mode', m); } catch (_) { /* ignore */ } document.documentElement.setAttribute('data-theme', m); }, mode);
    await page.waitForTimeout(150);
  };
  const goTab = async (page, id, tab) => {
    await page.evaluate(([i, t]) => { location.hash = '#gw/' + i + (t === 'overview' ? '' : '/' + t); }, [id, tab]);
    return until(page, ([t]) => { const b = document.getElementById('gwe-tab-' + t); return b && b.getAttribute('aria-selected') === 'true' && !document.querySelector('#gwe-tabpanel .gwe-loading'); }, [tab]);
  };
  // a viewport picture from the top of the page (the sticky page head would cover a full-page one)
  const view = async (page, name, height) => {
    const vp = page.viewportSize();
    await page.setViewportSize({ width: vp.width, height: height || 1500 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await shot(page, name, false);
    await page.setViewportSize(vp);
  };
  const fresh = (page) => page.evaluate(() => {
    const c = window.GCGatewayNet && window.GCGatewayNet._cache;
    if (c) Object.keys(c).forEach((k) => { Object.keys(c[k]).forEach((x) => delete c[k][x]); });
  });

  return {
    async gatewaynet(page) {
      const GW = FIXTURES.gateways.home;
      const ping = await page.request.fetch(BASE + '/api/v1/ping');
      if (ping.status() !== 200) await ctx.login(page);
      await page.setViewportSize({ width: 1440, height: 1000 });

      // a known gateway token for the seeded gateway (restored at the end), a clean slate
      const token = 'gc_gw_' + crypto.randomBytes(32).toString('hex');
      const hash = 'sha256:' + crypto.createHash('sha256').update(token).digest('hex');
      const old = withDb((db) => {
        db.prepare("UPDATE peers SET enabled = 1 WHERE id = ? AND peer_type = 'gateway'").run(GW);
        const r = db.prepare('SELECT api_token_hash, last_health, last_seen_at, first_seen_at FROM gateway_meta WHERE peer_id = ?').get(GW);
        db.prepare('UPDATE gateway_meta SET api_token_hash = ? WHERE peer_id = ?').run(hash, GW);
        for (const t of ['netwatch_devices', 'inetq_samples', 'inetq_outages', 'inetq_speedtests', 'gateway_features']) db.prepare(`DELETE FROM ${t} WHERE peer_id = ?`).run(GW);
        return r || null;
      });
      step('net: seeded gateway prepared with a known token', !!(old && old.api_token_hash));
      const gw = async (p, body) => {
        const r = await page.request.fetch(BASE + '/api/v1/gateway' + p, { method: 'POST', data: body, headers: { Authorization: 'Bearer ' + token } });
        return r.status();
      };
      // German like the mockups (labels are not checked; restored at the end)
      await page.goto(BASE + '/gateways');
      const lang0 = await page.evaluate(() => document.documentElement.lang || 'en');
      const langSet = await api(page, 'POST', '/api/v1/settings/language', { language: 'de' });
      step('net: page in German for the run', langSet.status === 200, 'status ' + langSet.status);
      try {
        const now = Date.now();
        const hb = await gw('/heartbeat', { uptime_s: 3600, telemetry: {
          gateway_version: '1.21.0', node_version: 'v22.22.0', cpu_cores: 4, cpu_load_avg: [0.2, 0.3, 0.3], mem_total: 1024 ** 3, mem_used: 380 * 1024 ** 2,
          hardware: { model: 'Raspberry Pi 3 Model B Plus Rev 1.3', cpu_cores: 4, mem_total: 1024 ** 3, storage: { total: 30e9, free: 22e9 },
            radios: [{ kind: 'zigbee', type: 'raspbee2-conbee2', device: '/dev/ttyAMA0', detected: true, enabled: true }] },
          lan_ip: '192.168.1.23', lan_discovery: true, capabilities: ['netwatch', 'inetq', 'presence', 'ups'], state_dir_writable: true,
          ups: { status: 'OL', charge: 100, runtimeSec: 2520, model: 'APC Back-UPS 700', at: now },
        } });
        step('net: heartbeat with hardware, capabilities and UPS (gateway API)', hb === 200);
        step('net: inventory of the network watch', await gw('/netwatch', { scanAt: now - 5 * MIN, full: true, devices: devices(now) }) === 200);
        step('net: two new devices (one with a random MAC)', await gw('/netwatch', { scanAt: now - 4 * MIN, full: false, devices: [
          { mac: '24:0a:c4:9f:12:aa', ip: '192.168.1.77', vendor: 'Espressif', hostname: 'esp32-9f12aa', randomMac: false, online: true, firstSeen: now - 70 * MIN, lastSeen: now - 4 * MIN, ports: [] },
          { mac: 'da:a1:19:42:10:12', ip: '192.168.1.112', vendor: 'Samsung', hostname: 'Galaxy-A54', randomMac: true, online: true, firstSeen: now - 15 * 60 * MIN, lastSeen: now - 4 * MIN, ports: null },
        ] }) === 200);
        const samples = [];
        const b0 = now - (now % (5 * MIN));
        for (let i = 0; i < 288; i++) {
          const t = b0 - i * 5 * MIN;
          const bump = i === 40 || i === 41 ? 30 : (i === 150 ? 38 : 0);
          samples.push({ t, rttRouterMs: 2 + (i % 2), rttInetMs: i >= 100 && i < 102 ? null : Math.round((14 + 2 * Math.sin(i / 9) + (i % 5) * 0.3 + bump) * 10) / 10, lossInetPct: i === 40 ? 2 : 0, rttServerMs: 21 + (i % 4) });
        }
        step('net: 24 h of internet quality, outages and a speed test', await gw('/inetq', {
          samples,
          outages: [{ start: b0 - 102 * 5 * MIN, end: b0 - 100 * 5 * MIN + 2 * MIN, cause: 'isp' }, { start: now - 3 * 24 * 60 * MIN, end: now - 3 * 24 * 60 * MIN + 11 * MIN, cause: 'router' }],
          speedtests: [{ at: now - 3 * 60 * MIN, downMbps: 248.3, upMbps: 46.1, bytes: 61e6 }],
        }) === 200);

        // ── overview: the card "Funktionen" (what is on), the switches in the tab "Funktionen" ──
        await page.goto(`${BASE}/gateways#gw/${GW}`);
        await theme(page, 'dark');
        step('net: the overview shows the card "Funktionen" with chips and "Verwalten" → tab', await until(page, () => {
          const c = document.querySelector('.gwn-fsum');
          return c && c.querySelector('[data-fon="netwatch"]') && /#gw\/\d+\/features$/.test((c.querySelector('a.btn') || {}).href || '');
        }));
        step('net: eight tabs, Funktionen after Übersicht, then Netzwerk and Internet', await page.evaluate(() => [...document.querySelectorAll('.gwe-tabs [role="tab"]')].map((b) => b.dataset.tab).join(',') === 'overview,features,net,inet,dns,cache,edge,mqtt'));
        step('net: tab Funktionen opens', await goTab(page, GW, 'features'));
        step('net: switches for watch, internet, presence, UPS, edge; Zigbee and LAN discovery from what exists', await until(page, () => {
          const f = (k) => document.querySelector(`#gwe-tabpanel .gwn-features [data-feature="${k}"]`);
          return ['netwatch', 'inetq', 'presence', 'ups', 'edge', 'lan'].every((k) => f(k) && f(k).querySelector('[role="switch"]'))
            && f('zigbee') && !f('zigbee').querySelector('[role="switch"]');
        }));
        step('net: the rows sit in their groups (Heimnetz im Blick, Internet & Strom, Erweiterungen)', await page.evaluate(() => {
          const g = (k, f) => !!document.querySelector(`[data-fgroup="${k}"] [data-feature="${f}"]`);
          return g('home', 'netwatch') && g('home', 'presence') && g('home', 'lan') && g('power', 'inetq') && g('power', 'ups') && g('ext', 'edge') && g('ext', 'zigbee');
        }));
        step('net: hardware line and the Pi 3 B+ hint (about 300 Mbit/s)', await page.evaluate(() => {
          const p = document.getElementById('gwe-tabpanel');
          return /Raspberry Pi 3 Model B Plus/.test(p.querySelector('.gwn-hwline').textContent) && /300 Mbit\/s/.test(p.textContent) && !/\b90 Mbit/.test(p.textContent);
        }));
        step('net: memory summary bar on top of the tab', await visible(page, '#gwe-tabpanel .gwn-membar .gwn-membar-bar'));
        step('net: badge "2 neu" on the tab Netzwerk, "n an" on Funktionen', await until(page, () => /2/.test((document.querySelector('[data-gwe-badge="net"]') || {}).textContent || '')
          && /\d/.test((document.querySelector('[data-gwe-badge="features"]') || {}).textContent || '')));
        await view(page, 'gwnet-features-dark');

        // UPS switch without an address → dialog; wrong address → message; right one → on
        await page.click('.gwn-features [data-fk="gwn-f-ups"]');
        step('net: UPS switch without an address opens the dialog, focus on the address', await until(page, () => document.activeElement && document.activeElement.id === 'gwn-u-host'));
        await page.fill('#gwn-u-host', '8.8.8.8');
        await page.click('.gwn-upsdlg .gcd-foot .btn-primary');
        step('net: a public address is refused in the dialog', await until(page, () => { const e = document.querySelector('.gwn-upsdlg .gwe-err'); return e && !e.hidden && e.textContent.length > 10; }));
        await page.fill('#gwn-u-host', '192.168.1.10');
        await page.click('.gwn-upsdlg .gcd-foot .btn-primary');
        step('net: UPS switched on (real PUT)', await until(page, () => !document.querySelector('.gwn-upsdlg') && (document.querySelector('.gwn-features [data-fk="gwn-f-ups"]') || {}).getAttribute
          && document.querySelector('.gwn-features [data-fk="gwn-f-ups"]').getAttribute('aria-checked') === 'true'));
        const cfg = await api(page, 'GET', `/api/v1/gateways/${GW}/features`);
        step('net: the API has the UPS address', cfg.status === 200 && cfg.body.gateway.features.ups.host === '192.168.1.10' && cfg.body.gateway.features.ups.enabled === true);

        // ── tab "Netzwerk" ──
        step('net: tab Netzwerk opens', await goTab(page, GW, 'net'));
        step('net: KPIs (devices, new, risky ports, last scan)', await page.evaluate(() => {
          const k = [...document.querySelectorAll('.gwn-kpis .gwn-kpi')];
          return k.length === 4 && /^7/.test(k[0].querySelector('.gwn-kpi-v').textContent) && k[1].querySelector('.gwn-kpi-v').textContent.trim() === '2'
            && k[2].querySelector('.gwn-kpi-v').textContent.trim() === '1';
        }));
        step('net: "Neu im Heimnetz" lists the two new devices', await page.evaluate(() => document.querySelectorAll('.gwn-newcard .gwn-newrow').length === 2));
        step('net: device table in a scroll box, telnet marked, the risk explained', await page.evaluate(() => {
          const wrap = document.querySelector('.gwn-listcard .gwn-scroll[role="region"]');
          const rows = wrap ? wrap.querySelectorAll('tbody tr') : [];
          return rows.length === 7 && !!wrap.querySelector('tr[data-device="30:05:5c:11:22:33"] .gwn-port-risk')
            && !wrap.querySelector('tr[data-device="00:11:32:aa:bb:01"] .gwn-port-risk')
            && /23/.test((document.querySelector('.gwn-risks .gwe-note') || {}).textContent || '');
        }));
        await view(page, 'gwnet-net-dark');
        await page.fill('#gwn-q', 'brother');
        step('net: search narrows the list', await until(page, () => document.querySelectorAll('.gwn-listcard tbody tr').length === 1));
        await page.fill('#gwn-q', '');
        await page.selectOption('#gwn-filter', 'new');
        step('net: filter "Neu"', await until(page, () => document.querySelectorAll('.gwn-listcard tbody tr').length === 2));
        await page.selectOption('#gwn-filter', 'all');

        // new device → "Ist meins"
        await page.click('.gwn-newcard [data-fk^="look:"]');
        step('net: "Neues Gerät" dialog with the facts, focus on the name', await until(page, () => document.activeElement && document.activeElement.id === 'gwn-d-name' && document.querySelector('.gwn-dlg .gwn-facts')));
        await page.waitForTimeout(400);
        await shot(page, 'gwnet-newdevice-dark', false);
        await page.fill('#gwn-d-name', 'Wetterstation Balkon');
        await until(page, () => document.querySelectorAll('#gwn-d-owner option').length > 2);
        await page.click('.gwn-dlg .gwn-foot-r .btn-primary');
        step('net: "Ist meins – bestätigen" saves (real PUT); one new device left', await until(page, () => !document.querySelector('.gwn-dlg')
          && document.querySelectorAll('.gwn-newcard .gwn-newrow').length === 1 && /Wetterstation Balkon/.test(document.querySelector('.gwn-listcard tbody').textContent)));

        // edit a device: presence only with an owner
        await page.click('.gwn-listcard tr[data-device="3c:22:fb:00:00:02"] [data-fk^="edit:"]');
        step('net: edit dialog: "zählt für Anwesenheit" disabled without an owner', await until(page, () => { const c = document.getElementById('gwn-d-presence'); return c && c.disabled; }));
        await page.selectOption('#gwn-d-owner', String(FIXTURES.users.member));
        step('net: with an owner it can be ticked', await until(page, () => !document.getElementById('gwn-d-presence').disabled));
        await page.check('#gwn-d-presence');
        await page.click('.gwn-dlg .gwn-foot-r .btn-primary');
        step('net: owner and presence saved (row shows it)', await until(page, () => /Anwesenheit|presence/.test((document.querySelector('.gwn-listcard tr[data-device="3c:22:fb:00:00:02"] td:nth-child(3)') || {}).textContent || '')));
        await page.click('.gwn-listcard tr[data-device="f0:9f:c2:00:00:07"] [data-fk^="edit:"]');
        await until(page, () => document.querySelector('.gwn-dlg'));
        await page.keyboard.press('Escape');
        step('net: Escape closes the dialog', await until(page, () => !document.querySelector('.gwn-dlg')));

        // "Jetzt scannen": no gateway behind the tunnel address here → message (502 expected)
        await page.click('[data-fk="gwn-scan"]');
        step('net: "Jetzt scannen" without a reachable gateway → in-app message', await until(page, () => document.querySelector('.gcd-dialog .gcd-msg'), null, 15000));
        await page.keyboard.press('Escape');
        allow((p) => p.kind === 'http' && p.status === 502 && /\/netwatch\/scan$/.test(p.url));
        // the existing card "Gefundene Geräte" asks /discovered, which the seed licence does not cover (not phase 3a)
        allow((p) => p.kind === 'http' && p.status === 403 && /\/discovered$/.test(p.url));
        allow((p) => p.kind === 'console' && /403/.test(p.text));
        allow((p) => p.kind === 'console' && /502/.test(p.text));

        // ── tab "Internet" ──
        step('net: tab Internet opens', await goTab(page, GW, 'inet'));
        step('net: now, speed, UPS cards', await until(page, () => {
          const t = document.getElementById('gwe-tabpanel').textContent;
          return document.querySelectorAll('.gwn-grid3 > .gwe-card').length === 3 && /248/.test(t) && /APC Back-UPS 700/.test(t);
        }));
        step('net: the chart is an image with a text alternative, the outage band drawn', await page.evaluate(() => {
          const c = document.querySelector('.gwn-chart[role="img"]');
          return c && c.getAttribute('aria-label').length > 30 && c.querySelectorAll('polyline.gwn-line').length >= 1 && c.querySelectorAll('rect.gwn-band').length >= 1;
        }));
        step('net: outages with cause', await page.evaluate(() => document.querySelectorAll('.gwn-rows .gwn-row').length >= 2));
        await view(page, 'gwnet-inet-dark');
        await page.click('[data-fk="range:7d"]');
        step('net: 7 days (aria-pressed, hourly values)', await until(page, () => (document.querySelector('[data-fk="range:7d"]') || {}).getAttribute && document.querySelector('[data-fk="range:7d"]').getAttribute('aria-pressed') === 'true'));
        await page.click('[data-fk="gwn-astable"]');
        step('net: table view of the values', await until(page, () => document.querySelectorAll('.gwn-htable tbody tr').length >= 1));
        await page.click('[data-fk="gwn-astable"]');
        await page.click('[data-fk="range:24h"]');
        await page.selectOption('#gwn-plan', 'hourly');
        step('net: speed-test plan saved (real PUT)', (await (async () => {
          for (let i = 0; i < 20; i++) {
            const r = await api(page, 'GET', `/api/v1/gateways/${GW}/features`);
            if (r.body && r.body.gateway.features.inetq.speedtest === 'hourly') return true;
            await page.waitForTimeout(200);
          }
          return false;
        })()));
        const pull = await page.request.fetch(BASE + '/api/v1/gateway/config', { headers: { Authorization: 'Bearer ' + token } });
        const pj = await pull.json();
        step('net: the gateway pulls the new plan and the UPS address', pj.features && pj.features.inetq.speedtest === 'hourly' && pj.features.ups.host === '192.168.1.10');

        // ── light, 390 px ──
        await theme(page, 'light');
        await view(page, 'gwnet-inet-light');
        await page.setViewportSize({ width: 390, height: 900 });
        await fresh(page);
        for (const tab of ['overview', 'features', 'net', 'inet']) {
          await goTab(page, GW, tab);
          await page.waitForTimeout(400);
          const o = await overflow(page);
          step(`net: 390 px, tab ${tab}: no sideways scroll`, o <= 0, 'overflow ' + o);
          await view(page, `gwnet-${tab}-390-light`, 2400);
        }
        await theme(page, 'dark');
        await goTab(page, GW, 'net');
        await page.waitForTimeout(300);
        await view(page, 'gwnet-net-390-dark', 2400);
        await page.setViewportSize({ width: 1440, height: 1000 });
        allow((p) => p.kind === 'http' && p.status === 403 && /\/discovered$/.test(p.url));
        allow((p) => p.kind === 'console' && /403/.test(p.text));
      } finally {
        await api(page, 'POST', '/api/v1/settings/language', { language: lang0 }).catch(() => {});
        // the gateway as the seed left it (token, "never reported")
        withDb((db) => {
          if (old) db.prepare('UPDATE gateway_meta SET api_token_hash = ?, last_health = ?, last_seen_at = ?, first_seen_at = ? WHERE peer_id = ?')
            .run(old.api_token_hash, old.last_health, old.last_seen_at, old.first_seen_at, GW);
        });
      }
    },
  };
};
