'use strict';

// Dashboard (/dashboard): lädt ohne Konsolenfehler, das Traffic-Diagramm hat
// x-Beschriftungen und einen Tooltip (Maus und Tastatur), der gewählte
// Zeitraum übersteht einen Poll und ein Neuladen, die Aktivität rendert und
// filtert, Tabelle statt Diagramm, 390 px ohne Überlauf.
//
// Karte „Updates“ (GET /dashboard/updates, hier per page.route mit den Zahlen
// des Entwurfs beantwortet – updates-mock.js): schmale Zeile, vier Felder mit
// Updates, „Konnte nicht geprüft werden“; „Erneut prüfen“ fragt mit ?refresh=1.
// Das Dashboard steht links mit denselben Kanten wie die Einstellungen
// (gemessen), der schwebende Plus-Knopf ist auf 390 px auf keiner Seite mehr
// da, und die Anlege-Knöpfe im Kopf öffnen weiter die Dialoge (?action=add).
//
// Wie die anderen Szenarien ohne Textvergleiche: geprüft werden Auswahlpfade,
// aria-/data-Attribute und die API-Antworten. Die Daten kommen aus seed.js
// (30 Tage Traffic, ein Client-Peer, fünf Ereignisse).

// Top peers count the UTC calendar day ("today"). The seed records their
// traffic a minute before it ends, so a run that starts after midnight UTC
// (seed 23:59, scenario 00:02) would find nothing for "today". Instead of
// relaxing the check, the scenario writes the seeded per-peer rows again
// inside today's window when that window holds none yet — same peers, same
// bytes, so the check stays exactly as strict.
function ensurePeerTrafficToday(fixtures) {
  const rows = Array.isArray(fixtures.peerTraffic) ? fixtures.peerTraffic : [];
  const file = process.env.GC_DB_PATH || require('node:path').join(process.env.GC_DATA_DIR || '.', 'gatecontrol.db');
  if (!rows.length || !require('node:fs').existsSync(file)) return 0;
  const Database = require('better-sqlite3');
  const db = new Database(file);
  try {
    db.pragma('busy_timeout = 5000');
    const d = new Date();
    const dayStart = `${d.toISOString().slice(0, 10)} 00:00:00`;
    const have = db.prepare('SELECT COUNT(*) AS n FROM peer_traffic_snapshots WHERE recorded_at >= ?').get(dayStart).n;
    if (have > 0) return 0;
    const ins = db.prepare("INSERT INTO peer_traffic_snapshots (peer_id, upload_bytes, download_bytes, recorded_at) VALUES (?, ?, ?, datetime('now'))");
    db.transaction(() => rows.forEach(([id, up, down]) => ins.run(id, up, down)))();
    return rows.length;
  } finally { db.close(); }
}

const { mockUpdates } = require('../updates-mock');

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, visible, waitIdle, shot, api } = ctx;

  const box = (page, sel) => page.locator(sel).first().evaluate((n) => { const r = n.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right) }; });
  // the card after a (mocked) answer in state `want` ('ok' | 'updates' | 'unknown')
  const showUpdates = async (page, want) => {
    await page.evaluate(() => window.GCDashboard.run('updates'));
    return page.waitForFunction((v) => document.getElementById('db-updates').dataset.view === v, want, { timeout: 5000 }).then(() => true, () => false);
  };
  const fieldsOf = (page) => page.locator('#db-up-grid .db-up-item').evaluateAll((ns) => ns.map((n) => ({
    field: n.dataset.field, view: n.dataset.view, state: n.dataset.state,
    main: n.querySelector('.db-up-main').textContent.trim().length > 0,
    href: (n.querySelector('.db-up-act a') || {}).getAttribute ? n.querySelector('.db-up-act a').getAttribute('href') : null,
    recheck: !!n.querySelector('.db-up-act [data-up-recheck]'),
    left: Math.round(n.getBoundingClientRect().left), top: Math.round(n.getBoundingClientRect().top),
  })));

  const theme = async (page, mode) => {
    await page.evaluate((m) => {
      try { localStorage.setItem('gc-theme-mode', m); } catch { /* ignore */ }
      document.documentElement.setAttribute('data-theme', m);
    }, mode);
    await page.waitForTimeout(200);
  };
  const xLabels = (page) => page.locator('#db-chart .db-chart-xtick').evaluateAll((ns) => ns.map((n) => n.textContent.trim()).filter(Boolean));

  return {
    async dashboard(page) {
      // Standalone run (`run.js dashboard`): sign in first.
      const ping = await page.request.fetch(BASE + '/api/v1/ping');
      if (ping.status() !== 200) await ctx.login(page);

      // ── API ────────────────────────────────────────────────────────────
      for (const [period, n] of [['1h', 60], ['24h', 24], ['7d', 7], ['30d', 30]]) {
        const r = await api(page, 'GET', '/api/v1/dashboard/traffic?period=' + period);
        const data = (r.body && r.body.data) || [];
        step(`API: traffic ${period} has ${n} continuous buckets`, r.status === 200 && data.length === n && data.every((d) => d.time),
          `${data.length} buckets, last ${data.length ? data[data.length - 1].time : '-'}`);
      }
      const refreshed = ensurePeerTrafficToday(FIXTURES);
      const top = await api(page, 'GET', '/api/v1/dashboard/top-peers?limit=5');
      const wantPeers = (FIXTURES.peerTraffic || []).length || 1;
      step('API: top peers', top.status === 200 && Array.isArray(top.body.peers) && top.body.peers.length >= Math.min(5, wantPeers)
        && top.body.period === 'today', `${top.body && top.body.peers && top.body.peers.length} peers${refreshed ? ' (seeded rows rewritten for the new UTC day)' : ''}`);
      const sec = await api(page, 'GET', '/api/v1/dashboard/security-summary');
      step('API: security summary', sec.status === 200 && sec.body.logins && typeof sec.body.logins.failed_24h === 'number',
        JSON.stringify(sec.body && sec.body.logins));

      // The real endpoint: answers from the caches (nothing was ever fetched in this run).
      const up = await api(page, 'GET', '/api/v1/dashboard/updates');
      step('API: updates card', up.status === 200 && ['ok', 'updates', 'unknown'].includes(up.body.state)
        && ['server', 'plugins', 'gateways', 'apps'].every((k) => up.body[k] && typeof up.body[k].state === 'string')
        && typeof up.body.server.running_version === 'string' && typeof up.body.updates === 'number',
        JSON.stringify(up.body && { state: up.body.state, server: up.body.server && up.body.server.state }));

      // ── Page ───────────────────────────────────────────────────────────
      await page.evaluate(() => { try { localStorage.removeItem('gc-dash-range'); } catch { /* ignore */ } });
      await page.goto(BASE + '/dashboard');
      await waitIdle(page);
      step('health tiles leave the loading state', await page.waitForFunction(
        () => Array.from(document.querySelectorAll('.db-tile')).every((t) => t.dataset.state !== 'loading'), null, { timeout: 15000 }).then(() => true, () => false));
      const badges = await page.locator('.db-tile .db-tile-badge').evaluateAll((ns) => ns.map((n) => n.textContent.trim()));
      step('every tile carries a text state', badges.length === 5 && badges.every(Boolean), badges.join(' | '));
      step('traffic chart renders', await visible(page, '#db-chart-plot', 10000));
      const labels = await xLabels(page);
      step('x axis carries labels', labels.length >= 3, labels.join(' '));
      const yTicks = await page.locator('#db-chart .db-chart-ytick').count();
      step('y axis carries ticks', yTicks >= 2, `${yTicks} ticks`);

      // Tooltip: mouse …
      // hover() waits until the plot is attached and stable – a poll may
      // re-render the chart right now (boundingBox() then returned null).
      await page.locator('#db-chart-plot').hover();
      await page.waitForTimeout(100);
      const tip = await ctx.text(page, '#db-chart-plot .db-tip');
      step('hover shows the tooltip', await page.locator('#db-chart-plot .db-tip').isVisible() && tip.length > 0, tip);
      await shot(page, 'dashboard-tooltip', false);
      // … and keyboard.
      await page.mouse.move(0, 0);
      await page.focus('#db-chart-plot');
      const t1 = await ctx.text(page, '#db-chart-plot .db-tip-title');
      await page.keyboard.press('ArrowLeft');
      const t2 = await ctx.text(page, '#db-chart-plot .db-tip-title');
      step('arrow keys move the tooltip', !!t1 && !!t2 && t1 !== t2, `${t1} → ${t2}`);
      await page.keyboard.press('Escape');

      // Period: 7d survives a poll and a reload.
      await Promise.all([
        page.waitForResponse((r) => r.url().includes('/dashboard/traffic?period=7d')),
        page.click('#db-range [data-range="7d"]'),
      ]);
      await page.waitForTimeout(150);
      await page.evaluate(() => Promise.all([window.GCDashboard.run('traffic'), window.GCDashboard.run('stats')]));
      await page.waitForTimeout(150);
      const pressed = await page.getAttribute('#db-range [data-range="7d"]', 'aria-pressed');
      const labels7 = await xLabels(page);
      step('7d stays selected after a poll', pressed === 'true' && labels7.length >= 3, `${pressed}, ${labels7.join(' ')}`);
      await page.reload();
      await waitIdle(page);
      await visible(page, '#db-chart-plot', 10000);
      step('7d is remembered across a reload', await page.getAttribute('#db-range [data-range="7d"]', 'aria-pressed') === 'true');

      // Table view.
      await page.click('#db-table-toggle');
      const rows = await page.locator('#db-table-body tr').count();
      step('"Als Tabelle" shows the same buckets', await page.locator('#db-table').isVisible() && rows === 7, `${rows} rows`);
      await shot(page, 'dashboard-table', false);
      await page.click('#db-table-toggle');

      // Activity: renders, filters.
      step('activity feed renders', await visible(page, '#activity-feed .db-act', 8000));
      await Promise.all([
        page.waitForResponse((r) => r.url().includes('/logs/recent') && r.url().includes('category=login')),
        page.click('#db-activity-filter [data-cat="login"]'),
      ]);
      await page.waitForTimeout(150);
      const cats = await page.locator('#activity-feed .db-act').evaluateAll((ns) => ns.map((n) => n.dataset.cat));
      step('the login filter shows only sign-ins', cats.length > 0 && cats.every((c) => c === 'login'), cats.join(' '));
      step('the chip is pressed', await page.getAttribute('#db-activity-filter [data-cat="login"]', 'aria-pressed') === 'true');
      await page.click('#db-activity-filter [data-cat="all"]');
      await waitIdle(page);

      // ── Karte „Updates“: three states ──────────────────────────────────
      let upState = 'ok';
      const upRequests = [];
      page.on('request', (r) => { if (r.url().includes('/api/v1/dashboard/updates')) upRequests.push(r.url()); });
      await mockUpdates(page, () => upState);
      step('updates: everything current is one slim row', await showUpdates(page, 'ok') && await visible(page, '#db-up-ok')
        && !(await page.$('#db-up-grid')) && (await ctx.text(page, '#db-up-ok .db-up-ok-text')).includes('1.269.1')
        && await page.locator('#db-up-ok time[data-ts]').count() === 1);
      const okBox = await page.locator('#db-updates').boundingBox();
      step('the slim row is slim', !!okBox && okBox.height <= 64, `${okBox && Math.round(okBox.height)} px`);
      const order = await page.evaluate(() => {
        const y = (id) => document.getElementById(id).getBoundingClientRect().top;
        return y('db-tiles') < y('db-updates') && y('db-updates') < y('db-row-main');
      });
      const edges = [await box(page, '#db-tiles'), await box(page, '#db-updates')];
      step('the card sits directly below the tiles, over the full width', order && edges[0].left === edges[1].left && edges[0].right === edges[1].right, JSON.stringify(edges));
      await page.locator('#db-updates').screenshot({ path: require('node:path').join(ctx.OUT, 'dashboard-updates-ok.png') }).catch(() => {});

      upState = 'some';
      step('updates: some updates open the card', await showUpdates(page, 'updates') && await visible(page, '#db-up-card'));
      let fields = await fieldsOf(page);
      step('four fields: server, plugins, gateways, apps', fields.map((f) => f.field).join() === 'server,plugins,gateways,apps' && fields.every((f) => f.main),
        fields.map((f) => `${f.field}:${f.view}`).join(' '));
      step('fields with an update are marked, the others stay calm',
        fields.map((f) => f.state).join() === 'warn,warn,warn,good' && fields.map((f) => f.view).join() === 'update,update,update,current');
      step('the count names the fields with updates', (await ctx.text(page, '#db-up-count')) === '3');
      step('every field leads to its page', fields[1].href === '/settings/plugins/updates' && fields[2].href === '/gateways' && fields[3].href === '/peers'
        && /^https:\/\/github\.com\/.+\/releases\/tag\//.test(fields[0].href || ''), fields.map((f) => f.href).join(' '));
      step('"Update now" is offered where the Server card offers it (window on)', await visible(page, '#db-up-trigger') && await page.isEnabled('#db-up-trigger'));
      const row = fields.map((f) => f.top);
      step('four fields in one row at 1440 px', row.every((t) => t === row[0]) && new Set(fields.map((f) => f.left)).size === 4);
      await page.locator('#db-updates').screenshot({ path: require('node:path').join(ctx.OUT, 'dashboard-updates-some.png') }).catch(() => {});

      upState = 'fail';
      step('updates: a failed check is said openly', await showUpdates(page, 'unknown') && await visible(page, '#db-up-card'));
      fields = await fieldsOf(page);
      step('each field shows its last known state', fields.map((f) => f.view).join() === 'current,unknown,unknown,update'
        && fields.map((f) => f.state).join() === 'good,none,none,warn', fields.map((f) => `${f.field}:${f.view}`).join(' '));
      step('the stale fields name a time', await page.locator('#db-up-meta time[data-ts]').count() === 1
        && /\d{1,2}:\d{2}/.test(await ctx.text(page, '[data-field="plugins"] .db-up-sub')) && /\d{1,2}:\d{2}/.test(await ctx.text(page, '[data-field="apps"] .db-up-sub')));
      step('outdated devices lead to the filtered peers list', fields[3].href === '/peers#hints=outdated' && fields[1].recheck);
      await page.locator('#db-updates').screenshot({ path: require('node:path').join(ctx.OUT, 'dashboard-updates-fail.png') }).catch(() => {});
      // "Erneut prüfen" asks the server to check again (?refresh=1) and then reads the result
      upRequests.length = 0;
      upState = 'ok';
      await page.click('[data-field="plugins"] [data-up-recheck]');
      const rechecked = await page.waitForFunction(() => document.getElementById('db-updates').dataset.view === 'ok', null, { timeout: 12000 }).then(() => true, () => false);
      step('"Check again" asks with ?refresh=1 and shows the new state', rechecked && upRequests.some((u) => u.endsWith('?refresh=1')), upRequests.map((u) => u.replace(BASE, '')).join(' '));

      // ── Left-aligned with the edges of the settings ────────────────────
      for (const width of [1920, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(BASE + '/dashboard');
        await waitIdle(page);
        const dash = await box(page, '#db-page');
        await page.goto(BASE + '/settings/domains');
        await waitIdle(page);
        const st = await box(page, '.pgx-wrap');
        step(`dashboard and settings share both edges at ${width}px`, dash.left === st.left && dash.right === st.right
          && (width < 1920 || dash.right - dash.left === 1380), `dashboard ${dash.left}–${dash.right}, settings ${st.left}–${st.right}`);
      }
      await page.setViewportSize({ width: 1100, height: 1000 });
      await page.goto(BASE + '/dashboard');
      await waitIdle(page);
      upState = 'some';
      await showUpdates(page, 'updates');
      fields = await fieldsOf(page);
      const over1100 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      step('1100 px: the fields wrap to two columns, nothing overflows', new Set(fields.map((f) => f.left)).size === 2 && over1100 <= 1, `overflow ${over1100}px`);
      await page.setViewportSize({ width: 1440, height: 1000 });

      // ── The header buttons still open the dialogs ──────────────────────
      await page.goto(BASE + '/dashboard');
      await waitIdle(page);
      await Promise.all([page.waitForURL(/\/peers/), page.click('.db-head-actions a[href="/peers?action=add"]')]);
      step('"Add peer" in the header opens the add dialog (?action=add)', await visible(page, '#modal-add-peer', 6000) && !/action=/.test(page.url()), page.url());
      await page.goto(BASE + '/routes?action=add');
      step('/routes?action=add opens the add-domain dialog', await visible(page, '.zn-dialog .zn-dialog-box input.zn-input', 6000) && !/action=/.test(page.url()), page.url());
      await page.goto(BASE + '/dashboard');
      await waitIdle(page);
      await Promise.all([page.waitForURL(/\/routes/), page.click('.db-head-actions a[href="/routes?action=new-host"]')]);
      step('"New host" in the header opens its dialog', await visible(page, '.rt-dlg', 6000));
      await page.goto(BASE + '/dashboard');
      await waitIdle(page);

      // Themes + phone width.
      await page.evaluate(() => { try { localStorage.setItem('gc-dash-range', '24h'); } catch { /* ignore */ } });
      await page.reload();
      await waitIdle(page);
      await visible(page, '#db-chart-plot', 10000);
      await theme(page, 'dark');
      await shot(page, 'dashboard-dark');
      await theme(page, 'light');
      await shot(page, 'dashboard-light');
      await theme(page, 'dark');

      await page.setViewportSize({ width: 390, height: 860 });
      await page.reload();
      await waitIdle(page);
      await visible(page, '#db-chart-plot', 10000);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      step('no horizontal overflow at 390px', overflow <= 1, `overflow ${overflow}px`);
      upState = 'some';
      await showUpdates(page, 'updates');
      fields = await fieldsOf(page);
      const tops = fields.map((f) => f.top);
      step('390 px: the four fields stack', fields.length === 4 && new Set(fields.map((f) => f.left)).size === 1 && tops.every((t, i) => i === 0 || t > tops[i - 1]));
      const overflowUp = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      step('390 px: the open card does not overflow', overflowUp <= 1, `overflow ${overflowUp}px`);
      await shot(page, 'dashboard-phone');
      // the floating quick-add button is gone — on every page
      for (const url of ['/dashboard', '/peers', '/routes', '/settings']) {
        await page.goto(BASE + url);
        await waitIdle(page);
        const plus = await page.evaluate(() => !!document.querySelector('#fab-btn, #fab-wrap, .fab, .fab-wrap, .fab-backdrop'));
        const fixed = await page.evaluate(() => Array.from(document.querySelectorAll('body *')).filter((n) => {
          const cs = getComputedStyle(n);
          const r = n.getBoundingClientRect();
          // a round floating button in the lower right corner, above the bottom navigation
          return cs.position === 'fixed' && cs.display !== 'none' && r.width >= 40 && r.width <= 72 && Math.abs(r.width - r.height) < 2
            && r.right > window.innerWidth - 40 && r.bottom > window.innerHeight - 160;
        }).length);
        step(`390 px: no floating plus on ${url}`, !plus && fixed === 0 && await visible(page, '.bottom-nav'), `${fixed} round fixed element(s)`);
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.unroute('**/api/v1/dashboard/updates*');
      // Leave the dashboard before the next scenario (its timers keep polling).
      await page.goto('about:blank');
    },
  };
};
