'use strict';

// Einstellungen › Plugins › Updates: "Alle aktualisieren" for many plugins at
// once (15+ patch releases on one day). Real server: POST
// /api/v1/plugin-catalog/install answers with the catalogue's own budget
// (pluginCatalogLimiter, 100 per 15 minutes — not the 15 of the upload
// limiter). The catalogue and the installs are mocked (page.route, no GitHub):
// 16 updates, the mocked download budget runs out after 11 → those rows say
// "failed: Too many plugin downloads …", the button counts only the ready
// ones, "Try again" prepares only the failed rows again → "Update 16"; an
// install that fails is prepared again from the finished dialog; "Close"
// reloads the list (all current). 390 px without sideways scroll.

module.exports = (ctx) => {
  const { BASE, step, shot, allow } = ctx;
  const until = (page, fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const N = 16;
  const ids = Array.from({ length: N }, (_, i) => 'e2e-up-' + String(i + 1).padStart(2, '0'));
  const nameOf = (id) => 'Update demo ' + Number(id.slice(-2));
  const RATE_MSG = 'Too many plugin downloads in a short time. Please try again in 14 minute(s).';

  return {
    async pluginupdates(page) {
      const m = { budget: 11, prepared: {}, installed: new Set(), failOnce: new Set([ids[N - 1]]) };
      const item = (id) => ({
        id, name: nameOf(id), description: 'Patch release', publisher: 'GateControl', category: 'other', icon: null, summary: '', audience: 'all', keywords: [], related: [],
        highlight: null, adds: [], permissions: [], shows: [], needs: null, languages: ['de', 'en'],
        state: m.installed.has(id) ? 'installed' : 'update', installedVersion: m.installed.has(id) ? '1.0.1' : '1.0.0',
        latest: { version: '1.0.1', gatecontrol: '>=1.0.0', compatible: true, prerelease: false, licenseRequired: false, size: 24576, releaseUrl: null, publishedAt: '2026-11-07T08:00:00.000Z', notes: null },
        requiresNewer: null, replaces: null,
      });
      const perms = { network: { internet: ['api.example.com:443'] } };
      const json = (r, status, body) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      const catalogue = async (r) => {
        const req = r.request();
        const u = new URL(req.url());
        if (req.method() === 'GET' && u.pathname === '/api/v1/plugin-catalog') {
          return json(r, 200, { ok: true, enabled: true, available: true, serverVersion: '1.241.0', fetchedAt: Date.now(), source: { host: 'github.com', official: true }, plugins: ids.map(item) });
        }
        if (req.method() === 'GET' && u.pathname === '/api/v1/plugin-catalog/updates') {
          return json(r, 200, { ok: true, enabled: true, available: true, autoUpdate: 'off', catalogCheck: true, history: [], fetchedAt: Date.now(),
            updates: ids.filter((id) => !m.installed.has(id)).map((id) => ({ id, name: nameOf(id), from: '1.0.0', to: '1.0.1', kind: 'patch', gatecontrol: '>=1.0.0', size: 24576, needsApproval: false, notes: [] })) });
        }
        if (req.method() === 'POST' && u.pathname === '/api/v1/plugin-catalog/install') {
          const b = req.postDataJSON() || {};
          m.prepared[b.id] = (m.prepared[b.id] || 0) + 1;
          if (m.budget <= 0) return json(r, 429, { ok: false, code: 'rate_limited', retryAfter: 840, error: RATE_MSG });
          m.budget--;
          return json(r, 200, { ok: true, canInstall: true, origin: 'catalog', token: 'tok-' + b.id + '-' + m.prepared[b.id], checks: [],
            plugin: { id: b.id, name: nameOf(b.id), version: b.version, permissions: perms }, existing: { id: b.id, version: '1.0.0', permissions: perms } });
        }
        return r.fallback();
      };
      const install = async (r) => {
        const b = r.request().postDataJSON() || {};
        const id = String(b.token || '').replace(/^tok-(.+)-\d+$/, '$1');
        if (!ids.includes(id)) return r.fallback();
        if (m.failOnce.delete(id)) return json(r, 409, { ok: false, code: 'package_changed', error: 'The package changed meanwhile.' });
        m.installed.add(id);
        return json(r, 200, { ok: true, plugin: { id, name: nameOf(id), version: '1.0.1', status: 'running' } });
      };

      // the real server: the catalogue download has its own, larger budget
      await page.goto(BASE + '/settings/plugins/updates');
      const csrf = await page.evaluate(() => window.GC && window.GC.csrfToken);
      const real = await page.request.fetch(BASE + '/api/v1/plugin-catalog/install', { method: 'POST', data: { id: 'x', version: 'nope' }, headers: { 'X-CSRF-Token': csrf } });
      step('pluginupdates: the real catalogue download is budgeted with 100 per window (not the upload limiter\'s 15)',
        real.status() === 400 && real.headers()['ratelimit-limit'] === '100', real.status() + ' limit ' + real.headers()['ratelimit-limit']);

      await page.route(/\/api\/v1\/plugin-catalog(\/.*)?(\?.*)?$/, catalogue);
      await page.route(/\/api\/v1\/plugins\/install$/, install);
      try {
        await page.goto(BASE + '/settings/plugins/updates');
        step('pluginupdates: the updates page offers "Update all (16)"', await until(page, () => { const b = document.getElementById('pgx-update-all'); return !!b && /Update all \(16\)/.test(b.textContent); }));
        await page.click('#pgx-update-all');
        const prepared = await until(page, () => { const go = document.getElementById('pgx-ua-go'); return !!go && /^Update \d+$/.test(go.textContent.trim()); }, null, 15000);
        const rowStates = () => page.evaluate(() => [...document.querySelectorAll('.pgx-ua li')].map((li) => li.getAttribute('data-state')));
        const st = await rowStates();
        step('pluginupdates: 16 rows prepared one by one — 11 ready, 5 failed (download budget used up)',
          prepared && st.length === N && st.filter((s) => s === 'ready').length === 11 && st.filter((s) => s === 'failed').length === 5, st.join(','));
        step('pluginupdates: a failed row says why (the server\'s message)', await page.evaluate((msg) => [...document.querySelectorAll('.pgx-ua li[data-state="failed"] .pgx-ua-state')].every((s) => s.textContent === 'failed: ' + msg), RATE_MSG));
        step('pluginupdates: the button counts the ready ones ("Update 11"), "Try again" is offered',
          await page.evaluate(() => document.getElementById('pgx-ua-go').textContent.trim() === 'Update 11' && !document.getElementById('pgx-ua-go').disabled
            && !document.getElementById('pgx-ua-retry').hidden && document.getElementById('pgx-ua-retry').textContent.trim() === 'Try again'));
        await shot(page, 'plugin-updates-failed');

        // phone: the dialog with three buttons fits
        const vp = page.viewportSize();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(150);
        step('pluginupdates: 390 px — no sideways scroll, "Try again" visible', (await overflow(page)) <= 1 && await page.isVisible('#pgx-ua-retry'), 'overflow ' + (await overflow(page)));
        await shot(page, 'plugin-updates-390');
        await page.setViewportSize(vp);

        // the window passed: "Try again" prepares only the failed rows
        m.budget = 100;
        await page.click('#pgx-ua-retry');
        step('pluginupdates: "Try again" → all 16 ready, "Update 16", no "Try again" left',
          await until(page, () => document.getElementById('pgx-ua-go').textContent.trim() === 'Update 16' && document.getElementById('pgx-ua-retry').hidden
            && [...document.querySelectorAll('.pgx-ua li')].every((li) => li.getAttribute('data-state') === 'ready'), null, 15000));
        const again = ids.filter((id) => m.prepared[id] === 2);
        step('pluginupdates: … only the 5 failed plugins were downloaded again', again.length === 5 && ids.every((id) => m.prepared[id] === 1 || again.includes(id)) && again.join() === ids.slice(11).join(), again.join(','));

        // update: one install fails → prepared again from the finished dialog
        await page.click('#pgx-ua-go');
        step('pluginupdates: 15 updated, 1 failed, "Close" and "Try again"', await until(page, () => {
          const s = [...document.querySelectorAll('.pgx-ua li')].map((li) => li.getAttribute('data-state'));
          return document.getElementById('pgx-ua-go').textContent.trim() === 'Close' && s.filter((x) => x === 'updated').length === 15 && s.filter((x) => x === 'failed').length === 1
            && !document.getElementById('pgx-ua-retry').hidden;
        }, null, 15000));
        await page.click('#pgx-ua-retry');
        step('pluginupdates: … "Try again" prepares the failed one → "Update 1"', await until(page, () => document.getElementById('pgx-ua-go').textContent.trim() === 'Update 1'));
        step('pluginupdates: … the updated rows stay updated', await page.evaluate(() => [...document.querySelectorAll('.pgx-ua li')].filter((li) => li.getAttribute('data-state') === 'updated').length === 15));
        await page.click('#pgx-ua-go');
        step('pluginupdates: all 16 updated', await until(page, () => document.getElementById('pgx-ua-go').textContent.trim() === 'Close'
          && [...document.querySelectorAll('.pgx-ua li')].every((li) => li.getAttribute('data-state') === 'updated'), null, 15000));
        await page.click('#pgx-ua-go');
        step('pluginupdates: "Close" → the list is reloaded: all current', await until(page, () => !document.querySelector('.pgx-ua') && !!document.querySelector('.pgx-uptodate') && !document.getElementById('pgx-update-all')),
          String(m.installed.size));
      } finally {
        await page.unroute(/\/api\/v1\/plugin-catalog(\/.*)?(\?.*)?$/, catalogue);
        await page.unroute(/\/api\/v1\/plugins\/install$/, install);
        // provoked on purpose: the mocked 429 / 409 and the real 400
        allow((p) => p.kind === 'http' && [400, 409, 429].includes(p.status) && /\/api\/v1\/(plugin-catalog|plugins)\/install$/.test(p.url),
          (p) => p.kind === 'console' && /status of (409|429)/.test(p.text));
      }
    },
  };
};
