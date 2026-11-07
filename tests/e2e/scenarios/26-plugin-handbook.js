'use strict';

// Einstellungen › Plugins › <plugin>: the tab "Handbuch" / "Manual" and the
// Einrichtungshinweise (plugin.json handbook / setupNotices, since 1.241.0).
//
// No mocks: the fixture plugin tests/fixtures/plugins/handbook-demo is packed
// here (unsigned — "Unsignierte Plugins erlauben" while the scenario runs,
// switched off again at its end) and installed through the real API; the
// seeded gateway "e2e-gw-home" gets cameras switched on and a heartbeat
// without the service kameras (restored at the end). Checked: the badge "Action
// needed" in the list, the banners on every tab (the gateway's name and its
// docker-compose.yml with the service kameras; gone by itself once the service
// runs), "Read in the manual" opens
// the tab at the heading (?tab=handbook#<anchor>), the table of contents
// (deep link, link click), nothing of the handbook's HTML gets through,
// "Done" removes the banner (stored, activity log), the dashboard notice,
// light/dark, 390 px with the contents above the text and no sideways scroll.
// The plugin is removed completely at the end.

const fs = require('node:fs');
const path = require('node:path');

function withDb(fn) {
  const file = process.env.GC_DB_PATH || path.join(process.env.GC_DATA_DIR || '.', 'gatecontrol.db');
  if (!fs.existsSync(file)) return null;
  const Database = require('better-sqlite3');
  const db = new Database(file);
  try { db.pragma('busy_timeout = 5000'); return fn(db); } finally { db.close(); }
}

const telemetry = (service) => JSON.stringify({ telemetry: { gateway_version: '1.28.0', capabilities: ['cameras'], hardware: { model: 'DS918+' },
  lan_subnets: [{ cidr: '192.168.10.0/24' }], features: { cameras: { enabled: true, service, state: service === 'managed' ? 'running' : 'service_missing', cameras: 0, recording: 0 } } } });

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, shot, api } = ctx;
  const until = (page, fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const theme = async (page, mode) => {
    await page.evaluate((m) => { try { localStorage.setItem('gc-theme-mode', m); } catch (_) { /* ignore */ } document.documentElement.setAttribute('data-theme', m); }, mode);
    await page.waitForTimeout(150);
  };
  const ID = 'handbook-demo';
  const MANAGE = BASE + '/settings/plugins/manage/' + ID;

  async function install(page) {
    const { packDir } = require(path.join(__dirname, '..', '..', '..', 'scripts', 'plugin-pack'));
    const buf = packDir(path.join(__dirname, '..', '..', 'fixtures', 'plugins', ID), { signingKey: '' }).buffer;
    const pol = await api(page, 'PUT', '/api/v1/plugins/policy', { allowUnsigned: true, confirm: 'ALLOW' });
    const csrf = await page.evaluate(() => window.GC && window.GC.csrfToken);
    const r = await page.request.fetch(BASE + '/api/v1/plugins/inspect', { method: 'POST', data: buf, headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf } });
    const ins = await r.json().catch(() => null);
    const done = ins && ins.token ? await api(page, 'POST', '/api/v1/plugins/install', { token: ins.token, accept: true }) : null;
    return pol.status === 200 && !!done && done.status === 200;
  }

  return {
    async pluginhandbook(page) {
      const GW = FIXTURES.gateways.home;
      const old = withDb((db) => {
        const r = db.prepare('SELECT gm.last_health, gm.platform, p.enabled FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id WHERE gm.peer_id = ?').get(GW);
        db.prepare("UPDATE peers SET enabled = 1 WHERE id = ? AND peer_type = 'gateway'").run(GW);
        const f = db.prepare('SELECT settings FROM gateway_features WHERE peer_id = ?').get(GW);
        db.prepare("UPDATE gateway_meta SET last_health = ?, platform = 'synology' WHERE peer_id = ?").run(telemetry('missing'), GW);
        const cur = f ? JSON.parse(f.settings || '{}') : {};
        cur.cameras = { ...(cur.cameras || {}), enabled: true };
        db.prepare(`INSERT INTO gateway_features (peer_id, settings, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(peer_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`).run(GW, JSON.stringify(cur), Date.now());
        return r ? { ...r, features: f ? f.settings : null } : null;
      });
      try {
        await run(page, GW);
      } finally {
        withDb((db) => {
          if (!old) return;
          db.prepare('UPDATE gateway_meta SET last_health = ?, platform = ? WHERE peer_id = ?').run(old.last_health, old.platform, GW);
          db.prepare('UPDATE peers SET enabled = ? WHERE id = ?').run(old.enabled, GW);
          if (old.features) db.prepare('UPDATE gateway_features SET settings = ? WHERE peer_id = ?').run(old.features, GW);
          else db.prepare('DELETE FROM gateway_features WHERE peer_id = ?').run(GW);
        });
      }
    },
  };

  async function run(page, GW) {
    await page.goto(BASE + '/dashboard');
    step('handbook: the fixture plugin installs (unsigned, allowed for the run)', await install(page));

    // the list: a badge on the plugin
    await page.goto(BASE + '/settings/plugins');
    const row = `[data-plugin="${ID}"]`;
    step('handbook: the plugin list shows "Action needed" at the plugin', await until(page, (s) => { const r = document.querySelector(s + ' [data-notices]'); return !!r && /Action needed/.test(r.textContent); }, row),
      await page.evaluate((s) => (document.querySelector(s) || { outerHTML: 'no row' }).outerHTML.slice(0, 600), row));
    step('handbook: "Needs your attention" names it', await until(page, (id) => { const c = document.getElementById('pgx-attention'); return !!c && /needs your help/.test(c.textContent) && !!c.querySelector('[data-kind="setup"]') && !!id; }, ID));

    // the plugin page: banners on every tab, the tab "Manual"
    await page.goto(MANAGE);
    step('handbook: banners of the open notices on the overview', await until(page, () => !!document.querySelector('.pgx-notice[data-notice="camera-settings"]') && !!document.querySelector('.pgx-notice[data-notice="cameras-compose"]')));
    step('handbook: a notice of a later version (since 2.0.0) and a met check (hostVersion) are not shown',
      await page.evaluate(() => !document.querySelector('[data-notice="later-step"]') && !document.querySelector('[data-notice="host-new"]')));
    step('handbook: the tab "Manual" is there, last', await page.evaluate(() => { const t = [...document.querySelectorAll('.pgx-tabs .pgx-tab')]; const last = t[t.length - 1]; return !!last && last.id === 'pg-tab-handbook' && last.textContent.trim() === 'Manual'; }));
    // the seeded gateway has cameras on but no service kameras: its name and its compose file in the banner
    step('handbook: the gateway without the service is named in the banner', await page.evaluate(() => /e2e-gw-home/.test(document.querySelector('.pgx-notice[data-notice="cameras-compose"]').textContent)));
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
      page.click('.pgx-notice[data-notice="cameras-compose"] [data-action="compose"]'),
    ]);
    let yml = '';
    if (dl) { try { yml = fs.readFileSync(await dl.path(), 'utf8'); } catch (_) { yml = ''; } }
    step('handbook: "Download docker-compose.yml" gives the compose file with the service kameras', !!dl && dl.suggestedFilename() === 'docker-compose.yml' && /\n\s{2}kameras:/.test(yml), dl ? dl.suggestedFilename() + ' ' + yml.length + ' B' : 'no download');
    await page.click('#pg-tab-log');
    step('handbook: the banners stay on the other tabs', await until(page, () => document.getElementById('pg-tab-log').getAttribute('aria-selected') === 'true' && document.querySelectorAll('.pgx-notice').length === 2));

    // "Read in the manual" → the tab at the heading of the notice
    await page.click('.pgx-notice[data-notice="camera-settings"] [data-action="handbook"]');
    const opened = await until(page, () => !!document.querySelector('#pg-hb-doc h4#hb-kamera-einstellungen'));
    step('handbook: "Read in the manual" opens the tab "Manual" (English text)', opened && await page.evaluate(() => document.getElementById('pg-tab-handbook').getAttribute('aria-selected') === 'true' && document.getElementById('pg-hb-doc').lang === 'en'));
    step('handbook: … at the anchor of the notice (?tab=handbook#kamera-einstellungen)', await page.evaluate(() => location.search === '?tab=handbook' && location.hash === '#kamera-einstellungen'));
    step('handbook: … scrolled to that heading', await until(page, () => { const r = document.getElementById('hb-kamera-einstellungen').getBoundingClientRect(); return window.scrollY > 0 && r.top >= -2 && r.bottom <= window.innerHeight; }));
    step('handbook: the table of contents lists the headings', await page.evaluate(() => [...document.querySelectorAll('#pg-hb-toc a[data-hb-anchor]')].map((a) => a.getAttribute('data-hb-anchor')).join(',') === 'manual-demo,what-the-plugin-does,setting-up-cameras,kamera-einstellungen'));
    await page.click('#pg-hb-toc a[data-hb-anchor="what-the-plugin-does"]');
    step('handbook: a TOC link jumps and sets the address', await until(page, () => { const r = document.getElementById('hb-what-the-plugin-does').getBoundingClientRect(); return location.hash === '#what-the-plugin-does' && r.top >= -2 && r.bottom <= window.innerHeight; }));
    step('handbook: links of the text: anchors stay on the page, https opens a new tab with rel=noopener', await page.evaluate(() => {
      const doc = document.getElementById('pg-hb-doc');
      const a = doc.querySelector('a[data-hb-anchor="setting-up-cameras"]');
      return !!a && a.getAttribute('href') === '#setting-up-cameras' && [...doc.querySelectorAll('a[href^="https:"]')].every((x) => x.target === '_blank' && /noopener/.test(x.rel));
    }));
    await shot(page, 'plugin-handbook-en');

    // a deep link from elsewhere; the German handbook through the API; nothing of its HTML is live
    await page.goto(BASE + '/settings/plugins');
    await page.goto(MANAGE + '?tab=handbook#setting-up-cameras');
    step('handbook: a deep link opens the tab at the heading', await until(page, () => { const h = document.getElementById('hb-setting-up-cameras'); if (!h) return false; const r = h.getBoundingClientRect(); return window.scrollY > 0 && r.top >= -2 && r.bottom <= window.innerHeight; }));
    const safe = await page.evaluate(async () => {
      const r = await fetch('/api/v1/plugins/handbook-demo/handbook?lang=de', { credentials: 'same-origin' });
      const j = await r.json();
      return j.ok && j.lang === 'de' && /&lt;script&gt;/.test(j.html) && !/javascript:/.test(j.html);
    });
    step('handbook: the German handbook from the API, its <script> and javascript: link only as text', safe);
    step('handbook: no script, iframe or event attribute in the rendered manual', await page.evaluate(() => {
      const doc = document.getElementById('pg-hb-doc');
      return !doc.querySelector('script,iframe,img,style,[onclick],[onerror]') && [...doc.querySelectorAll('*')].every((e) => [...e.attributes].every((a) => !/^on/i.test(a.name) && !/^style$/i.test(a.name)));
    }));
    await theme(page, 'dark');
    await shot(page, 'plugin-handbook-dark');
    await theme(page, 'light');

    // phone: the contents above the text, no sideways scroll
    const vp = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(MANAGE + '?tab=handbook');
    await until(page, () => !!document.getElementById('pg-hb-doc'));
    step('handbook: 390 px — the contents above the text', await page.evaluate(() => {
      const toc = document.getElementById('pg-hb-toc');
      return !!toc && toc.getBoundingClientRect().bottom <= document.getElementById('pg-hb-doc').getBoundingClientRect().top;
    }));
    step('handbook: 390 px — no sideways scroll', (await overflow(page)) <= 1, 'overflow ' + (await overflow(page)));
    await shot(page, 'plugin-handbook-390');
    await page.setViewportSize(vp);

    // the dashboard: "Plugins need your help"
    await page.goto(BASE + '/dashboard');
    step('handbook: the dashboard says "Plugins need your help" with a link to the plugin', await until(page, (id) => { const b = document.getElementById('db-plugin-setup'); return !!b && /Plugins need your help/.test(b.textContent) && !!b.querySelector('a[href="/settings/plugins/manage/' + id + '"]'); }, ID));

    // "Done"
    await page.goto(MANAGE);
    await until(page, () => !!document.querySelector('.pgx-notice[data-notice="camera-settings"]'));
    await page.click('.pgx-notice[data-notice="camera-settings"] [data-action="ack"]');
    step('handbook: "Done" removes the banner', await until(page, () => !document.querySelector('.pgx-notice[data-notice="camera-settings"]')));
    const all = await api(page, 'GET', '/api/v1/plugins/' + ID + '/notices');
    step('handbook: … stored with the person (GET …/notices: acked)', all.status === 200 && all.body.notices.some((n) => n.id === 'camera-settings' && n.state === 'acked' && !!n.ack.by));
    // the service runs now (heartbeat): the notice clears itself (the gateway snapshot lives 10 s)
    withDb((db) => db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(telemetry('managed'), GW));
    await page.waitForTimeout(10500);
    await page.goto(MANAGE);
    await until(page, () => !!document.getElementById('pg-tab-overview'));
    step('handbook: the service runs → the compose notice is gone by itself, no banner left', await page.evaluate(() => !document.querySelector('.pgx-notice')));
    const st = await api(page, 'GET', '/api/v1/plugins/' + ID + '/notices');
    step('handbook: … state "done", not acknowledged', st.status === 200 && st.body.notices.some((n) => n.id === 'cameras-compose' && n.state === 'done' && !n.ack));
    await page.goto(BASE + '/settings/plugins');
    step('handbook: no badge in the list any more', await until(page, (s) => !!document.querySelector(s) && !document.querySelector(s + ' [data-notices]'), `[data-plugin="${ID}"]`));
    await page.goto(BASE + '/dashboard');
    step('handbook: … and no dashboard notice', await page.evaluate(() => !document.getElementById('db-plugin-setup')));

    const rm = await api(page, 'POST', '/api/v1/plugins/' + ID + '/uninstall', { mode: 'wipe', confirm: 'Manual demo' });
    const pol = await api(page, 'PUT', '/api/v1/plugins/policy', { allowUnsigned: false });
    step('handbook: the plugin is removed again, unsigned plugins are off again', rm.status === 200 && pol.status === 200, 'status ' + rm.status + '/' + pol.status);
  }
};
