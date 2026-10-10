'use strict';

// Benachrichtigungen (/notifications, docs/feature-notification-center.md):
// the admin page of the notification centre with its five tabs. The admin
// API (/api/v1/notify/*) comes from tests/e2e/notify-mock.js via page.route,
// so the scenario does not depend on the backend being present. Checked:
// sidebar entry + badge, tabs (URL, keyboard), overview KPIs, rules table and
// editor (save sends only the change), deep links, devices with live presence
// (gc:push_presence), "Nachricht senden" with preview, history filters and the
// delivery log, settings (save sends the diff), the calm state of a server
// without the API (404), the licence lock, Settings → Benachrichtigungen links
// here, light/dark and 400 px without horizontal overflow.
//
// Like the other scenarios: no text comparisons, only selectors, aria-/data-
// attributes and the requests the page sends.

const path = require('node:path');
const NotifyMock = require(path.join(__dirname, '..', 'notify-mock.js'));

module.exports = (ctx) => {
  const { BASE, step, shot, visible } = ctx;
  const idle = (page) => page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  const theme = async (page, mode) => {
    await page.evaluate((m) => { try { localStorage.setItem('gc-theme-mode', m); } catch (_) { /* ignore */ } document.documentElement.setAttribute('data-theme', m); }, mode);
    await page.waitForTimeout(150);
  };
  const count = (page, sel) => page.locator(sel).count();
  const attr = (page, sel, name) => page.getAttribute(sel, name).catch(() => null);
  const last = (mock, method, p) => mock.calls.filter((c) => c.method === method && (typeof p === 'string' ? c.path === p : p.test(c.path))).pop();
  // waitForLoadState('networkidle') returns at once once the page reached it,
  // so every step that follows an async render waits for its own condition
  // (true when it holds within the time, false otherwise).
  const until = (page, fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const rowsAtLeast = (page, sel, n) => until(page, ([s, k]) => document.querySelectorAll(s).length >= k, [sel, n]);
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  return {
    async notifications(page) {
      const ping = await page.request.fetch(BASE + '/api/v1/ping');
      if (ping.status() !== 200) await ctx.login(page);

      const mock = NotifyMock.create();
      await page.route(/\/api\/v1\/notify\//, mock.handle);

      // ── Overview + sidebar ──
      await page.goto(BASE + '/notifications');
      await idle(page);
      await rowsAtLeast(page, '#nc-recent-list .nc-recent-item', 1);
      step('the sidebar entry is there and active', await count(page, '#sidebar a.nav-item.active[href="/notifications"]') === 1);
      step('overview KPIs show the API numbers', await ctx.text(page, '#nc-kpi-delivered-val') === '142' && (await ctx.text(page, '#nc-kpi-devices-val')).startsWith('4'),
        await ctx.text(page, '#nc-kpi-devices-val'));
      step('the queue tile warns and the sidebar badge counts the queue',
        await attr(page, '#nc-kpi-queued', 'data-tone') === 'warn' && await ctx.text(page, '#nc-nav-badge') === '3');
      step('recent notifications are listed', await count(page, '#nc-recent-list .nc-recent-item') === 6);
      step('five sources with bars', await count(page, '#nc-sources .nc-bar-fill') === 5);
      await theme(page, 'dark');
      await shot(page, 'notifications-overview-dark');
      await theme(page, 'light');
      await shot(page, 'notifications-overview-light');
      await theme(page, 'dark');

      // ── Tabs: keyboard + URL ──
      await page.focus('#nc-tab-overview');
      await page.keyboard.press('ArrowRight');
      await idle(page);
      step('ArrowRight moves to Regeln and the address follows',
        await attr(page, '#nc-tab-rules', 'aria-selected') === 'true' && /#rules$/.test(page.url()) && await page.evaluate(() => document.activeElement.id) === 'nc-tab-rules', page.url());
      await page.keyboard.press('End');
      step('End jumps to Einstellungen', await attr(page, '#nc-tab-settings', 'aria-selected') === 'true');
      await page.keyboard.press('Home');
      step('Home goes back to Übersicht', await attr(page, '#nc-tab-overview', 'aria-selected') === 'true' && !/#/.test(page.url().replace(BASE, '')));

      // ── Rules ──
      await page.click('#nc-tab-rules');
      await idle(page);
      await rowsAtLeast(page, '#nc-rules-body tr.nc-rule-row', mock.state.rules.length);
      step('every rule of the API is a row', await count(page, '#nc-rules-body tr.nc-rule-row') === mock.state.rules.length);
      await page.fill('#nc-rule-search', 'gateway');
      step('search filters the rules', await count(page, '#nc-rules-body tr.nc-rule-row') === 1);
      await page.fill('#nc-rule-search', '');
      await page.click('#nc-rules-body button[data-event-id="gateway_offline"]');
      step('the editor opens for the clicked rule', await visible(page, '#nc-rule-editor #nc-ed-title') && /#rules\/gateway_offline$/.test(page.url()), page.url());
      step('the editor shows its recipients', await count(page, '#nc-ed-chips .nc-chip') === 2);
      step('save is off without a change', await page.isDisabled('#nc-ed-save'));
      await page.click('#nc-rule-editor .nc-seg-btn[data-prio="high"]');
      await page.selectOption('#nc-ed-bundle', '1800');
      await shot(page, 'notifications-rules-dark');
      await Promise.all([page.waitForRequest((r) => r.method() === 'PUT' && /\/notify\/rules\/gateway_offline$/.test(r.url())), page.click('#nc-ed-save')]);
      await page.waitForTimeout(200);
      const put = last(mock, 'PUT', '/rules/gateway_offline');
      step('saving sends only the changed fields', !!put && JSON.stringify(Object.keys(put.body).sort()) === '["bundle_s","priority"]' && put.body.priority === 'high' && put.body.bundle_s === 1800,
        JSON.stringify(put && put.body));
      await until(page, () => { const n = document.querySelector('#nc-rules-body tr[data-event-id="gateway_offline"] .nc-prio'); return n && n.dataset.prio === 'high'; });
      step('the table shows the new priority', await attr(page, '#nc-rules-body tr[data-event-id="gateway_offline"] .nc-prio', 'data-prio') === 'high');
      await page.keyboard.press('Escape');
      await page.click('#nc-ed-close').catch(() => {});
      await page.goto(BASE + '/notifications#rules/login_failed');
      await idle(page);
      await until(page, () => !!document.querySelector('#nc-rules-body tr[data-event-id="login_failed"][data-selected="1"]'));
      step('a deep link #rules/<event> opens that rule', (await ctx.text(page, '#nc-ed-title')).length > 0
        && await attr(page, '#nc-rules-body tr[data-event-id="login_failed"]', 'data-selected') === '1');

      // ── Devices + live presence + send ──
      await page.click('#nc-tab-devices');
      await idle(page);
      await rowsAtLeast(page, '#nc-dev-body tr[data-token-id]', mock.state.devices.length);
      step('every device is a row', await count(page, '#nc-dev-body tr[data-token-id]') === mock.state.devices.length);
      step('an offline device cannot get a test, an unsupported one has no button',
        await page.isDisabled('#nc-dev-body tr[data-token-id="15"] .nc-dev-test') && await count(page, '#nc-dev-body tr[data-token-id="16"] .nc-dev-test') === 0);
      await page.evaluate(() => document.dispatchEvent(new CustomEvent('gc:push_presence', { detail: { token_id: 15, state: 'connected', via: 'tunnel' } })));
      step('gc:push_presence updates the row live', await attr(page, '#nc-dev-body tr[data-token-id="15"]', 'data-state') === 'connected');
      await page.click('#nc-send-target [data-target="users"]');
      await page.selectOption('#nc-send-pick', '3');
      await page.fill('#nc-send-title', 'Wartung heute Abend');
      await page.fill('#nc-send-body', 'Zwischen 22 und 23 Uhr startet der Server neu.');
      step('the phone preview follows the form', await ctx.text(page, '#nc-pv-title') === 'Wartung heute Abend');
      step('the reach line is filled', (await ctx.text(page, '#nc-send-reach')).length > 0);
      await shot(page, 'notifications-devices-dark');
      await Promise.all([page.waitForRequest((r) => r.method() === 'POST' && /\/notify\/send$/.test(r.url())), page.click('#nc-send-btn')]);
      await page.waitForTimeout(200);
      const send = last(mock, 'POST', '/send');
      step('send posts target, title and ttl', !!send && send.body.target.type === 'users' && JSON.stringify(send.body.target.ids) === '[3]'
        && send.body.title === 'Wartung heute Abend' && send.body.ttl_s > 0, JSON.stringify(send && send.body));
      await until(page, () => document.getElementById('nc-send-title').value === '');
      step('the form is emptied after sending', await page.inputValue('#nc-send-title') === '');

      // ── History ──
      await page.click('#nc-tab-history');
      await idle(page);
      await rowsAtLeast(page, '#nc-hist-body tr[data-id]', 5);
      await until(page, () => !document.getElementById('nc-hist-more').hidden);
      step('history lists the first page and offers more', await count(page, '#nc-hist-body tr[data-id]') === 5 && await page.isVisible('#nc-hist-more'));
      await Promise.all([page.waitForResponse((r) => /\/notify\/history\?.*before=/.test(r.url())), page.click('#nc-hist-more')]);
      await rowsAtLeast(page, '#nc-hist-body tr[data-id]', 6);
      step('"Mehr laden" asks with before=', /before=/.test((last(mock, 'GET', '/history') || {}).query || '') && await count(page, '#nc-hist-body tr[data-id]') > 5);
      await Promise.all([page.waitForResponse((r) => /\/notify\/history\?filter=important/.test(r.url())), page.click('#nc-hist-filters [data-filter="important"]')]);
      await until(page, () => !document.querySelector('#nc-hist-body tr[data-id="105"]'));
      step('a filter chip reloads with filter=important', /filter=important/.test((last(mock, 'GET', '/history') || {}).query || '')
        && await attr(page, '#nc-hist-filters [data-filter="important"]', 'aria-pressed') === 'true');
      await page.click('#nc-hist-body button[data-id="107"]');
      await rowsAtLeast(page, '#nc-proto .nc-delivery', 3);
      step('the delivery log opens with its devices', await visible(page, '#nc-proto .nc-deliveries') && await count(page, '#nc-proto .nc-delivery') === 3 && /#history\/107$/.test(page.url()));
      await shot(page, 'notifications-history-dark');
      await page.click('#nc-proto-rule');
      await until(page, () => document.getElementById('nc-tab-rules').getAttribute('aria-selected') === 'true');
      step('"Regel öffnen" leads to the rule', await attr(page, '#nc-tab-rules', 'aria-selected') === 'true' && /#rules\/gateway_offline$/.test(page.url()), page.url());

      // ── Settings ──
      await page.click('#nc-tab-settings');
      await until(page, () => document.getElementById('nc-set-retention').value !== '');
      step('settings are filled from the API', await page.inputValue('#nc-set-retention') === '72' && await attr(page, '#nc-set-direct', 'aria-checked') === 'true');
      await page.fill('#nc-set-retention', '48');
      step('a change enables save', !(await page.isDisabled('#nc-set-save')));
      await page.fill('#nc-set-keepalive', '1');
      step('an out-of-range value is marked before saving', await attr(page, '#nc-set-keepalive', 'aria-invalid') === 'true');
      await page.fill('#nc-set-keepalive', '25');
      await shot(page, 'notifications-settings-dark');
      await Promise.all([page.waitForRequest((r) => r.method() === 'PUT' && /\/notify\/settings$/.test(r.url())), page.click('#nc-set-save')]);
      await page.waitForTimeout(200);
      const sput = last(mock, 'PUT', '/settings');
      step('saving sends only the change', !!sput && JSON.stringify(sput.body) === '{"retention_h":48}', JSON.stringify(sput && sput.body));

      // ── 400 px ──
      await page.setViewportSize({ width: 400, height: 860 });
      for (const tab of ['overview', 'rules', 'devices', 'history', 'settings']) {
        await page.goto(BASE + '/notifications' + (tab === 'overview' ? '' : '#' + tab));
        await idle(page);
        await until(page, (t) => document.getElementById('nc-tab-' + t).getAttribute('aria-selected') === 'true', tab);
        await page.waitForTimeout(400);
        const o = await overflow(page);
        step('no horizontal overflow at 400 px: ' + tab, o <= 1, `overflow ${o}px`);
        if (tab === 'overview' || tab === 'devices') await shot(page, 'notifications-' + tab + '-phone', false);
      }
      await page.setViewportSize({ width: 1440, height: 1000 });

      // ── Without the backend (404): calm state, no crash ──
      mock.state.unavailable = true;
      await page.goto('about:blank');
      await page.goto(BASE + '/notifications');
      await idle(page);
      await until(page, () => { const b = document.getElementById('nc-ov-state'); return b && b.dataset.kind === 'unavailable'; });
      step('a server without the API shows a calm state', await attr(page, '#nc-ov-state', 'data-kind') === 'unavailable' && await page.isVisible('#nc-ov-state .nc-retry'));
      await page.click('#nc-tab-rules');
      await until(page, () => { const b = document.getElementById('nc-rules-state'); return b && b.dataset.kind === 'unavailable'; });
      step('the rules tab says the same', await attr(page, '#nc-rules-state', 'data-kind') === 'unavailable');
      ctx.allow((p) => p.kind === 'http' && p.status === 404 && /\/api\/v1\/notify\//.test(p.url),
        (p) => p.kind === 'console' && /404/.test(p.text));
      mock.state.unavailable = false;

      // ── Licence lock ──
      const free = NotifyMock.create({ pro: false });
      await page.unroute(/\/api\/v1\/notify\//, mock.handle);
      await page.route(/\/api\/v1\/notify\//, free.handle);
      await page.goto('about:blank');
      await page.goto(BASE + '/notifications#devices');
      await idle(page);
      step('without Pro the composer is locked', await page.isVisible('#nc-send-lock') && await page.isDisabled('#nc-send-btn'));
      await page.click('#nc-tab-rules');
      await page.click('#nc-rules-body button[data-event-id="plugin:gatecontrol-skoda:charging"]');
      await visible(page, '#nc-rule-editor .nc-lock');
      step('a plugin rule shows the licence lock', await page.isVisible('#nc-rule-editor .nc-lock') && await page.isDisabled('#nc-ed-save'));
      await page.unroute(/\/api\/v1\/notify\//, free.handle);

      // ── Settings → Benachrichtigungen links here ──
      await page.goto(BASE + '/settings#benachrichtigungen');
      await page.waitForFunction(() => window.GCSettings && window.GCSettings.current(), null, { timeout: 10000 }).catch(() => {});
      await idle(page);
      step('settings section links to the new page instead of the matrix',
        await page.isVisible('#st-notify-link') && await attr(page, '#st-notify-link', 'href') === '/notifications#rules' && await count(page, '#st-matrix-body') === 0);
      step('the recipient field stays', await page.isVisible('#st-al-email'));
      await page.goto('about:blank');
    },
  };
};
