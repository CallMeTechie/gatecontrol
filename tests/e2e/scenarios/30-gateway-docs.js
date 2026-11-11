'use strict';

// Gateway detail › „Mehr“ › „Versionen“ and „Handbuch“ (#gw/<id>/versions,
// #gw/<id>/handbook — public/js/gateway-docs.js, the building blocks of the
// plugin area).
//
// The seeded gateway "e2e-gw-home" reports gateway 1.31.0 (restored at the end);
// the fleet answer of the real API gets the latest version 1.34.1 (no GitHub in
// the test run). Checked: the "More" menu has "Versions" and "Manual" (links in
// the page, no new tab), "What's new?" of the state card and of a "too old" note
// lead to "Versions"; the real /releases without GitHub ("not available" with the
// GitHub link), then a list (page.route) with a hostile note — only text, no
// element of it —, the installed version marked, the three newer ones flagged,
// "Latest", the banner "3 versions are newer"; the marks follow when the gateway
// reports a new version (poll); the crumb back to the gateway and to the fleet,
// the stale banner; the tab "Manual": real handbook (chapters 3–7), the table of
// contents (link → address #gw/<id>/handbook/<anchor>, scrolled), a heading as
// address, nothing of the HTML gets through, German via the API, light/dark,
// 390 px with the contents above the text and no sideways scroll.

const fs = require('node:fs');
const path = require('node:path');

function withDb(fn) {
  const file = process.env.GC_DB_PATH || path.join(process.env.GC_DATA_DIR || '.', 'gatecontrol.db');
  if (!fs.existsSync(file)) return null;
  const Database = require('better-sqlite3');
  const db = new Database(file);
  try { db.pragma('busy_timeout = 5000'); return fn(db); } finally { db.close(); }
}

const REL = 'https://github.com/CallMeTechie/gatecontrol-gateway/releases';
const VERSIONS = [
  { version: '1.34.1', published_at: '2026-11-07T17:43:15.000Z', notes: '- Cache-Test mit falscher Signatur schlug in jedem 16. Lauf fehl (#54)', url: REL + '/tag/v1.34.1' },
  { version: '1.34.0', published_at: '2026-11-07T17:13:47.000Z', notes: '- Funksticks von Hand zuordnen (#51)\n- <img src=x onerror="window.__gwdXss=1"> **fett** `code` [link](javascript:alert(1))', url: REL + '/tag/v1.34.0' },
  { version: '1.33.1', published_at: '2026-11-07T16:39:47.000Z', notes: null, url: REL + '/tag/v1.33.1' },
  { version: '1.31.0', published_at: '2026-11-07T14:31:00.000Z', notes: '- Lokale KI mit Grafikkarte (#49)', url: REL + '/tag/v1.31.0' },
  { version: '1.30.0', published_at: '2026-11-06T10:00:00.000Z', notes: '- Drucken und Scannen (#45)', url: REL + '/tag/v1.30.0' },
];
// a longer history: with it "All versions" opens with the newest ones and folds the rest
const OLDER = ['1.29.2', '1.29.1', '1.29.0', '1.28.0', '1.27.1', '1.27.0', '1.26.0', '1.25.0']
  .map((v, i) => ({ version: v, published_at: new Date(Date.UTC(2026, 9, 28 - i)).toISOString(), notes: '- Änderung in ' + v, url: REL + '/tag/v' + v }));
// the API sends the notes as lines too (the plugin area's noteLines, routes/api/gateways.js)
const { noteLines } = require('../../../public/js/plugins-ui');
VERSIONS.concat(OLDER).forEach((v) => { v.lines = noteLines(v.notes); });
const health = (v) => JSON.stringify({ telemetry: { gateway_version: v, hardware: { model: 'Raspberry Pi 4' }, cpu_cores: 4, state_dir_writable: true } });

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, shot } = ctx;
  const until = (page, fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const theme = async (page, mode) => {
    await page.evaluate((m) => { try { localStorage.setItem('gc-theme-mode', m); } catch (_) { /* ignore */ } document.documentElement.setAttribute('data-theme', m); }, mode);
    await page.waitForTimeout(150);
  };
  const hash = (page, h) => page.evaluate((x) => { location.hash = x; }, h);

  let stale = false;
  let long = false; // the list with the older versions too
  async function mockReleases(page) {
    await page.route(/\/api\/v1\/gateways\/releases(\?.*)?$/, (route) => {
      const body = { ok: true, available: true, stale, fetched_at: Date.now() - 3 * 3600 * 1000, latest_version: '1.34.1', releases_url: REL, versions: long ? VERSIONS.concat(OLDER) : VERSIONS };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
  }

  return {
    async gatewaydocs(page) {
      const GW = FIXTURES.gateways.home;
      const old = withDb((db) => {
        const r = db.prepare('SELECT gm.last_health, p.enabled FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id WHERE gm.peer_id = ?').get(GW);
        db.prepare("UPDATE peers SET enabled = 1 WHERE id = ? AND peer_type = 'gateway'").run(GW);
        db.prepare('UPDATE gateway_meta SET last_health = ?, last_seen_at = ? WHERE peer_id = ?').run(health('1.31.0'), Date.now(), GW);
        return r || null;
      });
      // the switched-on functions of the gateway (chips of its fleet card), restored at the end
      const feat0 = withDb((db) => db.prepare('SELECT settings, updated_at FROM gateway_features WHERE peer_id = ?').get(GW) || null);
      // the real fleet answer, with a latest version (the test run has no GitHub)
      await page.route(/\/api\/v1\/gateways(\?.*)?$/, async (route) => {
        const res = await route.fetch();
        const j = await res.json().catch(() => null);
        if (j && Array.isArray(j.gateways)) {
          j.latest_version = '1.34.1';
          j.gateways.forEach((g) => {
            const v = g.health && g.health.telemetry ? g.health.telemetry.gateway_version : null;
            if (g.peer_id === GW) g.update_available = v !== '1.34.1';
          });
        }
        await route.fulfill({ response: res, body: JSON.stringify(j) });
      });
      try {
        await run(page, GW);
      } finally {
        await page.unroute(/\/api\/v1\/gateways(\?.*)?$/).catch(() => {});
        await page.unroute(/\/api\/v1\/gateways\/releases(\?.*)?$/).catch(() => {});
        withDb((db) => {
          if (!old) return;
          db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(old.last_health, GW);
          db.prepare('UPDATE peers SET enabled = ? WHERE id = ?').run(old.enabled, GW);
        });
        withDb((db) => {
          if (feat0) db.prepare('UPDATE gateway_features SET settings = ?, updated_at = ? WHERE peer_id = ?').run(feat0.settings, feat0.updated_at, GW);
          else db.prepare('DELETE FROM gateway_features WHERE peer_id = ?').run(GW);
        });
      }
    },
  };

  async function run(page, GW) {
    const V = '#gw/' + GW + '/versions';
    const H = '#gw/' + GW + '/handbook';
    // a fresh page: when the scenario before ended on /gateways, a goto that only changes the
    // hash keeps the fleet that was loaded before the fleet answer above was routed
    await page.goto('about:blank');
    await page.goto(BASE + '/gateways#gw/' + GW);
    if (page.url().includes('/login')) { await ctx.login(page); await page.goto(BASE + '/gateways#gw/' + GW); }
    step('docs: the gateway detail is open, with the update to 1.34.1', await until(page, () => !document.getElementById('gw-detail-view').hidden && !!document.getElementById('gw-more-btn')
      && !!document.querySelector('.gwo-state li[data-check="update"]')));
    step('docs: the "More" menu: "Versions" and "Manual" as links in the page', await page.evaluate((x) => {
      const v = document.querySelector('#gw-more-menu a[data-act="versions"]');
      const h = document.querySelector('#gw-more-menu a[data-act="handbook"]');
      return !!v && !!h && v.getAttribute('href') === x.V && h.getAttribute('href') === x.H && !v.target && !h.target
        && v.textContent === 'Versions' && h.textContent === 'Manual' && !document.querySelector('#gw-more-menu [data-act="relnotes"]');
    }, { V, H }));
    step('docs: the state card: "What\'s new?" next to the update → Versions', await page.evaluate((v) => {
      const a = document.querySelector('.gwo-state li[data-check="update"] a.gw-whats-new');
      return !!a && a.getAttribute('href') === v && /What's new\?/.test(a.textContent) && !a.target;
    }, V));
    step('docs: "What\'s new?" of a "too old" note of a tab → Versions of the gateway', await page.evaluate((x) => {
      const ui = window.GCGatewayEdge && window.GCGatewayEdge.ui;
      const a = ui && ui.whatsNew({ peer_id: x.GW });
      const b = ui && ui.whatsNew(null);
      return !!a && a.getAttribute('href') === x.V && !a.target && !!b && /\/gatecontrol-gateway\/releases$/.test(b.href) && b.target === '_blank';
    }, { GW, V }));

    // the menu opens "Versions"; the real API without GitHub: not available, a link to GitHub
    await page.click('#gw-more-btn');
    await page.click('#gw-more-menu a[data-act="versions"]');
    step('docs: "Versions" opens the view (detail hidden, tab selected, crumb with the gateway)', await until(page, (x) => !document.getElementById('gw-docs-view').hidden && document.getElementById('gw-detail-view').hidden
      && document.getElementById('gwd-tab-versions').getAttribute('aria-selected') === 'true' && location.hash === x.V
      && document.getElementById('gwd-back').getAttribute('href') === '#gw/' + x.GW && document.getElementById('gwd-title').textContent === document.getElementById('gwd-back').textContent, { V, GW }));
    step('docs: the head: installed version and the update', await page.evaluate(() => document.getElementById('gwd-sub').textContent === 'Installed: 1.31.0 · Update to 1.34.1 available'));
    step('docs: without GitHub: "not available" and the releases on GitHub (new tab)', await until(page, (rel) => {
      const p = document.getElementById('gwd-ver-unavailable');
      const a = p && p.closest('.pgx-card').querySelector('a[target="_blank"]');
      return !!a && a.href === rel && /noopener/.test(a.rel);
    }, REL));

    // a list (mocked) — a hostile note stays text
    await mockReleases(page);
    await page.click('#gwd-ver-reload');
    step('docs: every version, newest first; 1.31.0 marked "Installed", the three after it "Newer", "Latest" on 1.34.1', await until(page, () => {
      const rows = [...document.querySelectorAll('#gwd-versions .pgx-vr')];
      const st = rows.map((r) => r.getAttribute('data-version') + ':' + r.getAttribute('data-state')).join();
      const row = (v) => document.querySelector('#gwd-versions .pgx-vr[data-version="' + v + '"]');
      return st === '1.34.1:newer,1.34.0:newer,1.33.1:newer,1.31.0:installed,1.30.0:older'
        && /Installed/.test(row('1.31.0').querySelector('.pgx-pill[data-tone="good"]').textContent)
        && ['1.34.1', '1.34.0', '1.33.1'].every((v) => /Newer/.test(row(v).querySelector('.pgx-pill[data-tone="new"]').textContent) && row(v).querySelector('.pgx-vr-new'))
        && /Latest/.test(row('1.34.1').querySelector('.pgx-pill[data-tone="blue"]').textContent)
        && !row('1.30.0').querySelector('.pgx-pill') && !row('1.31.0').querySelector('.pgx-vr-new');
    }));
    step('docs: the banner: update to 1.34.1, 3 versions are newer', await page.evaluate(() => /Update to 1\.34\.1 available\. 3 versions are newer than the installed 1\.31\.0/.test(document.getElementById('gwd-ver-newer').textContent)));
    step('docs: the notes as text: no element, no script of the note runs', await page.evaluate(() => {
      const row = document.querySelector('#gwd-versions .pgx-vr[data-version="1.34.0"]');
      return !row.querySelector('img,a,script,[onerror]') && /<img src=x onerror=/.test(row.textContent) && /fett/.test(row.textContent) && !window.__gwdXss
        && row.querySelectorAll('.pgx-notes li').length === 2;
    }));
    step('docs: a version without notes says so', await page.evaluate(() => /No release notes/.test(document.querySelector('#gwd-versions .pgx-vr[data-version="1.33.1"]').textContent)));
    await shot(page, 'gateway-docs-versions');

    // the gateway reports a new version: the marks follow with the next poll
    withDb((db) => db.prepare('UPDATE gateway_meta SET last_health = ?, last_seen_at = ? WHERE peer_id = ?').run(health('1.34.0'), Date.now(), GW));
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('gc:gateway', { detail: {} })));
    step('docs: after an update to 1.34.0: it is "Installed", only 1.34.1 is newer', await until(page, () => {
      const st = [...document.querySelectorAll('#gwd-versions .pgx-vr')].map((r) => r.getAttribute('data-state')).join();
      return st === 'newer,installed,older,older,older' && /1 version is newer than the installed 1\.34\.0/.test(document.getElementById('gwd-ver-newer').textContent)
        && document.getElementById('gwd-sub').textContent === 'Installed: 1.34.0 · Update to 1.34.1 available';
    }, null, 6000));
    withDb((db) => db.prepare('UPDATE gateway_meta SET last_health = ?, last_seen_at = ? WHERE peer_id = ?').run(health('1.31.0'), Date.now(), GW));
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('gc:gateway', { detail: {} })));
    await until(page, () => /^Installed: 1\.31\.0/.test(document.getElementById('gwd-sub').textContent), null, 6000);

    // the crumb: the gateway, the fleet
    await page.click('#gwd-back');
    step('docs: the crumb leads back to the gateway', await until(page, (id) => location.hash === '#gw/' + id && !document.getElementById('gw-detail-view').hidden && document.getElementById('gw-docs-view').hidden, String(GW)));
    await page.click('.gwo-state li[data-check="update"] a.gw-whats-new');
    step('docs: "What\'s new?" of the state card opens the versions', await until(page, (v) => location.hash === v && document.querySelectorAll('#gwd-versions .pgx-vr[data-state="newer"]').length === 3, V));
    await page.click('#gw-docs-view [data-act="docs-fleet"]');
    step('docs: the crumb "Gateways" leads back to the fleet', await until(page, () => !document.getElementById('fleet-view').hidden && document.getElementById('gw-docs-view').hidden && !location.hash));

    // the fleet card: the switched-on functions as chips (features_on of the real API)
    const setFeatures = (settings) => withDb((db) => db.prepare(`INSERT INTO gateway_features (peer_id, settings, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(peer_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`).run(GW, JSON.stringify(settings), Date.now()));
    // what the card must show: features_on of the real API through the rule of the kit (other
    // scenarios leave the DNS filter, the home cache … switched on for this gateway)
    const cardVsApi = async (id) => {
      const r = await fetch('/api/v1/gateways?peek=1', { credentials: 'same-origin' }).then((x) => x.json());
      const g = r.gateways.find((x) => String(x.peer_id) === id);
      const want = window.GCGatewayPoolKit.featureChips(g.features_on);
      const card = document.querySelector('#fleet-grid .gw[data-id="' + id + '"]');
      const row = card && card.querySelector('.gw-card-feats');
      if (!row) return { ok: false, on: g.features_on, got: null };
      const I = JSON.parse(document.getElementById('gwiz-i18n').textContent);
      const names = (keys) => keys.map((k) => I['gwp.fname.' + k]);
      const chips = [...row.querySelectorAll('span.gwe-chip')];
      const more = row.querySelector('a.gw-card-feats-more');
      const c = card.getBoundingClientRect();
      const ok = chips.map((x) => x.getAttribute('data-feature')).join() === want.shown.join()
        && chips.map((x) => x.textContent).join('|') === names(want.shown).join('|')
        && (want.more.length ? !!more && more.textContent === '+' + want.more.length && more.getAttribute('data-more') === want.more.join(' ')
          && more.title === names(want.more).join(', ') && more.getAttribute('aria-label') === 'and ' + want.more.length + ' more: ' + names(want.more).join(', ')
          && more.getAttribute('href') === '#gw/' + id + '/features' : !more)
        && row.getAttribute('aria-label') === 'Functions switched on'
        && [...row.children].every((x) => { const b = x.getBoundingClientRect(); return b.left >= c.left && b.right <= c.right + 0.5; });
      return { ok, on: g.features_on, got: [...row.children].map((x) => x.textContent).join() };
    };
    setFeatures({ print: { enabled: true }, cameras: { enabled: true }, netwatch: { enabled: false }, inetq: { enabled: false } });
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('gc:gateway', { detail: {} })));
    await until(page, (id) => { const r = document.querySelector('#fleet-grid .gw[data-id="' + id + '"] .gw-card-feats [data-feature="print"]'); return !!r; }, String(GW), 6000);
    let fc = await page.evaluate(cardVsApi, String(GW));
    step('fleet: the card names the switched-on functions as chips ("Print & scan", "Cameras" first), as the API reports them',
      fc.ok && fc.on.slice(0, 2).join() === 'print,cameras' && /^Print & scan,Cameras/.test(fc.got) && !fc.on.includes('netwatch') && !fc.on.includes('presence'), JSON.stringify(fc));
    setFeatures({ print: { enabled: true }, cameras: { enabled: true }, ai: { enabled: true }, radio: { ble: true } });
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('gc:gateway', { detail: {} })));
    await until(page, (id) => !!document.querySelector('#fleet-grid .gw[data-id="' + id + '"] .gw-card-feats a.gw-card-feats-more[data-more~="presence"]'), String(GW), 6000);
    fc = await page.evaluate(cardVsApi, String(GW));
    step('fleet: seven or more functions on → three chips ("Print & scan", "Cameras", "Radio") and "+N" (its name lists the rest), inside the card',
      fc.ok && fc.on.length >= 7 && fc.on.includes('ai') && /^Print & scan,Cameras,Radio,\+\d+$/.test(fc.got), JSON.stringify(fc));
    await shot(page, 'gateway-fleet-feature-chips');
    await page.click('#fleet-grid .gw[data-id="' + GW + '"] a.gw-card-feats-more');
    step('fleet: "+N" opens the tab "Functions" of the gateway', await until(page, (id) => location.hash === '#gw/' + id + '/features' && !document.getElementById('gw-detail-view').hidden, String(GW)));
    await hash(page, '');
    await until(page, () => !document.getElementById('fleet-view').hidden);

    // stale: the last list with a banner
    stale = true;
    await hash(page, V);
    step('docs: GitHub not reachable: the last list with a hint', await until(page, () => !!document.getElementById('gwd-ver-stale') && /cannot be reached/.test(document.getElementById('gwd-ver-stale').textContent)
      && document.querySelectorAll('#gwd-versions .pgx-vr').length === 5));
    stale = false;

    // a long history: the newest five, the rest behind "Show older"
    long = true;
    await page.click('#gwd-ver-reload');
    const shownRows = () => [...document.querySelectorAll('#gwd-versions .pgx-vr')].filter((r) => r.offsetParent !== null).map((r) => r.getAttribute('data-version')).join();
    step('docs: 13 versions: the newest five show (with "Installed" and every "Newer" one), eight are folded behind "Show older (8)"', await until(page, () => {
      const older = document.getElementById('gwd-ver-older');
      const btn = document.getElementById('gwd-ver-older-btn');
      const shown = [...document.querySelectorAll('#gwd-versions .pgx-vr')].filter((r) => r.offsetParent !== null).map((r) => r.getAttribute('data-version')).join();
      return !!older && older.hidden && older.querySelectorAll('.pgx-vr').length === 8 && shown === '1.34.1,1.34.0,1.33.1,1.31.0,1.30.0'
        && !!btn && btn.textContent === 'Show older (8)' && btn.getAttribute('aria-expanded') === 'false' && btn.getAttribute('aria-controls') === 'gwd-ver-older'
        && !document.getElementById('gwd-ver-stale');
    }), await page.evaluate(shownRows));
    await shot(page, 'gateway-docs-versions-folded');
    await page.focus('#gwd-ver-older-btn');
    await page.keyboard.press('Enter');
    step('docs: "Show older" (keyboard) opens the rest; the button says "Hide older"', await until(page, () => {
      const older = document.getElementById('gwd-ver-older');
      const btn = document.getElementById('gwd-ver-older-btn');
      const rows = [...document.querySelectorAll('#gwd-versions .pgx-vr')].filter((r) => r.offsetParent !== null);
      return !older.hidden && rows.length === 13 && rows[12].getAttribute('data-version') === '1.25.0' && rows[5].getAttribute('data-state') === 'older'
        && btn.textContent === 'Hide older' && btn.getAttribute('aria-expanded') === 'true' && older.contains(document.activeElement);
    }));
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('gc:gateway', { detail: {} })));
    await page.waitForTimeout(1500);
    step('docs: the poll leaves the older versions open', await page.evaluate(() => !document.getElementById('gwd-ver-older').hidden));
    await page.click('#gwd-ver-older-btn');
    step('docs: "Hide older" folds them again', await until(page, () => document.getElementById('gwd-ver-older').hidden
      && document.getElementById('gwd-ver-older-btn').textContent === 'Show older (8)'));
    long = false;
    await page.click('#gwd-ver-refresh');
    step('docs: a short list (five versions) has no fold', await until(page, () => document.querySelectorAll('#gwd-versions .pgx-vr').length === 5 && !document.getElementById('gwd-ver-older-btn')));

    // the tab "Manual"
    await page.click('#gwd-tab-handbook');
    step('docs: the tab "Manual": chapters 3–7 in English with a table of contents', await until(page, (h) => {
      const doc = document.getElementById('gwd-hb-doc');
      const toc = [...document.querySelectorAll('#gwd-hb-toc a[data-hb-anchor]')].map((a) => a.getAttribute('data-hb-anchor'));
      return !!doc && doc.lang === 'en' && location.hash === h && toc[0] === '3-setting-up-a-gateway' && toc.includes('7-faq-and-troubleshooting')
        && document.getElementById('gwd-tab-handbook').getAttribute('aria-selected') === 'true';
    }, H));
    await page.click('#gwd-hb-toc a[data-hb-anchor="6-updating-an-existing-gateway"]');
    step('docs: a TOC link jumps and sets the address', await until(page, (h) => location.hash === h + '/6-updating-an-existing-gateway' && (() => {
      const r = document.getElementById('hb-6-updating-an-existing-gateway').getBoundingClientRect(); return r.top >= -2 && r.top < window.innerHeight; })(), H));
    step('docs: links of the text: anchors stay in the page, the rest opens GitHub in a new tab', await page.evaluate((h) => {
      const doc = document.getElementById('gwd-hb-doc');
      const inner = [...doc.querySelectorAll('a[data-hb-anchor]')];
      return inner.length > 20 && inner.every((a) => a.getAttribute('href') === h + '/' + a.getAttribute('data-hb-anchor') && document.getElementById('hb-' + a.getAttribute('data-hb-anchor')))
        && [...doc.querySelectorAll('a:not([data-hb-anchor])')].every((a) => a.href.startsWith('https://') && a.target === '_blank' && /noopener/.test(a.rel));
    }, H));
    step('docs: no script, image or event attribute in the manual', await page.evaluate(() => {
      const doc = document.getElementById('gwd-hb-doc');
      return !doc.querySelector('script,iframe,img,style') && [...doc.querySelectorAll('*')].every((e) => [...e.attributes].every((a) => !/^on/i.test(a.name) && !/^style$/i.test(a.name)));
    }));
    await shot(page, 'gateway-docs-handbook');

    // a heading as address (reload)
    await page.goto(BASE + '/gateways' + H + '/3-3-raspberry-pi');
    step('docs: #gw/<id>/handbook/3-3-raspberry-pi opens chapter 3.3', await until(page, () => {
      const e = document.getElementById('hb-3-3-raspberry-pi');
      return !!e && e.getBoundingClientRect().top >= -2 && e.getBoundingClientRect().top < window.innerHeight;
    }));
    // an unknown gateway: the fleet
    await page.goto(BASE + '/gateways#gw/999999/versions');
    step('docs: an unknown gateway leads to the fleet', await until(page, () => !document.getElementById('fleet-view').hidden && document.getElementById('gw-docs-view').hidden));

    // German through the API
    const de = await page.evaluate(async () => { const r = await fetch('/api/v1/gateways/handbook?lang=de', { credentials: 'same-origin' }); return r.json(); });
    step('docs: the German manual through the API', de && de.ok && de.lang === 'de' && /id="hb-3-gateway-einrichten"/.test(de.html) && !/<script/i.test(de.html));

    await hash(page, H);
    await until(page, () => !!document.getElementById('gwd-hb-doc'));
    await theme(page, 'dark');
    await shot(page, 'gateway-docs-handbook-dark', false);
    await hash(page, V);
    await until(page, () => document.querySelectorAll('#gwd-versions .pgx-vr[data-state="newer"]').length === 3);
    await shot(page, 'gateway-docs-versions-dark', false);
    await theme(page, 'light');

    // phone
    const vp = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE + '/gateways' + H);
    step('docs: 390 px: the contents (closed) above the text, no sideways scroll', await until(page, () => {
      const toc = document.getElementById('gwd-hb-toc');
      const doc = document.getElementById('gwd-hb-doc');
      return !!toc && !!doc && !toc.open && toc.getBoundingClientRect().bottom <= doc.getBoundingClientRect().top;
    }) && (await overflow(page)) <= 0, 'overflow ' + (await overflow(page)));
    await shot(page, 'gateway-docs-handbook-390', false);
    await page.goto(BASE + '/gateways' + V);
    step('docs: 390 px: the versions without sideways scroll', await until(page, () => document.querySelectorAll('#gwd-versions .pgx-vr[data-state="newer"]').length === 3) && (await overflow(page)) <= 0, 'overflow ' + (await overflow(page)));
    await shot(page, 'gateway-docs-versions-390', false);
    await page.setViewportSize(vp);
  }
};
