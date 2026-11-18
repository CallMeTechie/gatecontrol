'use strict';

// Portal "Mein Profil › Meine Orte" (docs/feature-user-profile.md "Meine Orte"): the card on "Mein Profil" leads to
// #orte; the map loads (Leaflet over the tile relay); a click on the map starts a new place with its point; "Speichern"
// only with a name and a point; the place is listed and drawn; opening it shows the form; deleting asks first;
// 390 px without horizontal scroll. The address search is not asked (no request to OpenStreetMap from CI).
//
// Like 08-portal.js: an own browser resolves the portal host to 127.0.0.1 and adds the identity header itself.
// No text comparisons: selectors, aria-/data- attributes, URLs, API answers.

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, shot, problems } = ctx;

  return {
    async portalplaces() {
      const { chromium } = require('playwright');
      const P = FIXTURES.portal;
      const port = new URL(BASE).port || '80';
      const HOST = `home.${process.env.GC_DNS_DOMAIN || 'gc.internal'}`;
      const PORTAL = `http://${HOST}:${port}`;
      const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] });
      async function open(ip, width = 1440) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, bypassCSP: true });
        await context.route((url) => url.hostname === HOST, (route) => route.continue({
          headers: Object.assign({}, route.request().headers(), { 'x-gc-portal-peer-ip': ip }),
        }));
        // map tiles: answered here with an empty picture — the run never asks OpenStreetMap
        await context.route((url) => url.hostname === HOST && url.pathname.startsWith('/plugins/_shared/tiles/'), (route) => route.fulfill({
          status: 200, contentType: 'image/png',
          body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
        }));
        const p = await context.newPage();
        p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|Cross-Origin-Opener-Policy/.test(m.text())) problems.push({ kind: 'console', text: m.text().slice(0, 300) }); });
        p.on('pageerror', (e) => problems.push({ kind: 'pageerror', text: String(e).slice(0, 300) }));
        p.on('response', (r) => {
          const u = r.url();
          if (u.startsWith(PORTAL) && r.status() >= 400 && !u.includes('/favicon')) problems.push({ kind: 'http', status: r.status(), url: u.replace(PORTAL, 'portal:') });
        });
        return { context, p };
      }
      const signIn = async (p) => {
        const r = await (await fetch(BASE + '/api/v1/client/portal-link', { method: 'POST', headers: { Authorization: `Bearer ${P.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ next: '/portal#profil' }) })).json();
        const u = new URL(r.url);
        await p.goto(PORTAL + u.pathname + u.search);
        await p.waitForLoadState('networkidle').catch(() => {});
      };
      const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      const places = (p) => p.evaluate(async () => {
        const r = await fetch('/api/v1/portal/me/profile/places', { credentials: 'same-origin' });
        return (await r.json()).places;
      });

      try {
        const { context, p } = await open(P.ip);
        await signIn(p);
        step('"Mein Profil" has the card "Meine Orte"', await p.isVisible('#pt-pf-places'));
        await p.click('#pt-pf-places');
        await p.waitForSelector('#pt-pl-map.leaflet-container', { timeout: 8000 }).catch(() => {});
        step('#orte opens with the map (Leaflet, tiles through the relay)', /#orte$/.test(p.url()) && await p.isVisible('#panel-orte')
          && !!(await p.$('#pt-pl-map .leaflet-tile-pane')) && /\/plugins\/_shared\/tiles\//.test(await p.evaluate(() => JSON.parse(document.getElementById('portal-ctx').textContent).tiles || '')));
        step('the breadcrumb leads back to "Mein Profil"', (await p.getAttribute('#panel-orte .pt-crumbs a', 'data-goto')) === 'profil');
        const before = (await places(p)).length;

        // ── a new place by a click on the map ──
        const box = await p.locator('#pt-pl-map').boundingBox();
        await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await p.waitForSelector('#pt-pl-name', { timeout: 4000 }).catch(() => {});
        step('a click on the map opens the form with the point set', await p.isVisible('#pt-pl-name') && (await p.getAttribute('#pt-pl-point', 'data-tone')) === 'good');
        step('"Speichern" stays off without a name', await p.isDisabled('#pt-pl-save'));
        await p.fill('#pt-pl-name', 'Testort Lindenweg');
        await p.check('.pt-pl-iconbtn input[value="work"]', { force: true });
        await p.locator('#pt-pl-radius').evaluate((el) => { el.value = '400'; el.dispatchEvent(new Event('input', { bubbles: true })); });
        step('the radius shows its value', /400/.test(await p.textContent('#pt-pl-radius-v')));
        await shot(p, 'portal-places-new');
        await Promise.all([p.waitForResponse((x) => x.url().endsWith('/me/profile/places') && x.request().method() === 'POST'), p.click('#pt-pl-save')]);
        await p.waitForSelector('#pt-pl-side .pt-pl-item', { timeout: 4000 }).catch(() => {});
        const after = await places(p);
        const made = after.find((x) => x.name === 'Testort Lindenweg');
        step('saved with point, symbol and radius; listed', after.length === before + 1 && !!made && made.icon === 'work' && made.radiusM === 400
          && Number.isFinite(made.lat) && !!(await p.$(`#pt-pl-side .pt-pl-item[data-id="${made && made.id}"]`)));
        step('the map draws it', (await p.$$('#pt-pl-map path.leaflet-interactive')).length >= 2);

        // ── open, then delete — asks first ──
        await p.click(`#pt-pl-side .pt-pl-item[data-id="${made.id}"]`);
        step('a place opens in the form', await p.inputValue('#pt-pl-name') === 'Testort Lindenweg' && await p.isVisible('#pt-pl-delete'));
        await p.click('#pt-pl-delete');
        step('deleting asks first', await p.isVisible('.pt-dialog[role="alertdialog"]'));
        await p.keyboard.press('Escape');
        await p.waitForTimeout(200);
        step('Escape keeps the place', (await places(p)).some((x) => x.id === made.id));
        await p.click('#pt-pl-delete');
        await Promise.all([p.waitForResponse((x) => x.url().includes(`/me/profile/places/${made.id}`) && x.request().method() === 'DELETE'), p.click('.pt-dialog .pt-btn-danger-solid')]);
        await p.waitForTimeout(300);
        step('deleted after the question', !(await places(p)).some((x) => x.id === made.id) && !(await p.isVisible('#pt-pl-name')));
        await context.close();

        // ── a phone ──
        const small = await open(P.ip, 390);
        await signIn(small.p);
        await small.p.goto(PORTAL + '/portal#orte');
        await small.p.waitForSelector('#pt-pl-map.leaflet-container', { timeout: 8000 }).catch(() => {});
        step('390 px: "Meine Orte" without horizontal scroll', await noOverflow(small.p));
        await shot(small.p, 'portal-places-390');
        await small.context.close();
      } finally {
        await browser.close();
      }
    },
  };
};
