'use strict';

// Portal Start tab: plugin tiles come by themselves (public/js/portal.js
// loadPluginStart, since 1.198.0). Without a server: a minimal page with the
// real portal.js, GET /api/v1/portal/plugins/start answered here and counted,
// Playwright's clock instead of waiting. Checked: a new tile shows within a
// minute without reloading, one that is gone disappears, a hidden page or
// another tab asks nothing, coming back asks at once (at most every 15 s).

const fs = require('fs');
const path = require('path');

module.exports = (ctx) => {
  const { step } = ctx;

  return {
    async portalstart() {
      const { chromium } = require('playwright');
      const js = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', 'js', 'portal.js'), 'utf8');
      const html = '<!doctype html><html lang="de"><head><meta charset="utf-8">'
        + '<script type="application/json" id="portal-i18n">{}</script>'
        + '<script type="application/json" id="portal-ctx">{"tabs":{"plugins":true}}</script></head><body>'
        + '<nav class="pt-tabs" role="tablist"><a class="pt-tab" id="tab-start" data-tab="start" href="#start">Start</a>'
        + '<a class="pt-tab" id="tab-geraete" data-tab="geraete" href="#geraete">Geräte</a></nav>'
        + '<section class="pt-panel" id="panel-start" data-panel="start">'
        + '<section class="pt-card" id="pt-start-card-plg-x" hidden><div class="pt-plg-tiles" id="pt-start-tiles-plg-x"></div></section></section>'
        + '<section class="pt-panel" id="panel-geraete" data-panel="geraete" hidden></section>'
        + '<script src="/js/portal.js"></script></body></html>';
      const browser = await chromium.launch();
      try {
        const context = await browser.newContext();
        await context.clock.install();
        const p = await context.newPage();
        const errors = [];
        p.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
        let calls = 0;
        let tiles = [];
        await p.route('http://portal.test/**', async (route) => {
          const u = new URL(route.request().url());
          if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
          if (u.pathname === '/js/portal.js') return route.fulfill({ contentType: 'application/javascript', body: js });
          if (u.pathname === '/api/v1/portal/plugins/start') { calls++; return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, tiles }) }); }
          return route.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' });
        });
        const settle = () => p.waitForTimeout(150);
        const shown = () => p.locator('#pt-start-tiles-plg-x .pt-plg-tile').count();
        const setHidden = (hidden) => p.evaluate((h) => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
          document.dispatchEvent(new Event('visibilitychange'));
        }, hidden);

        await p.goto('http://portal.test/');
        await settle();
        step('portal Start: the tiles are asked once on load', calls === 1, `calls ${calls}`);

        tiles = [{ plugin: 'x', title: 'WLAN', value: 'Gäste', goto: 'plg-x', anchor: null }];
        await p.clock.runFor(61000);
        await settle();
        step('portal Start: a new tile shows within a minute, without reloading', calls === 2 && (await shown()) === 1 && !(await p.locator('#pt-start-card-plg-x').isHidden()), `calls ${calls}`);

        tiles = [];
        await p.clock.runFor(61000);
        await settle();
        step('portal Start: a tile that is gone disappears with its card', calls === 3 && (await shown()) === 0 && (await p.locator('#pt-start-card-plg-x').isHidden()), `calls ${calls}`);

        await setHidden(true);
        await p.clock.runFor(5 * 60000);
        await settle();
        step('portal Start: a hidden page asks nothing', calls === 3, `calls ${calls}`);
        await setHidden(false);
        await settle();
        step('portal Start: visible again → asked at once', calls === 4, `calls ${calls}`);
        await p.evaluate(() => window.dispatchEvent(new Event('focus')));
        await setHidden(false);
        await settle();
        step('portal Start: not again within 15 s (focus, visibility)', calls === 4, `calls ${calls}`);

        await p.click('#tab-geraete');
        await p.clock.runFor(3 * 60000);
        await settle();
        step('portal Start: another tab open → nothing asked', calls === 4, `calls ${calls}`);
        await p.click('#tab-start');
        await settle();
        step('portal Start: back on Start → asked at once', calls === 5, `calls ${calls}`);
        step('portal Start: no page errors', errors.length === 0, errors.join(' | '));
      } finally {
        await browser.close();
      }
    },
  };
};
