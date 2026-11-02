'use strict';

// Settings (/settings, /settings/<section>): one address per section, the
// old addresses (#section, old tab names, ?tab=), the start page (attention,
// states), the save model (change → save bar → save → reload shows the value;
// discard), the webhook dialog (events picked, saved, still there after a
// reload), field errors from the server (400), light/dark and 390 px.
//
// Like the other scenarios without text comparisons: selectors, aria-/data-
// attributes and API answers. The webhook comes from seed.js (creating one
// needs the webhooks licence, editing an existing one does not).

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, shot, api } = ctx;
  // networkidle covers a page load; a section switch without a reload only
  // ends when the section's own requests are done (GCSettings.whenLoaded)
  const idle = async (page) => {
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await page.evaluate(() => window.GCSettings && window.GCSettings.whenLoaded()).catch(() => {});
  };
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

      // ── Navigation: one address per section, old addresses lead there ──
      const path = (page) => new URL(page.url()).pathname;
      await page.goto(BASE + '/settings#backup');
      await ready(page);
      await idle(page);
      step('old hash #backup opens the Backups section at /settings/backup', await current(page) === 'backup' && await visibleSection(page) === 'backup' && path(page) === '/settings/backup', page.url());
      await page.goto(BASE + '/settings?tab=general');
      await ready(page);
      step('?tab=general leads to the start page /settings', await current(page) === 'start' && path(page) === '/settings' && !/tab=/.test(page.url()), page.url());
      await page.goto(BASE + '/settings/uebersicht');
      await ready(page);
      step('/settings/uebersicht (the former section) leads to the start page', await current(page) === 'start' && path(page) === '/settings', page.url());
      await page.goto(BASE + '/settings#security');
      await ready(page);
      // same document: the hash change is handled after the navigation resolves
      await page.waitForFunction(() => window.GCSettings && window.GCSettings.current() === 'anmeldung', null, { timeout: 4000 }).catch(() => {});
      step('old tab #security maps to /settings/anmeldung', await current(page) === 'anmeldung' && path(page) === '/settings/anmeldung', page.url());
      await page.goto(BASE + '/settings/email');
      await ready(page);
      await idle(page);
      step('/settings/email renders the e-mail page with its own heading', await visibleSection(page) === 'email' && await page.isVisible('#st-h-email'));
      await page.click('#st-nav a[data-section="daten"]');
      await idle(page);
      const cur = await page.getAttribute('#st-nav a[data-section="daten"]', 'aria-current');
      step('a menu link opens its section, carries aria-current and its address', cur === 'page' && path(page) === '/settings/daten', page.url());
      await page.goBack();
      await page.waitForTimeout(300);
      step('browser back returns to the previous section', await current(page) === 'email' && path(page) === '/settings/email', page.url());
      await page.goForward();
      await page.waitForTimeout(300);
      step('only one menu entry is current', (await page.$$eval('#st-nav [aria-current="page"]', (ns) => ns.length)) === 1);
      const pluginsHref = await page.getAttribute('#st-nav a[data-section="plugins"]', 'href');
      step('the Plugins entry is a link to the plugin area', pluginsHref === '/settings/plugins', pluginsHref);
      await page.fill('#st-search', 'smtp');
      const navShown = await page.$$eval('#st-nav li a[data-section]', (ns) => ns.filter((n) => !n.closest('li').hidden).map((n) => n.dataset.section));
      step('search filters the menu', navShown.includes('email') && !navShown.includes('lizenz'), navShown.join(' '));
      await page.fill('#st-search', '');

      // ── Start page: tiles, attention, every area with its state ──
      await page.click('#st-nav a[data-section="start"]');
      await page.waitForSelector('#st-att-list li', { timeout: 8000 }).catch(() => null);
      await idle(page);
      const att = await page.$$eval('#st-att-list li[data-kind]', (ns) => ns.map((n) => n.dataset.kind));
      step('start page: the attention list is filled from real sources', att.length > 0 && await page.textContent('#st-att-n') === String(att.length), att.join(' '));
      const states = await page.$$eval('.stx-allgrid [data-state-of]', (ns) => ns.filter((n) => n.textContent.trim()).length);
      step('start page: the areas carry their state', states >= 10, String(states));
      const dom = await api(page, 'GET', '/api/v1/settings/overview');
      step('GET /api/v1/settings/overview answers with tiles, attention and states', dom.status === 200 && !!dom.body.data.tiles && Array.isArray(dom.body.data.attention) && !!dom.body.data.states.domains);
      await theme(page, 'dark');
      await shot(page, 'settings-start-dark');
      await theme(page, 'light');
      await shot(page, 'settings-start-light');
      await theme(page, 'dark');
      await page.click('#st-nav a[data-section="daten"]');
      await idle(page);

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
      await page.click('#st-nav a[data-section="lizenz"]');
      step('switching section with changes asks', await ctx.visible(page, '.gcd-dialog', 3000));
      await page.click('.gcd-dialog .gcd-cancel');
      step('cancel keeps the section and the change', await current(page) === 'daten' && await page.inputValue('#st-ret-activity') === '33');
      step('a changed row is marked', await page.$eval('#st-ret-activity', (n) => n.closest('.st-row').hasAttribute('data-changed')));
      await page.click('#st-discard');

      // ── One save bar on every page with fields (also KI-Anbieter) ──
      for (const [sec, sel, kind] of [['email', '#st-smtp-host', 'fill'], ['monitoring', '#st-mon-interval', 'fill'], ['portal', '#st-po-auto', 'click'], ['richtlinien', '#stcp-global-lock-settings', 'click'], ['ki', '#ai-budget', 'fill']]) {
        await page.click('#st-nav a[data-section="' + sec + '"]');
        // networkidle of the page is long reached: wait for the section's own load
        // (its saved values), otherwise the change lands before the baseline
        await page.waitForFunction((x) => window.GCSettings.current() === x, sec);
        await page.evaluate(() => window.GCSettings.whenLoaded());
        if (kind === 'fill') await page.fill(sel, sec === 'ki' ? '12.50' : (sec === 'monitoring' ? '61' : 'smtp.changed.example'));
        else await page.click(sel);
        const dirty = await page.evaluate(() => window.GCSettings.dirty());
        step(sec + ': a change shows the save bar', await page.isVisible('#st-savebar') && dirty.length > 0, dirty.join());
        await page.click('#st-discard');
        step(sec + ': discard hides it again', !(await page.isVisible('#st-savebar')));
      }
      await page.click('#st-nav a[data-section="daten"]');
      await idle(page);

      // ── Webhook dialog: pick events, save, reload ──
      await page.click('#st-nav a[data-section="webhooks"]');
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
        await page.click('#st-nav a[data-section="' + sec + '"]');
        await idle(page);
        await theme(page, 'dark');
        await shot(page, 'settings-' + name + '-dark');
        await theme(page, 'light');
        await shot(page, 'settings-' + name + '-light');
      }
      // ── KI-Anbieter (settings-ai.js): four provider rows, the general settings in the save bar ──
      await page.click('#st-nav a[data-section="ki"]');
      // networkidle was reached long before: it does not wait for the section's own requests
      const aiCards = (pg) => pg.waitForSelector('#ai-providers .ai-prov', { timeout: 10000 }).catch(() => null);
      await aiCards(page);
      await idle(page);
      const cards = await page.$$eval('#ai-providers .ai-prov', (ns) => ns.map((n) => n.dataset.provider));
      step('KI-Anbieter: four provider rows', cards.join() === 'openai,anthropic,gemini,openrouter', cards.join());
      await page.click('#ai-providers .ai-prov[data-provider="openai"] .pgx-btn');
      step('KI-Anbieter: "Verwalten" opens the key dialog', await ctx.visible(page, '#ai-prov-modal .modal') && await page.isVisible('#ai-key-openai'));
      await page.click('#ai-prov-modal [data-close-modal]');
      step('KI-Anbieter: plugin list and budget are filled', await page.isVisible('#ai-plugins li') && (await page.inputValue('#ai-budget')) !== '');
      step('KI-Anbieter: no own save button any more', !(await page.$('#ai-defaults-save')));
      await shot(page, 'settings-ai-light');
      await theme(page, 'dark');
      await shot(page, 'settings-ai-dark');
      await page.setViewportSize({ width: 390, height: 860 });
      await page.goto(BASE + '/settings/ki');
      await ready(page);
      await aiCards(page);
      await idle(page);
      const aiOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      step('KI-Anbieter: no horizontal overflow at 390 px', aiOverflow <= 1, `overflow ${aiOverflow}px`);
      await shot(page, 'settings-ai-phone');
      await page.setViewportSize({ width: 1440, height: 1000 });

      await theme(page, 'dark');
      await page.setViewportSize({ width: 390, height: 860 });
      await page.goto(BASE + '/settings');
      await ready(page);
      await idle(page);
      step('at 390 px the start page is the list of areas', await page.isVisible('#st-nav a[data-section="email"]') && !(await page.isVisible('#st-back')));
      await shot(page, 'settings-phone-start');
      await page.click('#st-nav a[data-section="anmeldung"]');
      await idle(page);
      step('a section page has "Einstellungen" back on top and no menu', await page.isVisible('#st-back') && !(await page.isVisible('#st-nav')));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      step('no horizontal overflow at 390 px', overflow <= 1, `overflow ${overflow}px`);
      await page.click('#st-back');
      await idle(page);
      step('the back link leads to the start page', await current(page) === 'start');
      await page.click('#st-nav a[data-section="email"]');
      await idle(page);
      step('the list opens the section', await current(page) === 'email');
      await shot(page, 'settings-phone');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto('about:blank');
    },
  };
};
