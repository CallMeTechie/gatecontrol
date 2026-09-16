'use strict';

// Sicherheitsseite (/security): zeigt sie genau das, was GET
// /api/v1/security/check liefert, und zwar in beiden Farbschemata und ohne
// Konsolenfehler?
//
// Wieder ohne Textvergleiche (W1 ändert Texte) und ohne Aussage über
// Stylesheets (W2 führt sie zusammen) — geprüft werden die Datenattribute der
// Zeilen gegen die API-Antwort.

module.exports = (ctx) => {
  const { BASE, step, visible, waitIdle, shot, api, text } = ctx;

  const theme = async (page, mode) => {
    await page.evaluate((m) => {
      try { localStorage.setItem('gc-theme-mode', m); } catch { /* ignore */ }
      document.documentElement.setAttribute('data-theme', m);
    }, mode);
    await page.waitForTimeout(200);
  };

  return {
    async security(page) {
      const check = await api(page, 'GET', '/api/v1/security/check');
      const checks = (check.body && check.body.checks) || [];
      step('API: GET /security/check answers', check.status === 200 && checks.length >= 10,
        `${checks.length} checks, summary ${JSON.stringify(check.body && check.body.summary)}`);

      const exposure = await api(page, 'GET', '/api/v1/security/exposure');
      step('API: GET /security/exposure answers', exposure.status === 200 && Array.isArray(exposure.body && exposure.body.entries),
        `${exposure.body && exposure.body.entries && exposure.body.entries.length} entries`);

      await page.goto(BASE + '/security');
      await waitIdle(page);
      step('security page renders its checks', await visible(page, '#sc-checks .sc-group', 10000));

      const groups = await page.locator('#sc-checks .sc-group').evaluateAll((ns) => ns.map((n) => n.dataset.severity));
      const order = ['critical', 'warning', 'info'].filter((s) => groups.includes(s));
      step('groups appear in severity order', groups.join() === order.join(), groups.join(' '));

      const rows = await page.locator('#sc-checks .sc-check').evaluateAll((ns) => ns.map((n) => n.dataset.checkId + ':' + n.dataset.status));
      const want = checks.map((c) => c.id + ':' + c.status).sort();
      step('every check of the API is on the page with its status', rows.slice().sort().join() === want.join(),
        `${rows.length} rows vs ${want.length} checks`);

      const summary = (check.body && check.body.summary) || {};
      const tiles = [await text(page, '#sc-tile-fail-val'), await text(page, '#sc-tile-info-val'), await text(page, '#sc-tile-pass-val')];
      step('the tiles repeat the summary (fail / info / pass)',
        tiles.join('/') === [summary.fail, summary.info, summary.pass].join('/'), tiles.join('/'));

      await theme(page, 'dark');
      await shot(page, 'security-dark');
      await theme(page, 'light');
      await shot(page, 'security-light');

      await page.setViewportSize({ width: 400, height: 860 });
      await page.goto(BASE + '/security');
      await waitIdle(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      step('no horizontal overflow at 400px', overflow <= 1, `overflow ${overflow}px`);
      await shot(page, 'security-phone', false);
      await page.setViewportSize({ width: 1440, height: 1000 });
    },
  };
};
