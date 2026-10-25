'use strict';

// Plugin frames learn the height they can take without the page scrolling
// (public/js/plugin-bridge.js sendViewport → the frame's window.GC.viewport,
// --gc-viewport-height, `gc:viewport`; since 1.199.0). Without a server: a page
// with a header above and a footer below a real plugin frame document
// (src/services/plugins/frame.js document()) whose content takes
// var(--gc-viewport-height). Checked: the value, no page scroll, a resized
// window, a banner above, a frame shown later (another tab).

const fs = require('fs');
const path = require('path');

module.exports = (ctx) => {
  const { step } = ctx;

  return {
    async pluginviewport() {
      const { chromium } = require('playwright');
      const root = path.join(__dirname, '..', '..', '..');
      const bridge = fs.readFileSync(path.join(root, 'public', 'js', 'plugin-bridge.js'), 'utf8');
      const frameDoc = require(path.join(root, 'src', 'services', 'plugins', 'frame.js')).document({
        html: '<div id="wall" style="height:var(--gc-viewport-height,640px);background:#0b7a55"></div>'
          + '<script>window.addEventListener("gc:viewport",function(e){document.title=String(e.detail.height);});</script>',
        lang: 'de',
      });
      const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const html = '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;min-height:100vh}header{height:150px}footer{height:60px}</style></head><body>'
        + '<div id="top"><header id="head"></header></div>'
        + '<section id="tab-a"><iframe id="f" data-plugin-frame data-plugin-id="x" data-plugin-api="/api/v1/portal/plugins/x/api/" sandbox="allow-scripts"'
        + ' style="display:block;width:100%;border:0" srcdoc="' + esc(frameDoc) + '"></iframe></section>'
        + '<section id="tab-b" hidden><iframe id="g" data-plugin-frame data-plugin-id="y" data-plugin-api="/api/v1/portal/plugins/y/api/" sandbox="allow-scripts"'
        + ' style="display:block;width:100%;border:0" srcdoc="' + esc(frameDoc) + '"></iframe></section>'
        + '<footer></footer><script src="/js/plugin-bridge.js"></script></body></html>';
      const browser = await chromium.launch();
      try {
        const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await p.route('http://viewport.test/**', (route) => {
          const u = new URL(route.request().url());
          if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
          if (u.pathname === '/js/plugin-bridge.js') return route.fulfill({ contentType: 'application/javascript', body: bridge });
          return route.fulfill({ status: 404, body: '' });
        });
        await p.goto('http://viewport.test/');
        const view = async (id) => {
          const el = await p.$('#' + id);
          const f = await el.contentFrame();
          return f.evaluate(() => (window.GC.viewport ? window.GC.viewport.height : null));
        };
        const scrolls = () => p.evaluate(() => document.documentElement.scrollHeight > window.innerHeight);
        await p.waitForFunction(() => document.getElementById('f').offsetHeight !== 640 && document.getElementById('f').offsetHeight > 150, null, { timeout: 5000 }).catch(() => {});
        await p.waitForTimeout(200);
        let h = await view('f');
        step('plugin viewport: the frame learns the height between header and footer', h === 800 - 150 - 60, `got ${h}`);
        step('plugin viewport: a frame that uses it fills the window, the page does not scroll', !(await scrolls()) && (await p.$eval('#f', (f) => f.offsetHeight)) === 590);
        step('plugin viewport: --gc-viewport-height and gc:viewport in the frame', await (await (await p.$('#f')).contentFrame()).evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--gc-viewport-height').trim() === '590px' && document.title === '590'));
        await p.setViewportSize({ width: 1280, height: 1000 });
        await p.waitForTimeout(300);
        h = await view('f');
        step('plugin viewport: a taller window → a taller frame', h === 790 && !(await scrolls()), `got ${h}`);
        await p.evaluate(() => { document.getElementById('head').style.height = '190px'; });
        await p.waitForTimeout(300);
        h = await view('f');
        step('plugin viewport: a banner above → less height, still no scroll', h === 750 && !(await scrolls()), `got ${h}`);
        step('plugin viewport: a hidden frame is not told yet', (await view('g')) === null);
        await p.evaluate(() => { document.getElementById('tab-a').hidden = true; document.getElementById('tab-b').hidden = false; });
        await p.waitForTimeout(300);
        h = await view('g');
        step('plugin viewport: shown later (another tab) → told then', h === 750, `got ${h}`);
      } finally {
        await browser.close();
      }
    },
  };
};
