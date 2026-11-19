'use strict';

// A plugin's dialog taller than the window (public/js/plugin-bridge.js placeDim /
// sendViewport). The fixture plugin tests/fixtures/plugins/dialog-demo is packed
// here (unsigned — "Unsignierte Plugins erlauben" while the scenario runs) and
// installed through the real API; its page /plugins/dialog-demo opens
//   - "Long": a card of 1600 px. The frame grows, the page scrolls and the frame
//     slides under the sticky, see-through topbar. The page's dim must cover the
//     topbar there (and the bottom navigation at 390 px): it leaves out only the
//     frame below the topbar / above the bottom navigation — left out up to the
//     frame's top, the topbar stayed undimmed, a light band over the dialog.
//   - "Fit": a card kept to --gc-viewport-height. The page is shorter than the
//     window; GC.viewport is the room between the frame's top and the window's
//     bottom minus .main's bottom padding — the min-height filler of .app
//     (100vh) is no content below the frame. The dialog then fits in the window.
// Also: the frame has the page's theme, and gets it with GC.viewport when it
// loaded before plugin-bridge.js ran (the script held back here).
// Desktop and 390 px, light and dark. The plugin is removed at the end.

const path = require('node:path');

module.exports = (ctx) => {
  const { BASE, step, shot, api } = ctx;
  const ID = 'dialog-demo';
  const until = (page, fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const theme = async (page, mode) => {
    await page.evaluate((m) => { try { localStorage.setItem('gc-theme-mode', m); } catch (_) { /* ignore */ } document.documentElement.setAttribute('data-theme', m); }, mode);
    await page.waitForTimeout(150);
  };

  async function install(page) {
    const { packDir } = require(path.join(__dirname, '..', '..', '..', 'scripts', 'plugin-pack'));
    const buf = packDir(path.join(__dirname, '..', '..', 'fixtures', 'plugins', ID), { signingKey: '' }).buffer;
    const pol = await api(page, 'PUT', '/api/v1/plugins/policy', { allowUnsigned: true, confirm: 'ALLOW' });
    const csrf = await page.evaluate(() => window.GC && window.GC.csrfToken);
    const r = await page.request.fetch(BASE + '/api/v1/plugins/inspect', { method: 'POST', data: buf, headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf } });
    const ins = await r.json().catch(() => null);
    const done = ins && ins.token ? await api(page, 'POST', '/api/v1/plugins/install', { token: ins.token, accept: true }) : null;
    return pol.status === 200 && !!done && done.status === 200;
  }

  // Where the page's dim leaves a hole and where the bars are (viewport px).
  const layout = (page) => page.evaluate(() => {
    const d = document.querySelector('.plugin-frame-dim');
    const bar = document.querySelector('.topbar').getBoundingClientRect();
    const nav = document.querySelector('.bottom-nav');
    const nb = nav && nav.getClientRects().length ? nav.getBoundingClientRect() : null;
    const f = document.getElementById('pg-frame').getBoundingClientRect();
    const h = d && d.getBoundingClientRect();
    return {
      dim: h ? { top: Math.round(h.top), bottom: Math.round(h.bottom) } : null,
      barBottom: Math.round(bar.bottom), navTop: nb && nb.height ? Math.round(nb.top) : null,
      frameTop: Math.round(f.top), frameBottom: Math.round(f.bottom),
    };
  });

  async function openPage(page) {
    await page.goto(BASE + '/plugins/' + ID);
    const fr = page.frameLocator('#pg-frame');
    await fr.locator('#title').waitFor({ timeout: 10000 }).catch(() => {});
    // #title alone is not "ready": the buttons get their handlers from the script at the end of the
    // document — a click before that does nothing (CI, 1440-light: the dialog never opened)
    let polls = 0;
    for (; polls < 100; polls++) {
      const ready = await fr.locator('html').evaluate(() => document.readyState === 'complete'
        && typeof document.getElementById('open-fit').onclick === 'function'
        && typeof document.getElementById('open-long').onclick === 'function').catch(() => false);
      if (ready) break;
      await page.waitForTimeout(100);
    }
    fr.readyPolls = polls;
    return fr;
  }

  // Opens a dialog of the frame and waits until it shows; a click that got lost (the page still
  // moving under the pointer) is given once more — what is tested is the layout of the open dialog.
  // Returns the number of clicks it took (0: it never opened) — in the step's detail.
  async function openDialog(fr, id) {
    const dlg = fr.locator('#' + id);
    for (let i = 1; i <= 3; i++) {
      await fr.locator('#open-' + id).click();
      if (await dlg.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) return i;
    }
    return 0;
  }

  async function round(page, label) {
    const fr = await openPage(page);
    const view = () => page.evaluate(() => {
      const f = document.getElementById('pg-frame');
      const r = f.getBoundingClientRect();
      const m = getComputedStyle(document.querySelector('.main'));
      return { top: Math.round(r.top + window.scrollY), padB: parseFloat(m.paddingBottom) || 0, inner: window.innerHeight };
    });
    // "Fit": GC.viewport is the room down to the window's bottom (less .main's padding), not the frame's own height
    const v = await view();
    const mode = label.split('-')[1];
    // the frame takes the page's theme — also when it loaded before plugin-bridge.js ran
    let ft = null;
    for (let i = 0; i < 30 && ft !== mode; i++) {
      ft = await fr.locator('html').evaluate((h) => h.getAttribute('data-theme')).catch(() => null);
      if (ft !== mode) await page.waitForTimeout(100);
    }
    step(`plugindialog ${label}: the frame has the page's theme`, ft === mode, `frame ${ft}`);
    const want = Math.floor(v.inner - v.top - v.padB);
    const told = () => fr.locator('html').evaluate(() => (window.GC.viewport ? window.GC.viewport.height : null)).catch(() => null);
    let got = null;
    for (let i = 0; i < 30 && got !== want; i++) { got = await told(); if (got !== want) await page.waitForTimeout(100); }
    step(`plugindialog ${label}: GC.viewport is the room below the frame's top (not its own height)`, got === want, `got ${got}, want ${want}`);
    const clicks = await openDialog(fr, 'fit');
    step(`plugindialog ${label}: "Fit" opens`, clicks > 0, `clicks ${clicks}, frame ready after ${fr.readyPolls} polls`);
    // the bridge places the dim and sizes the frame once the frame reports the dialog
    await until(page, (h) => !!document.querySelector('.plugin-frame-dim')
      && Math.round(document.getElementById('pg-frame').getBoundingClientRect().height) === h, want);
    let l = await layout(page);
    // (the page itself may scroll for the sidebar — a long navigation on a low window; the frame stays inside it)
    step(`plugindialog ${label}: a dialog kept to GC.viewport fits, the frame ends inside the window`, !!l.dim && l.frameBottom + v.padB <= v.inner && l.frameBottom - l.frameTop === want, JSON.stringify(l));
    await shot(page, `plugindialog-${label}-fit`, false);
    await fr.locator('#fit .close').click();
    await fr.locator('#fit').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    await until(page, () => !document.querySelector('.plugin-frame-dim'));

    // "Long": the frame grows past the window; scrolled down, it is under the topbar
    const longClicks = await openDialog(fr, 'long');
    step(`plugindialog ${label}: "Long" opens`, longClicks > 0, `clicks ${longClicks}`);
    await until(page, () => !!document.querySelector('.plugin-frame-dim') && document.getElementById('pg-frame').offsetHeight > window.innerHeight);
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(300);
    l = await layout(page);
    step(`plugindialog ${label}: scrolled, the frame is under the topbar`, l.frameTop < l.barBottom, JSON.stringify(l));
    step(`plugindialog ${label}: the dim leaves out the frame only below the topbar (topbar dimmed)`, !!l.dim && l.dim.top >= l.barBottom, JSON.stringify(l));
    if (l.navTop != null) step(`plugindialog ${label}: … and only above the bottom navigation`, !!l.dim && l.dim.bottom <= l.navTop, JSON.stringify(l));
    await shot(page, `plugindialog-${label}-long`, false);
    await fr.locator('#long .close').click();
    await until(page, () => !document.querySelector('.plugin-frame-dim'));
    step(`plugindialog ${label}: closed → no dim`, !(await page.$('.plugin-frame-dim')));
  }

  return {
    async plugindialog(page) {
      step('plugindialog: fixture plugin installed', await install(page));
      try {
        for (const mode of ['dark', 'light']) {
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.goto(BASE + '/plugins/' + ID);
          await theme(page, mode);
          await round(page, `1440-${mode}`);
          await page.setViewportSize({ width: 390, height: 844 });
          await round(page, `390-${mode}`);
        }
        // plugin-bridge.js late (the frame loaded and said hello before it ran): still the theme and GC.viewport
        const late = (route) => setTimeout(() => route.continue().catch(() => {}), 1500);
        await page.route('**/js/plugin-bridge.js*', late);
        try {
          await page.setViewportSize({ width: 1440, height: 900 });
          const fr = await openPage(page);
          await until(page, () => !!window.GCPluginBridge);
          let got = null;
          for (let i = 0; i < 30 && !(got && got.theme === 'light' && got.view); i++) {
            got = await fr.locator('html').evaluate((h) => ({ theme: h.getAttribute('data-theme'), view: !!window.GC.viewport })).catch(() => null);
            if (!(got && got.theme === 'light' && got.view)) await page.waitForTimeout(100);
          }
          step('plugindialog: a frame loaded before plugin-bridge.js ran gets the theme and GC.viewport', !!got && got.theme === 'light' && got.view, JSON.stringify(got));
        } finally {
          await page.unroute('**/js/plugin-bridge.js*', late);
        }
      } finally {
        await page.setViewportSize({ width: 1440, height: 900 });
        await theme(page, 'dark');
        const rm = await api(page, 'POST', '/api/v1/plugins/' + ID + '/uninstall', { mode: 'wipe', confirm: 'Dialog demo' });
        const pol = await api(page, 'PUT', '/api/v1/plugins/policy', { allowUnsigned: false });
        step('plugindialog: plugin removed, unsigned off again', rm.status === 200 && pol.status === 200, `${rm.status}/${pol.status}`);
      }
    },
  };
};
