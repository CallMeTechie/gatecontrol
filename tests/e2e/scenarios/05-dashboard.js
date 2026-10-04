'use strict';

// Dashboard (/dashboard): lädt ohne Konsolenfehler, das Traffic-Diagramm hat
// x-Beschriftungen und einen Tooltip (Maus und Tastatur), der gewählte
// Zeitraum übersteht einen Poll und ein Neuladen, die Aktivität rendert und
// filtert, Tabelle statt Diagramm, 390 px ohne Überlauf.
//
// Wie die anderen Szenarien ohne Textvergleiche: geprüft werden Auswahlpfade,
// aria-/data-Attribute und die API-Antworten. Die Daten kommen aus seed.js
// (30 Tage Traffic, ein Client-Peer, fünf Ereignisse).

module.exports = (ctx) => {
  const { BASE, step, visible, waitIdle, shot, api } = ctx;

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
      const top = await api(page, 'GET', '/api/v1/dashboard/top-peers?limit=5');
      step('API: top peers', top.status === 200 && Array.isArray(top.body.peers) && top.body.peers.length > 0, `${top.body && top.body.peers && top.body.peers.length} peers`);
      const sec = await api(page, 'GET', '/api/v1/dashboard/security-summary');
      step('API: security summary', sec.status === 200 && sec.body.logins && typeof sec.body.logins.failed_24h === 'number',
        JSON.stringify(sec.body && sec.body.logins));

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
      const box = await page.locator('#db-chart-plot').boundingBox();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
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
      await shot(page, 'dashboard-phone');
      await page.setViewportSize({ width: 1440, height: 1000 });
      // Leave the dashboard before the next scenario (its timers keep polling).
      await page.goto('about:blank');
    },
  };
};
