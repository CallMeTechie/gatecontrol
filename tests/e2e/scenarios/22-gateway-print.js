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
// the way to the plugin (catalogue, not installed here). A 1.24.0 gateway
// reports no search details → "bitte aktualisieren"; a newer one reports its
// last search (answers, a printer dropped: other subnet) → the row says so.
// "Drucker nicht gefunden? Per IP-Adresse hinzufügen": the dialog refuses a
// public address, takes one typed and the one the search saw in the other
// subnet (one click), saves (real PUT) → features.print.manual in the config
// pull. "Neu suchen" against the unreachable seeded gateway → a clear
// message. Light/dark, 390 px without sideways scroll (row and dialog).

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
        step('print: a gateway without search details → "bitte das Gateway aktualisieren"', await page.evaluate((sel) => {
          const h = document.querySelector(sel + ' [data-print-nosearch]');
          return !!h && /1\.24\.0/.test(h.textContent) && /aktualisieren/.test(h.textContent) && !document.querySelector(sel + ' [data-print-search]');
        }, row));

        // ── a newer gateway: its last search, one printer in another subnet ──
        const search = { at: Date.now(), interfaces: 1, responses: 14, responders: 3, services: 4, devices: 2, dropped: { other_subnet: 1 },
          hosts: [{ ip: '192.168.20.5', reason: 'other_subnet', name: 'HP OfficeJet Pro 8720 [5A3B2C]' }], manual: [], errors: [] };
        step('print: the gateway reports its devices with the search', await gw('/print/devices', { scannedAt: Date.now(), devices: devices(Date.now()), search }) === 200);
        await fresh(page);
        await page.reload();
        await goFeatures(page, GW);
        step('print: the row shows the last search and what was dropped (with the address)', await until(page, (sel) => {
          const x = document.querySelector(sel + ' [data-print-search]');
          return !!x && /mDNS-Antworten 14/.test(x.textContent) && /Geräte 2/.test(x.textContent) && /1 × anderes Subnetz \(192\.168\.20\.5\)/.test(x.textContent)
            && !document.querySelector(sel + ' [data-print-nosearch]');
        }, row));
        step('print: "Neu suchen" and "Drucker nicht gefunden? Per IP-Adresse hinzufügen" in the row', await page.evaluate((sel) => {
          const a = document.querySelector(sel + ' [data-fk="gwn-print-again"]');
          const m = document.querySelector(sel + ' [data-fk="gwn-print-manual"]');
          return !!a && /Neu suchen/.test(a.textContent) && !!m && /Drucker nicht gefunden\? Per IP-Adresse hinzufügen/.test(m.textContent);
        }, row));
        // "Neu suchen": the seeded gateway is not reachable (no tunnel in the test) → a clear message
        await page.click(row + ' [data-fk="gwn-print-again"]');
        step('print: "Neu suchen" → the gateway is asked; unreachable → "nicht erreichbar"', await until(page, () => {
          const m = document.querySelector('.gcd-dialog .gcd-msg');
          return !!m && /nicht erreichbar|nicht angenommen/.test(m.textContent);
        }, null, 15000));
        await page.click('.gcd-dialog .gcd-ok').catch(() => {});
        await until(page, () => !document.querySelector('.gcd-dialog'));
        // the 502 of this unreachable gateway is the expected answer, not a page problem
        ctx.allow((x) => x.kind === 'http' && x.status === 502 && /\/print\/discover$/.test(x.url),
          (x) => x.kind === 'console' && /status of 502/.test(x.text));

        // ── "Per IP-Adresse hinzufügen" ──
        await page.click(row + ' [data-fk="gwn-print-manual"]');
        step('print: the dialog opens with the address field focused', await until(page, () => document.activeElement && document.activeElement.id === 'gwn-p-ip' && !!document.querySelector('.gwn-printdlg')));
        await page.fill('#gwn-p-ip', '8.8.8.8');
        await page.click('.gwn-printdlg [data-fk="gwn-p-add"]');
        step('print: a public address is refused', await until(page, () => {
          const e = document.querySelector('.gwn-printdlg .gwe-err');
          return !!e && !e.hidden && /private IPv4/.test(e.textContent) && document.getElementById('gwn-p-ip').getAttribute('aria-invalid') === 'true';
        }));
        await page.fill('#gwn-p-ip', '192.168.1.70');
        await page.press('#gwn-p-ip', 'Enter');
        step('print: the suggestion from the search (other subnet) is offered', await until(page, () => {
          const b = document.querySelector('.gwn-printdlg [data-fk="gwn-p-sugg:192.168.20.5"]');
          return !!b && /HP OfficeJet Pro 8720/.test(b.textContent);
        }));
        await page.click('.gwn-printdlg [data-fk="gwn-p-sugg:192.168.20.5"]');
        step('print: both addresses listed, waiting for the next search', await until(page, () => {
          const r = [...document.querySelectorAll('.gwn-printdlg [data-print-ip]')].map((x) => x.getAttribute('data-print-ip'));
          return r.join(',') === '192.168.1.70,192.168.20.5' && /nächsten Suche/.test(document.querySelector('.gwn-printdlg [data-print-manual-list]').textContent);
        }));
        await view(page, 'gwprint-manual-dark', 1000);
        await page.setViewportSize({ width: 390, height: 900 });
        await page.waitForTimeout(300);
        const od = await overflow(page);
        step('print: 390 px, dialog: no sideways scroll', od <= 0, 'overflow ' + od);
        await shot(page, 'gwprint-manual-390-dark', false);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.click('.gwn-printdlg [data-fk="gwn-p-save"]');
        step('print: saved (real PUT), the row names the addresses', await until(page, (sel) => {
          const m = document.querySelector(sel + ' [data-fk="gwn-print-manual"]');
          return !document.querySelector('.gwn-printdlg') && !!m && /192\.168\.1\.70, 192\.168\.20\.5/.test(m.textContent);
        }, row));
        const cfg2 = await (await page.request.fetch(BASE + '/api/v1/gateway/config', { headers: { Authorization: 'Bearer ' + token } })).json();
        step('print: the config pull carries features.print.manual', JSON.stringify(cfg2.features.print.manual) === JSON.stringify(['192.168.1.70', '192.168.20.5']));
        // the gateway asked them: one found, one not reachable → shown per address
        search.manual = [{ ip: '192.168.1.70', found: false, error: 'unreachable' }, { ip: '192.168.20.5', found: true, via: 'mdns' }];
        search.at = Date.now();
        await gw('/print/devices', { scannedAt: Date.now(), devices: devices(Date.now()), search });
        await fresh(page);
        await page.reload();
        await goFeatures(page, GW);
        await page.click(row + ' [data-fk="gwn-print-manual"]');
        step('print: per address: "nicht erreichbar" / "gefunden"', await until(page, () => {
          const st = (ip) => (document.querySelector(`.gwn-printdlg [data-print-ip="${ip}"]`) || {}).textContent || '';
          return /nicht erreichbar/.test(st('192.168.1.70')) && /gefunden/.test(st('192.168.20.5'));
        }));
        await page.click('.gwn-printdlg .gcd-foot .btn-ghost');
        await until(page, () => !document.querySelector('.gwn-printdlg'));

        // ── a printer without PDF (HP OfficeJet Pro 8720): this 1.24.0 gateway cannot convert → "ab 1.30.0" ──
        const withHp = (convert) => [...devices(Date.now()), { id: 'h:8720872087208720', name: 'HP OfficeJet Pro 8720', model: 'HP OfficeJet Pro 8720', ip: '192.168.1.80', location: 'Büro', source: 'mdns', online: true, seenAt: Date.now(), problem: null,
          printer: { state: 'idle', reasons: [], color: true, duplex: true, formats: ['application/vnd.hp-pcl', 'image/jpeg', 'application/pclm', 'image/urf', 'image/pwg-raster', 'application/octet-stream'], copiesMax: 99, markers: [], convert }, scanner: null }];
        await gw('/print/devices', { scannedAt: Date.now(), devices: withHp(null), search });
        await fresh(page);
        await page.reload();
        await goFeatures(page, GW);
        step('print: a printer without PDF on a gateway that cannot convert → update hint with 1.30.0, no checkbox', await until(page, (sel) => {
          const x = document.querySelector(sel + ' [data-print-convert="old"]');
          return !!x && /HP OfficeJet Pro 8720 nimmt kein PDF/.test(x.textContent) && /ab 1\.30\.0/.test(x.textContent) && !document.querySelector(sel + ' #gwn-f-pdfconv');
        }, row));
        // ── 1.30.0 with `print-convert`: the checkbox (on), the printer is converted for ──
        step('print: heartbeat of a 1.30.0 gateway with print-convert', await heartbeat('1.30.0', [...CAPS, 'print', 'print-convert']) === 200);
        await gw('/print/devices', { scannedAt: Date.now(), devices: withHp('image/pwg-raster'), search });
        await fresh(page);
        await page.reload();
        await goFeatures(page, GW);
        step('print: "PDF für Drucker ohne PDF umwandeln" checked, the printer named as converted', await until(page, (sel) => {
          const box = document.querySelector(sel + ' #gwn-f-pdfconv');
          const on = document.querySelector(sel + ' [data-print-convert="on"]');
          return !!box && box.checked && /PDF für Drucker ohne PDF umwandeln/.test(box.parentElement.textContent)
            && !!on && /HP OfficeJet Pro 8720 nimmt kein PDF – dieses Gateway wandelt/.test(on.textContent);
        }, row));
        await view(page, 'gwprint-convert-dark');
        await page.click(row + ' #gwn-f-pdfconv');
        step('print: unchecked (real PUT) → features.print.convert false in the config pull', await until(page, (sel) => {
          const box = document.querySelector(sel + ' #gwn-f-pdfconv');
          return !!box && !box.checked && !!document.querySelector(sel + ' [data-print-convert="off"]');
        }, row) && (await (await page.request.fetch(BASE + '/api/v1/gateway/config', { headers: { Authorization: 'Bearer ' + token } })).json()).features.print.convert === false);
        await page.click(row + ' #gwn-f-pdfconv');
        step('print: checked again → convert left out of the config pull (default on)', await until(page, (sel) => {
          const box = document.querySelector(sel + ' #gwn-f-pdfconv');
          return !!box && box.checked && !document.querySelector(sel + ' [data-print-convert="off"]');
        }, row) && !('convert' in (await (await page.request.fetch(BASE + '/api/v1/gateway/config', { headers: { Authorization: 'Bearer ' + token } })).json()).features.print));
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
