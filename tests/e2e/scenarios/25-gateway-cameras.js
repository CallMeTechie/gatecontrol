'use strict';

// Gateways › detail › tab "Funktionen" › group "Geräte im Heimnetz" › row
// "Kameras" (public/js/gateway-net.js camerasRow, phase 3c step 4).
//
// No mocks: the seeded gateway "e2e-gw-home" gets a known gateway token and
// reports like a real gateway — first as 1.26.0 without the capability
// `cameras` ("Gateway zu alt – ab 1.28.0", switch disabled), then as a
// Raspberry Pi 3 B+ with 1.28.0 and the capability, but without the service
// kameras (old compose file). Switching on is a real PUT; the config pull then
// carries features.cameras (and never a password); the row shows the memory
// share, the hint "höchstens 1 Kamera mit Bewegungserkennung", the compose
// hint and the way to "Tür & Kamera" (catalogue, not installed here); the
// hints "Ein Schalter genügt" / "Hinweise statt Verbote" under the groups.
// "Speicherort und Netze": a folder with ".." and a public network are refused
// in the dialog, a NAS folder and a camera VLAN are saved (the network goes to
// the gateway, the folder never — compose file only); the gateway's report
// (1.29.0, storage.mount) decides between "gilt erst mit der neuen
// Compose-Datei" and no hint. Light/dark, 390 px without sideways scroll.

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

const CAPS = ['netwatch', 'inetq', 'presence', 'ups', 'dns', 'cache', 'storage', 'timezone', 'print', 'radio', 'ai'];

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
  const row = '.gwn-features [data-feature="cameras"]';

  return {
    async gatewaycameras(page) {
      const GW = FIXTURES.gateways.home;
      const ping = await page.request.fetch(BASE + '/api/v1/ping');
      if (ping.status() !== 200) await ctx.login(page);
      await page.setViewportSize({ width: 1440, height: 1000 });

      const token = 'gc_gw_' + crypto.randomBytes(32).toString('hex');
      const hash = 'sha256:' + crypto.createHash('sha256').update(token).digest('hex');
      const old = withDb((db) => {
        db.prepare("UPDATE peers SET enabled = 1 WHERE id = ? AND peer_type = 'gateway'").run(GW);
        const r = db.prepare('SELECT api_token_hash, last_health, last_seen_at, first_seen_at, alive, platform FROM gateway_meta WHERE peer_id = ?').get(GW);
        const f = db.prepare('SELECT settings FROM gateway_features WHERE peer_id = ?').get(GW);
        db.prepare("UPDATE gateway_meta SET api_token_hash = ?, platform = 'synology' WHERE peer_id = ?").run(hash, GW);
        return r ? { ...r, features: f ? f.settings : null } : null;
      });
      step('cameras: seeded gateway prepared with a known token', !!(old && old.api_token_hash));
      const gw = async (p, body) => (await page.request.fetch(BASE + '/api/v1/gateway' + p, { method: 'POST', data: body, headers: { Authorization: 'Bearer ' + token } })).status();
      const heartbeat = (version, caps, service = 'missing') => gw('/heartbeat', { uptime_s: 3600, telemetry: {
        gateway_version: version, node_version: 'v20.19.0', cpu_cores: 4, mem_total: 1024 ** 3, mem_used: 300 * 1024 ** 2,
        hardware: { model: 'Raspberry Pi 3 Model B Plus Rev 1.3', cpu_cores: 4, mem_total: 1024 ** 3, storage: { total: 64e9, free: 40e9 }, radios: [] },
        lan_ip: '192.168.1.23', default_gateway_ip: '192.168.1.1', state_dir_writable: true, capabilities: caps,
        features: caps.includes('cameras') ? { cameras: { enabled: false, service, state: 'off', cameras: 0, recording: 0, live: 0, storage: { free: 40e9, total: 64e9, problem: null }, host: { cores: 4, memTotal: 1024 ** 3, arch: 'arm64' }, error: null } } : {},
      } });
      await page.goto(BASE + '/gateways');
      const lang0 = await page.evaluate(() => document.documentElement.lang || 'en');
      const langSet = await api(page, 'POST', '/api/v1/settings/language', { language: 'de' });
      step('cameras: page in German for the run', langSet.status === 200, 'status ' + langSet.status);
      try {
        // ── an older gateway: no capability `cameras` ──
        step('cameras: heartbeat of a 1.26.0 gateway (no capability cameras)', await heartbeat('1.26.0', CAPS) === 200);
        await page.goto(`${BASE}/gateways#gw/${GW}/features`);
        await page.reload();
        await theme(page, 'dark');
        await goFeatures(page, GW);
        step('cameras: the row "Kameras" in "Geräte im Heimnetz", right after "Drucken & Scannen"', await until(page, () => {
          const g = document.querySelector('[data-fgroup="devices"]');
          if (!g) return false;
          const keys = [...g.querySelectorAll('[data-feature]')].map((x) => x.getAttribute('data-feature'));
          return keys.indexOf('cameras') === keys.indexOf('print') + 1 && /Kameras/.test(g.textContent);
        }));
        step('cameras: too old → "Gateway zu alt – ab 1.28.0", switch disabled', await page.evaluate((sel) => {
          const r = document.querySelector(sel);
          const sw = r && r.querySelector('[role="switch"]');
          const hint = r && r.querySelector('[data-cameras-old]');
          return !!sw && sw.disabled && sw.getAttribute('aria-checked') === 'false' && !!hint && /Gateway zu alt – ab 1\.28\.0/.test(hint.textContent);
        }, row));

        // ── 1.28.0 with `cameras` on a Pi 3 B+, old compose file ──
        step('cameras: heartbeat of a 1.28.0 gateway with cameras', await heartbeat('1.28.0', [...CAPS, 'cameras']) === 200);
        await fresh(page);
        await page.reload();
        await goFeatures(page, GW);
        step('cameras: switch enabled and off', await until(page, (sel) => {
          const r = document.querySelector(sel);
          const sw = r && r.querySelector('[role="switch"]');
          return !!sw && !sw.disabled && sw.getAttribute('aria-checked') === 'false' && !r.querySelector('[data-cameras-old]');
        }, row));
        await page.click(row + ' [role="switch"]');
        step('cameras: switched on (real PUT)', await until(page, (sel) => {
          const sw = document.querySelector(sel + ' [role="switch"]');
          return sw && sw.getAttribute('aria-checked') === 'true';
        }, row));
        const cfg = await (await page.request.fetch(BASE + '/api/v1/gateway/config', { headers: { Authorization: 'Bearer ' + token } })).json();
        step('cameras: the config pull carries features.cameras (no cameras yet, no password)', !!(cfg.features && cfg.features.cameras && cfg.features.cameras.enabled === true
          && Array.isArray(cfg.features.cameras.cameras) && !/password/.test(JSON.stringify(cfg.features.cameras))));
        const cred = await (await page.request.fetch(BASE + '/api/v1/gateway/cameras/credentials', { headers: { Authorization: 'Bearer ' + token } })).json();
        step('cameras: the credentials route answers this gateway only', !!cred && typeof cred.cameras === 'object' && Object.keys(cred.cameras).length === 0);
        await fresh(page);
        await page.reload();
        await goFeatures(page, GW);
        step('cameras: ≈ MB, "0 Kameras eingebunden", the Pi hint, the compose hint and the way to the plugin', await until(page, (sel) => {
          const r = document.querySelector(sel);
          if (!r) return false;
          const hint = r.querySelector('[data-cameras-hint="one_motion"]');
          const compose = r.querySelector('[data-cameras-compose]');
          const link = r.querySelector('[data-cameras-link]');
          return !!r.querySelector('.gwn-fr-mem') && /0 Kameras eingebunden/.test(r.textContent)
            && !!hint && /höchstens 1 Kamera mit Bewegungserkennung/.test(hint.textContent)
            && !!compose && /Compose-Datei/.test(compose.textContent) && !!r.querySelector('[data-fk="gwn-cameras-compose"]')
            && !!link && link.getAttribute('data-cameras-link') === 'catalog' && /\/settings\/plugins\/catalog\/gatecontrol-door$/.test(link.href);
        }, row));
        step('cameras: "Hinweise statt Verbote" names the cameras', await page.evaluate(() => /höchstens 1 Kamera mit Bewegungserkennung/.test((document.querySelector('.gwn-fhints') || {}).textContent || '')));
        step('cameras: the row links to the handbook inside the app (chapter 5, "Kameras")', await page.evaluate((sel) => {
          const a = document.querySelector(sel + ' a[data-guide="feat.cameras"]');
          return !a || /\/gateways#gw\/\d+\/handbook\/kameras$/.test(a.href);
        }, row));
        await view(page, 'gwcameras-on-dark');
        await theme(page, 'light');
        await view(page, 'gwcameras-on-light');
        await page.setViewportSize({ width: 390, height: 900 });
        await page.waitForTimeout(400);
        const o = await overflow(page);
        step('cameras: 390 px, tab Funktionen: no sideways scroll', o <= 0, 'overflow ' + o);
        await view(page, 'gwcameras-on-390-light', 2600);
        await page.setViewportSize({ width: 1440, height: 1000 });
        // the service kameras is there now → no compose hint
        step('cameras: heartbeat with the service kameras running', await heartbeat('1.28.0', [...CAPS, 'cameras'], 'managed') === 200);
        await fresh(page);
        await page.reload();
        await goFeatures(page, GW);
        step('cameras: with the service, no compose hint', await until(page, (sel) => {
          const r = document.querySelector(sel);
          return !!r && !r.querySelector('[data-cameras-compose]') && !!r.querySelector('[data-cameras-hint]');
        }, row));
        // ── "Speicherort und Netze": the clip folder (compose file) and a camera VLAN ──
        step('cameras: "Clips im Docker-Volume" before a folder is chosen', await page.evaluate((sel) => {
          const w = document.querySelector(sel + ' [data-cameras-where]');
          return !!w && w.getAttribute('data-cameras-where') === 'volume' && /cam-recordings/.test(w.textContent);
        }, row));
        await page.click(row + ' [data-fk="gwn-cameras-settings"]');
        step('cameras: the dialog opens with the folder field and the networks', await until(page, () => !!document.getElementById('gwn-cam-path') && !!document.getElementById('gwn-cam-net')
          && /Nur die eigenen Netze/.test((document.querySelector('[data-cameras-subnet-list]') || {}).textContent || '')));
        await theme(page, 'dark');
        await shot(page, 'gwcameras-settings-dark', false);
        await page.fill('#gwn-cam-path', '/volume1/../kameras');
        await page.click('[data-fk="gwn-cam-save"]');
        step('cameras: a folder with ".." is refused in the dialog (nothing sent)', await until(page, () => {
          const p = document.getElementById('gwn-cam-path');
          return !!p && p.getAttribute('aria-invalid') === 'true' && /\/volume1\/kameras/.test((document.querySelector('.gwn-printdlg') || document.body).textContent);
        }));
        await page.fill('#gwn-cam-net', '8.8.8.0/24');
        await page.click('[data-fk="gwn-cam-net-add"]');
        step('cameras: a public network is refused', await until(page, () => (document.getElementById('gwn-cam-net') || {}).getAttribute && document.getElementById('gwn-cam-net').getAttribute('aria-invalid') === 'true'));
        await page.fill('#gwn-cam-net', '192.168.20.0/24');
        await page.click('[data-fk="gwn-cam-net-add"]');
        step('cameras: 192.168.20.0/24 in the list', await until(page, () => !!document.querySelector('[data-cameras-subnet="192.168.20.0/24"]')));
        await page.fill('#gwn-cam-path', '/volume1/kameras');
        await theme(page, 'light');
        await shot(page, 'gwcameras-settings-light', false);
        await page.click('[data-fk="gwn-cam-save"]');
        step('cameras: saved (real PUT): folder and network in the row', await until(page, (sel) => {
          const r = document.querySelector(sel);
          const w = r && r.querySelector('[data-cameras-where]');
          return !document.getElementById('gwn-cam-path') && !!w && w.getAttribute('data-cameras-where') === 'folder' && /\/volume1\/kameras/.test(w.textContent)
            && /192\.168\.20\.0\/24/.test((r.querySelector('[data-cameras-subnets]') || {}).textContent || '');
        }, row));
        const cfg2 = await (await page.request.fetch(BASE + '/api/v1/gateway/config', { headers: { Authorization: 'Bearer ' + token } })).json();
        step('cameras: the network goes to the gateway, the folder never (compose file only)', !!(cfg2.features && cfg2.features.cameras
          && JSON.stringify(cfg2.features.cameras.subnets) === JSON.stringify(['192.168.20.0/24']) && !/volume1/.test(JSON.stringify(cfg2.features))));
        // the gateway (1.29.0) still reports the Docker volume → "Neue Compose-Datei"
        step('cameras: report of the gateway: clips still in the volume', await gw('/cameras/report', { service: 'managed', storage: { free: 40e9, total: 64e9, mount: 'volume', volume: 'gatecontrol_cam-recordings' }, cameras: [] }) === 200);
        await fresh(page);
        await page.reload();
        await goFeatures(page, GW);
        step('cameras: hint "gilt erst mit der neuen Compose-Datei" with the download', await until(page, (sel) => {
          const h = document.querySelector(sel + ' [data-cameras-storage-state="compose"]');
          return !!h && /Compose-Datei/.test(h.textContent) && !!h.querySelector('[data-fk="gwn-cameras-storage-compose"]');
        }, row));
        await page.setViewportSize({ width: 390, height: 900 });
        await page.waitForTimeout(300);
        const o2 = await overflow(page);
        step('cameras: 390 px with folder and hints: no sideways scroll', o2 <= 0, 'overflow ' + o2);
        await page.setViewportSize({ width: 1440, height: 1000 });
        step('cameras: report: the folder is in use', await gw('/cameras/report', { service: 'managed', storage: { free: 40e9, total: 64e9, mount: 'folder', folder: '/kameras' }, cameras: [] }) === 200);
        await fresh(page);
        await page.reload();
        await goFeatures(page, GW);
        step('cameras: no storage hint once the folder is in use', await until(page, (sel) => {
          const r = document.querySelector(sel);
          return !!r && !!r.querySelector('[data-cameras-where="folder"]') && !r.querySelector('[data-cameras-storage-state]');
        }, row));
        await page.click(row + ' [role="switch"]');
        step('cameras: switched off again', await until(page, (sel) => {
          const sw = document.querySelector(sel + ' [role="switch"]');
          return sw && sw.getAttribute('aria-checked') === 'false';
        }, row));
        await theme(page, 'dark');
      } finally {
        await api(page, 'POST', '/api/v1/settings/language', { language: lang0 }).catch(() => {});
        withDb((db) => {
          if (old) {
            db.prepare('UPDATE gateway_meta SET api_token_hash = ?, last_health = ?, last_seen_at = ?, first_seen_at = ?, alive = ?, platform = ? WHERE peer_id = ?')
              .run(old.api_token_hash, old.last_health, old.last_seen_at, old.first_seen_at, old.alive, old.platform, GW);
            if (old.features) db.prepare('UPDATE gateway_features SET settings = ? WHERE peer_id = ?').run(old.features, GW);
          }
        });
      }
    },
  };
};
