'use strict';

// Logs & Monitoring (/logs, FEATURES.md "Logs & Monitoring"): KPI tiles,
// timeline, facets with counts, filter in the address, entry detail with
// "Zur selben Zeit", Probleme, Zugriffe, export dialog with preview, the
// filter bottom sheet and no overflow at 390 px; light/dark screenshots.
//
// Against the real API with the seed's activity log, the app's own server
// log (GC_SERVER_LOG=on in the job) and whatever the run produced — no text
// comparisons, only ids, classes and API answers.

module.exports = (ctx) => {
  const { BASE, step, visible, waitIdle, shot, api } = ctx;
  const until = (page, fn, arg, ms = 10000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const count = (page, sel) => page.locator(sel).count();
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const theme = async (page, mode) => {
    await page.evaluate((m) => {
      try { localStorage.setItem('gc-theme-mode', m); } catch { /* ignore */ }
      document.documentElement.setAttribute('data-theme', m);
    }, mode);
    await page.waitForTimeout(200);
  };

  return {
    async logs(page) {
      const ping = await page.request.fetch(BASE + '/api/v1/ping');
      if (ping.status() !== 200) await ctx.login(page);
      await page.setViewportSize({ width: 1440, height: 1000 });

      const meta = await api(page, 'GET', '/api/v1/logs/meta');
      step('API: meta for an admin session lists every source',
        meta.status === 200 && meta.body.admin === true && meta.body.sources.length === 5, JSON.stringify(meta.body && meta.body.sources));

      await page.goto(BASE + '/logs');
      await waitIdle(page);
      step('KPI tiles render', await until(page, () => document.querySelectorAll('#lg-kpis .lg-kpi').length >= 4));
      step('timeline has bars', await until(page, () => document.querySelectorAll('#lg-hist .lg-bar').length > 0));
      step('facets carry counts', await until(page, () => document.querySelector('#lg-f-levels .lg-fc') && document.querySelector('#lg-f-levels .lg-fc').textContent !== ''));

      // every level
      for (const lv of ['info', 'debug']) {
        await page.check(`#lg-f-levels input[value="${lv}"]`);
        await page.waitForTimeout(300);
      }
      step('all levels: the list shows entries', await until(page, () => document.querySelectorAll('#lg-rows .lg-row').length > 0));
      step('the filter is in the address', /level=/.test(page.url()) || /#events$/.test(page.url()), page.url());
      await theme(page, 'dark');
      await shot(page, 'logs-events-dark');
      await theme(page, 'light');
      await shot(page, 'logs-events-light');

      // only one source
      await page.uncheck('#lg-f-sources input[value="server"]');
      await page.uncheck('#lg-f-sources input[value="plugins"]');
      step('source filter: only activity entries', await until(page, () => {
        const r = document.querySelectorAll('#lg-rows .lg-row');
        return r.length > 0 && Array.prototype.every.call(r, (n) => n.dataset.source === 'activity');
      }));
      step('chips show the filter', await count(page, '#lg-chips .lg-chip') >= 1);

      // detail
      await page.click('#lg-rows .lg-row .lg-msg');
      step('detail opens with title and fields', await visible(page, '#lg-d-title', 8000) && await count(page, '#lg-detail .lg-fieldrow') >= 2);
      step('address points at the entry', /#e\/a\.\d+$/.test(page.url()), page.url());
      step('"Zur selben Zeit" lists the entry itself', await until(page, () => document.querySelector('#lg-detail .lg-ev-self') !== null));
      await shot(page, 'logs-detail-light');
      await page.click('#lg-detail .lg-crumb a');
      step('back to the list', await visible(page, '#lg-rows .lg-row'));

      // problems
      await page.click('#lg-tab-problems');
      step('problems tab: list or calm empty state', await until(page, () => document.querySelector('#lg-plist .lg-prow, #lg-plist .lg-empty') !== null));
      if (await count(page, '#lg-plist .lg-prow')) {
        await page.click('#lg-plist .lg-prow');
        step('a problem shows its details', await until(page, () => document.querySelector('#lg-pdetail .lg-pstats') !== null));
      }
      await theme(page, 'dark');
      await shot(page, 'logs-problems-dark');

      // access
      await page.click('#lg-tab-access');
      step('access tab renders', await until(page, () => document.querySelectorAll('#lg-a-status .lg-seg-btn').length === 5));

      // export dialog
      await page.click('#lg-tab-events');
      await page.click('#lg-export-open');
      step('export dialog opens with a preview', await until(page, () => {
        const s = document.querySelector('.lg-xbox .lg-x-sum');
        return s && /\d/.test(s.textContent);
      }));
      await shot(page, 'logs-export-dark', false);
      await page.keyboard.press('Escape');
      step('export dialog closes', await until(page, () => !document.querySelector('.lg-xbox')));

      // phone
      await page.setViewportSize({ width: 390, height: 860 });
      await page.waitForTimeout(300);
      step('390px: no horizontal overflow', await overflow(page) <= 1);
      await page.click('#lg-filter-open');
      step('filters open as a bottom sheet', await visible(page, '#lg-sheet #lg-filters'));
      await theme(page, 'light');
      await shot(page, 'logs-mobile-filters-light', false);
      await page.click('#lg-sheet-done');
      step('the sheet closes', await until(page, () => document.getElementById('lg-sheet').hidden));
      await page.setViewportSize({ width: 1440, height: 1000 });
      // The Sitzungen tab (rdp-history.js) asks the RDP history on load; the
      // e2e licence may lack the remote desktop feature.
      ctx.allow((p) => p.kind === 'http' && p.status === 403 && /\/api\/v1\/rdp\/history/.test(p.url),
        (p) => p.kind === 'console' && /status of 403/.test(p.text));
    },
  };
};
