'use strict';

// Gateways › detail › tab "Funktionen" › group "Geräte im Heimnetz" › row
// "Drucken & Scannen" (public/js/gateway-net.js printRow, phase 3c).
//
// No mocks: the seeded gateway "e2e-gw-home" gets a known gateway token and
// reports like a real gateway — first as 1.23.0 without the capability
// `print` ("Gateway zu alt – ab 1.24.0", switch off and disabled), then as
// 1.24.0 with it. Switching on is a real PUT; the config pull then carries
// features.print; the gateway reports its devices (printer + scanner, a
// black-and-white printer) and the row names them, with the memory share and
// the way to the plugin (catalogue, not installed here). Light/dark, 390 px
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

const CAPS = ['netwatch', 'inetq', 'presence', 'ups', 'dns', 'cache', 'storage', 'timezone'];

function devices(now) {
  const markers = [['Black', '#000000', 62], ['Cyan', '#00FFFF', 55], ['Magenta', '#FF00FF', 8], ['Yellow', '#FFFF00', 40]]
    .map(([name, color, level]) => ({ name, color, type: 'ink-cartridge', level, low: level < 10 }));
  return [
    { id: 'u:f0d8a1b2000010008000' + '00aabbccddee', name: 'HP OfficeJet 8020', model: 'HP OfficeJet 8020 series', ip: '192.168.1.57', location: 'Wohnzimmer', source: 'mdns', online: true, seenAt: now, problem: null,
      printer: { state: 'idle', reasons: [], color: true, duplex: true, formats: ['application/pdf', 'image/jpeg'], copiesMax: 99, markers },
      scanner: { state: 'idle', platen: true, feeder: true, duplex: false, color: ['bw', 'gray', 'color'], resolutions: [75, 200, 300, 600], formats: ['image/jpeg', 'application/pdf'], adf: 'empty' } },
    { id: 'h:0123456789abcdef', name: 'Brother HL-L2350DW', model: 'Brother HL-L2350DW series', ip: '192.168.1.61', location: 'Arbeitszimmer', source: 'mdns', online: true, seenAt: now, problem: null,
      printer: { state: 'idle', reasons: ['sleep'], color: false, duplex: true, formats: ['image/urf', 'image/jpeg', 'application/pdf'], copiesMax: 99, markers: [{ name: 'Toner', color: '#000000', type: 'toner', level: 80, low: false }] },
      scanner: null },
  ];
}

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, shot, api } = ctx;
  const until = (page, fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const theme = async (page, mode) => {
    await page.evaluate((m) => { try { localStorage.setItem('gc-theme-mode', m); } catch (_) { /* ignore */ } document.documentElement.setAttribute('data-theme', m); }, mode);
    await page.waitForTimeout(150);
  };
  const goFeatures = async (page, id) => {
    await page.evaluate((i) => { location.hash = '#gw/' + i + '/features'; }, id);
    return until(page, () => { const b = document.getElementById('gwe-tab-features'); return b && b.getAttribute('aria-selected') === 'true' && !document.querySelector('#gwe-tabpanel .gwe-loading'); });
  };
  const fresh = (page) => page.evaluate(() => {
    for (const k of ['GCGatewayHome', 'GCGatewayNet']) {
      const c = window[k] && window[k]._cache;
      if (c) Object.keys(c).forEach((x) => { Object.keys(c[x]).forEach((y) => delete c[x][y]); });
    }
  });
  const view = async (page, name, height) => {
    const vp = page.viewportSize();
    await page.setViewportSize({ width: vp.width, height: height || 1500 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await shot(page, name, false);
    await page.setViewportSize(vp);
  };
  const row = '.gwn-features [data-feature="print"]';

  return {
    async gatewayprint(page) {
      const GW = FIXTURES.gateways.home;
      const ping = await page.request.fetch(BASE + '/api/v1/ping');
      if (ping.status() !== 200) await ctx.login(page);
      await page.setViewportSize({ width: 1440, height: 1000 });

      const token = 'gc_gw_' + crypto.randomBytes(32).toString('hex');
      const hash = 'sha256:' + crypto.createHash('sha256').update(token).digest('hex');
      const old = withDb((db) => {
        db.prepare("UPDATE peers SET enabled = 1 WHERE id = ? AND peer_type = 'gateway'").run(GW);
        const r = db.prepare('SELECT api_token_hash, last_health, last_seen_at, first_seen_at, alive FROM gateway_meta WHERE peer_id = ?').get(GW);
        const f = db.prepare('SELECT settings FROM gateway_features WHERE peer_id = ?').get(GW);
        db.prepare('UPDATE gateway_meta SET api_token_hash = ? WHERE peer_id = ?').run(hash, GW);
        db.prepare('DELETE FROM print_devices WHERE peer_id = ?').run(GW);
        return r ? { ...r, features: f ? f.settings : null } : null;
      });
      step('print: seeded gateway prepared with a known token', !!(old && old.api_token_hash));
      const gw = async (p, body) => (await page.request.fetch(BASE + '/api/v1/gateway' + p, { method: 'POST', data: body, headers: { Authorization: 'Bearer ' + token } })).status();
      const heartbeat = (version, caps) => gw('/heartbeat', { uptime_s: 3600, telemetry: {
        gateway_version: version, node_version: 'v20.19.0', cpu_cores: 4, mem_total: 16 * 1024 ** 3, mem_used: 2 * 1024 ** 3,
        hardware: { model: 'Synology DS918+', cpu_cores: 4, mem_total: 16 * 1024 ** 3, storage: { total: 4e12, free: 1.2e12 }, radios: [] },
        lan_ip: '192.168.1.23', default_gateway_ip: '192.168.1.1', state_dir_writable: true, capabilities: caps,
        features: caps.includes('print') ? { print: { enabled: false, running: false, devices: 0 } } : {},
      } });
      await page.goto(BASE + '/gateways');
      const lang0 = await page.evaluate(() => document.documentElement.lang || 'en');
      const langSet = await api(page, 'POST', '/api/v1/settings/language', { language: 'de' });
      step('print: page in German for the run', langSet.status === 200, 'status ' + langSet.status);
      try {
        // ── an older gateway: no capability `print` ──
        step('print: heartbeat of a 1.23.0 gateway (no capability print)', await heartbeat('1.23.0', CAPS) === 200);
        await page.goto(`${BASE}/gateways#gw/${GW}/features`);
        await page.reload();
        await theme(page, 'dark');
        await goFeatures(page, GW);
        step('print: group "Geräte im Heimnetz" with the row "Drucken & Scannen"', await until(page, () => {
          const g = document.querySelector('[data-fgroup="devices"]');
          return g && g.querySelector('[data-feature="print"]') && /Geräte im Heimnetz/.test(g.textContent);
        }));
        step('print: too old → "Gateway zu alt – ab 1.24.0", switch disabled', await page.evaluate((sel) => {
          const r = document.querySelector(sel);
          const sw = r && r.querySelector('[role="switch"]');
          const hint = r && r.querySelector('[data-print-old]');
          return !!sw && sw.disabled && sw.getAttribute('aria-checked') === 'false' && !!hint && /Gateway zu alt – ab 1\.24\.0/.test(hint.textContent);
        }, row));
        step('print: the group comes right after "Heimnetz im Blick"', await page.evaluate(() => {
          const g = [...document.querySelectorAll('[data-fgroup]')].map((x) => x.getAttribute('data-fgroup'));
          return g.indexOf('devices') === g.indexOf('home') + 1;
        }));
        step('print: the row links to the user guide (chapter 5)', await page.evaluate((sel) => {
          const a = document.querySelector(sel + ' a[data-guide="feat.print"]');
          return !!a && /05-funktionen\.md#drucken--scannen$/.test(a.href);
        }, row));
        await view(page, 'gwprint-old-dark');

        // ── 1.24.0 with `print`: switch on (real PUT) ──
        step('print: heartbeat of a 1.24.0 gateway with print', await heartbeat('1.24.0', [...CAPS, 'print']) === 200);
        await fresh(page);
        await page.reload();
        await goFeatures(page, GW);
        step('print: switch enabled and off, no "zu alt"', await until(page, (sel) => {
          const r = document.querySelector(sel);
          const sw = r && r.querySelector('[role="switch"]');
          return !!sw && !sw.disabled && sw.getAttribute('aria-checked') === 'false' && !r.querySelector('[data-print-old]');
        }, row));
        await page.click(row + ' [role="switch"]');
        step('print: switched on (real PUT)', await until(page, (sel) => {
          const sw = document.querySelector(sel + ' [role="switch"]');
          return sw && sw.getAttribute('aria-checked') === 'true';
        }, row));
        const cfg = await (await page.request.fetch(BASE + '/api/v1/gateway/config', { headers: { Authorization: 'Bearer ' + token } })).json();
        step('print: the config pull carries features.print', !!(cfg.features && cfg.features.print && cfg.features.print.enabled === true));
        step('print: the gateway reports two devices', await gw('/print/devices', { scannedAt: Date.now(), devices: devices(Date.now()) }) === 200);
        await fresh(page);
        await page.reload();
        await goFeatures(page, GW);
        step('print: the row names what was found, with ≈ MB and the way to the plugin', await until(page, (sel) => {
          const r = document.querySelector(sel);
          if (!r) return false;
          const found = r.querySelector('[data-print-found]');
          const link = r.querySelector('[data-print-link]');
          return !!found && found.getAttribute('data-print-found') === '2' && /HP OfficeJet 8020 \(Drucker \+ Scanner\)/.test(found.textContent)
            && /Brother HL-L2350DW \(Drucker\)/.test(found.textContent) && !!r.querySelector('.gwn-fr-mem') && !!link
            && link.getAttribute('data-print-link') === 'catalog' && /\/settings\/plugins\/catalog\/gatecontrol-print$/.test(link.href);
        }, row));
        step('print: tab badge counts it as on', await page.evaluate(() => /\d/.test((document.querySelector('#gwe-tab-features .gwe-tab-badge') || {}).textContent || '')));
        await view(page, 'gwprint-on-dark');
        await theme(page, 'light');
        await view(page, 'gwprint-on-light');
        await page.setViewportSize({ width: 390, height: 900 });
        await page.waitForTimeout(400);
        const o = await overflow(page);
        step('print: 390 px, tab Funktionen: no sideways scroll', o <= 0, 'overflow ' + o);
        await view(page, 'gwprint-on-390-light', 2600);
        await page.setViewportSize({ width: 1440, height: 1000 });
        // off again (real PUT) – leaves the gateway as it was
        await page.click(row + ' [role="switch"]');
        step('print: switched off again', await until(page, (sel) => {
          const sw = document.querySelector(sel + ' [role="switch"]');
          return sw && sw.getAttribute('aria-checked') === 'false';
        }, row));
        await theme(page, 'dark');
      } finally {
        await api(page, 'POST', '/api/v1/settings/language', { language: lang0 }).catch(() => {});
        withDb((db) => {
          if (old) {
            db.prepare('UPDATE gateway_meta SET api_token_hash = ?, last_health = ?, last_seen_at = ?, first_seen_at = ?, alive = ? WHERE peer_id = ?')
              .run(old.api_token_hash, old.last_health, old.last_seen_at, old.first_seen_at, old.alive, GW);
            if (old.features) db.prepare('UPDATE gateway_features SET settings = ? WHERE peer_id = ?').run(old.features, GW);
          }
          db.prepare('DELETE FROM print_devices WHERE peer_id = ?').run(GW);
        });
      }
    },
  };
};
