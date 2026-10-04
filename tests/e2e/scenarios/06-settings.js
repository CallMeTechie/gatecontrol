'use strict';

// Settings (/settings): sections and the address (#section, old tab names,
// ?tab=), the save model (change → save bar → save → reload shows the value;
// discard), the webhook dialog (events picked, saved, still there after a
// reload), field errors from the server (400), light/dark and 390 px.
//
// Like the other scenarios without text comparisons: selectors, aria-/data-
// attributes and API answers. The webhook comes from seed.js (creating one
// needs the webhooks licence, editing an existing one does not).

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, shot, api } = ctx;
  const idle = (page) => page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  const current = (page) => page.evaluate(() => window.GCSettings && window.GCSettings.current());
  const visibleSection = (page) => page.$eval('.st-section:not([hidden])', (n) => n.dataset.section).catch(() => null);
  const ready = (page) => page.waitForFunction(() => window.GCSettings && window.GCSettings.current(), null, { timeout: 10000 }).catch(() => {});
  const theme = async (page, mode) => {
    await page.evaluate((m) => { try { localStorage.setItem('gc-theme-mode', m); } catch (_) { /* ignore */ } document.documentElement.setAttribute('data-theme', m); }, mode);
    await page.waitForTimeout(150);
  };

  return {
    async settings(page) {
      const ping = await page.request.fetch(BASE + '/api/v1/ping');
      if (ping.status() !== 200) await ctx.login(page);

      // ── Navigation ──
      await page.goto(BASE + '/settings#backup');
      await ready(page);
      await idle(page);
      step('old hash #backup opens the Backups section', await current(page) === 'backup' && await visibleSection(page) === 'backup');
      await page.goto(BASE + '/settings?tab=general');
      await ready(page);
      step('?tab=general opens Übersicht and the address becomes #uebersicht',
        await current(page) === 'uebersicht' && /#uebersicht$/.test(page.url()) && !/tab=/.test(page.url()), page.url());
      await page.goto(BASE + '/settings#security');
      await ready(page);
      step('old tab #security maps to Anmeldung & Konten', await current(page) === 'anmeldung');
      await page.click('.st-nav-item[data-section="daten"]');
      await idle(page);
      const cur = await page.getAttribute('.st-nav-item[data-section="daten"]', 'aria-current');
      step('a nav button opens its section and carries aria-current', cur === 'page' && /#daten$/.test(page.url()), page.url());
      await page.fill('#st-search', 'smtp');
      const navShown = await page.$$eval('.st-nav-item', (ns) => ns.filter((n) => !n.closest('li').hidden).map((n) => n.dataset.section));
      step('search filters the nav', navShown.includes('email') && !navShown.includes('lizenz'), navShown.join(' '));
      await page.fill('#st-search', '');

      // ── Save model: change, save, reload, persisted ──
      const before = (await api(page, 'GET', '/api/v1/settings/data')).body.data.retention_traffic_days;
      const next = before === 45 ? 46 : 45;
      await page.fill('#st-ret-traffic', String(next));
      step('the save bar appears with one change', await page.isVisible('#st-savebar')
        && (await page.evaluate(() => window.GCSettings.dirty())).join() === 'ret-traffic');
      // sticky: inside the viewport, not at the end of a long page
      const barBox = await page.evaluate(() => { const r = document.getElementById('st-savebar').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, vh: window.innerHeight }; });
      step('the save bar sits inside the viewport', barBox.top >= 0 && barBox.bottom <= barBox.vh, JSON.stringify(barBox));
      await shot(page, 'settings-savebar', false);
      await Promise.all([page.waitForResponse((r) => r.url().includes('/settings/data') && r.request().method() === 'PUT'), page.click('#st-save')]);
      await page.waitForTimeout(200);
      step('saving hides the save bar', !(await page.isVisible('#st-savebar')));
      await page.reload();
      await ready(page);
      await idle(page);
      step('the value survives a reload', await page.inputValue('#st-ret-traffic') === String(next), await page.inputValue('#st-ret-traffic'));

      // Discard
      await page.fill('#st-ret-activity', '200');
      await page.click('#st-discard');
      step('discard restores the saved value', !(await page.isVisible('#st-savebar')) && await page.inputValue('#st-ret-activity') !== '200');

      // Out of range: the server answers 400 with a message per field.
      const bad = await api(page, 'PUT', '/api/v1/settings/data', { retention_traffic_days: 999 });
      ctx.allow((p) => p.kind === 'http' && p.status === 400 && /\/settings\/data/.test(p.url));
      step('out-of-range value: 400 with a field message', bad.status === 400 && !!(bad.body && bad.body.fields && bad.body.fields.retention_traffic_days), JSON.stringify(bad.body));
      await page.fill('#st-ret-traffic', '999');
      await page.click('#st-save');
      step('the field shows the range error before anything is sent',
        await page.getAttribute('#st-ret-traffic', 'aria-invalid') === 'true' && await page.isVisible('#st-ret-traffic-err'));
      await page.click('#st-discard');

      // Leaving with unsaved changes asks first.
      await page.fill('#st-ret-activity', '33');
      await page.click('.st-nav-item[data-section="lizenz"]');
      step('switching section with changes asks', await ctx.visible(page, '.gcd-dialog', 3000));
      await page.click('.gcd-dialog .gcd-cancel');
      step('cancel keeps the section and the change', await current(page) === 'daten' && await page.inputValue('#st-ret-activity') === '33');
      await page.click('#st-discard');

      // ── Webhook dialog: pick events, save, reload ──
      await page.click('.st-nav-item[data-section="webhooks"]');
      await idle(page);
      const row = '.st-li[data-webhook-id="' + FIXTURES.webhook + '"]';
      step('the seeded webhook is listed', await ctx.visible(page, row));
      await page.click(row + ' .st-li-actions button:last-child');
      step('the dialog opens', await ctx.visible(page, '#st-wh-modal .modal'));
      await page.check('#st-wh-pick');
      await page.check('#st-wh-groups input[value="login_failed"]');
      await page.check('#st-wh-groups input[value="resources"]');
      await shot(page, 'settings-webhook-dialog', false);
      await Promise.all([page.waitForResponse((r) => /\/webhooks\/\d+$/.test(r.url()) && r.request().method() === 'PUT'), page.click('#st-wh-save')]);
      await page.waitForTimeout(200);
      const hook = ((await api(page, 'GET', '/api/v1/webhooks')).body.webhooks || []).find((h) => h.id === FIXTURES.webhook);
      step('the event selection is stored as event types', !!hook && hook.events.split(',').includes('login_failed') && hook.events.split(',').includes('resource_alert') && !hook.events.includes('*'), hook && hook.events);
      await page.reload();
      await ready(page);
      await idle(page);
      await page.click(row + ' .st-li-actions button:last-child');
      const picked = await page.$$eval('#st-wh-groups input:checked', (ns) => ns.map((n) => n.value));
      step('after a reload the dialog shows the same events', picked.sort().join() === 'login_failed,resources', picked.join());
      await page.click('#st-wh-modal [data-close-modal]');

      // ── Themes + phone ──
      for (const [sec, name] of [['benachrichtigungen', 'notifications'], ['backup', 'backups']]) {
        await page.click('.st-nav-item[data-section="' + sec + '"]');
        await idle(page);
        await theme(page, 'dark');
        await shot(page, 'settings-' + name + '-dark');
        await theme(page, 'light');
        await shot(page, 'settings-' + name + '-light');
      }
      await theme(page, 'dark');
      await page.setViewportSize({ width: 390, height: 860 });
      await page.goto(BASE + '/settings#anmeldung');
      await ready(page);
      await idle(page);
      step('at 390 px the nav is a select', await page.isVisible('#st-select') && !(await page.isVisible('#st-nav')));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      step('no horizontal overflow at 390 px', overflow <= 1, `overflow ${overflow}px`);
      await page.selectOption('#st-select', 'email');
      await idle(page);
      step('the select switches the section', await current(page) === 'email');
      await shot(page, 'settings-phone');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto('about:blank');
    },
  };
};
