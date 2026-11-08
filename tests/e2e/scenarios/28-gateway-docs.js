'use strict';

// Gateways: "Versionen" and "Handbuch" (#versions, #handbook — public/js/gateway-docs.js,
// the building blocks of the plugin area).
//
// The seeded gateway "e2e-gw-home" reports gateway 1.31.0 (restored at the end);
// the fleet answer of the real API gets the latest version 1.34.1 (no GitHub in the
// test run), so the card says "Update auf 1.34.1 verfügbar · What's new?". Checked:
// the page's buttons, the real /releases without GitHub ("not available" with the
// GitHub link), then a list (page.route) with a hostile note — only text, no
// element of it —, "Neueste", "Runs on e2e-gw-home", "New since 1.31.0" from the
// card, the state card and the "More" menu of the gateway, the crumb back to where
// it was opened, the stale banner; the tab "Manual": real handbook (chapters 3–7),
// the table of contents (link → address #handbook/<anchor>, scrolled), a help topic
// as address (#handbook/gw.rpi → its heading), a help link of the page opens it in
// the page, in the assistant in a new tab; nothing of the HTML gets through,
// German via the API, light/dark, 390 px with the contents above the text and no
// sideways scroll.

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
];
const cmp = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

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
  async function mockReleases(page) {
    await page.route(/\/api\/v1\/gateways\/releases(\?.*)?$/, (route) => {
      const u = new URL(route.request().url());
      const from = u.searchParams.get('from');
      const body = { ok: true, available: true, stale, fetched_at: Date.now() - 3 * 3600 * 1000, latest_version: '1.34.1', releases_url: REL, versions: VERSIONS,
        from, to: '1.34.1', since: from ? VERSIONS.filter((v) => cmp(v.version, from) > 0) : [] };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
  }

  return {
    async gatewaydocs(page) {
      const GW = FIXTURES.gateways.home;
      const old = withDb((db) => {
        const r = db.prepare('SELECT gm.last_health, p.enabled FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id WHERE gm.peer_id = ?').get(GW);
        db.prepare("UPDATE peers SET enabled = 1 WHERE id = ? AND peer_type = 'gateway'").run(GW);
        db.prepare('UPDATE gateway_meta SET last_health = ?, last_seen_at = ? WHERE peer_id = ?')
          .run(JSON.stringify({ telemetry: { gateway_version: '1.31.0', hardware: { model: 'Raspberry Pi 4' }, cpu_cores: 4, state_dir_writable: true } }), Date.now(), GW);
        return r || null;
      });
      // the real fleet answer, with a latest version (the test run has no GitHub)
      await page.route(/\/api\/v1\/gateways(\?.*)?$/, async (route) => {
        const res = await route.fetch();
        const j = await res.json().catch(() => null);
        if (j && Array.isArray(j.gateways)) {
          j.latest_version = '1.34.1';
          j.gateways.forEach((g) => { if (g.peer_id === GW) g.update_available = true; });
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
      }
    },
  };

  async function run(page, GW) {
    await page.goto(BASE + '/gateways');
    if (page.url().includes('/login')) { await ctx.login(page); await page.goto(BASE + '/gateways'); }
    const card = `#fleet-grid .gw[data-id="${GW}"]`;
    step('docs: the page offers "Versions" and "Manual"', await until(page, () => {
      const v = document.getElementById('btn-gw-versions');
      const h = document.getElementById('btn-gw-handbook');
      return !!v && !!h && v.getAttribute('href') === '#versions' && h.getAttribute('href') === '#handbook' && /Versions/.test(v.textContent) && /Manual/.test(h.textContent);
    }));
    step('docs: the card says "Update to 1.34.1 available" with "What\'s new?" → #versions/1.31.0', await until(page, (s) => {
      const c = document.querySelector(s);
      const a = c && c.querySelector('a.gw-whats-new');
      return !!a && a.getAttribute('href') === '#versions/1.31.0' && /What's new\?/.test(a.textContent) && /1\.34\.1/.test(c.querySelector('.gw-card-update').textContent);
    }, card));
    await shot(page, 'gateway-docs-card', false);

    // the real API without GitHub: not available, a link to GitHub
    await page.click('#btn-gw-versions');
    step('docs: "Versions" opens the view (fleet hidden, tab selected)', await until(page, () => !document.getElementById('gw-docs-view').hidden && document.getElementById('fleet-view').hidden
      && document.getElementById('gwd-tab-versions').getAttribute('aria-selected') === 'true' && location.hash === '#versions'));
    step('docs: without GitHub: "not available" and the releases on GitHub (new tab)', await until(page, (rel) => {
      const p = document.getElementById('gwd-ver-unavailable');
      const a = p && p.closest('.pgx-card').querySelector('a[target="_blank"]');
      return !!a && a.href === rel && /noopener/.test(a.rel);
    }, REL));

    // a list (mocked) — a hostile note stays text
    await mockReleases(page);
    await page.click('#gwd-ver-reload');
    step('docs: the list of all versions, newest first, "Latest" on 1.34.1', await until(page, () => {
      const rows = [...document.querySelectorAll('#gwd-versions .pgx-vr')].map((r) => r.getAttribute('data-version'));
      const first = document.querySelector('#gwd-versions .pgx-vr[data-version="1.34.1"]');
      return rows.join() === '1.34.1,1.34.0,1.33.1,1.31.0' && /Latest/.test(first.textContent) && first.querySelector('.pgx-vr-new');
    }));
    step('docs: "Runs on e2e-gw-home" on the installed version', await page.evaluate(() => /Runs on e2e-gw-home/.test(document.querySelector('#gwd-versions .pgx-vr[data-version="1.31.0"]').textContent)));
    step('docs: the notes as text: no element, no script of the note runs', await page.evaluate(() => {
      const row = document.querySelector('#gwd-versions .pgx-vr[data-version="1.34.0"]');
      return !row.querySelector('img,a,script,[onerror]') && /<img src=x onerror=/.test(row.textContent) && /fett/.test(row.textContent) && !window.__gwdXss
        && row.querySelectorAll('.pgx-notes li').length === 2;
    }));
    step('docs: a version without notes says so', await page.evaluate(() => /No release notes/.test(document.querySelector('#gwd-versions .pgx-vr[data-version="1.33.1"]').textContent)));
    await shot(page, 'gateway-docs-versions');

    // the crumb back to the fleet; "What's new?" of the card
    await page.click('#gw-docs-view [data-act="docs-back"]');
    step('docs: the crumb "Gateways" leads back to the fleet', await until(page, () => !document.getElementById('fleet-view').hidden && document.getElementById('gw-docs-view').hidden && !location.hash));
    await page.click(card + ' a.gw-whats-new');
    step('docs: "What\'s new?" of the card: "New since 1.31.0" with what the update brings', await until(page, () => {
      const rows = [...document.querySelectorAll('#gwd-since .pgx-vr')].map((r) => r.getAttribute('data-version'));
      return location.hash === '#versions/1.31.0' && rows.join() === '1.34.1,1.34.0,1.33.1' && /from 1\.31\.0 to 1\.34\.1/.test(document.getElementById('gwd-since').textContent)
        && document.querySelectorAll('#gwd-versions .pgx-vr').length === 4;
    }));
    await shot(page, 'gateway-docs-whats-new');

    // the gateway: state card and "More" menu; the crumb back to the gateway
    await hash(page, '#gw/' + GW);
    step('docs: the state card of the gateway links "What\'s new?"', await until(page, () => {
      const a = document.querySelector('.gwo-state li[data-check="update"] a.gw-whats-new');
      return !!a && a.getAttribute('href') === '#versions/1.31.0';
    }));
    step('docs: the "More" menu: release notes in the page', await page.evaluate(() => {
      const a = document.querySelector('#gw-more-menu a[data-act="relnotes"]');
      return !!a && a.getAttribute('href') === '#versions/1.31.0' && !a.target;
    }));
    await page.click('.gwo-state li[data-check="update"] a.gw-whats-new');
    step('docs: … opens the versions', await until(page, () => location.hash === '#versions/1.31.0' && document.querySelectorAll('#gwd-since .pgx-vr').length === 3));
    await page.click('#gw-docs-view [data-act="docs-back"]');
    step('docs: the crumb leads back to the gateway it was opened from', await until(page, (id) => location.hash === '#gw/' + id && !document.getElementById('gw-detail-view').hidden, String(GW)));

    // stale: the last list with a banner
    stale = true;
    await hash(page, '#versions');
    step('docs: GitHub not reachable: the last list with a hint', await until(page, () => !!document.getElementById('gwd-ver-stale') && /cannot be reached/.test(document.getElementById('gwd-ver-stale').textContent)
      && document.querySelectorAll('#gwd-versions .pgx-vr').length === 4));
    stale = false;

    // the tab "Manual"
    await page.click('#gwd-tab-handbook');
    step('docs: the tab "Manual": chapters 3–7 in English with a table of contents', await until(page, () => {
      const doc = document.getElementById('gwd-hb-doc');
      const toc = [...document.querySelectorAll('#gwd-hb-toc a[data-hb-anchor]')].map((a) => a.getAttribute('data-hb-anchor'));
      return !!doc && doc.lang === 'en' && location.hash === '#handbook' && toc[0] === '3-setting-up-a-gateway' && toc.includes('7-faq-and-troubleshooting')
        && document.getElementById('gwd-tab-handbook').getAttribute('aria-selected') === 'true';
    }));
    await page.click('#gwd-hb-toc a[data-hb-anchor="6-updating-an-existing-gateway"]');
    step('docs: a TOC link jumps and sets the address', await until(page, () => location.hash === '#handbook/6-updating-an-existing-gateway' && (() => {
      const r = document.getElementById('hb-6-updating-an-existing-gateway').getBoundingClientRect(); return r.top >= -2 && r.top < window.innerHeight; })()));
    step('docs: links of the text: anchors stay in the page, the rest opens GitHub in a new tab', await page.evaluate(() => {
      const doc = document.getElementById('gwd-hb-doc');
      const inner = [...doc.querySelectorAll('a[data-hb-anchor]')];
      return inner.length > 20 && inner.every((a) => a.getAttribute('href') === '#handbook/' + a.getAttribute('data-hb-anchor') && document.getElementById('hb-' + a.getAttribute('data-hb-anchor')))
        && [...doc.querySelectorAll('a:not([data-hb-anchor])')].every((a) => a.href.startsWith('https://') && a.target === '_blank' && /noopener/.test(a.rel));
    }));
    step('docs: no script, image or event attribute in the manual', await page.evaluate(() => {
      const doc = document.getElementById('gwd-hb-doc');
      return !doc.querySelector('script,iframe,img,style') && [...doc.querySelectorAll('*')].every((e) => [...e.attributes].every((a) => !/^on/i.test(a.name) && !/^style$/i.test(a.name)));
    }));
    await shot(page, 'gateway-docs-handbook');

    // a help topic as address
    await page.goto(BASE + '/gateways#handbook/gw.rpi');
    step('docs: #handbook/gw.rpi opens chapter 3.3 (address names the heading)', await until(page, () => {
      const e = document.getElementById('hb-3-3-raspberry-pi');
      return location.hash === '#handbook/3-3-raspberry-pi' && !!e && e.getBoundingClientRect().top >= -2 && e.getBoundingClientRect().top < window.innerHeight;
    }));

    // a help link of the page → the manual in the page; in the assistant → a new tab
    await hash(page, '#gw/' + GW);
    await until(page, () => !document.getElementById('gw-detail-view').hidden);
    const viaLink = await page.evaluate(() => {
      const a = document.createElement('a');
      a.href = 'https://github.com/CallMeTechie/gatecontrol/blob/master/docs/guide/05-features.md#dns-filter'; a.target = '_blank'; a.setAttribute('data-guide', 'feat.dns'); a.textContent = 'Guide';
      document.getElementById('gw-detail-view').appendChild(a);
      a.click();
      return true;
    });
    step('docs: a help link of the page (data-guide) opens the manual in the page', viaLink && await until(page, () => {
      const e = document.getElementById('hb-dns-filter');
      return location.hash === '#handbook/dns-filter' && !!e && e.getBoundingClientRect().top >= -2 && e.getBoundingClientRect().top < window.innerHeight;
    }));
    const inWizard = await page.evaluate(() => {
      const opened = [];
      const orig = window.open;
      window.open = (u, t, f) => { opened.push([u, t, f]); return null; };
      const a = document.querySelector('#gwz-overlay a[data-guide="gw.rpi"]');
      if (!a) { window.open = orig; return 'no link'; }
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      a.dispatchEvent(ev);
      window.open = orig;
      return JSON.stringify({ opened, prevented: ev.defaultPrevented, hash: location.hash });
    });
    step('docs: in the assistant a help link opens the manual in a new tab (the assistant stays)', /"opened":\[\["\/gateways#handbook\/gw.rpi","_blank","noopener"\]\],"prevented":true,"hash":"#handbook\/dns-filter"/.test(inWizard), inWizard);

    // German through the API
    const de = await page.evaluate(async () => { const r = await fetch('/api/v1/gateways/handbook?lang=de', { credentials: 'same-origin' }); return r.json(); });
    step('docs: the German manual through the API', de && de.ok && de.lang === 'de' && /id="hb-3-gateway-einrichten"/.test(de.html) && !/<script/i.test(de.html));

    await hash(page, '#handbook');
    await until(page, () => !!document.getElementById('gwd-hb-doc'));
    await theme(page, 'dark');
    await shot(page, 'gateway-docs-handbook-dark', false);
    await hash(page, '#versions/1.31.0');
    await until(page, () => document.querySelectorAll('#gwd-since .pgx-vr').length === 3);
    await shot(page, 'gateway-docs-versions-dark', false);
    await theme(page, 'light');

    // phone
    const vp = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE + '/gateways#handbook');
    step('docs: 390 px: the contents (closed) above the text, no sideways scroll', await until(page, () => {
      const toc = document.getElementById('gwd-hb-toc');
      const doc = document.getElementById('gwd-hb-doc');
      return !!toc && !!doc && !toc.open && toc.getBoundingClientRect().bottom <= doc.getBoundingClientRect().top;
    }) && (await overflow(page)) <= 0, 'overflow ' + (await overflow(page)));
    await shot(page, 'gateway-docs-handbook-390', false);
    await page.goto(BASE + '/gateways#versions/1.31.0');
    step('docs: 390 px: the versions without sideways scroll', await until(page, () => document.querySelectorAll('#gwd-since .pgx-vr').length === 3) && (await overflow(page)) <= 0, 'overflow ' + (await overflow(page)));
    await shot(page, 'gateway-docs-versions-390', false);
    await page.setViewportSize(vp);
  }
};
