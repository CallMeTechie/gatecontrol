'use strict';

// Einstellungen › Sicherheit: IP-Sperre and Routenschutz (/settings/ipsperre,
// /settings/routenschutz). The menu entries, a setting through the save bar
// (change → save → reload shows it), a field error from the client check,
// blocking an address by hand and unblocking it (with the question), "Nie
// sperren" add / remove, the routes table with the open seed route, "Ist
// Absicht" and withdrawing it, keyboard focus, light/dark and 390 px.
//
// Like the other scenarios without text comparisons: selectors, aria-/data-
// attributes and API answers. The seed has one open HTTP route (e2e.example.com).

module.exports = (ctx) => {
  const { BASE, step, shot, api } = ctx;
  const idle = async (page) => {
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await page.evaluate(() => window.GCSettings && window.GCSettings.whenLoaded()).catch(() => {});
  };
  const ready = (page) => page.waitForFunction(() => window.GCSettings && window.GCSettings.current(), null, { timeout: 10000 }).catch(() => {});
  const theme = async (page, mode) => {
    await page.evaluate((m) => { try { localStorage.setItem('gc-theme-mode', m); } catch (_) { /* ignore */ } document.documentElement.setAttribute('data-theme', m); }, mode);
    await page.waitForTimeout(150);
  };
  const confirm = async (page) => {
    await page.waitForSelector('.gcd-dialog .gcd-ok', { timeout: 3000 });
    await page.click('.gcd-dialog .gcd-ok');
  };

  return {
    async securitysettings(page) {
      const ping = await page.request.fetch(BASE + '/api/v1/ping');
      if (ping.status() !== 200) await ctx.login(page);
      await page.setViewportSize({ width: 1440, height: 1000 });

      // ── Menu: both pages in the group "Sicherheit" ──
      await page.goto(BASE + '/settings');
      await ready(page);
      await idle(page);
      const inSecurity = await page.$$eval('.stx-grp[data-group="security"] a[data-section]', (as) => as.map((a) => a.dataset.section));
      step('IP-Sperre and Routenschutz are in the group Sicherheit', inSecurity.includes('ipsperre') && inSecurity.includes('routenschutz'), inSecurity.join());

      // ── IP-Sperre ──
      await page.click('a[data-section="ipsperre"]');
      await idle(page);
      step('the menu entry opens /settings/ipsperre', new URL(page.url()).pathname === '/settings/ipsperre' && await page.isVisible('#ipb-bans'));
      step('the page head has a status line', ((await ctx.text(page, '#st-status-ipsperre')) || '').length > 3);
      const view = await api(page, 'GET', '/api/v1/settings/ip-block');
      step('the switches show the saved sources', await page.getAttribute('#ipb-src-login', 'aria-checked') === String(view.body.config.sources.login)
        && await page.getAttribute('#ipb-src-rate_limit', 'aria-checked') === String(view.body.config.sources.rate_limit));

      await page.fill('#ipb-threshold', '2');
      await page.click('#st-save');
      step('a threshold below 3 is refused at the field', await page.getAttribute('#ipb-threshold', 'aria-invalid') === 'true' && !(await page.isHidden('#ipb-threshold-err')));
      await page.fill('#ipb-threshold', '12');
      await page.click('#ipb-src-rate_limit');
      step('two changes show the save bar', await page.isVisible('#st-savebar'));
      await Promise.all([page.waitForResponse((r) => r.url().includes('/settings/ip-block') && r.request().method() === 'PUT'), page.click('#st-save')]);
      await idle(page);
      await page.reload();
      await ready(page);
      await idle(page);
      step('after a reload the saved values are back', await page.inputValue('#ipb-threshold') === '12' && await page.getAttribute('#ipb-src-rate_limit', 'aria-checked') === 'true');
      await api(page, 'PUT', '/api/v1/settings/ip-block', { threshold: 10, sources: { rate_limit: false } });

      // block by hand → row → unblock with the question
      await page.click('#ipb-ban-open');
      step('"Adresse von Hand sperren" opens the form', await page.isVisible('#ipb-ban-add') && await page.getAttribute('#ipb-ban-open', 'aria-expanded') === 'true');
      await page.fill('#ipb-ban-ip', '10.0.0.1');
      await page.click('#ipb-ban-add [type="submit"]');
      await page.waitForTimeout(300);
      ctx.allow((p) => p.kind === 'http' && p.status === 400 && p.url.includes('/ip-block/bans'),
        (p) => p.kind === 'console' && /status of 400/.test(p.text));
      step('a private address is refused with a message', !(await page.isHidden('#ipb-ban-err')));
      await page.fill('#ipb-ban-ip', '185.220.101.0/24');
      await Promise.all([page.waitForResponse((r) => r.url().endsWith('/ip-block/bans') && r.status() === 201), page.click('#ipb-ban-add [type="submit"]')]);
      await page.waitForSelector('#ipb-bans .ipb-ban', { timeout: 4000 }).catch(() => {});
      step('the blocked network is listed', (await ctx.text(page, '#ipb-bans')).includes('185.220.101.0/24'));
      await page.setViewportSize({ width: 1440, height: 1000 });
      await theme(page, 'dark');
      await shot(page, 'settings-ipsperre-dark');
      await theme(page, 'light');
      await shot(page, 'settings-ipsperre-light');
      await theme(page, 'dark');
      await page.click('#ipb-bans .ipb-ban button');
      await confirm(page);
      await page.waitForFunction(() => !document.querySelector('#ipb-bans .ipb-ban'), null, { timeout: 4000 }).catch(() => {});
      step('"Entsperren" asks and removes the row', !(await page.$('#ipb-bans .ipb-ban')));

      // "Nie sperren"
      await page.click('#ipb-never-open');
      await page.fill('#ipb-never-ip', '192.168.178.0/24');
      await page.fill('#ipb-never-label', 'Heimnetz');
      await Promise.all([page.waitForResponse((r) => r.url().endsWith('/ip-block/never')), page.click('#ipb-never-add [type="submit"]')]);
      await page.waitForTimeout(300);
      step('"Nie sperren" lists the new network', (await ctx.text(page, '#ipb-never')).includes('192.168.178.0/24'));
      await page.click('#ipb-never li:last-child button');
      await page.waitForTimeout(400);
      step('removing it takes it out again', !(await ctx.text(page, '#ipb-never')).includes('192.168.178.0/24'));

      // ── Routenschutz ──
      await page.click('a[data-section="routenschutz"]');
      await idle(page);
      step('the menu entry opens /settings/routenschutz', new URL(page.url()).pathname === '/settings/routenschutz' && await page.isVisible('#rg-rows'));
      const rg = await api(page, 'GET', '/api/v1/settings/route-guard');
      const rows = await page.$$eval('#rg-rows tr[data-risk]', (r) => r.length);
      step('every active route has a row', rows === rg.body.routes.filter((r) => r.enabled).length && rows > 0, String(rows));
      const open = rg.body.attention.length;
      step('the open seed route needs attention', open > 0 && await page.$$eval('#rg-att .stx-att', (l) => l.length) === open);
      await page.click('#rg-filter [data-value="open"]');
      step('the filter "Offen" shows only open routes', await page.$$eval('#rg-rows tr[data-risk]', (r) => r.every((x) => ['high', 'check'].includes(x.dataset.risk))));
      await page.click('#rg-filter [data-value="all"]');
      await theme(page, 'dark');
      await shot(page, 'settings-routenschutz-dark');
      await theme(page, 'light');
      await shot(page, 'settings-routenschutz-light');
      await theme(page, 'dark');
      await Promise.all([page.waitForResponse((r) => r.url().includes('/ack')), page.click('#rg-att .stx-att button')]);
      await page.waitForTimeout(400);
      step('"Ist Absicht" confirms the route (no longer in the list)', await page.$$eval('#rg-att .stx-att', (l) => l.length) === open - 1
        && await page.$$eval('#rg-rows tr[data-risk="ack"]', (r) => r.length) === 1);
      await page.click('#rg-rows button.rg-ack');
      await confirm(page);
      await page.waitForTimeout(500);
      step('the confirmation can be withdrawn', await page.$$eval('#rg-att .stx-att', (l) => l.length) === open);

      // the defaults through the save bar
      await page.click('#rg-access [data-value="internet"]');
      await Promise.all([page.waitForResponse((r) => r.url().includes('/route-guard') && r.request().method() === 'PUT'), page.click('#st-save')]);
      await idle(page);
      const after = await api(page, 'GET', '/api/v1/settings/route-guard');
      step('the access default is saved', after.body.defaults.access === 'internet');
      await api(page, 'PUT', '/api/v1/settings/route-guard', { defaults: { access: 'vpn' } });

      // keyboard: the filter and the route links are reachable
      await page.focus('#rg-filter [data-value="open"]');
      await page.keyboard.press('Enter');
      step('the filter works with the keyboard', await page.getAttribute('#rg-filter [data-value="open"]', 'aria-pressed') === 'true');

      // ── 390 px ──
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(BASE + '/settings/ipsperre');
      await ready(page);
      await idle(page);
      const overflowA = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      await shot(page, 'settings-ipsperre-390');
      await page.goto(BASE + '/settings/routenschutz');
      await ready(page);
      await idle(page);
      const overflowB = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      await shot(page, 'settings-routenschutz-390');
      step('390 px: no sideways scrolling of the page', overflowA <= 1 && overflowB <= 1, `${overflowA} / ${overflowB}`);
      await page.setViewportSize({ width: 1440, height: 1000 });
    },
  };
};
