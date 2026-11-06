'use strict';

// Gateways › detail › tabs "DNS-Filter" and "Zwischenspeicher" and their rows
// in the card "Funktionen dieses Gateways" (public/js/gateway-home.js, phase 3b).
//
// No mocks: the seeded gateway "e2e-gw-home" gets a known gateway token in the
// test database and reports like a real gateway through the gateway API —
// heartbeat (Raspberry Pi 4 with a USB drive, DNS filter running on port 53,
// home cache with its certificate fingerprint), the network watch (the
// family's devices), the DNS statistics, a speed test, the home cache's
// stock. The admin side then works with the real admin API: switch the
// filter on, a new profile "Kinder" (a person from the picker, a list, safe
// search, a time Mo–Fr 21–07, an own exception) → the config pull carries the
// person's MACs, the dialog "Router einstellen" (FRITZ!Box / Speedport, the
// check), the exceptions, forwarding (wrong address → message), "Test: Domain
// prüfen" and "Zwischenspeicher leeren" reach no gateway here (502, expected),
// the home cache (switch on, the USB suggestion, size). Light/dark, 390 px
// without sideways scroll.

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
const TIM = 'da:a1:19:00:00:05';
const TIM_TAB = 'da:a1:19:00:00:06';
const UPD_SHA = 'a1'.repeat(32);

function devices(now) {
  const d = (mac, ip, vendor, hostname, extra) => ({ mac, ip, vendor, hostname, randomMac: false, online: true, firstSeen: now - 40 * 24 * 60 * MIN, lastSeen: now - MIN, ports: [], ...extra });
  return [
    d('00:11:32:aa:bb:01', '192.168.1.10', 'Synology', 'diskstation'),
    d('30:05:5c:11:22:33', '192.168.1.40', 'Brother', 'BRN30055C'),
    d('a8:23:fe:44:55:66', '192.168.1.55', 'LG Electronics', 'LGwebOSTV'),
    d('3c:22:fb:00:00:02', '192.168.1.104', 'Apple', 'Marcs-iPhone'),
    d(TIM, '192.168.1.120', 'Samsung', 'Galaxy-A14'),
    d(TIM_TAB, '192.168.1.121', 'Apple', 'Tims-iPad'),
    d('f0:9f:c2:00:00:01', '192.168.1.1', 'AVM', 'fritz.box'),
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
  const view = async (page, name, height) => {
    const vp = page.viewportSize();
    await page.setViewportSize({ width: vp.width, height: height || 1500 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await shot(page, name, false);
    await page.setViewportSize(vp);
  };
  const dialogShot = async (page, name) => { await page.waitForTimeout(300); await shot(page, name, false); };
  const fresh = (page) => page.evaluate(() => {
    for (const k of ['GCGatewayHome', 'GCGatewayNet']) {
      const c = window[k] && window[k]._cache;
      if (c) Object.keys(c).forEach((x) => { Object.keys(c[x]).forEach((y) => delete c[x][y]); });
    }
  });

  return {
    async gatewayhome(page) {
      const GW = FIXTURES.gateways.home;
      const member = FIXTURES.users.member;
      const ping = await page.request.fetch(BASE + '/api/v1/ping');
      if (ping.status() !== 200) await ctx.login(page);
      await page.setViewportSize({ width: 1440, height: 1000 });

      const token = 'gc_gw_' + crypto.randomBytes(32).toString('hex');
      const hash = 'sha256:' + crypto.createHash('sha256').update(token).digest('hex');
      const old = withDb((db) => {
        db.prepare("UPDATE peers SET enabled = 1 WHERE id = ? AND peer_type = 'gateway'").run(GW);
        const r = db.prepare('SELECT api_token_hash, last_health, last_seen_at, first_seen_at FROM gateway_meta WHERE peer_id = ?').get(GW);
        db.prepare('UPDATE gateway_meta SET api_token_hash = ? WHERE peer_id = ?').run(hash, GW);
        for (const t of ['netwatch_devices', 'inetq_speedtests', 'gateway_features', 'gateway_dns', 'dns_stats_day', 'dns_reports', 'gateway_cache', 'home_cache_have', 'cache_stats_day']) db.prepare(`DELETE FROM ${t} WHERE peer_id = ?`).run(GW);
        db.prepare('DELETE FROM home_cache_blobs').run();
        // an app update in the server's stock (the file itself is not needed for the page)
        db.prepare("INSERT INTO home_cache_blobs (sha256, size, kind, source, ref, file, priority, label, created_at, updated_at) VALUES (?, 74000000, 'updates', 'update', 'android:1:x', '/nonexistent', 80, 'android 1.81.0', ?, ?)")
          .run(UPD_SHA, Date.now(), Date.now());
        return r || null;
      });
      step('home: seeded gateway prepared with a known token', !!(old && old.api_token_hash));
      const gw = async (p, body) => {
        const r = await page.request.fetch(BASE + '/api/v1/gateway' + p, { method: 'POST', data: body, headers: { Authorization: 'Bearer ' + token } });
        return r.status();
      };
      const pullCfg = async () => (await page.request.fetch(BASE + '/api/v1/gateway/config', { headers: { Authorization: 'Bearer ' + token } })).json();
      await page.goto(BASE + '/gateways');
      const lang0 = await page.evaluate(() => document.documentElement.lang || 'en');
      const langSet = await api(page, 'POST', '/api/v1/settings/language', { language: 'de' });
      step('home: page in German for the run', langSet.status === 200, 'status ' + langSet.status);
      try {
        const now = Date.now();
        const hb = await gw('/heartbeat', { uptime_s: 3600, telemetry: {
          gateway_version: '1.22.0', node_version: 'v22.22.0', cpu_cores: 4, mem_total: 4 * 1024 ** 3, mem_used: 900 * 1024 ** 2,
          hardware: { model: 'Raspberry Pi 4 Model B Rev 1.4', cpu_cores: 4, mem_total: 4 * 1024 ** 3, storage: { total: 30e9, free: 22e9 }, radios: [] },
          lan_ip: '192.168.1.23', default_gateway_ip: '192.168.1.1', state_dir_writable: true,
          capabilities: ['netwatch', 'inetq', 'presence', 'ups', 'dns', 'cache'],
          storage: [{ mount: '/', fs: 'ext4', sizeBytes: 32e9, freeBytes: 21e9, removable: false, origin: 'host' }, { mount: '/media/usb-cache', fs: 'ext4', sizeBytes: 500e9, freeBytes: 412e9, removable: true, origin: 'host' },
            { mount: '/cache', fs: 'ext4', sizeBytes: 32e9, freeBytes: 21e9, removable: false, origin: 'container' }],
          features: {
            dns: { enabled: true, running: true, state: 'running', listen: ['192.168.1.23', 'fe80::ba27:ebff:fe12:3456', 'fd00::ba27:ebff:fe12:3456'], lastError: null },
            cache: { enabled: true, running: true, state: 'running', port: 8443, urls: ['https://192.168.1.23:8443'], tlsSha256: 'AB:'.repeat(31) + 'AB', usedBytes: 18.4e9, freeBytes: 21e9 },
          },
        } });
        step('home: heartbeat with DNS filter, home cache and a USB drive (gateway API)', hb === 200);
        step('home: the family\'s devices (network watch)', await gw('/netwatch', { scanAt: now - 5 * MIN, full: true, devices: devices(now) }) === 200);
        const owner = await Promise.all([TIM, TIM_TAB].map(async (mac) => {
          const list = await api(page, 'GET', `/api/v1/gateways/${GW}/netwatch`);
          const d = list.body.devices.find((x) => x.mac === mac);
          return api(page, 'PUT', `/api/v1/gateways/${GW}/netwatch/devices/${d.id}`, { name: mac === TIM ? 'Handy Kind' : 'Tablet Kind', ownerUserId: member });
        }));
        step('home: two devices belong to a person', owner.every((r) => r.status === 200));
        step('home: a speed test (for "schneller als Server")', await gw('/inetq', { samples: [], outages: [], speedtests: [{ at: now - 60 * MIN, downMbps: 100, upMbps: 40, bytes: 3e8 }] }) === 200);

        // ── tab "Funktionen": the rows of phase 3b ──
        await page.goto(`${BASE}/gateways#gw/${GW}/features`);
        // only the hash changed: load the page again so it comes in German
        await page.reload();
        await theme(page, 'dark');
        step('home: nine tabs with Funktionen, DNS-Filter, Zwischenspeicher and Funk', await until(page, () => [...document.querySelectorAll('.gwe-tabs [role="tab"]')].map((b) => b.dataset.tab).join(',') === 'overview,features,net,inet,dns,cache,radio,edge,mqtt'));
        step('home: switched-off functions: their tabs muted with "· aus"', await until(page, () => {
          const off = (t) => { const b = document.getElementById('gwe-tab-' + t); return b && b.classList.contains('gwe-tab-is-off') && !b.querySelector('[data-gwe-off]').hidden; };
          return off('dns') && off('cache');
        }));
        step('home: the tab "Funktionen" has DNS filter, home cache (switches, card "Für das ganze Heimnetz") and the local time', await until(page, () => {
          const f = (k) => document.querySelector(`.gwn-features [data-feature="${k}"]`);
          if (!document.querySelector('[data-fgroup="wide"] [data-feature="dns"]') || !document.querySelector('[data-fgroup="system"] [data-feature="timezone"]')) return false;
          return f('dns') && f('dns').querySelector('[role="switch"]') && f('cache') && f('cache').querySelector('[role="switch"]') && f('timezone') && !f('timezone').querySelector('[role="switch"]');
        }));
        step('home: the rows link to the user guide (chapter 5)', await page.evaluate(() => {
          const g = (k) => document.querySelector(`.gwn-features [data-feature="${k}"] a[data-guide="feat.${k}"]`);
          return ['netwatch', 'dns', 'cache'].every((k) => g(k) && /\/docs\/(handbuch\/05-funktionen|guide\/05-features)\.md#/.test(g(k).href) && g(k).target === '_blank');
        }));
        step('home: the time zone row explains that TZ on the gateway is not needed', await page.evaluate(() => /TZ/.test(document.querySelector('.gwn-features [data-feature="timezone"]').textContent)));

        // ── tab "DNS-Filter": off → on ──
        step('home: tab DNS-Filter opens', await goTab(page, GW, 'dns'));
        step('home: switched off → "DNS-Filter ist aus" with a button', await visible(page, '#gwe-tabpanel .gwe-big button.btn-primary'));
        await page.click('#gwe-tabpanel .gwe-big button.btn-primary');
        step('home: switched on (real PUT) → the status card with its switch', await until(page, () => { const s = document.querySelector('#gwe-tabpanel [data-fk="gwh-dns-sw"]'); return s && s.getAttribute('aria-checked') === 'true'; }));
        const t0 = Date.now() - 20 * MIN;
        const rep = (from, extra) => ({ period: { from, to: from + 5 * MIN }, queries: 24105, blocked: 4340, cached: 14700, avgMs: 4,
          topBlocked: [{ domain: 'doubleclick.net', count: 1706, profileId: 'default' }, { domain: 'app-measurement.com', count: 1490, profileId: 'default' }, { domain: 'samsungads.com', count: 602, profileId: 'default' }],
          byProfile: { default: { queries: 20000, blocked: 4000 } }, clientsSeen: ['3c:22:fb:00:00:02', TIM, '00:11:32:aa:bb:01'], ...extra });
        step('home: DNS statistics (two reports)', await gw('/dns', rep(t0)) === 200 && await gw('/dns', rep(t0 + 5 * MIN)) === 200);
        await fresh(page);
        await goTab(page, GW, 'overview');
        await goTab(page, GW, 'dns');
        step('home: KPIs (queries, filtered, response time, cache)', await until(page, () => {
          const k = [...document.querySelectorAll('#gwe-tabpanel .gwn-kpis .gwn-kpi')];
          return k.length === 4 && /48[.,\u202f ]?210/.test(k[0].textContent) && /18/.test(k[1].textContent) && /4 ms/.test(k[2].textContent) && /61/.test(k[3].textContent);
        }));
        step('home: status "aktiv · 3 Geräte", the router line with the gateway\'s address', await page.evaluate(() => {
          const t = document.querySelector('.gwh-status').textContent;
          return /3/.test(t) && /192\.168\.1\.23/.test(document.querySelector('.gwh-routerline').textContent);
        }));
        step('home: most filtered today', await page.evaluate(() => document.querySelectorAll('#gwe-tabpanel .gwh-li .gwh-dom').length === 3));
        await view(page, 'gwhome-dns-dark');

        // new profile "Kinder"
        await page.click('[data-fk="gwh-prof-new"]');
        step('home: dialog "Neues Profil", focus on the name', await until(page, () => document.activeElement && document.activeElement.id === 'gwh-p-name'));
        await page.fill('#gwh-p-name', 'Kinder');
        await page.click('.gwh-profdlg [aria-controls="gwh-p-picker"]');
        step('home: the picker lists people and the network watch\'s devices', await until(page, ([m]) => document.getElementById('gwh-pd-u' + m) && document.querySelectorAll('.gwh-picker input[id^="gwh-pd-d"]').length === 7, [member]));
        await page.check('#gwh-pd-u' + member);
        step('home: the chip shows the person with 2 devices', await until(page, () => /2/.test((document.querySelector('.gwh-profdlg .gwh-chips') || {}).textContent || '')));
        await page.check('#gwh-pl-adult');
        await page.check('#gwh-p-safe');
        await page.click('.gwh-profdlg .gwh-addtime');
        step('home: the time editor (days as toggles, from/to, categories)', await until(page, () => document.querySelector('.gwh-sched-ed .gwh-days') && document.querySelector('.gwh-sched-ed input[type="time"]')));
        step('home: "über Mitternacht" for 21:00–07:00', await page.evaluate(() => (document.querySelector('.gwh-overnight') || {}).textContent.length > 5));
        await dialogShot(page, 'gwhome-profile-dark');
        await page.click('.gwh-sched-ed .btn-primary');
        step('home: the time is in the list (Mo–Fr 21:00 – 07:00)', await until(page, () => /(Mo–Fr|Mon–Fri) 21:00 – 07:00/.test((document.querySelector('.gwh-rules') || {}).textContent || '')));
        await page.fill('#gwh-p-allow', 'anton.app\n*.schulportal.hessen.de');
        await page.click('.gwh-profdlg .gwn-foot-r .btn-primary');
        step('home: profile saved (real POST), the row shows it', await until(page, () => !document.querySelector('.gwh-profdlg') && document.querySelectorAll('#gwe-tabpanel .gwh-prof').length === 2));
        const cfg1 = await pullCfg();
        const kids = cfg1.features && cfg1.features.dns && cfg1.features.dns.profiles.find((p) => p.name === 'Kinder');
        step('home: the gateway pulls the profile with the person\'s MACs, list, safe search, time, exception',
          !!kids && kids.macs.join() === [TIM, TIM_TAB].sort().join() && kids.lists.includes('adult') && kids.safeSearch === true
          && kids.schedules.length === 1 && kids.schedules[0].from === '21:00' && kids.allow.some((x) => x === 'anton.app'), JSON.stringify(kids));
        step('home: features.timezone in the pull', typeof cfg1.features.timezone === 'string' && cfg1.features.timezone.length > 1);

        // a wrong domain in the profile → message from the server
        await page.click('#gwe-tabpanel .gwh-prof[data-profile="' + kids.id + '"] [data-fk^="gwh-prof:"]');
        await until(page, () => document.getElementById('gwh-p-deny'));
        await page.fill('#gwh-p-deny', 'kaputt!.de');
        await page.click('.gwh-profdlg .gwn-foot-r .btn-primary');
        step('home: an invalid domain → the dialog says which one', await until(page, () => { const e = document.querySelector('.gwh-profdlg .gwe-err'); return e && !e.hidden && e.textContent.length > 10; }));
        await page.keyboard.press('Escape');
        await until(page, () => !document.querySelector('.gwh-profdlg'));
        allow((p) => p.kind === 'http' && p.status === 400 && /\/dns\/profiles\//.test(p.url));
        allow((p) => p.kind === 'console' && /400/.test(p.text));

        // router dialog
        await page.click('[data-fk="gwh-router"]');
        step('home: router dialog: FRITZ!Box steps with IPv4 and the ULA IPv6 address, copy buttons', await until(page, () => {
          const d = document.querySelector('.gwh-routerdlg');
          return d && /192\.168\.1\.23/.test(d.textContent) && /fd00::ba27:ebff:fe12:3456/.test(d.textContent) && !/fe80::/.test(d.textContent) && d.querySelectorAll('.gwh-copy').length >= 2;
        }));
        step('home: the check: answers, 3 devices ask, 3 online devices not yet (not the router)', await page.evaluate(() => {
          const c = document.querySelectorAll('.gwh-routerdlg .gwh-ck');
          return c.length === 3 && c[0].classList.contains('gwh-ck-ok') && c[1].classList.contains('gwh-ck-ok') && c[2].classList.contains('gwh-ck-warn') && /3/.test(c[2].textContent);
        }));
        await dialogShot(page, 'gwhome-router-dark');
        await page.selectOption('#gwh-r-type', 'speedport');
        step('home: Speedport: the honest note first', await until(page, () => /Speedport/.test((document.querySelector('.gwh-routerdlg .gwe-note') || {}).textContent || '')));
        await page.selectOption('#gwh-r-type', 'fritzbox');
        await page.keyboard.press('Escape');
        step('home: Escape closes the dialog', await until(page, () => !document.querySelector('.gwh-routerdlg')));

        // exceptions for every profile
        await page.click('[data-fk="gwh-allow"]');
        await until(page, () => document.querySelector('.gwh-allowdlg .gwh-quick button'));
        await page.click('.gwh-allowdlg .gwh-quick button');
        await page.click('.gwh-allowdlg .gcd-foot .btn-primary');
        await until(page, () => !document.querySelector('.gwh-allowdlg'));
        const cfg2 = await pullCfg();
        step('home: an exception for all from the top list → in every profile\'s allow', cfg2.features.dns.profiles.every((p) => p.allow.some((x) => x === 'doubleclick.net')));

        // forwarding: custom over http → message; Cloudflare → saved
        await page.click('[data-fk="gwh-up"]');
        await until(page, () => document.querySelector('.gwh-updlg'));
        await page.check('#gwh-up-custom');
        await page.fill('#gwh-up-url', 'http://dns.example/dns-query');
        await page.click('.gwh-updlg .gcd-foot .btn-primary');
        step('home: forwarding: only https is accepted', await until(page, () => { const e = document.querySelector('.gwh-updlg .gwe-err'); return e && !e.hidden; }));
        await page.check('#gwh-up-cloudflare');
        await page.click('.gwh-updlg .gcd-foot .btn-primary');
        step('home: forwarding to Cloudflare saved', await until(page, () => !document.querySelector('.gwh-updlg') && /Cloudflare/.test(document.querySelector('#gwe-tabpanel').textContent)));

        // "Domain prüfen": no gateway behind the tunnel address here → message (502 expected)
        await page.click('[data-fk="gwh-test"]');
        await until(page, () => document.getElementById('gwh-t-dom'));
        await page.fill('#gwh-t-dom', 'tiktok.com');
        await page.click('.gwh-testdlg .gcd-foot .btn-primary');
        step('home: "Domain prüfen" without a reachable gateway → message in the dialog', await until(page, () => { const e = document.querySelector('.gwh-testdlg .gwe-err'); return e && !e.hidden; }, null, 15000));
        await page.keyboard.press('Escape');
        allow((p) => p.kind === 'http' && p.status === 502 && /\/dns\/test$|\/cache\/clear$/.test(p.url));
        allow((p) => p.kind === 'http' && p.status === 403 && /\/discovered$/.test(p.url));
        allow((p) => p.kind === 'console' && /403|502/.test(p.text));

        // ── tab "Zwischenspeicher" ──
        step('home: tab Zwischenspeicher opens', await goTab(page, GW, 'cache'));
        step('home: switched off → button; the Pi note names the USB drive', await until(page, () => document.querySelector('#gwe-tabpanel .gwe-big button.btn-primary') && /usb-cache/.test(document.getElementById('gwe-tabpanel').textContent)));
        await page.click('#gwe-tabpanel .gwe-big button.btn-primary');
        step('home: switched on (real PUT)', await until(page, () => { const s = document.querySelector('[data-fk="gwh-cache-sw"]'); return s && s.getAttribute('aria-checked') === 'true'; }));
        step('home: four kinds with switches, vault off', await page.evaluate(() => {
          const rows = [...document.querySelectorAll('#gwe-tabpanel [data-kind]')];
          return rows.length === 4 && rows.find((r) => r.dataset.kind === 'vault').querySelector('[role="switch"]').getAttribute('aria-checked') === 'false';
        }));
        const cc = await pullCfg();
        step('home: the gateway pulls the cache with its volume /cache and a secret', cc.features.cache.enabled === true && cc.features.cache.path === '/cache' && /^[0-9a-f]{64}$/.test(cc.features.cache.secret));
        step('home: the storage card explains CACHE_DIR in settings.txt with the USB suggestion to copy', await page.evaluate(() => {
          const t = (document.querySelector('#gwe-tabpanel .gwh-folder') || {}).textContent || '';
          return /CACHE_DIR/.test(t) && /CACHE_DIR=\/media\/usb-cache\/gatecontrol-cache/.test(document.getElementById('gwe-tabpanel').textContent);
        }));
        step('home: the secret is never in the admin page', await page.evaluate((s) => !document.documentElement.outerHTML.includes(s), cc.features.cache.secret));
        step('home: the gateway reports what it holds and served', await gw('/cache', { have: [UPD_SHA], usedBytes: 18.4e9, hits: 18, misses: 7, bytesServed: 3.4e9, bytesFetched: 0.7e9 }) === 200);
        await fresh(page);
        await goTab(page, GW, 'overview');
        await goTab(page, GW, 'cache');
        step('home: KPIs: used of the limit, from the home network, saved today, faster', await until(page, () => {
          const k = [...document.querySelectorAll('#gwe-tabpanel .gwn-kpis .gwn-kpi')];
          return k.length === 4 && /18[,.]4 GB/.test(k[0].textContent) && /72/.test(k[1].textContent) && /3[,.]4 GB/.test(k[2].textContent) && /9[,.]4/.test(k[3].textContent);
        }));
        await page.selectOption('#gwh-c-max', String(50 * 1024 ** 3));
        step('home: size limit saved (real PUT)', (await (async () => {
          for (let i = 0; i < 20; i++) {
            const r = await api(page, 'GET', `/api/v1/gateways/${GW}/cache`);
            if (r.body && r.body.settings.maxBytes === 50 * 1024 ** 3) return true;
            await page.waitForTimeout(200);
          }
          return false;
        })()));
        await until(page, () => document.querySelector('[data-fk="gwh-c-clear"]') && !document.querySelector('#gwe-tabpanel .gwe-loading'));
        await view(page, 'gwhome-cache-dark');
        await page.click('[data-fk="gwh-c-clear"]');
        await until(page, () => document.querySelector('.gcd-dialog .btn-danger, .gcd-dialog .btn-primary'));
        await page.click('.gcd-dialog .gcd-foot button:last-child');
        step('home: "Zwischenspeicher leeren" without a reachable gateway → in-app message', await until(page, () => document.querySelector('.gcd-dialog .gcd-msg'), null, 15000));
        await page.keyboard.press('Escape');
        allow((p) => p.kind === 'http' && p.status === 502 && /\/cache\/clear$/.test(p.url));
        allow((p) => p.kind === 'console' && /502/.test(p.text));

        // the tab "Funktionen" shows both switched on, with their memory share; the tabs are no longer muted
        await goTab(page, GW, 'features');
        step('home: the tab "Funktionen" shows both switched on (≈ MB next to them)', await until(page, () => {
          const f = (k) => document.querySelector(`.gwn-features [data-feature="${k}"] [role="switch"]`);
          const mem = (k) => document.querySelector(`.gwn-features [data-feature="${k}"] .gwn-fr-mem`);
          return f('dns') && f('dns').getAttribute('aria-checked') === 'true' && f('cache') && f('cache').getAttribute('aria-checked') === 'true' && mem('dns') && mem('cache')
            && !document.getElementById('gwe-tab-dns').classList.contains('gwe-tab-is-off');
        }));
        await view(page, 'gwhome-features-dark');
        await goTab(page, GW, 'overview');
        step('home: the overview card "Funktionen" lists DNS filter and home cache as on', await until(page, () => !!document.querySelector('.gwn-fsum [data-fon="dns"]') && !!document.querySelector('.gwn-fsum [data-fon="cache"]')));
        await view(page, 'gwhome-overview-dark');

        // ── light, 390 px ──
        await theme(page, 'light');
        await goTab(page, GW, 'dns');
        await view(page, 'gwhome-dns-light');
        await goTab(page, GW, 'cache');
        await view(page, 'gwhome-cache-light');
        await page.setViewportSize({ width: 390, height: 900 });
        await fresh(page);
        for (const tab of ['overview', 'features', 'dns', 'cache']) {
          await goTab(page, GW, tab);
          await page.waitForTimeout(400);
          const o = await overflow(page);
          step(`home: 390 px, tab ${tab}: no sideways scroll`, o <= 0, 'overflow ' + o);
          await view(page, `gwhome-${tab}-390-light`, 2600);
        }
        await goTab(page, GW, 'dns');
        await page.click('[data-fk="gwh-router"]');
        await until(page, () => document.querySelector('.gwh-routerdlg'));
        step('home: 390 px, router dialog: no sideways scroll', (await overflow(page)) <= 0);
        await dialogShot(page, 'gwhome-router-390-light');
        await page.keyboard.press('Escape');
        await theme(page, 'dark');
        await goTab(page, GW, 'dns');
        await page.waitForTimeout(300);
        await view(page, 'gwhome-dns-390-dark', 2600);
        await page.setViewportSize({ width: 1440, height: 1000 });
        allow((p) => p.kind === 'http' && p.status === 403 && /\/discovered$/.test(p.url));
        allow((p) => p.kind === 'console' && /403/.test(p.text));
      } finally {
        await api(page, 'POST', '/api/v1/settings/language', { language: lang0 }).catch(() => {});
        withDb((db) => {
          if (old) db.prepare('UPDATE gateway_meta SET api_token_hash = ?, last_health = ?, last_seen_at = ?, first_seen_at = ? WHERE peer_id = ?')
            .run(old.api_token_hash, old.last_health, old.last_seen_at, old.first_seen_at, GW);
          db.prepare('DELETE FROM home_cache_blobs WHERE sha256 = ?').run(UPD_SHA);
        });
      }
    },
  };
};
